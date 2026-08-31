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
// every tick's step from the start. Measured effect: in a liquidity taker
// that calls this once per order over a multi-minute run, the growing cost
// of this call became a real, measured tax on the arrival process itself
// -- later orders were delayed more than earlier ones purely by this
// function getting slower, which is confounded with anything we actually
// want to measure about the system. Use IncrementalPricePath below for
// any run longer than a few seconds; this function stays as the reference
// implementation IncrementalPricePath is checked against.
constexpr std::int64_t kPriceTickNs = 1'000'000; // 1ms ticks

inline double price_step(std::uint64_t seed, std::int64_t tick_index, double step_stddev)
{
    const std::uint64_t tick_seed = seed ^ (static_cast<std::uint64_t>(tick_index) * 0x9E3779B97F4A7C15ULL);
    std::mt19937_64 rng(tick_seed);
    std::normal_distribution<double> normal(0.0, 1.0);
    return step_stddev * normal(rng);
}

inline double price_at(std::uint64_t seed, double sigma, double s0, std::int64_t elapsed_ns)
{
    if (elapsed_ns <= 0)
    {
        return s0;
    }

    const std::int64_t num_ticks = elapsed_ns / kPriceTickNs;
    const double dt_seconds = static_cast<double>(kPriceTickNs) / 1e9;
    const double step_stddev = sigma * std::sqrt(dt_seconds);

    double price = s0;
    for (std::int64_t i = 0; i < num_ticks; ++i)
    {
        price += price_step(seed, i, step_stddev);
    }

    return price;
}

// Amortized version of the same computation: each instance remembers how
// many ticks it has already summed, so a call only pays for ticks new
// since the previous call on the SAME instance -- O(1) amortized for the
// monotonically-increasing elapsed_ns sequence a single process naturally
// produces. Gives bit-identical results to price_at for the same inputs,
// since it is the same per-tick math, just not recomputed from zero every
// time. Not shared across processes -- each process keeps its own cache,
// which is fine, since the underlying math is still the same pure function
// of (seed, tick index) that made cross-process agreement work in the
// first place.
class IncrementalPricePath
{
public:
    IncrementalPricePath(std::uint64_t seed, double sigma, double s0) :
        seed_(seed),
        step_stddev_(sigma * std::sqrt(static_cast<double>(kPriceTickNs) / 1e9)),
        last_tick_(0),
        price_(s0)
    {
    }

    double price_at(std::int64_t elapsed_ns)
    {
        if (elapsed_ns <= 0)
        {
            return price_;
        }

        const std::int64_t target_tick = elapsed_ns / kPriceTickNs;
        for (std::int64_t i = last_tick_; i < target_tick; ++i)
        {
            price_ += price_step(seed_, i, step_stddev_);
        }
        last_tick_ = target_tick;
        return price_;
    }

private:
    std::uint64_t seed_;
    double step_stddev_;
    std::int64_t last_tick_;
    double price_;
};

} // namespace seq
