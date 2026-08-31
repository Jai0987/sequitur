# sequitur

sequitur is a small low-latency trading systems project built from the ground up on Aeron, an open source messaging library used in real exchange and trading infrastructure. It started as a hands-on way to understand how systems like this actually work, and grew into a research project that tests a classical market-making model against a real, measured system instead of a textbook assumption.

The project has two layers. The first is a set of small programs that walk through the fundamentals: sending messages over shared memory versus a network, and building a single-writer sequencer that takes input from multiple independent sources and puts it into one agreed order. The second layer is a small market simulation built on top of that sequencer: synthetic traders generating buy and sell orders, a market maker quoting prices and absorbing those orders, and a script that checks the resulting data is trustworthy before treating it as real research input.

## Why this exists

A market maker is a participant that continuously offers to buy and sell something, profiting from the small gap between the two prices. The Avellaneda-Stoikov model, from a well known 2008 paper, works out the mathematically optimal prices to quote given your current inventory and how much time is left. Like most models of its kind, it assumes trades arrive as a clean, textbook random process.

Real systems do not behave that cleanly. When you build the actual pipeline that generates and processes trades, message arrival is affected by system load, queueing, and how fast a consumer can keep up, none of which shows up in an idealized model. This project builds that real pipeline, measures how orders actually arrive and get filled, and uses that measured data instead of the textbook assumption. The first phase of that work, the simulator and its data, is what is currently implemented. Later phases, described in `docs/design`, will do the actual model comparison.

## Repository layout

```
include/
  core/         the sequencing envelope shared by every part of the project
  fundamentals/ message types used by the basic pub/sub walkthrough
  simulation/   message types and the price process used by the simulator

src/
  fundamentals/ publisher, subscriber, producer, consumer: the walkthrough
  sequencer/    the single-writer sequencer, shared by both layers
  simulation/   liquidity_taker and market_maker: the research project

analysis/       validate_fill_log.py, checks simulator output before you trust it
docs/design/    the written spec and implementation plan for the simulator
third_party/    Aeron itself, included as a git submodule
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

This follows the same shape, with different programs. Start the driver if it is not already running, then:

```bash
./build/sequencer aeron:ipc 30 aeron:ipc 31
./build/market_maker aeron:ipc 31 fills.csv
```

The liquidity takers that generate orders need to agree on a shared reference point in time, since two independent processes have to compute the same synthetic price without ever messaging each other about it. Get one with `date +%s` and pass the same number to every liquidity taker you start:

```bash
EPOCH=$(date +%s)
./build/liquidity_taker aeron:ipc 30 1 $EPOCH 42 0.5 100.0 0.05 10.0 20.0 30
./build/liquidity_taker aeron:ipc 30 2 $EPOCH 42 0.5 100.0 0.05 10.0 20.0 30
```

The seed, here 42 for both, must also match across every liquidity taker in a run. It is what makes them agree on one shared price path. The trader ID right after it, 1 and 2 here, should differ, since that is each trader's own identity. The remaining numbers are the starting price, the market maker's fixed quote distance, and the two parameters of the order arrival rate.

Once the liquidity takers finish, stop the market maker with Ctrl+C so it flushes and closes `fills.csv`. Then check the data is trustworthy:

```bash
./.venv/bin/python3 analysis/validate_fill_log.py fills.csv
```

This checks that the recorded sequence has no gaps and that the running inventory in the file matches an independently recomputed total, before you use the data for anything else.

## Design docs

`docs/design/specs` has the written design for the simulator, including what it does and does not attempt to do. `docs/design/plans` has the implementation plan it was built from, task by task. Both are worth reading if you want the reasoning behind a decision, not just the code that resulted from it.
