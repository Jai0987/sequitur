#include <array>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <thread>

#include "Aeron.h"
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
    if (argc < 3)
    {
        std::cerr << "Usage: " << argv[0] << " <channel> <producerId> [streamId] [numMessages] [ratePerSec]\n"
                  << "  e.g. " << argv[0] << " aeron:ipc 1 20 200000 50000\n";
        return 1;
    }

    const std::string channel = argv[1];
    const std::uint32_t producer_id = static_cast<std::uint32_t>(std::stoul(argv[2]));
    const std::int32_t stream_id = argc > 3 ? std::stoi(argv[3]) : 20;
    const std::uint64_t num_messages = argc > 4 ? std::stoull(argv[4]) : 200'000ULL;
    const std::uint64_t rate_per_sec = argc > 5 ? std::stoull(argv[5]) : 50'000ULL;
    const std::int64_t period_ns = rate_per_sec > 0 ? (1'000'000'000LL / static_cast<std::int64_t>(rate_per_sec)) : 0;

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

    std::cout << "Producer " << producer_id << " on " << channel << " stream " << stream_id
              << " -- waiting for sequencer..." << std::endl;
    while (running && !publication->isConnected())
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    if (!running)
    {
        return 0;
    }

    std::cout << "Producer " << producer_id << " sending " << num_messages << " messages." << std::endl;

    using MessageBuffer = std::array<std::uint8_t, sizeof(seq::ProducerMessage)>;
    AERON_DECL_ALIGNED(MessageBuffer buffer, 16);
    concurrent::AtomicBuffer src_buffer(buffer.data(), buffer.size());

    std::uint64_t sent = 0;
    std::int64_t next_send_ns = std::chrono::steady_clock::now().time_since_epoch().count();

    while (running && sent < num_messages)
    {
        if (period_ns > 0)
        {
            while (std::chrono::steady_clock::now().time_since_epoch().count() < next_send_ns)
            {
                // busy-wait for our scheduled send time
            }
        }

        seq::ProducerMessage msg{
            producer_id,
            sent,
            std::chrono::steady_clock::now().time_since_epoch().count()};
        std::memcpy(buffer.data(), &msg, sizeof(msg));

        const std::int64_t result = publication->offer(src_buffer, 0, sizeof(msg));

        if (result >= 0)
        {
            ++sent;
            next_send_ns += period_ns;
        }
        else if (result == NOT_CONNECTED)
        {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        // BACK_PRESSURED / ADMIN_ACTION: just retry the same message.
        // PUBLICATION_CLOSED / unknown: fall through and retry too -- for this
        // demo we don't need the extra teardown path the earlier publisher had.
    }

    std::cout << "Producer " << producer_id << " done. Sent " << sent << " messages." << std::endl;
    return 0;
}
