#include <atomic>
#include <csignal>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <thread>

#include "Aeron.h"
#include "FragmentAssembler.h"
#include "concurrent/BusySpinIdleStrategy.h"
#include "core/sequenced_envelope.hpp"

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
    if (argc < 3)
    {
        std::cerr << "Usage: " << argv[0] << " <inboundChannel> <inboundStreamId> <outboundChannel> [outboundStreamId]\n"
                  << "  e.g. " << argv[0] << " aeron:ipc 20 aeron:ipc 21\n";
        return 1;
    }

    const std::string inbound_channel = argv[1];
    const std::int32_t inbound_stream_id = std::stoi(argv[2]);
    const std::string outbound_channel = argc > 3 ? argv[3] : inbound_channel;
    const std::int32_t outbound_stream_id = argc > 4 ? std::stoi(argv[4]) : inbound_stream_id + 1;

    std::signal(SIGINT, on_sigint);

    aeron::Context context;
    std::shared_ptr<Aeron> aeron = Aeron::connect(context);

    const std::int64_t sub_id = aeron->addSubscription(inbound_channel, inbound_stream_id);
    std::shared_ptr<Subscription> subscription = aeron->findSubscription(sub_id);
    while (!subscription)
    {
        std::this_thread::yield();
        subscription = aeron->findSubscription(sub_id);
    }

    const std::int64_t pub_id = aeron->addPublication(outbound_channel, outbound_stream_id);
    std::shared_ptr<Publication> publication = aeron->findPublication(pub_id);
    while (!publication)
    {
        std::this_thread::yield();
        publication = aeron->findPublication(pub_id);
    }

    std::cout << "Sequencer: reading " << inbound_channel << " stream " << inbound_stream_id
              << ", writing " << outbound_channel << " stream " << outbound_stream_id
              << " -- waiting for a downstream consumer before accepting input..." << std::endl;

    // Don't start reading producer input until a consumer is present downstream --
    // otherwise we'd assign sequence numbers to messages we can't actually deliver,
    // and the consumer would see gaps that look like a sequencing bug but are
    // really just "you started me before anyone was listening."
    while (running && !publication->isConnected())
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    if (!running)
    {
        return 0;
    }
    std::cout << "Consumer connected. Sequencer is live." << std::endl;

    // This counter is the entire sequencing decision: one thread, one counter,
    // incremented once per message it reads. No locks, no comparisons between
    // producers needed -- whichever message this thread reads next gets the
    // next number, period.
    std::uint64_t global_sequence = 0;

    using OutBuffer = std::array<std::uint8_t, sizeof(seq::SequencedEnvelope)>;
    AERON_DECL_ALIGNED(OutBuffer out_buffer, 16);
    concurrent::AtomicBuffer out_atomic_buffer(out_buffer.data(), out_buffer.size());

    fragment_handler_t on_message = [&](const concurrent::AtomicBuffer &buffer, util::index_t offset, util::index_t length, const Header &)
    {
        seq::SequencedEnvelope envelope{};
        envelope.global_sequence = global_sequence;
        ++global_sequence;
        seq::set_payload(envelope, buffer.buffer() + offset, static_cast<std::size_t>(length));

        std::memcpy(out_buffer.data(), &envelope, sizeof(envelope));

        // Retry the offer on transient failure so we never silently drop a
        // message we've already assigned a sequence number to -- once stamped,
        // it must make it out.
        std::int64_t result;
        do
        {
            result = publication->offer(out_atomic_buffer, 0, sizeof(envelope));
        }
        while (running && result == BACK_PRESSURED);

        // Logging happens AFTER the message is on its way out, and the
        // sequencer no longer knows the payload's meaning -- it only
        // knows its size. Whatever consumes a given stream interprets
        // payload[0..payload_size) itself.
        std::cout << "global_seq=" << envelope.global_sequence
                  << " payload_size=" << envelope.payload_size << '\n';
    };

    FragmentAssembler assembler(on_message);
    fragment_handler_t handler = assembler.handler();
    concurrent::BusySpinIdleStrategy idle_strategy;

    while (running)
    {
        const int fragments_read = subscription->poll(handler, 10);
        idle_strategy.idle(fragments_read);
    }

    std::cout << "Sequencer stopped after assigning " << global_sequence << " sequence numbers." << std::endl;
    return 0;
}
