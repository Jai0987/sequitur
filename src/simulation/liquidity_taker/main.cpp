#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <random>
#include <thread>

#include "Aeron.h"
#include "simulation/order_event.hpp"
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
    if (argc < 11)
    {
        std::cerr << "Usage: " << argv[0]
                  << " <channel> <streamId> <traderId> <simEpochSeconds> <seed> <sigma> <s0> <delta> <A> <k> [durationSeconds]\n"
                  << "  simEpochSeconds: same value passed to every liquidity_taker in this run (e.g. `date +%s`)\n"
                  << "  e.g. " << argv[0] << " aeron:ipc 30 1 1798650000 42 0.5 100.0 0.05 10.0 20.0 30\n";
        return 1;
    }

    const std::string channel = argv[1];
    const std::int32_t stream_id = std::stoi(argv[2]);
    const std::uint32_t trader_id = static_cast<std::uint32_t>(std::stoul(argv[3]));
    const std::int64_t sim_epoch_ns = std::stoll(argv[4]) * 1'000'000'000LL;
    const std::uint64_t seed = std::stoull(argv[5]);
    const double sigma = std::stod(argv[6]);
    const double s0 = std::stod(argv[7]);
    const double delta = std::stod(argv[8]);
    const double A = std::stod(argv[9]);
    const double k = std::stod(argv[10]);
    const double duration_seconds = argc > 11 ? std::stod(argv[11]) : 30.0;

    const double lambda = A * std::exp(-k * delta);
    if (lambda <= 0.0)
    {
        std::cerr << "Computed arrival rate lambda=" << lambda << " is not positive; check A/k/delta.\n";
        return 1;
    }

    std::signal(SIGINT, on_sigint);

    aeron::Context context;
    std::shared_ptr<Aeron> aeron = Aeron::connect(context);

    const std::int64_t id = aeron->addPublication(channel, stream_id);
    std::shared_ptr<Publication> publication = aeron->findPublication(id);
    while (!publication)
    {
        std::this_thread::yield();
        publication = aeron->findPublication(id);
    }

    std::cout << "Liquidity taker " << trader_id << " on " << channel << " stream " << stream_id
              << " -- lambda=" << lambda << "/sec, waiting for downstream..." << std::endl;
    while (running && !publication->isConnected())
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    if (!running)
    {
        return 0;
    }
    std::cout << "Liquidity taker " << trader_id << " is live." << std::endl;

    std::mt19937_64 rng(seed ^ (static_cast<std::uint64_t>(trader_id) << 32));
    std::exponential_distribution<double> gap_seconds(lambda);
    std::bernoulli_distribution side_coin(0.5);

    using MessageBuffer = std::array<std::uint8_t, sizeof(seq::OrderEvent)>;
    AERON_DECL_ALIGNED(MessageBuffer buffer, 16);
    concurrent::AtomicBuffer src_buffer(buffer.data(), buffer.size());

    std::uint64_t sent = 0;

    while (running)
    {
        const double gap = gap_seconds(rng);
        std::this_thread::sleep_for(std::chrono::duration<double>(gap));

        const std::int64_t wall_now_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        const std::int64_t elapsed_ns = wall_now_ns - sim_epoch_ns;
        if (elapsed_ns > static_cast<std::int64_t>(duration_seconds * 1e9))
        {
            break;
        }

        const double true_price = seq::price_at(seed, sigma, s0, elapsed_ns);
        const seq::Side side = side_coin(rng) ? seq::Side::Buy : seq::Side::Sell;
        const double trade_price = side == seq::Side::Buy ? true_price + delta : true_price - delta;

        seq::OrderEvent order{
            trader_id,
            side,
            trade_price,
            1.0, // fixed lot size for phase 1
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
    }

    std::cout << "Liquidity taker " << trader_id << " done. Sent " << sent << " orders." << std::endl;
    return 0;
}
