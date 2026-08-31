#include <algorithm>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <vector>

#include "Aeron.h"
#include "FragmentAssembler.h"
#include "concurrent/BusySpinIdleStrategy.h"
#include "fundamentals/message.hpp"

using namespace aeron;

namespace {

std::atomic<bool> running{true};

void on_sigint(int)
{
    running = false;
}

void print_summary(std::vector<std::int64_t> &latencies_ns)
{
    if (latencies_ns.empty())
    {
        std::cout << "No messages received." << std::endl;
        return;
    }

    std::sort(latencies_ns.begin(), latencies_ns.end());

    auto pct = [&](double p) {
        std::size_t idx = static_cast<std::size_t>(p * (latencies_ns.size() - 1));
        return latencies_ns[idx];
    };

    std::cout << "\n--- latency summary (" << latencies_ns.size() << " messages) ---\n"
              << "min:    " << latencies_ns.front() << " ns\n"
              << "p50:    " << pct(0.50) << " ns\n"
              << "p90:    " << pct(0.90) << " ns\n"
              << "p99:    " << pct(0.99) << " ns\n"
              << "p99.9:  " << pct(0.999) << " ns\n"
              << "max:    " << latencies_ns.back() << " ns\n";
}

} // namespace

int main(int argc, char **argv)
{
    if (argc < 2)
    {
        std::cerr << "Usage: " << argv[0] << " <channel> [streamId]\n"
                  << "  e.g. " << argv[0] << " aeron:ipc\n"
                  << "       " << argv[0] << " aeron:udp?endpoint=localhost:20121\n";
        return 1;
    }

    const std::string channel = argv[1];
    const std::int32_t stream_id = argc > 2 ? std::stoi(argv[2]) : 10;

    std::signal(SIGINT, on_sigint);

    std::vector<std::int64_t> latencies_ns;
    latencies_ns.reserve(16'000'000);

    std::uint64_t received = 0;
    std::int64_t min_ns = std::numeric_limits<std::int64_t>::max();
    std::int64_t max_ns = std::numeric_limits<std::int64_t>::min();
    std::int64_t sum_ns = 0;

    fragment_handler_t on_message = [&](const concurrent::AtomicBuffer &buffer, util::index_t offset, util::index_t length, const Header &)
    {
        seq::Message msg;
        std::memcpy(&msg, buffer.buffer() + offset, sizeof(msg));

        const std::int64_t now_ns = std::chrono::steady_clock::now().time_since_epoch().count();
        const std::int64_t latency_ns = now_ns - msg.send_timestamp_ns;

        latencies_ns.push_back(latency_ns);
        ++received;
        min_ns = std::min(min_ns, latency_ns);
        max_ns = std::max(max_ns, latency_ns);
        sum_ns += latency_ns;

        if (received % 1'000'000 == 0)
        {
            std::cout << "received " << received << " (running mean=" << (sum_ns / static_cast<double>(received))
                      << "ns min=" << min_ns << "ns max=" << max_ns << "ns)" << std::endl;
        }
    };

    aeron::Context context;
    context.availableImageHandler(
        [](Image &image)
        {
            std::cout << "Publisher connected: sessionId=" << image.sessionId()
                      << " from " << image.sourceIdentity() << std::endl;
        });
    context.unavailableImageHandler(
        [](Image &image)
        {
            std::cout << "Publisher disconnected: sessionId=" << image.sessionId() << std::endl;
        });

    std::shared_ptr<Aeron> aeron = Aeron::connect(context);

    const std::int64_t id = aeron->addSubscription(channel, stream_id);
    std::shared_ptr<Subscription> subscription = aeron->findSubscription(id);
    while (!subscription)
    {
        std::this_thread::yield();
        subscription = aeron->findSubscription(id);
    }

    std::cout << "Subscribed on " << channel << " stream " << stream_id
              << " -- waiting for messages (Ctrl+C for summary)..." << std::endl;

    FragmentAssembler assembler(on_message);
    fragment_handler_t handler = assembler.handler();
    concurrent::BusySpinIdleStrategy idle_strategy;

    while (running)
    {
        const int fragments_read = subscription->poll(handler, 10);
        idle_strategy.idle(fragments_read);
    }

    print_summary(latencies_ns);
    return 0;
}
