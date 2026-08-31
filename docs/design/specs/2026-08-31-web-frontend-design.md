# Web Frontend for Running Simulations

## Context

Every simulation so far has been run by hand: several terminals, a
manually-generated shared epoch, remembering which stream IDs go where.
That's been valuable for learning the mechanics, but it's a real barrier
for anyone else who wants to run this project's experiment without
already knowing all of that. This adds a web frontend that drives the
existing C++ binaries the same way we've been doing by hand, so someone
can configure a run, launch it, and see the results without touching a
terminal beyond starting the server.

## Goals

- A form to configure and launch one simulation run: which market maker
  (fixed-delta or Avellaneda-Stoikov), and its parameters.
- Live progress while it runs.
- A results view once it finishes: price and trades over time, inventory
  over time, and summary stats -- the same kind of view as the earlier
  artifact, now committed as real, reusable frontend code.

## Non-goals

- No side-by-side comparison of both market makers in one run (that
  stays a manual two-run workflow via `analysis/compare_market_makers.py`
  for now).
- No building the C++ project from the web UI -- it assumes `cmake
  --build build` has already been run, per the README, and errors
  clearly if the binaries are missing.
- No support for multiple concurrent runs -- one run at a time, enforced
  by the backend.

## Design

### Backend (`server/`)

A FastAPI app. It does not reimplement any simulation logic -- it
launches the existing binaries as subprocesses, the same sequence used
by hand throughout this project:

1. Check `third_party/aeron/cmake-build/binaries/aeronmd` is running;
   start it if not.
2. Generate a run ID, a fresh pair of stream IDs (so concurrent stale
   runs can't collide), and a shared epoch (`now + 2` seconds, giving
   every process a moment to connect before it's needed).
3. Launch the sequencer, then the chosen market maker (`market_maker` or
   `optimal_market_maker`, with its own parameters), then two
   `liquidity_taker` processes with matching seed/epoch/`A`/`k`.
4. Parse each process's stdout for the same status lines we've been
   reading by hand (`is live`, `received N fills`, `done. Sent N
   orders`) and forward them as Server-Sent Events.
5. Once both liquidity takers exit, send `SIGINT` to the market maker
   (and the sequencer) to flush and close the fill log, exactly like the
   manual shutdown sequence used throughout this project.
6. Read the resulting CSV, compute the same summary stats as
   `analysis/compare_market_makers.py`, and hold the result in memory
   keyed by run ID for the frontend to fetch.

**API:**

- `POST /api/runs` -- body: market maker type and its parameters. Returns
  `{ "runId": ... }`. Rejected with 409 if a run is already in progress.
- `GET /api/runs/{runId}/events` -- Server-Sent Events stream of progress
  lines, ending with a `done` or `error` event.
- `GET /api/runs/{runId}/result` -- once finished: the fill rows as JSON
  plus summary stats (fills, final inventory, inventory std dev, max
  absolute inventory, realized P&L -- the same metrics
  `compare_market_makers.py` already computes).

### Frontend (`web/`)

React + Vite, single page, no routing needed for this scope.

- A parameter form. Selecting "fixed-delta" vs "Avellaneda-Stoikov"
  swaps in the right fields (`delta` for one, `gamma` + `horizonSeconds`
  for the other), since they take genuinely different parameters.
- On submit: POST to `/api/runs`, then open an `EventSource` to the
  events endpoint and render each line as it arrives.
- On the `done` event: fetch `/api/runs/{runId}/result` and render two
  charts (price with buy/sell fills marked, inventory over time) and a
  stat row, reusing the visual approach from the earlier artifact but as
  real, version-controlled components this time.

### Data flow

```
browser --(POST params)--> FastAPI --(spawns)--> aeronmd, sequencer, market maker, 2x liquidity_taker
browser <--(SSE progress)-- FastAPI <--(stdout)-- those processes
browser --(GET result)--> FastAPI --(reads)--> fill log CSV --> JSON
```

## Testing

Manual: run a fixed-delta simulation and an Avellaneda-Stoikov simulation
through the UI, confirm the resulting summary stats match what running
the same parameters by hand through the CLI produces (cross-check against
`analysis/compare_market_makers.py`'s output on the same fill log).

## Open questions for the implementation plan

- Exact process-cleanup behavior if the browser tab closes mid-run (the
  plan should have the backend keep running to completion regardless,
  since the subprocesses are already committed to their duration).
