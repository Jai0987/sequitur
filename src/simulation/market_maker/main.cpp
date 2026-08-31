#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <thread>

#include "Aeron.h"
#include "FragmentAssembler.h"
#include "concurrent/BusySpinIdleStrategy.h"
#include "core/sequenced_envelope.hpp"
#include "simulation/order_event.hpp"

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
    if (argc < 4)
    {
        std::cerr << "Usage: " << argv[0] << " <channel> <streamId> <fillLogPath>\n"
                  << "  e.g. " << argv[0] << " aeron:ipc 31 fills.csv\n";
        return 1;
    }

    const std::string channel = argv[1];
    const std::int32_t stream_id = std::stoi(argv[2]);
    const std::string fill_log_path = argv[3];

    std::signal(SIGINT, on_sigint);

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

        // A liquidity taker buying takes from our ask, so our inventory
        // goes down; them selling means our inventory goes up.
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

    const std::int64_t id = aeron->addSubscription(channel, stream_id);
    std::shared_ptr<Subscription> subscription = aeron->findSubscription(id);
    while (!subscription)
    {
        std::this_thread::yield();
        subscription = aeron->findSubscription(id);
    }

    std::cout << "Market maker on " << channel << " stream " << stream_id
              << ", logging fills to " << fill_log_path << " (Ctrl+C to stop)..." << std::endl;

    FragmentAssembler assembler(on_message);
    fragment_handler_t handler = assembler.handler();
    concurrent::BusySpinIdleStrategy idle_strategy;

    while (running)
    {
        const int fragments_read = subscription->poll(handler, 10);
        idle_strategy.idle(fragments_read);
    }

    fill_log.flush();
    fill_log.close();
    std::cout << "Market maker stopped. Received " << received << " fills, final inventory=" << inventory
              << ". Fill log: " << fill_log_path << std::endl;
    return 0;
}
