#include <array>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <thread>

#include "Aeron.h"
#include "fundamentals/message.hpp"

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
        std::cerr << "Usage: " << argv[0] << " <channel> [streamId] [numMessages] [ratePerSec]\n"
                  << "  ratePerSec=0 means send as fast as possible (flood/throughput test).\n"
                  << "  e.g. " << argv[0] << " aeron:ipc 10 1000000 100000   # 1M msgs paced at 100k/sec\n"
                  << "       " << argv[0] << " aeron:udp?endpoint=localhost:20121\n";
        return 1;
    }

    const std::string channel = argv[1];
    const std::int32_t stream_id = argc > 2 ? std::stoi(argv[2]) : 10;
    const std::uint64_t num_messages = argc > 3 ? std::stoull(argv[3]) : 10'000'000ULL;
    const std::uint64_t rate_per_sec = argc > 4 ? std::stoull(argv[4]) : 0ULL;
    const std::int64_t period_ns = rate_per_sec > 0 ? (1'000'000'000LL / static_cast<std::int64_t>(rate_per_sec)) : 0;

    std::signal(SIGINT, on_sigint);

    aeron::Context context;
    context.newPublicationHandler(
        [](const std::string &chan, std::int32_t sid, std::int32_t session_id, std::int64_t correlation_id)
        {
            std::cout << "Publication added: " << chan << " stream=" << sid
                      << " session=" << session_id << " correlationId=" << correlation_id << std::endl;
        });

    std::shared_ptr<Aeron> aeron = Aeron::connect(context);

    const std::int64_t id = aeron->addPublication(channel, stream_id);
    std::shared_ptr<Publication> publication = aeron->findPublication(id);
    while (!publication)
    {
        std::this_thread::yield();
        publication = aeron->findPublication(id);
    }

    std::cout << "Publishing on " << channel << " stream " << stream_id << " -- waiting for a subscriber..." << std::endl;
    while (running && !publication->isConnected())
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }

    if (!running)
    {
        return 0;
    }

    std::cout << "Subscriber connected. Sending " << num_messages << " messages." << std::endl;

    using MessageBuffer = std::array<std::uint8_t, sizeof(seq::Message)>;
    AERON_DECL_ALIGNED(MessageBuffer buffer, 16);
    concurrent::AtomicBuffer src_buffer(buffer.data(), buffer.size());

    std::uint64_t back_pressure_events = 0;
    std::uint64_t sent = 0;

    // For a paced (open-loop) run, each message has a scheduled send time.
    // We spin-wait until that time arrives rather than sleep, since sleep_for's
    // wake-up granularity is far coarser than the microsecond-scale spacing
    // we want between messages at realistic rates.
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

        seq::Message msg{
            sent,
            std::chrono::steady_clock::now().time_since_epoch().count()};
        std::memcpy(buffer.data(), &msg, sizeof(msg));

        const std::int64_t result = publication->offer(src_buffer, 0, sizeof(msg));

        if (result >= 0)
        {
            ++sent;
            next_send_ns += period_ns;
            if (sent % 1'000'000 == 0)
            {
                std::cout << "sent " << sent << "/" << num_messages
                          << " (back-pressure events so far: " << back_pressure_events << ")" << std::endl;
            }
        }
        else if (result == BACK_PRESSURED || result == ADMIN_ACTION)
        {
            // Transient: the term buffer is full, or the driver is doing internal
            // housekeeping (e.g. rotating to the next log buffer). Retry the same
            // message rather than dropping it or treating this as an error.
            ++back_pressure_events;
        }
        else if (result == NOT_CONNECTED)
        {
            std::cerr << "Lost subscriber, waiting to reconnect..." << std::endl;
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        else // PUBLICATION_CLOSED or unknown negative result
        {
            std::cerr << "Publication closed or failed (result=" << result << "), exiting." << std::endl;
            break;
        }
    }

    std::cout << "Done. Sent " << sent << " messages, " << back_pressure_events << " back-pressure retries." << std::endl;
    return 0;
}
