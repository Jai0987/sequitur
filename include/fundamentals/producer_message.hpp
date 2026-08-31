#pragma once

#include <cstdint>

namespace seq {

// What a producer sends: its own identity plus a sequence number that is
// only meaningful relative to that one producer (producer A's local_sequence
// 5 has no ordering relationship to producer B's local_sequence 5 -- they're
// two independent counters). The sequencer is what turns these into one
// meaningful global order.
struct ProducerMessage
{
    std::uint32_t producer_id;
    std::uint64_t local_sequence;
    std::int64_t send_timestamp_ns;
};

} // namespace seq
