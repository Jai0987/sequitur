#pragma once

#include <array>
#include <cstdint>
#include <cstring>

namespace seq {

// Generic sequencing wrapper: the sequencer doesn't need to understand
// what kind of message it's forwarding, only how many bytes it is. It
// stamps a global_sequence and copies the original bytes through
// unchanged. Whatever consumes a given stream already knows, by
// convention (which stream ID it subscribed to), what struct type to
// reinterpret payload[0..payload_size) as.
constexpr std::size_t kMaxPayloadBytes = 64;

struct SequencedEnvelope
{
    std::uint64_t global_sequence;
    std::uint32_t payload_size;
    std::array<std::uint8_t, kMaxPayloadBytes> payload;
};

inline void set_payload(SequencedEnvelope &envelope, const void *data, std::size_t size)
{
    envelope.payload_size = static_cast<std::uint32_t>(size);
    std::memcpy(envelope.payload.data(), data, size);
}

template <typename T>
T read_payload(const SequencedEnvelope &envelope)
{
    T value{};
    std::memcpy(&value, envelope.payload.data(), sizeof(T));
    return value;
}

} // namespace seq
