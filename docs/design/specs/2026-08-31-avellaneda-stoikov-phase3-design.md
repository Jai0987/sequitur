# Phase 3: Avellaneda-Stoikov Market Maker and Backtest

## Context

Phase 1 built a market simulator with a fixed-quote market maker: it always
quotes `true_price +/- delta` for a constant `delta`, regardless of its own
inventory or how much of the trading session remains. Phase 2 confirmed
that, at a moderate order-arrival rate, the resulting fill process is
statistically indistinguishable from the Poisson process the classical
Avellaneda-Stoikov (2008) model assumes.

This phase implements that model for real: a market maker that computes
its quotes from its own inventory, the time remaining in the trading
session, and its risk aversion, using the paper's closed-form
approximation. It then backtests this against the fixed-delta baseline
from phase 1, using identical order flow, to see whether adapting quotes
this way actually changes the outcome.

## Goals

- Implement the Avellaneda-Stoikov reservation price and optimal spread
  formulas as a new market maker binary.
- Give liquidity takers a way to see and react to a market maker's live,
  changing quotes, since the fixed-delta simplification from phase 1 no
  longer holds once quotes move.
- Run the same liquidity taker order flow against both the phase 1
  (fixed-delta) and phase 3 (optimal) market makers and compare the
  resulting inventory and P&L outcomes.

## Non-goals

- No numerical solution of the full Hamilton-Jacobi-Bellman equation --
  this phase uses the paper's own closed-form approximation, not a
  from-scratch PDE solver.
- No change to how orders get sequenced or matched -- the sequencer and
  the single-fill-per-order matching model from phase 1 are unchanged.
- No treatment of adverse selection or informed traders -- liquidity
  takers remain undifferentiated noise traders, same as phase 1 and 2.

## Design

### A shared trading horizon

Every process in a run now needs to agree on when the session ends, since
the AS spread formula depends on time remaining. This is a new required
parameter, `horizonSeconds`, passed the same way the shared epoch and seed
already are: identically, on every process's command line.

### Quote message and stream

A new message type, `Quote`, carries `bid`, `ask`, and the timestamp it
was computed at. The optimal market maker publishes one every time its
quotes change materially (see below), on a new outbound stream separate
from the sequenced order/fill stream. Liquidity takers subscribe to it
and keep the most recently seen bid and ask.

### The optimal market maker

Extends the phase 1 `market_maker` pattern into a new binary,
`optimal_market_maker`. Unlike the phase 1 version, it needs to know the
current true price continuously, not just when an order arrives, so it
carries its own `IncrementalPricePath` (same seed, sigma, s0, shared
epoch as the liquidity takers -- the same mechanism that already lets
independent processes agree on one price path).

On a fixed tick interval (100ms), it:

1. Computes the current true price from its own price path.
2. Computes time remaining: `horizonSeconds - elapsed_seconds`.
3. Computes reservation price: `r = s - q * gamma * sigma^2 * (T - t)`.
4. Computes optimal spread: `gamma * sigma^2 * (T - t) + (2 / gamma) * ln(1 + gamma / k)`.
5. Publishes `bid = r - spread/2`, `ask = r + spread/2` as a `Quote`.

It still consumes the sequenced order stream exactly as phase 1's market
maker does, updating inventory and logging fills to CSV with the same
columns, so the existing validation script works unchanged on its output.

`gamma` (risk aversion) and `k` (the same intensity decay parameter
liquidity takers already use for their arrival rate) are new required
parameters, matched across every process in a run the same way seed
already has to be.

### Liquidity takers: reacting to a live quote instead of a fixed one

Liquidity takers gain a subscription to the market maker's quote stream
and track the latest bid and ask. Instead of a single fixed `delta`
passed on the command line, each liquidity taker now computes its own
current `delta_bid = true_price - bid` and `delta_ask = ask - true_price`
from whatever the latest published quote is, and uses `lambda(delta) = A
* exp(-k * delta)` on each side to decide when its next order arrives, the
same intensity formula as before, just evaluated against a moving target
instead of a constant.

Before the first quote arrives, a liquidity taker waits (same
wait-for-downstream-connection pattern already used everywhere else in
this project) rather than guessing.

Running a liquidity taker against the *fixed-delta* market maker from
phase 1 still works with this same binary: phase 1's `market_maker` gets
a small addition so it also publishes a (constant) `Quote` every tick,
purely so liquidity takers have one consistent way to learn the current
quote regardless of which market maker they are trading against. This
keeps phase 1's binary meaningfully unchanged (same core logic, same fill
log columns) while making the comparison in this phase apples-to-apples:
identical liquidity taker code, only the market maker differs.

### The comparison

A run consists of: the sequencer, one market maker (either binary), and
two liquidity takers, with every shared parameter (seed, epoch, `A`, `k`,
`horizonSeconds`) identical between the two runs being compared. Each
produces its own fill log. A comparison script reads both, and reports,
per run: final inventory, inventory variance over the run (a proxy for
how much risk the maker carried), and a simple realized P&L: the sum of
`(trade price - true price at trade) * signed quantity` across all fills,
which is exactly the spread captured, positive when the maker's quotes
were, on net, favorably placed relative to the true price.

## Testing and validation

Same standard as phase 1 and 2: this is a research tool, not production
code. After a run: the existing `validate_fill_log.py` must still pass on
both market makers' fill logs unchanged. The comparison script's P&L
figure should be cross-checked by hand against a handful of individual
fills before trusting it across a full run.

## Open questions for the implementation plan

- Whether the 100ms quote-publish tick is frequent enough relative to the
  arrival rates used in phase 2 (roughly one fill every 100-150ms at the
  rates already validated) -- the plan should confirm this against the
  actual numbers rather than assume it.
- Exact CLI argument shapes for `optimal_market_maker` and the updated
  `liquidity_taker`, following the existing style.
