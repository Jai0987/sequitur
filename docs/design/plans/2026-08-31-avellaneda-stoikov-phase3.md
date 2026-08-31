# Avellaneda-Stoikov Phase 3 Implementation Plan

**Goal:** A market maker that quotes from the AS closed-form formulas
instead of a fixed spread, backtested against the phase 1 baseline on
identical order flow.

**Spec:** `docs/design/specs/2026-08-31-avellaneda-stoikov-phase3-design.md`

## Global constraints

- Every shared parameter (seed, simulation epoch, `A`, `k`, now also
  `horizonSeconds`) must be identical across every process in one run,
  same as established in phase 1/2.
- Liquidity takers trade at the market maker's actual published bid/ask,
  not a self-computed price -- this is a real behavior change from phase 1.
- The existing `validate_fill_log.py` must pass unchanged on both market
  makers' output.

---

## Task 1: Quote message type, and the phase 1 market maker publishes one

**Files:**
- Create: `include/simulation/quote.hpp`
- Modify: `src/simulation/market_maker/main.cpp`
- Modify: `CMakeLists.txt` (no new target, `market_maker`'s existing entry is fine)

**Quote type:**

```cpp
// include/simulation/quote.hpp
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
```

**`market_maker` changes:** new CLI shape
`<orderChannel> <orderStreamId> <fillLogPath> <quoteChannel> <quoteStreamId> <simEpochSeconds> <seed> <sigma> <s0> <delta>`.
It gains a second Aeron `Publication` (for quotes) and an
`IncrementalPricePath` (same as `liquidity_taker`'s). In the existing
poll loop, before each `subscription->poll(...)` call, check if 100ms
has elapsed since the last quote publish; if so, compute
`true_price = price_path.price_at(elapsed_ns)`,
`bid = true_price - delta`, `ask = true_price + delta`, and `offer()` a
`Quote`. Unlike order fills, a dropped or unread quote is fine to ignore
-- only the latest one matters, so no retry-on-`BACK_PRESSURED` loop is
needed here, unlike everywhere else in this project. Fill log output
format is unchanged.

**Test:** rebuild, run the full phase 1 pipeline with the new CLI shape
(driver, sequencer, this market maker, one plain subscriber temporarily
standing in for a quote listener on the new stream to confirm `Quote`
messages actually arrive), confirm the fill log still validates with the
existing script.

**Commit:** only when asked, per this project's standing rule.

---

## Task 2: Liquidity takers react to live quotes instead of a fixed delta

**Files:**
- Modify: `src/simulation/liquidity_taker/main.cpp`

**Interfaces:**
- Consumes: `seq::Quote` (Task 1), `seq::IncrementalPricePath` (already used).
- Produces: `seq::OrderEvent` with `price` now taken directly from the
  latest known bid/ask, not computed from a local delta.

**New CLI shape:**
`<orderChannel> <orderStreamId> <traderId> <quoteChannel> <quoteStreamId> <simEpochSeconds> <seed> <sigma> <s0> <A> <k> [durationSeconds]`
-- `delta` is gone; `A` and `k` remain, since the intensity formula is
still `lambda(delta) = A * exp(-k * delta)`, just evaluated against
whatever delta the current quote implies rather than a constant.

**Logic change:** add a `Subscription` to the quote stream. Wait for at
least one `Quote` to arrive before trading (same
wait-before-acting pattern used everywhere else in this project -- don't
guess at a price with no data). Track `next_buy_ns` and `next_sell_ns` as
absolute deadlines. Each loop iteration: poll the quote subscription
(non-blocking) to update the latest bid/ask; compute
`true_price = price_path.price_at(elapsed_ns)`,
`delta_bid = true_price - latest_bid`, `delta_ask = latest_ask - true_price`;
if `now >= next_buy_ns`, send a BUY at `price = latest_ask`, then redraw
`next_buy_ns = now + Exponential(A * exp(-k * delta_ask))`; symmetrically
for sell against `latest_bid`. This is a standard practical approximation
of a time-varying-rate Poisson process (redraw the exponential gap using
the current rate each time a side fires) -- worth a comment noting it's
an approximation, not an exact simulation of a non-homogeneous process.

**Test:** run against Task 1's updated (fixed-delta) market maker. Since
that market maker publishes a *constant* quote, this should reproduce
statistically the same behavior as phase 1/2's fixed-delta runs --
rerun the phase 2 arrival-process analysis against this new fill log and
confirm it still looks Poisson at the same rate, as a regression check
that this rewrite didn't silently change the arrival dynamics.

---

## Task 3: The actual Avellaneda-Stoikov market maker

**Files:**
- Create: `src/simulation/optimal_market_maker/main.cpp`
- Modify: `CMakeLists.txt`: `add_aeron_executable(optimal_market_maker simulation/optimal_market_maker)`

**Interfaces:**
- Consumes: `seq::SequencedEnvelope`, `seq::OrderEvent` (order stream, same
  as `market_maker`), `seq::IncrementalPricePath`, publishes `seq::Quote`.
- Produces: the same fill log CSV format as `market_maker`, so
  `validate_fill_log.py` and the Task 4 comparison script both work on
  either binary's output unchanged.

**New CLI:**
`<orderChannel> <orderStreamId> <fillLogPath> <quoteChannel> <quoteStreamId> <simEpochSeconds> <seed> <sigma> <s0> <gamma> <k> <horizonSeconds>`

**Logic:** same skeleton as Task 1's updated `market_maker` (own price
path, 100ms quote-publish tick, poll loop for incoming orders, same fill
log columns and inventory tracking), except the quote computation is:

```cpp
double elapsed_s = static_cast<double>(elapsed_ns) / 1e9;
double time_remaining = std::max(0.0, horizon_seconds - elapsed_s);
double reservation = true_price - inventory * gamma * sigma * sigma * time_remaining;
double spread = gamma * sigma * sigma * time_remaining
    + (2.0 / gamma) * std::log(1.0 + gamma / k);
double bid = reservation - spread / 2.0;
double ask = reservation + spread / 2.0;
```

`inventory` is the same running double this binary already tracks from
fills, exactly like `market_maker`. Note `k` here must be the identical
value passed to the liquidity takers' `A`/`k` -- it is the same intensity
decay parameter in both places, not two different constants that happen
to share a name.

**Test:** run the full pipeline (driver, sequencer, this market maker,
two liquidity takers from Task 2) with a real `horizonSeconds` (e.g. 300,
matching the run's actual duration). Confirm by inspection: quotes narrow
as `time_remaining` shrinks toward the end of the run, and the
reservation price visibly shifts away from `true_price` when inventory is
large in either direction. Validate the fill log with the existing script.

---

## Task 4: Backtest comparison

**Files:**
- Create: `analysis/compare_market_makers.py`

**Interfaces:**
- Consumes: two fill log CSVs, one from `market_maker` (Task 1), one from
  `optimal_market_maker` (Task 3), from runs sharing identical seed,
  epoch, `A`, `k`, and duration.

```python
#!/usr/bin/env python3
"""Compare a fixed-delta market maker's run against an Avellaneda-Stoikov
market maker's run on the same order flow: final inventory, how much
inventory risk each carried over the run, and realized spread P&L."""
import sys
import pandas as pd


def summarize(path: str) -> dict:
    df = pd.read_csv(path)
    signed_pnl = (df["price"] - df["true_price_at_trade"]) * df["quantity"].where(
        df["side"] == "SELL", -df["quantity"]
    )
    return {
        "fills": len(df),
        "final_inventory": df["inventory_after"].iloc[-1],
        "inventory_std": df["inventory_after"].std(),
        "max_abs_inventory": df["inventory_after"].abs().max(),
        "realized_pnl": signed_pnl.sum(),
    }


def main(baseline_path: str, optimal_path: str) -> int:
    baseline = summarize(baseline_path)
    optimal = summarize(optimal_path)

    print(f"{'metric':<20}{'fixed-delta':>15}{'avellaneda-stoikov':>22}")
    for key in ["fills", "final_inventory", "inventory_std", "max_abs_inventory", "realized_pnl"]:
        print(f"{key:<20}{baseline[key]:>15.3f}{optimal[key]:>22.3f}")

    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <baseline_fills.csv> <optimal_fills.csv>")
        sys.exit(1)
    sys.exit(main(sys.argv[1], sys.argv[2]))
```

**Test:** run against the two fill logs from Tasks 1-3 and read the
result -- this IS the phase 3 finding, not a correctness check on
something else, so there's no separate pass/fail here beyond confirming
the script runs and the numbers are sane (e.g. `fills` counts roughly
matching each run's own reported total).

## Self-review notes

- Spec coverage: quote message/stream (Task 1), liquidity taker rewrite
  (Task 2), AS formulas (Task 3), comparison (Task 4) -- all sections
  covered.
- The realized P&L sign convention: `(price - true_price_at_trade)` is
  positive when the maker sold above true price or bought below it --
  the sign flip via `quantity.where(side == SELL, -quantity)` handles
  both directions consistently with the existing inventory sign
  convention in `market_maker`/`optimal_market_maker`.
