#pragma once

#include <cstdint>

namespace seq {

struct Quote
{
    double bid;
    double ask;
    std::int64_t timestamp_ns;
};

} // namespace seq
