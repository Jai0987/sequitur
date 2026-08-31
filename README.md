# sequitur

sequitur is a small low-latency trading systems project built from the ground up on Aeron, an open source messaging library used in real exchange and trading infrastructure. It started as a hands-on way to understand how systems like this actually work, and grew into a research project that tests a classical market-making model against a real, measured system instead of a textbook assumption.

The project has two layers. The first is a set of small programs that walk through the fundamentals: sending messages over shared memory versus a network, and building a single-writer sequencer that takes input from multiple independent sources and puts it into one agreed order. The second layer is a market simulation built on top of that sequencer: synthetic traders generating buy and sell orders, a market maker quoting live prices and absorbing those orders, and scripts that check the resulting data is trustworthy and measure what it actually shows.

A web frontend (`web/` and `server/`) lets you configure and run a simulation from a browser instead of the command line, if you would rather not manage several terminals by hand.

## Why this exists

A market maker is a participant that continuously offers to buy and sell something, profiting from the small gap between the two prices. The Avellaneda-Stoikov model, from a well known 2008 paper, works out the mathematically optimal prices to quote given your current inventory and how much time is left. Like most models of its kind, it assumes trades arrive as a clean, textbook random process.

Real systems do not behave that cleanly. When you build the actual pipeline that generates and processes trades, message arrival is affected by system load, queueing, and how fast a consumer can keep up, none of which shows up in an idealized model. This project builds that real pipeline, measures how orders actually arrive and get filled, and uses that measured data instead of the textbook assumption.

Three phases are implemented so far. The simulator itself (synthetic traders, a market maker, a fill log). An analysis of whether the resulting arrival process actually looks Poisson, which it does at a moderate order rate once a real performance bug in the price simulation was fixed, described in `analysis/arrival_process_analysis.py`. And an actual Avellaneda-Stoikov market maker, backtested against the simple fixed-spread one on identical order flow. The comparison is stark: the adaptive market maker cut its worst inventory exposure by roughly 7x and its realized loss by roughly 30x, at the cost of trading less often. All of this is described in more depth in `docs/design`.

## Repository layout

```
include/
  core/         the sequencing envelope shared by every part of the project
  fundamentals/ message types used by the basic pub/sub walkthrough
  simulation/   message types and the price process used by the simulator

src/
  fundamentals/ publisher, subscriber, producer, consumer: the walkthrough
  sequencer/    the single-writer sequencer, shared by both layers
  simulation/   liquidity_taker, market_maker, optimal_market_maker

analysis/       validation and statistical analysis of simulator output
docs/design/    the written specs and implementation plans, phase by phase
third_party/    Aeron itself, included as a git submodule

server/         FastAPI backend that runs simulations for the web frontend
web/            React frontend for configuring and running a simulation
```

## Prerequisites

You need a C++ compiler, CMake 3.20 or newer, and git. On macOS, the Xcode command line tools (`xcode-select --install`) provide the compiler. On Linux, a recent GCC or Clang works. You also need Python 3 if you want to run the validation script.

## Setting up

Clone the repository with its submodule, or if you already cloned it without one, pull the submodule in separately:

```bash
git clone --recurse-submodules <this repo's URL>
# or, if already cloned:
git submodule update --init
```

Aeron's own media driver needs to be built once, on its own, before the rest of the project:

```bash
cmake -S third_party/aeron -B third_party/aeron/cmake-build \
  -DCMAKE_BUILD_TYPE=Release \
  -DAERON_TESTS=OFF -DAERON_UNIT_TESTS=OFF -DAERON_SYSTEM_TESTS=OFF \
  -DAERON_BUILD_SAMPLES=OFF -DAERON_BUILD_DOCUMENTATION=OFF \
  -DBUILD_AERON_ARCHIVE_API=OFF

cmake --build third_party/aeron/cmake-build --parallel
```

This produces `aeronmd`, the driver process that owns the shared memory and network transport everything else in this project talks through. Then build the project itself:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
```

If you want to run the validation script, set up a Python virtual environment once:

```bash
python3 -m venv .venv
./.venv/bin/pip install pandas
```

## Running the fundamentals walkthrough

Every program in this project talks to the Aeron media driver, so it has to be running first. Start it in its own terminal and leave it running:

```bash
./third_party/aeron/cmake-build/binaries/aeronmd
```

It will not print anything. Silence means it is healthy.

In a second terminal, start the sequencer. It waits for a consumer before it will accept input, so start it before anything else:

```bash
./build/sequencer aeron:ipc 20 aeron:ipc 21
```

In a third terminal, start the consumer, which will read the sequencer's output:

```bash
./build/consumer aeron:ipc 21 A
```

Once the sequencer reports it is live, send it some input from a fourth terminal, or from two at once to see messages from two independent sources get interleaved into one order:

```bash
./build/producer aeron:ipc 1 20 20 5
./build/producer aeron:ipc 2 20 20 7
```

The last two numbers are how many messages to send and how many per second. The consumer's output shows a running `global_seq` number that increases by exactly one for every message it receives, regardless of which producer it came from, along with the end to end latency of that message in nanoseconds.

## Running the market simulation

This follows the same shape, with different programs, and one more moving part: the market maker now publishes its live quotes on their own stream, and liquidity takers trade against whatever it last published rather than a price they compute themselves. Start the driver if it is not already running, then the sequencer, on its own pair of streams:

```bash
./build/sequencer aeron:ipc 30 aeron:ipc 31
```

Then the market maker. Two versions exist, and they're worth comparing to each other. The fixed-spread baseline always quotes the same distance from the price no matter what it's holding:

```bash
EPOCH=$(date +%s)
./build/market_maker aeron:ipc 31 fills.csv aeron:ipc 32 $EPOCH 42 0.5 100.0 0.05
```

Or the Avellaneda-Stoikov version, which adjusts its quotes based on its own inventory, volatility, and how much of the trading session is left:

```bash
./build/optimal_market_maker aeron:ipc 31 fills.csv aeron:ipc 32 $EPOCH 42 0.5 100.0 0.001 20.0 120
```

The seed (`42`) and the epoch you just generated must be identical across every process in the run -- it's what lets independent processes agree on one shared price path and one shared clock without messaging each other about it. Then the two liquidity takers, with the same seed and epoch:

```bash
./build/liquidity_taker aeron:ipc 30 1 aeron:ipc 32 $EPOCH 42 0.5 100.0 10.0 20.0 120
./build/liquidity_taker aeron:ipc 30 2 aeron:ipc 32 $EPOCH 42 0.5 100.0 10.0 20.0 120
```

Once the liquidity takers finish (they stop themselves after their duration), stop the market maker with Ctrl+C so it flushes and closes the fill log. Then check the data is trustworthy:

```bash
./.venv/bin/python3 analysis/validate_fill_log.py fills.csv
```

This checks the recorded sequence has no gaps and the running inventory in the file matches an independently recomputed total, before you use the data for anything else. To see whether the order arrival process actually looks like the Poisson process the classical model assumes:

```bash
./.venv/bin/python3 analysis/arrival_process_analysis.py fills.csv 7.3576 arrivals.png
```

The second argument is the theoretical combined arrival rate for whatever `A` and `k` you used (`2 * A * exp(-k * delta)` for two liquidity takers). To compare a fixed-spread run against an Avellaneda-Stoikov run made with the same seed, epoch, `A`, and `k`:

```bash
./.venv/bin/python3 analysis/compare_market_makers.py fills_baseline.csv fills_optimal.csv
```

## Running it from the browser

Instead of managing several terminals by hand, a small web app can run one simulation for you. The fastest path, once the C++ project is built (`make build`, or the manual steps above):

```bash
make setup   # first time only -- installs Python and npm dependencies
make up      # starts the driver, backend, and frontend together
```

Then open `http://localhost:5173`. Pick a market maker, set its parameters, and run -- the backend launches the driver if needed and the same binaries and CLI shape described above, streams progress live, and renders the resulting fill log as a price/trade chart and an inventory chart once the run finishes. `make down` stops everything again, and `make logs` tails what each piece is doing.

If you would rather run each piece by hand: install the backend's dependencies with `./.venv/bin/pip install -r server/requirements.txt`, start it with `cd server && ../.venv/bin/uvicorn main:app --port 8000`, and in another terminal run `cd web && npm install && npm run dev`.

## Design docs

`docs/design/specs` has the written design for each phase, including what it does and does not attempt to do. `docs/design/plans` has the implementation plan each phase was built from, task by task. Both are worth reading if you want the reasoning behind a decision, not just the code that resulted from it.
