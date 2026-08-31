#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <thread>

#include "Aeron.h"
#include "FragmentAssembler.h"
#include "concurrent/BusySpinIdleStrategy.h"
#include "core/sequenced_envelope.hpp"
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

constexpr std::int64_t kQuoteTickNs = 100'000'000; // publish a quote every 100ms

} // namespace

int main(int argc, char **argv)
{
    if (argc < 13)
    {
        std::cerr << "Usage: " << argv[0]
                  << " <orderChannel> <orderStreamId> <fillLogPath> <quoteChannel> <quoteStreamId>"
                  << " <simEpochSeconds> <seed> <sigma> <s0> <gamma> <k> <horizonSeconds>\n"
                  << "  Quotes from the Avellaneda-Stoikov closed-form approximation:\n"
                  << "  reservation = s - q*gamma*sigma^2*(T-t)\n"
                  << "  spread = gamma*sigma^2*(T-t) + (2/gamma)*ln(1 + gamma/k)\n"
                  << "  e.g. " << argv[0] << " aeron:ipc 30 fills.csv aeron:ipc 32 1798650000 42 0.5 100.0 0.1 20.0 300\n";
        return 1;
    }

    const std::string order_channel = argv[1];
    const std::int32_t order_stream_id = std::stoi(argv[2]);
    const std::string fill_log_path = argv[3];
    const std::string quote_channel = argv[4];
    const std::int32_t quote_stream_id = std::stoi(argv[5]);
    const std::int64_t sim_epoch_ns = std::stoll(argv[6]) * 1'000'000'000LL;
    const std::uint64_t seed = std::stoull(argv[7]);
    const double sigma = std::stod(argv[8]);
    const double s0 = std::stod(argv[9]);
    const double gamma = std::stod(argv[10]);
    const double k = std::stod(argv[11]);
    const double horizon_seconds = std::stod(argv[12]);

    std::signal(SIGINT, on_sigint);
    std::setvbuf(stdout, nullptr, _IOLBF, 0);

    std::ofstream fill_log(fill_log_path);
    fill_log << "global_sequence,timestamp_ns,side,price,quantity,true_price_at_trade,delta,inventory_after\n";

    double inventory = 0.0;
    std::uint64_t received = 0;

    fragment_handler_t on_message = [&](const concurrent::AtomicBuffer &buffer, util::index_t offset, util::index_t length, const Header &)
    {
        seq::SequencedEnvelope envelope;
        std::memcpy(&envelope, buffer.buffer() + offset, sizeof(envelope));
        const seq::OrderEvent order = seq::read_payload<seq::OrderEvent>(envelope);
        ++received;

        const double signed_quantity = order.side == seq::Side::Buy ? order.quantity : -order.quantity;
        inventory -= signed_quantity;

        const double delta_at_trade = std::abs(order.price - order.true_price_at_send);
        const std::int64_t now_ns = std::chrono::steady_clock::now().time_since_epoch().count();

        fill_log << envelope.global_sequence << ','
                  << now_ns << ','
                  << (order.side == seq::Side::Buy ? "BUY" : "SELL") << ','
                  << order.price << ','
                  << order.quantity << ','
                  << order.true_price_at_send << ','
                  << delta_at_trade << ','
                  << inventory << '\n';

        if (received % 50 == 0)
        {
            fill_log.flush();
            std::cout << "received " << received << " fills, inventory=" << inventory << '\n';
        }
    };

    aeron::Context context;
    std::shared_ptr<Aeron> aeron = Aeron::connect(context);

    const std::int64_t sub_id = aeron->addSubscription(order_channel, order_stream_id);
    std::shared_ptr<Subscription> subscription = aeron->findSubscription(sub_id);
    while (!subscription)
    {
        std::this_thread::yield();
        subscription = aeron->findSubscription(sub_id);
    }

    const std::int64_t pub_id = aeron->addPublication(quote_channel, quote_stream_id);
    std::shared_ptr<Publication> quote_publication = aeron->findPublication(pub_id);
    while (!quote_publication)
    {
        std::this_thread::yield();
        quote_publication = aeron->findPublication(pub_id);
    }

    std::cout << "Optimal market maker on " << order_channel << " stream " << order_stream_id
              << ", publishing quotes on " << quote_channel << " stream " << quote_stream_id
              << ", horizon " << horizon_seconds << "s, logging fills to " << fill_log_path
              << " (Ctrl+C to stop)..." << std::endl;

    seq::IncrementalPricePath price_path(seed, sigma, s0);

    using QuoteBuffer = std::array<std::uint8_t, sizeof(seq::Quote)>;
    AERON_DECL_ALIGNED(QuoteBuffer quote_buffer, 16);
    concurrent::AtomicBuffer quote_atomic_buffer(quote_buffer.data(), quote_buffer.size());
    std::int64_t last_quote_ns = 0;

    FragmentAssembler assembler(on_message);
    fragment_handler_t handler = assembler.handler();
    concurrent::BusySpinIdleStrategy idle_strategy;

    while (running)
    {
        const std::int64_t wall_now_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        const std::int64_t elapsed_ns = wall_now_ns - sim_epoch_ns;

        if (wall_now_ns - last_quote_ns >= kQuoteTickNs)
        {
            const double true_price = price_path.price_at(elapsed_ns);
            const double elapsed_s = static_cast<double>(elapsed_ns) / 1e9;
            const double time_remaining = std::max(0.0, horizon_seconds - elapsed_s);

            const double reservation = true_price - inventory * gamma * sigma * sigma * time_remaining;
            const double spread = gamma * sigma * sigma * time_remaining
                + (2.0 / gamma) * std::log(1.0 + gamma / k);

            seq::Quote quote{reservation - spread / 2.0, reservation + spread / 2.0, wall_now_ns};
            std::memcpy(quote_buffer.data(), &quote, sizeof(quote));
            quote_publication->offer(quote_atomic_buffer, 0, sizeof(quote));
            last_quote_ns = wall_now_ns;
        }

        const int fragments_read = subscription->poll(handler, 10);
        idle_strategy.idle(fragments_read);
    }

    fill_log.flush();
    fill_log.close();
    std::cout << "Optimal market maker stopped. Received " << received << " fills, final inventory=" << inventory
              << ". Fill log: " << fill_log_path << std::endl;
    return 0;
}
