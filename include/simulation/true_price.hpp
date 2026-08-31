#pragma once

#include <cmath>
#include <cstdint>
#include <random>

namespace seq {

// Deterministic arithmetic Brownian motion: S(t + dt) = S(t) + sigma *
// sqrt(dt) * Z. This is a PURE function of (seed, sigma, s0, elapsed_ns) --
// each 1ms tick's random step is derived from a hash of (seed, tick
// index), not from any prior call's state, so calling this repeatedly
// with the same inputs always gives the same answer, and two different
// processes with the same seed agree on the price at the same elapsed_ns
// without exchanging any messages.
//
// elapsed_ns MUST be measured from a reference point shared across every
// process in a given simulation run (e.g. wall-clock time since an
// agreed Unix-epoch timestamp passed on every process's command line) --
// NOT from steady_clock, whose epoch is unspecified and not comparable
// across independently-started processes.
//
// Performance note: this is O(elapsed_ns / 1ms) per call, since it sums
// every tick's step from the start. That's fine for the short (tens of
// seconds), interactive runs this project uses -- it is not intended to
// scale to long-running simulations without switching to a cached or
// incremental approach.
inline double price_at(std::uint64_t seed, double sigma, double s0, std::int64_t elapsed_ns)
{
    constexpr std::int64_t kTickNs = 1'000'000; // 1ms ticks
    if (elapsed_ns <= 0)
    {
        return s0;
    }

    const std::int64_t num_ticks = elapsed_ns / kTickNs;
    const double dt_seconds = static_cast<double>(kTickNs) / 1e9;
    const double step_stddev = sigma * std::sqrt(dt_seconds);

    double price = s0;
    for (std::int64_t i = 0; i < num_ticks; ++i)
    {
        const std::uint64_t tick_seed = seed ^ (static_cast<std::uint64_t>(i) * 0x9E3779B97F4A7C15ULL);
        std::mt19937_64 rng(tick_seed);
        std::normal_distribution<double> normal(0.0, 1.0);
        price += step_stddev * normal(rng);
    }

    return price;
}

} // namespace seq
