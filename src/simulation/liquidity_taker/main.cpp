#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <optional>
#include <random>
#include <thread>

#include "Aeron.h"
#include "FragmentAssembler.h"
#include "simulation/order_event.hpp"
#include "simulation/quote.hpp"
#include "simulation/true_price.hpp"

using namespace aeron;

namespace {

std::atomic<bool> running{true};

void on_sigint(int)
{
    running = false;
}

} // namespace

int main(int argc, char **argv)
{
    if (argc < 12)
    {
        std::cerr << "Usage: " << argv[0]
                  << " <orderChannel> <orderStreamId> <traderId> <quoteChannel> <quoteStreamId>"
                  << " <simEpochSeconds> <seed> <sigma> <s0> <A> <k> [durationSeconds]\n"
                  << "  e.g. " << argv[0] << " aeron:ipc 30 1 aeron:ipc 32 1798650000 42 0.5 100.0 10.0 20.0 30\n";
        return 1;
    }

    const std::string order_channel = argv[1];
    const std::int32_t order_stream_id = std::stoi(argv[2]);
    const std::uint32_t trader_id = static_cast<std::uint32_t>(std::stoul(argv[3]));
    const std::string quote_channel = argv[4];
    const std::int32_t quote_stream_id = std::stoi(argv[5]);
    const std::int64_t sim_epoch_ns = std::stoll(argv[6]) * 1'000'000'000LL;
    const std::uint64_t seed = std::stoull(argv[7]);
    const double sigma = std::stod(argv[8]);
    const double s0 = std::stod(argv[9]);
    const double A = std::stod(argv[10]);
    const double k = std::stod(argv[11]);
    const double duration_seconds = argc > 12 ? std::stod(argv[12]) : 30.0;

    std::signal(SIGINT, on_sigint);
    std::setvbuf(stdout, nullptr, _IOLBF, 0);

    aeron::Context context;
    std::shared_ptr<Aeron> aeron = Aeron::connect(context);

    const std::int64_t pub_id = aeron->addPublication(order_channel, order_stream_id);
    std::shared_ptr<Publication> publication = aeron->findPublication(pub_id);
    while (!publication)
    {
        std::this_thread::yield();
        publication = aeron->findPublication(pub_id);
    }

    const std::int64_t sub_id = aeron->addSubscription(quote_channel, quote_stream_id);
    std::shared_ptr<Subscription> quote_subscription = aeron->findSubscription(sub_id);
    while (!quote_subscription)
    {
        std::this_thread::yield();
        quote_subscription = aeron->findSubscription(sub_id);
    }

    std::cout << "Liquidity taker " << trader_id << " on " << order_channel << " stream " << order_stream_id
              << ", reading quotes from " << quote_channel << " stream " << quote_stream_id
              << " -- waiting for downstream and a first quote..." << std::endl;
    while (running && !publication->isConnected())
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    if (!running)
    {
        return 0;
    }

    std::optional<seq::Quote> latest_quote;
    fragment_handler_t on_quote = [&](const concurrent::AtomicBuffer &buffer, util::index_t offset, util::index_t length, const Header &)
    {
        seq::Quote quote;
        std::memcpy(&quote, buffer.buffer() + offset, sizeof(quote));
        latest_quote = quote;
    };
    FragmentAssembler quote_assembler(on_quote);
    fragment_handler_t quote_handler = quote_assembler.handler();

    // Don't guess at a price with no data -- wait for a real quote, same as
    // every other "wait before acting" pattern in this project.
    while (running && !latest_quote.has_value())
    {
        quote_subscription->poll(quote_handler, 10);
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    if (!running)
    {
        return 0;
    }
    std::cout << "Liquidity taker " << trader_id << " is live." << std::endl;

    std::mt19937_64 rng(seed ^ (static_cast<std::uint64_t>(trader_id) << 32));
    seq::IncrementalPricePath price_path(seed, sigma, s0);

    using MessageBuffer = std::array<std::uint8_t, sizeof(seq::OrderEvent)>;
    AERON_DECL_ALIGNED(MessageBuffer buffer, 16);
    concurrent::AtomicBuffer src_buffer(buffer.data(), buffer.size());

    // This redraws each side's next arrival time, using the *current*
    // published quote, every time that side fires or a new quote arrives.
    // It's a practical approximation of a time-varying-rate Poisson
    // process, not an exact simulation of one -- the rate is only exactly
    // right at the instant each gap is drawn, and treated as constant
    // until the next redraw.
    auto reschedule = [&](bool buy_side, std::int64_t now_ns) -> std::int64_t
    {
        const double true_price = price_path.price_at(now_ns - sim_epoch_ns);
        const double delta = buy_side
            ? (latest_quote->ask - true_price)
            : (true_price - latest_quote->bid);
        const double lambda = A * std::exp(-k * std::max(0.0, delta));
        std::exponential_distribution<double> gap_seconds(std::max(lambda, 1e-6));
        return now_ns + static_cast<std::int64_t>(gap_seconds(rng) * 1e9);
    };

    const std::int64_t start_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    std::int64_t next_buy_ns = reschedule(true, start_ns);
    std::int64_t next_sell_ns = reschedule(false, start_ns);

    std::uint64_t sent = 0;

    while (running)
    {
        quote_subscription->poll(quote_handler, 10);

        const std::int64_t wall_now_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        const std::int64_t elapsed_ns = wall_now_ns - sim_epoch_ns;
        if (elapsed_ns > static_cast<std::int64_t>(duration_seconds * 1e9))
        {
            break;
        }

        const bool buy_due = wall_now_ns >= next_buy_ns;
        const bool sell_due = wall_now_ns >= next_sell_ns;
        if (!buy_due && !sell_due)
        {
            continue;
        }

        const seq::Side side = buy_due ? seq::Side::Buy : seq::Side::Sell;
        const double true_price = price_path.price_at(elapsed_ns);
        const double trade_price = side == seq::Side::Buy ? latest_quote->ask : latest_quote->bid;

        seq::OrderEvent order{
            trader_id,
            side,
            trade_price,
            1.0,
            true_price,
            std::chrono::steady_clock::now().time_since_epoch().count()};
        std::memcpy(buffer.data(), &order, sizeof(order));

        std::int64_t result;
        do
        {
            result = publication->offer(src_buffer, 0, sizeof(order));
        }
        while (running && result == BACK_PRESSURED);

        if (result >= 0)
        {
            ++sent;
            std::cout << "trader=" << trader_id
                      << " side=" << (side == seq::Side::Buy ? "BUY" : "SELL")
                      << " true_price=" << true_price
                      << " trade_price=" << trade_price << '\n';
        }

        if (side == seq::Side::Buy)
        {
            next_buy_ns = reschedule(true, wall_now_ns);
        }
        else
        {
            next_sell_ns = reschedule(false, wall_now_ns);
        }
    }

    std::cout << "Liquidity taker " << trader_id << " done. Sent " << sent << " orders." << std::endl;
    return 0;
}
