# Market-Maker Simulator Phase 1 Implementation Plan

**Goal:** Extend the existing Aeron sequencer demo into a small market
simulation — liquidity takers submitting orders, a fixed-quote market maker
consuming them — producing a reproducible fill log for phase 2's
statistical analysis in Python.

**Architecture:** New `liquidity_taker` and `market_maker` binaries reuse
the existing `sequencer` binary, generalized to carry an arbitrary payload
instead of the old demo's specific message types. A deterministic,
shared-reference true-price function lets independently-started processes
agree on the same synthetic fair value at the same real-world instant
without needing a separate price-feed message stream.

**Tech Stack:** C++17, Aeron 1.52.2 (already vendored in
`third_party/aeron`), CMake. Fill log is plain CSV, consumed later by
Python/pandas (not part of this plan).

**Spec:** `docs/design/specs/2026-08-30-market-maker-simulator-phase1-design.md`

## Global Constraints

- Aeron version: 1.52.2 (pinned submodule at `third_party/aeron`) — do not
  change the pinned version.
- C++ standard: C++17 (set in top-level `CMakeLists.txt`).
- New executables follow the existing style: plain `argc`/`argv` parsing
  with a usage message on `argc` mismatch, `SIGINT` sets an
  `std::atomic<bool> running` flag checked in the main loop, no exceptions
  used for control flow.
- Never silently drop a message: retry `BACK_PRESSURED`/`ADMIN_ACTION`
  results from `offer()`; wait for a downstream consumer to be connected
  before a publishing process starts sending (existing pattern already in
  `src/producer/main.cpp` and `src/sequencer/main.cpp`).
- The existing demo binaries (`publisher`, `subscriber`, `producer`,
  `consumer`) must keep working after this plan — `sequencer` is
  generalized in place, `consumer` is updated to match, `producer` is
  untouched.

---

## Task 1: Generalize the sequencer to a payload-agnostic envelope

**Files:**
- Create: `include/sequenced_envelope.hpp`
- Modify: `src/sequencer/main.cpp`
- Modify: `src/consumer/main.cpp`
- Delete: `include/sequenced_message.hpp` (superseded by the envelope; no
  longer referenced by anything after this task)
- Modify: `CMakeLists.txt` (no new targets, but confirm `sequencer` and
  `consumer` still list `${CMAKE_SOURCE_DIR}/include` — they already do
  via `add_aeron_executable`, no change needed; verify only)

**Interfaces:**
- Produces: `seq::SequencedEnvelope` struct (`global_sequence`,
  `payload_size`, fixed `payload` byte array of `seq::kMaxPayloadBytes`
  bytes), `seq::set_payload(envelope, data, size)`,
  `seq::read_payload<T>(envelope)` — template that `memcpy`s the first
  `sizeof(T)` bytes of the payload into a `T`. Every later task that reads
  a sequenced stream uses these two free functions.
- Consumes: nothing new from earlier tasks — this generalizes existing
  code.

- [ ] **Step 1: Create the generic envelope header**

```cpp
// include/sequenced_envelope.hpp
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
```

- [ ] **Step 2: Rewrite the sequencer to be payload-agnostic**

Open `src/sequencer/main.cpp`. Replace the `#include "producer_message.hpp"`
and `#include "sequenced_message.hpp"` lines with
`#include "sequenced_envelope.hpp"`.

Replace the body of `on_message` (the lambda passed to `FragmentAssembler`)
so it no longer knows about `seq::ProducerMessage`/`seq::SequencedMessage`
at all — it just wraps whatever bytes arrived:

```cpp
    using OutBuffer = std::array<std::uint8_t, sizeof(seq::SequencedEnvelope)>;
    AERON_DECL_ALIGNED(OutBuffer out_buffer, 16);
    concurrent::AtomicBuffer out_atomic_buffer(out_buffer.data(), out_buffer.size());

    fragment_handler_t on_message = [&](const concurrent::AtomicBuffer &buffer, util::index_t offset, util::index_t length, const Header &)
    {
        seq::SequencedEnvelope envelope{};
        envelope.global_sequence = global_sequence;
        ++global_sequence;
        seq::set_payload(envelope, buffer.buffer() + offset, static_cast<std::size_t>(length));

        std::memcpy(out_buffer.data(), &envelope, sizeof(envelope));

        // Retry the offer on transient failure so we never silently drop a
        // message we've already assigned a sequence number to -- once
        // stamped, it must make it out.
        std::int64_t result;
        do
        {
            result = publication->offer(out_atomic_buffer, 0, sizeof(envelope));
        }
        while (running && result == BACK_PRESSURED);

        // Logging happens AFTER the message is on its way out, and the
        // sequencer no longer knows the payload's meaning -- it only
        // knows its size. Whatever consumes a given stream interprets
        // payload[0..payload_size) itself.
        std::cout << "global_seq=" << envelope.global_sequence
                  << " payload_size=" << envelope.payload_size << '\n';
    };
```

Everything else in `src/sequencer/main.cpp` (connection setup, the
downstream-consumer wait, the idle strategy, the poll loop) is unchanged.

- [ ] **Step 3: Update the consumer to unwrap the envelope**

Open `src/consumer/main.cpp`. Replace
`#include "sequenced_message.hpp"` with:

```cpp
#include "producer_message.hpp"
#include "sequenced_envelope.hpp"
```

Replace the body of `on_message` so it decodes the generic envelope, then
reinterprets its payload as the `seq::ProducerMessage` this demo has
always sent:

```cpp
    fragment_handler_t on_message = [&](const concurrent::AtomicBuffer &buffer, util::index_t offset, util::index_t length, const Header &)
    {
        seq::SequencedEnvelope envelope;
        std::memcpy(&envelope, buffer.buffer() + offset, sizeof(envelope));
        const seq::ProducerMessage inner = seq::read_payload<seq::ProducerMessage>(envelope);
        ++received;

        // The whole point of the sequencer: every consumer should see
        // global_sequence increase by exactly 1 every time, with no gaps
        // and no repeats -- regardless of which producer each message
        // originally came from.
        if (last_global_sequence.has_value() && envelope.global_sequence != *last_global_sequence + 1)
        {
            ++gaps_detected;
            std::cout << "[" << label << "] ORDERING PROBLEM: expected " << (*last_global_sequence + 1)
                      << " but got " << envelope.global_sequence << std::endl;
        }
        last_global_sequence = envelope.global_sequence;

        const std::int64_t now_ns = std::chrono::steady_clock::now().time_since_epoch().count();
        const std::int64_t latency_ns = now_ns - inner.send_timestamp_ns;

        std::cout << "[" << label << "] global_seq=" << envelope.global_sequence
                  << " producer=" << inner.producer_id
                  << " producer_local_seq=" << inner.local_sequence
                  << " end_to_end_latency=" << latency_ns << "ns\n";
    };
```

The rest of `src/consumer/main.cpp` (the `last_global_sequence` variable
declaration, connection setup, idle strategy, poll loop, final summary
print) is unchanged.

- [ ] **Step 4: Delete the now-unused header**

```bash
git rm include/sequenced_message.hpp
```

- [ ] **Step 5: Rebuild**

```bash
cmake --build build --parallel
```

Expected: clean build, no errors. If `sequenced_message.hpp` is still
referenced anywhere, the build will fail with a "file not found" error —
that means Step 2 or Step 3 missed a reference; search with
`grep -rn sequenced_message src/` and fix.

- [ ] **Step 6: Verify the existing two-producer demo still works**

This is the regression check for this task — same commands used earlier
in this project, now exercising the generalized sequencer/consumer:

1. Confirm the driver is running (`pgrep -fl aeronmd`; start it from
   `third_party/aeron/cmake-build/binaries/aeronmd` if not).
2. `./build/sequencer aeron:ipc 20 aeron:ipc 21`
3. `./build/consumer aeron:ipc 21 A`
4. `./build/producer aeron:ipc 1 20 20 5`
5. `./build/producer aeron:ipc 2 20 20 7`

Expected: identical behavior to before — the sequencer now prints
`global_seq=N payload_size=40` lines (no more `producer=`/`producer_local_seq=`
directly from the sequencer, since it's now payload-agnostic — that's an
expected, correct change), and the consumer still prints full
`producer=`/`producer_local_seq=`/`end_to_end_latency=` lines with zero
`ORDERING PROBLEM` messages.

- [ ] **Step 7: Commit**

```bash
git add include/sequenced_envelope.hpp src/sequencer/main.cpp src/consumer/main.cpp
git commit -m "$(cat <<'EOF'
Generalize sequencer to a payload-agnostic envelope

Lets the sequencer forward any fixed-size message type instead of being
hardcoded to the teaching demo's ProducerMessage/SequencedMessage types,
so the same sequencer binary can also carry the upcoming market
simulation's OrderEvent messages.
EOF
)"
```

---

## Task 2: Shared price process, order event type, and the liquidity taker

**Files:**
- Create: `include/true_price.hpp`
- Create: `include/order_event.hpp`
- Create: `src/liquidity_taker/main.cpp`
- Modify: `CMakeLists.txt` (add `add_aeron_executable(liquidity_taker)`)

**Interfaces:**
- Consumes: `seq::SequencedEnvelope`/`set_payload`/`read_payload` from
  Task 1 (not used directly by `liquidity_taker`, which only publishes —
  but `market_maker` in Task 3 will use `read_payload<seq::OrderEvent>`).
- Produces: `seq::price_at(seed, sigma, s0, elapsed_ns) -> double`;
  `seq::Side` enum (`Buy`, `Sell`); `seq::OrderEvent` struct (`trader_id`,
  `side`, `price`, `quantity`, `true_price_at_send`,
  `send_timestamp_ns`) — Task 3's `market_maker` reads this exact struct
  out of the envelope payload.

- [ ] **Step 1: Create the deterministic price process header**

```cpp
// include/true_price.hpp
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
```

- [ ] **Step 2: Create the order event message type**

```cpp
// include/order_event.hpp
#pragma once

#include <cstdint>

#include "sequenced_envelope.hpp"

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
```

- [ ] **Step 3: Create the liquidity taker**

```cpp
// src/liquidity_taker/main.cpp
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <random>
#include <thread>

#include "Aeron.h"
#include "order_event.hpp"
#include "true_price.hpp"

using namespace aeron;

namespace {

std::atomic<bool> running{true};

void on_sigint(int)
{
    running = false;
}

} // namespace

int main(int argc, char **argv)
{
    if (argc < 11)
    {
        std::cerr << "Usage: " << argv[0]
                  << " <channel> <streamId> <traderId> <simEpochSeconds> <seed> <sigma> <s0> <delta> <A> <k> [durationSeconds]\n"
                  << "  simEpochSeconds: same value passed to every liquidity_taker in this run (e.g. `date +%s`)\n"
                  << "  e.g. " << argv[0] << " aeron:ipc 30 1 1798650000 42 0.5 100.0 0.05 10.0 20.0 30\n";
        return 1;
    }

    const std::string channel = argv[1];
    const std::int32_t stream_id = std::stoi(argv[2]);
    const std::uint32_t trader_id = static_cast<std::uint32_t>(std::stoul(argv[3]));
    const std::int64_t sim_epoch_ns = std::stoll(argv[4]) * 1'000'000'000LL;
    const std::uint64_t seed = std::stoull(argv[5]);
    const double sigma = std::stod(argv[6]);
    const double s0 = std::stod(argv[7]);
    const double delta = std::stod(argv[8]);
    const double A = std::stod(argv[9]);
    const double k = std::stod(argv[10]);
    const double duration_seconds = argc > 11 ? std::stod(argv[11]) : 30.0;

    const double lambda = A * std::exp(-k * delta);
    if (lambda <= 0.0)
    {
        std::cerr << "Computed arrival rate lambda=" << lambda << " is not positive; check A/k/delta.\n";
        return 1;
    }

    std::signal(SIGINT, on_sigint);

    aeron::Context context;
    std::shared_ptr<Aeron> aeron = Aeron::connect(context);

    const std::int64_t id = aeron->addPublication(channel, stream_id);
    std::shared_ptr<Publication> publication = aeron->findPublication(id);
    while (!publication)
    {
        std::this_thread::yield();
        publication = aeron->findPublication(id);
    }

    std::cout << "Liquidity taker " << trader_id << " on " << channel << " stream " << stream_id
              << " -- lambda=" << lambda << "/sec, waiting for downstream..." << std::endl;
    while (running && !publication->isConnected())
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    if (!running)
    {
        return 0;
    }
    std::cout << "Liquidity taker " << trader_id << " is live." << std::endl;

    std::mt19937_64 rng(seed ^ (static_cast<std::uint64_t>(trader_id) << 32));
    std::exponential_distribution<double> gap_seconds(lambda);
    std::bernoulli_distribution side_coin(0.5);

    using MessageBuffer = std::array<std::uint8_t, sizeof(seq::OrderEvent)>;
    AERON_DECL_ALIGNED(MessageBuffer buffer, 16);
    concurrent::AtomicBuffer src_buffer(buffer.data(), buffer.size());

    std::uint64_t sent = 0;

    while (running)
    {
        const double gap = gap_seconds(rng);
        std::this_thread::sleep_for(std::chrono::duration<double>(gap));

        const std::int64_t wall_now_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        const std::int64_t elapsed_ns = wall_now_ns - sim_epoch_ns;
        if (elapsed_ns > static_cast<std::int64_t>(duration_seconds * 1e9))
        {
            break;
        }

        const double true_price = seq::price_at(seed, sigma, s0, elapsed_ns);
        const seq::Side side = side_coin(rng) ? seq::Side::Buy : seq::Side::Sell;
        const double trade_price = side == seq::Side::Buy ? true_price + delta : true_price - delta;

        seq::OrderEvent order{
            trader_id,
            side,
            trade_price,
            1.0, // fixed lot size for phase 1
            true_price,
            std::chrono::steady_clock::now().time_since_epoch().count()};
        std::memcpy(buffer.data(), &order, sizeof(order));

        std::int64_t result;
        do
        {
            result = publication->offer(src_buffer, 0, sizeof(order));
        }
        while (running && result == BACK_PRESSURED);

        if (result >= 0)
        {
            ++sent;
            std::cout << "trader=" << trader_id
                      << " side=" << (side == seq::Side::Buy ? "BUY" : "SELL")
                      << " true_price=" << true_price
                      << " trade_price=" << trade_price << '\n';
        }
    }

    std::cout << "Liquidity taker " << trader_id << " done. Sent " << sent << " orders." << std::endl;
    return 0;
}
```

- [ ] **Step 4: Wire up the new binary in CMake**

Open `CMakeLists.txt`. After the existing `add_aeron_executable(consumer)`
line, add:

```cmake
add_aeron_executable(liquidity_taker)
```

- [ ] **Step 5: Build**

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
```

Expected: clean build (re-running `cmake -S . -B build` is necessary
because a new target was added, same as when the earlier
producer/sequencer/consumer demo added targets).

- [ ] **Step 6: Verify true-price determinism and order generation**

Since `market_maker` doesn't exist until Task 3, use the existing generic
`subscriber` binary purely as a connectivity plug (it will print garbled
numeric fields since it doesn't know about `OrderEvent`'s layout — that's
expected and fine; the actual thing being checked here is (a) that
liquidity takers agree on the same true price at the same real time, and
(b) that messages are actually delivered).

1. Confirm the driver is running.
2. Get a shared epoch: `date +%s` — call this value `EPOCH` below.
3. Terminal — connectivity plug: `./build/subscriber aeron:ipc 30`
4. Terminal — liquidity taker 1: `./build/liquidity_taker aeron:ipc 30 1 EPOCH 42 0.5 100.0 0.05 10.0 20.0 15`
5. Terminal — liquidity taker 2 (same `EPOCH`, different `traderId`):
   `./build/liquidity_taker aeron:ipc 30 2 EPOCH 42 0.5 100.0 0.05 10.0 20.0 15`

Expected: both liquidity takers print `true_price=` values that are close
to each other whenever their printed lines land at nearly the same
real-world moment (they won't be at the exact same instant, since arrivals
are random, but the `true_price` values should clearly be tracking one
shared underlying path around 100.0, not two unrelated random walks). The
`subscriber`'s final Ctrl+C summary should report a message count matching
the combined total both liquidity takers say they sent.

- [ ] **Step 7: Commit**

```bash
git add include/true_price.hpp include/order_event.hpp src/liquidity_taker/main.cpp CMakeLists.txt
git commit -m "$(cat <<'EOF'
Add deterministic true-price process and liquidity taker

Liquidity takers independently compute the same synthetic fair-value
path (given a shared seed and simulation epoch) and submit buy/sell
orders as a Poisson process whose rate follows the classical
Avellaneda-Stoikov intensity function at a fixed quote distance.
EOF
)"
```

---

## Task 3: Market maker and the fill log

**Files:**
- Create: `src/market_maker/main.cpp`
- Modify: `CMakeLists.txt` (add `add_aeron_executable(market_maker)`)

**Interfaces:**
- Consumes: `seq::SequencedEnvelope`, `seq::read_payload<T>` (Task 1);
  `seq::OrderEvent`, `seq::Side` (Task 2).
- Produces: a CSV fill log at a path given on the command line, columns
  `global_sequence,timestamp_ns,side,price,quantity,true_price_at_trade,delta,inventory_after`
  — this file is what phase 2 (not part of this plan) reads.

- [ ] **Step 1: Create the market maker**

```cpp
// src/market_maker/main.cpp
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <thread>

#include "Aeron.h"
#include "FragmentAssembler.h"
#include "concurrent/BusySpinIdleStrategy.h"
#include "order_event.hpp"
#include "sequenced_envelope.hpp"

using namespace aeron;

namespace {

std::atomic<bool> running{true};

void on_sigint(int)
{
    running = false;
}

} // namespace

int main(int argc, char **argv)
{
    if (argc < 4)
    {
        std::cerr << "Usage: " << argv[0] << " <channel> <streamId> <fillLogPath>\n"
                  << "  e.g. " << argv[0] << " aeron:ipc 31 fills.csv\n";
        return 1;
    }

    const std::string channel = argv[1];
    const std::int32_t stream_id = std::stoi(argv[2]);
    const std::string fill_log_path = argv[3];

    std::signal(SIGINT, on_sigint);

    std::ofstream fill_log(fill_log_path);
    fill_log << "global_sequence,timestamp_ns,side,price,quantity,true_price_at_trade,delta,inventory_after\n";

    double inventory = 0.0;
    std::uint64_t received = 0;

    fragment_handler_t on_message = [&](const concurrent::AtomicBuffer &buffer, util::index_t offset, util::index_t length, const Header &)
    {
        seq::SequencedEnvelope envelope;
        std::memcpy(&envelope, buffer.buffer() + offset, sizeof(envelope));
        const seq::OrderEvent order = seq::read_payload<seq::OrderEvent>(envelope);
        ++received;

        // A liquidity taker buying takes from our ask, so our inventory
        // goes down; them selling means our inventory goes up.
        const double signed_quantity = order.side == seq::Side::Buy ? order.quantity : -order.quantity;
        inventory -= signed_quantity;

        const double delta_at_trade = std::abs(order.price - order.true_price_at_send);
        const std::int64_t now_ns = std::chrono::steady_clock::now().time_since_epoch().count();

        fill_log << envelope.global_sequence << ','
                  << now_ns << ','
                  << (order.side == seq::Side::Buy ? "BUY" : "SELL") << ','
                  << order.price << ','
                  << order.quantity << ','
                  << order.true_price_at_send << ','
                  << delta_at_trade << ','
                  << inventory << '\n';

        if (received % 50 == 0)
        {
            fill_log.flush();
            std::cout << "received " << received << " fills, inventory=" << inventory << '\n';
        }
    };

    aeron::Context context;
    std::shared_ptr<Aeron> aeron = Aeron::connect(context);

    const std::int64_t id = aeron->addSubscription(channel, stream_id);
    std::shared_ptr<Subscription> subscription = aeron->findSubscription(id);
    while (!subscription)
    {
        std::this_thread::yield();
        subscription = aeron->findSubscription(id);
    }

    std::cout << "Market maker on " << channel << " stream " << stream_id
              << ", logging fills to " << fill_log_path << " (Ctrl+C to stop)..." << std::endl;

    FragmentAssembler assembler(on_message);
    fragment_handler_t handler = assembler.handler();
    concurrent::BusySpinIdleStrategy idle_strategy;

    while (running)
    {
        const int fragments_read = subscription->poll(handler, 10);
        idle_strategy.idle(fragments_read);
    }

    fill_log.flush();
    fill_log.close();
    std::cout << "Market maker stopped. Received " << received << " fills, final inventory=" << inventory
              << ". Fill log: " << fill_log_path << std::endl;
    return 0;
}
```

- [ ] **Step 2: Wire up the new binary in CMake**

Add, after `add_aeron_executable(liquidity_taker)`:

```cmake
add_aeron_executable(market_maker)
```

- [ ] **Step 3: Build**

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
```

- [ ] **Step 4: Run the full phase 1 pipeline**

This is the real end-to-end test: liquidity takers → the generalized
sequencer → the market maker → a real fill log.

1. Confirm the driver is running.
2. Get a shared epoch: `date +%s` — call this `EPOCH`.
3. Terminal — sequencer (reused from Task 1, new stream IDs):
   `./build/sequencer aeron:ipc 30 aeron:ipc 31`
4. Terminal — market maker, once the sequencer says it's waiting for a
   consumer: `./build/market_maker aeron:ipc 31 fills.csv`
5. Terminal — liquidity taker 1, once the sequencer says it's live:
   `./build/liquidity_taker aeron:ipc 30 1 EPOCH 42 0.5 100.0 0.05 10.0 20.0 30`
6. Terminal — liquidity taker 2 (same `EPOCH`, different `traderId`):
   `./build/liquidity_taker aeron:ipc 30 2 EPOCH 43 0.5 100.0 0.05 10.0 20.0 30`

Expected: the market maker's terminal prints periodic `received N fills,
inventory=...` lines; after ~30 seconds both liquidity takers finish and
print how many orders they sent. Ctrl+C the market maker to flush and
close `fills.csv`.

- [ ] **Step 5: Inspect the fill log by hand**

```bash
head -5 fills.csv
wc -l fills.csv
```

Expected: a header row plus one row per fill, `global_sequence` starting
at 0 and increasing, `inventory_after` visibly changing with each row (up
on a SELL, down on a BUY), and the total row count (minus the header)
matching the combined `sent` totals both liquidity takers reported.

- [ ] **Step 6: Commit**

```bash
git add src/market_maker/main.cpp CMakeLists.txt
git commit -m "$(cat <<'EOF'
Add market maker with fill logging

Consumes the sequenced order stream, tracks running inventory, and
records every fill to a CSV log -- the boundary artifact phase 2's
Python analysis will read.
EOF
)"
```

Note: `fills.csv` itself is a run artifact, not source — do not commit it.
If it's untracked and you want to keep the working tree clean, add
`fills.csv` (or `*.csv`) to `.gitignore` as part of this commit.

---

## Task 4: Validation script for the fill log

**Files:**
- Create: `analysis/validate_fill_log.py`

**Interfaces:**
- Consumes: the CSV format produced by Task 3's `market_maker`
  (`global_sequence,timestamp_ns,side,price,quantity,true_price_at_trade,delta,inventory_after`).
- Produces: a pass/fail console report — no code in later phases depends
  on this script's internals, only on the fill log format it validates.

- [ ] **Step 1: Write the validation script**

```python
#!/usr/bin/env python3
"""Sanity-check a market_maker fill log before trusting it for analysis.

Checks, per the phase 1 design spec:
  1. global_sequence has no gaps.
  2. The running inventory implied by summing signed fills matches the
     recorded inventory_after column.
  3. The empirical arrival rate is in a plausible range (just a sanity
     print, not a strict pass/fail -- real arrivals are random).
"""
import sys
import pandas as pd


def main(path: str) -> int:
    df = pd.read_csv(path)
    ok = True

    expected_seq = range(df["global_sequence"].iloc[0], df["global_sequence"].iloc[0] + len(df))
    if list(df["global_sequence"]) != list(expected_seq):
        print("FAIL: global_sequence has gaps or is out of order")
        ok = False
    else:
        print(f"OK: global_sequence is contiguous ({len(df)} rows)")

    signed_qty = df["quantity"].where(df["side"] == "SELL", -df["quantity"])
    running_inventory = signed_qty.cumsum()
    if not (running_inventory.round(9) == df["inventory_after"].round(9)).all():
        print("FAIL: recorded inventory_after does not match cumulative signed fills")
        ok = False
    else:
        print("OK: inventory_after matches cumulative signed fills")

    duration_s = (df["timestamp_ns"].iloc[-1] - df["timestamp_ns"].iloc[0]) / 1e9
    if duration_s > 0:
        rate = len(df) / duration_s
        print(f"INFO: empirical fill rate = {rate:.2f} fills/sec over {duration_s:.1f}s")

    return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <fill_log.csv>")
        sys.exit(1)
    sys.exit(main(sys.argv[1]))
```

- [ ] **Step 2: Run it against the fill log from Task 3**

```bash
python3 -m pip install --user pandas   # if pandas isn't already available
python3 analysis/validate_fill_log.py fills.csv
```

Expected: both checks print `OK:`, and the `INFO:` line shows a fill rate
in the right ballpark for the `lambda` values used in Task 3's run (two
liquidity takers, `A=10, k=20, delta=0.05` each gives
`lambda = 10 * e^(-20*0.05) = 10 * e^-1 ≈ 3.68`/sec per side per trader —
with 2 traders and both sides, total should land somewhere in the
similar single-digit-to-low-double-digit fills/sec range; treat this as a
plausibility check, not an exact target).

- [ ] **Step 3: Commit**

```bash
git add analysis/validate_fill_log.py
git commit -m "$(cat <<'EOF'
Add fill log validation script

Checks sequence contiguity and inventory consistency before a fill log
is trusted as input to phase 2's statistical analysis.
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** true price process (Task 2), liquidity takers (Task
  2), generalized sequencer (Task 1), market maker + fill log (Task 3),
  testing/validation (Task 4) — all spec sections have a corresponding
  task.
- **Deviation from the spec worth flagging explicitly:** the spec
  describes the market maker as also computing the true price
  independently. During planning this turned out to be unnecessary and
  was simplified: `OrderEvent` already carries `true_price_at_send` from
  the liquidity taker that generated it, so the market maker just reads
  it from the message instead of recomputing it — one less parameter to
  keep in sync across processes, same information.
- **Type consistency:** `seq::OrderEvent` fields and `seq::Side` are used
  identically in Task 2 (`liquidity_taker`) and Task 3 (`market_maker`);
  `seq::SequencedEnvelope`/`set_payload`/`read_payload` from Task 1 are
  used identically in Task 3.
