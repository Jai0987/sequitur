#pragma once

#include <cstdint>

#include "core/sequenced_envelope.hpp"

namespace seq {

enum class Side : std::uint8_t
{
    Buy = 0,
    Sell = 1,
};

struct OrderEvent
{
    std::uint32_t trader_id;
    Side side;
    double price;               // the price this order actually trades at
    double quantity;
    double true_price_at_send;  // the liquidity taker's own true-price computation
    std::int64_t send_timestamp_ns;
};

static_assert(sizeof(OrderEvent) <= kMaxPayloadBytes, "OrderEvent must fit in the sequencer's envelope payload");

} // namespace seq
