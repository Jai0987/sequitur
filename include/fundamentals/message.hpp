#pragma once

#include <cstdint>

namespace seq {

// Fixed-size, trivially-copyable wire message: a sequence number plus a
// send-side timestamp. steady_clock is backed by the OS monotonic clock
// (CLOCK_MONOTONIC on Linux, a mach continuous clock on macOS), which is a
// system-wide time base, not per-process -- so a timestamp taken in the
// publisher process is directly comparable to steady_clock::now() taken
// later in the subscriber process, as long as both run on the same machine.
struct Message
{
    std::uint64_t sequence;
    std::int64_t send_timestamp_ns;
};

} // namespace seq
