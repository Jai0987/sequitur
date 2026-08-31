# Market-Making Simulator — Phase 1: Simulator & Data Generation

## Context and motivation

This is phase 1 of a larger research project: recalibrate the classical
Avellaneda-Stoikov (2008) market-making model to empirically measured fill
dynamics from a real low-latency event-sequencing system (the Aeron-based
sequencer already built in this repo), rather than assuming the idealized
Poisson order-arrival process the textbook model assumes.

Full project phase breakdown, for context (only phase 1 is scoped by this
document):

1. **Market simulator** (this spec) — synthetic order flow and a fixed-quote
   market maker, routed through the real sequencer, producing a recorded
   fill log.
2. Measure the empirical fill-arrival distribution from phase 1's output and
   compare it against the textbook Poisson assumption.
3. Implement Avellaneda-Stoikov with the textbook Poisson-calibrated
   intensity function, solve for optimal quotes, backtest against phase 1's
   simulator.
4. Recalibrate the intensity function to the empirical distribution from
   phase 2, resolve for optimal quotes, backtest again, and compare phase 3
   vs. phase 4 performance.
5. (Stretch, separate) Kyle's lambda ground-truth validation study, reusing
   the simulator's informed/noise-trader labels (not modeled in phase 1).

## Goals for phase 1

- Extend the existing sequencer infrastructure (`src/producer`,
  `src/sequencer`, `src/consumer`) into a small market simulation: liquidity
  takers submitting orders, a single fixed-spread ("dumb") market maker
  consuming them, all routed through the real Aeron pipeline so fill timing
  reflects genuine system behavior (queueing, backlog under load) rather
  than an idealized random-number generator.
- Produce a reproducible, recorded fill log suitable for phase 2's
  statistical analysis in Python.

## Non-goals for phase 1

- No optimal/Avellaneda-Stoikov quoting logic yet — the market maker quotes
  a fixed distance from the true price for the whole run.
- No full limit order book or multi-maker matching — a single market maker,
  direct fills against its implied quote.
- No statistics, regression, or model fitting — that is phase 2, in Python.
- No informed-vs-noise trader distinction yet — deferred to the phase 5
  stretch goal.

## Design

### True price process

- Arithmetic Brownian motion: `S(t + dt) = S(t) + sigma * sqrt(dt) * Z`,
  `Z ~ N(0, 1)` — the same simple process the original Avellaneda-Stoikov
  paper assumes.
- Deterministic given `(seed, sigma, S0, elapsed simulation time)`. It is
  **not** transmitted as Aeron messages — every process that needs it
  (liquidity takers, market maker) computes it independently from the same
  seed and config, via a pure function `price_at(seed, sigma, s0,
  elapsed_ns)` in a small shared header. This keeps runs reproducible and
  avoids an extra message stream for something that is pure computation.

### Liquidity takers

- Extends `src/producer` into `src/liquidity_taker`.
- Two independent Poisson arrival streams per process instance: one for
  "sell into the market maker's bid," one for "buy from the market maker's
  ask." Each stream's rate is `lambda(delta) = A * exp(-k * delta)`, with
  `delta` a fixed configuration parameter for phase 1 (so each stream is a
  simple homogeneous Poisson process with a constant rate for the duration
  of a run).
- On each arrival: compute the current true price, compute the implied
  market-maker quote (`true_price +/- delta`), and submit an `OrderEvent`
  (trader_id, side, price, quantity, true_price_at_send,
  send_timestamp_ns) on the inbound stream.
- Multiple liquidity-taker processes can run concurrently, as in the
  existing two-producer demo, representing independent participants.

### Sequencer

- Reused from the existing implementation. Generalized to carry an
  arbitrary fixed-size payload (the `OrderEvent`) instead of being
  hardcoded to the placeholder `ProducerMessage`/`SequencedMessage` types
  used for the earlier teaching demo. The sequencing mechanism itself
  (single-writer global counter, round-robin fair polling across producer
  images, wait-for-downstream-consumer-before-accepting-input) is
  unchanged.
- The existing demo binaries (`producer`, `sequencer`, `consumer`) are kept
  as-is for their teaching value; the market-simulation pieces are new
  binaries alongside them, not replacements.

### Market maker

- Extends `src/consumer` into `src/market_maker`.
- Fixed `delta`; quotes are `true_price(t) +/- delta`, computed
  continuously as a pure function of time — never separately "posted" as a
  message.
- Consumes the sequenced order stream. Every order that arrives is treated
  as trading against the market maker's implied quote at that instant
  (immediate fill; no rejection logic is modeled in phase 1, since there is
  only one maker and no competing liquidity). Updates a running inventory
  and appends one row per fill to a CSV log file.
- Fill log columns: `global_sequence, timestamp_ns, side, price, quantity,
  true_price_at_trade, delta, inventory_after`.

### Configuration

Passed via CLI arguments, consistent with the existing binaries' style:
seed, sigma (price volatility), S0 (starting price), delta (fixed quote
distance), A and k (intensity function parameters), simulation duration or
total order count, number of liquidity-taker processes.

## Data flow

```
liquidity takers --(orders, Aeron)--> sequencer --(sequenced orders, Aeron)--> market maker --(fill log)--> CSV file
```

The CSV file is the boundary between phase 1 (C++) and phase 2 (Python) —
deliberately a plain, dependency-free format both sides can read without a
shared schema library.

## Error handling

Same patterns as the existing sequencer/producer/consumer code: retry on
`BACK_PRESSURED`/`ADMIN_ACTION` rather than dropping, wait for a downstream
consumer to connect before accepting input (already implemented in the
sequencer), no silent message drops.

## Testing and validation

This is a research tool, not production code — the correctness bar is
"trustworthy enough to build statistics on," not full test coverage. After
a run:

- The fill log's running inventory must be internally consistent (the
  cumulative sum of signed fill quantities must match the recorded
  `inventory_after` column).
- `global_sequence` must have no gaps.
- The empirical arrival rate should roughly match the configured `lambda`
  (sanity check, not a strict pass/fail unit test).

## Open questions for the implementation plan

- Exact CLI argument shapes for the new binaries (`liquidity_taker`,
  `market_maker`), following the existing style established by
  `producer`/`sequencer`/`consumer`.
- Confirm generalizing the sequencer in place (rather than forking a
  second copy) does not break the existing two-producer demo binaries,
  which are being kept for their teaching value.
