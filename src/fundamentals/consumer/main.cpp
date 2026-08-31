#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <optional>
#include <thread>

#include "Aeron.h"
#include "FragmentAssembler.h"
#include "concurrent/BusySpinIdleStrategy.h"
#include "core/sequenced_envelope.hpp"
#include "fundamentals/producer_message.hpp"

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
    if (argc < 2)
    {
        std::cerr << "Usage: " << argv[0] << " <channel> [streamId] [consumerLabel]\n"
                  << "  e.g. " << argv[0] << " aeron:ipc 21 A\n";
        return 1;
    }

    const std::string channel = argv[1];
    const std::int32_t stream_id = argc > 2 ? std::stoi(argv[2]) : 21;
    const std::string label = argc > 3 ? argv[3] : "consumer";

    std::signal(SIGINT, on_sigint);

    std::optional<std::uint64_t> last_global_sequence;
    std::uint64_t received = 0;
    std::uint64_t gaps_detected = 0;

    fragment_handler_t on_message = [&](const concurrent::AtomicBuffer &buffer, util::index_t offset, util::index_t length, const Header &)
    {
        seq::SequencedEnvelope envelope;
        std::memcpy(&envelope, buffer.buffer() + offset, sizeof(envelope));
        const seq::ProducerMessage inner = seq::read_payload<seq::ProducerMessage>(envelope);
        ++received;

        // The whole point of the sequencer: every consumer should see
        // global_sequence increase by exactly 1 every time, with no gaps
        // and no repeats -- regardless of which producer each message
        // originally came from.
        if (last_global_sequence.has_value() && envelope.global_sequence != *last_global_sequence + 1)
        {
            ++gaps_detected;
            std::cout << "[" << label << "] ORDERING PROBLEM: expected " << (*last_global_sequence + 1)
                      << " but got " << envelope.global_sequence << std::endl;
        }
        last_global_sequence = envelope.global_sequence;

        const std::int64_t now_ns = std::chrono::steady_clock::now().time_since_epoch().count();
        const std::int64_t latency_ns = now_ns - inner.send_timestamp_ns;

        std::cout << "[" << label << "] global_seq=" << envelope.global_sequence
                  << " producer=" << inner.producer_id
                  << " producer_local_seq=" << inner.local_sequence
                  << " end_to_end_latency=" << latency_ns << "ns\n";
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

    std::cout << "[" << label << "] Subscribed on " << channel << " stream " << stream_id
              << " -- waiting for the sequencer's output (Ctrl+C to stop)..." << std::endl;

    FragmentAssembler assembler(on_message);
    fragment_handler_t handler = assembler.handler();
    concurrent::BusySpinIdleStrategy idle_strategy;

    while (running)
    {
        const int fragments_read = subscription->poll(handler, 10);
        idle_strategy.idle(fragments_read);
    }

    std::cout << "[" << label << "] Received " << received << " messages, "
              << gaps_detected << " ordering problems detected." << std::endl;
    return 0;
}
