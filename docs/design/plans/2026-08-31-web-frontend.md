# Web Frontend Implementation Plan

**Goal:** A FastAPI backend that orchestrates the existing C++ binaries
for one simulation run, and a React/Vite frontend to configure, launch,
and view it.

**Spec:** `docs/design/specs/2026-08-31-web-frontend-design.md`

## Task 1: Backend -- process orchestration

**Files:**
- Create: `server/requirements.txt`
- Create: `server/runner.py`
- Create: `server/paths.py`

`server/paths.py` locates the repo root (two directories up from this
file) and the binaries, so the server works regardless of the working
directory it's started from:

```python
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BUILD_DIR = REPO_ROOT / "build"
DRIVER_BINARY = REPO_ROOT / "third_party" / "aeron" / "cmake-build" / "binaries" / "aeronmd"
RUNS_DIR = REPO_ROOT / "server" / "runs"


def require_built():
    missing = [
        name for name in ["sequencer", "market_maker", "optimal_market_maker", "liquidity_taker"]
        if not (BUILD_DIR / name).exists()
    ]
    if missing:
        raise RuntimeError(
            f"Missing binaries: {', '.join(missing)}. "
            "Build the project first -- see the README's Setting Up section."
        )
```

`server/runner.py` is the orchestration core -- a class that owns one
run's subprocesses and an event queue the API layer reads from:

```python
import queue
import subprocess
import threading
import time
import uuid
from pathlib import Path

from paths import BUILD_DIR, DRIVER_BINARY, RUNS_DIR, require_built


def ensure_driver_running():
    result = subprocess.run(["pgrep", "-f", str(DRIVER_BINARY)], capture_output=True)
    if result.returncode != 0:
        subprocess.Popen([str(DRIVER_BINARY)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)


class SimulationRun:
    def __init__(self, params: dict):
        require_built()
        self.run_id = str(uuid.uuid4())[:8]
        self.params = params
        self.events: "queue.Queue[dict]" = queue.Queue()
        self.result = None
        self.error = None
        self.run_dir = RUNS_DIR / self.run_id
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.fill_log_path = self.run_dir / "fills.csv"
        self._processes = []

    def _emit(self, message: str):
        self.events.put({"type": "progress", "message": message})

    def _stream_output(self, name: str, proc: subprocess.Popen):
        for line in proc.stdout:
            self._emit(f"[{name}] {line.rstrip()}")

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        try:
            ensure_driver_running()

            order_stream = 40 + (hash(self.run_id) % 1000) * 2
            quote_stream = order_stream + 1000
            fill_stream = order_stream + 1
            epoch = int(time.time()) + 2
            seed, sigma, s0, A, k = (
                self.params["seed"], self.params["sigma"], self.params["s0"],
                self.params["A"], self.params["k"],
            )

            sequencer = subprocess.Popen(
                [str(BUILD_DIR / "sequencer"), "aeron:ipc", str(order_stream), "aeron:ipc", str(fill_stream)],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
            )
            self._processes.append(sequencer)
            threading.Thread(target=self._stream_output, args=("sequencer", sequencer), daemon=True).start()

            if self.params["marketMaker"] == "fixed":
                mm_cmd = [
                    str(BUILD_DIR / "market_maker"), "aeron:ipc", str(fill_stream), str(self.fill_log_path),
                    "aeron:ipc", str(quote_stream), str(epoch), str(seed), str(sigma), str(s0),
                    str(self.params["delta"]),
                ]
            else:
                mm_cmd = [
                    str(BUILD_DIR / "optimal_market_maker"), "aeron:ipc", str(fill_stream), str(self.fill_log_path),
                    "aeron:ipc", str(quote_stream), str(epoch), str(seed), str(sigma), str(s0),
                    str(self.params["gamma"]), str(k), str(self.params["horizonSeconds"]),
                ]
            market_maker = subprocess.Popen(mm_cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
            self._processes.append(market_maker)
            threading.Thread(target=self._stream_output, args=("market_maker", market_maker), daemon=True).start()

            duration = self.params.get("durationSeconds") or self.params.get("horizonSeconds")
            liquidity_takers = []
            for trader_id in (1, 2):
                lt = subprocess.Popen(
                    [
                        str(BUILD_DIR / "liquidity_taker"), "aeron:ipc", str(order_stream), str(trader_id),
                        "aeron:ipc", str(quote_stream), str(epoch), str(seed), str(sigma), str(s0),
                        str(A), str(k), str(duration),
                    ],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
                )
                liquidity_takers.append(lt)
                self._processes.append(lt)
                threading.Thread(target=self._stream_output, args=(f"trader{trader_id}", lt), daemon=True).start()

            for lt in liquidity_takers:
                lt.wait()

            market_maker.send_signal(2)  # SIGINT, same clean-shutdown pattern used throughout this project
            market_maker.wait(timeout=5)
            sequencer.send_signal(2)
            sequencer.wait(timeout=5)

            self.result = self._summarize()
            self.events.put({"type": "done"})
        except Exception as exc:  # noqa: BLE001 -- surface any failure to the frontend, not just a stack trace in the server log
            self.error = str(exc)
            self.events.put({"type": "error", "message": str(exc)})
            for proc in self._processes:
                proc.kill()

    def _summarize(self):
        import pandas as pd

        df = pd.read_csv(self.fill_log_path)
        signed_pnl = (df["price"] - df["true_price_at_trade"]) * df["quantity"].where(
            df["side"] == "SELL", -df["quantity"]
        )
        return {
            "rows": df.to_dict(orient="records"),
            "stats": {
                "fills": len(df),
                "finalInventory": float(df["inventory_after"].iloc[-1]),
                "inventoryStd": float(df["inventory_after"].std()),
                "maxAbsInventory": float(df["inventory_after"].abs().max()),
                "realizedPnl": float(signed_pnl.sum()),
            },
        }
```

**Notes on the stream/epoch scheme:** stream IDs are derived from a hash
of the run ID so two runs started moments apart (there shouldn't be
concurrent ones, but the driver may still have a prior run's stale
subscriptions lingering briefly) don't collide. The epoch is set 2
seconds in the future, not "now" -- this avoids the exact bug from
earlier in this project where too little slack between generating the
epoch and processes actually starting caused liquidity takers to see
themselves as already past their duration and send nothing.

**Test:** run `python3 -c "from runner import SimulationRun; r = SimulationRun({...}); r.start(); ..."` directly against a fixed-delta config, poll `r.events` in a loop, confirm `r.result` ends up populated with sane stats matching a manual CLI run with the same parameters.

---

## Task 2: Backend -- FastAPI app

**Files:**
- Create: `server/main.py`

```python
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from runner import SimulationRun

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_current_run: SimulationRun | None = None


class RunParams(BaseModel):
    marketMaker: str  # "fixed" | "optimal"
    seed: int = 42
    sigma: float = 0.5
    s0: float = 100.0
    A: float = 10.0
    k: float = 20.0
    delta: float = 0.05
    gamma: float = 0.001
    horizonSeconds: float = 120.0
    durationSeconds: float = 120.0


@app.post("/api/runs")
def create_run(params: RunParams):
    global _current_run
    if _current_run is not None and _current_run.result is None and _current_run.error is None:
        raise HTTPException(409, "A simulation is already running")
    _current_run = SimulationRun(params.model_dump())
    _current_run.start()
    return {"runId": _current_run.run_id}


@app.get("/api/runs/{run_id}/events")
def stream_events(run_id: str):
    if _current_run is None or _current_run.run_id != run_id:
        raise HTTPException(404, "Unknown run")

    def gen():
        while True:
            event = _current_run.events.get()
            import json
            yield f"data: {json.dumps(event)}\n\n"
            if event["type"] in ("done", "error"):
                break

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/api/runs/{run_id}/result")
def get_result(run_id: str):
    if _current_run is None or _current_run.run_id != run_id:
        raise HTTPException(404, "Unknown run")
    if _current_run.result is None:
        raise HTTPException(409, "Run not finished yet")
    return _current_run.result
```

```
# server/requirements.txt
fastapi
uvicorn[standard]
pandas
```

**Test:** `uvicorn main:app --reload` from `server/`, `curl -X POST
localhost:8000/api/runs -d '{"marketMaker":"fixed","durationSeconds":20}'
-H 'content-type: application/json'`, confirm the run actually happens
(check `server/runs/<id>/fills.csv` gets created and populated) and the
events stream produces the expected progress lines.

---

## Task 3: Frontend -- Vite scaffold and API client

**Files:**
- Create: `web/package.json`, `web/vite.config.js`, `web/index.html`
- Create: `web/src/main.jsx`
- Create: `web/src/api.js`

Standard `npm create vite@latest -- --template react` scaffold. `api.js`
wraps the two calls the app needs:

```javascript
const BASE = "http://localhost:8000";

export async function startRun(params) {
  const res = await fetch(`${BASE}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export function watchRun(runId, onEvent) {
  const source = new EventSource(`${BASE}/api/runs/${runId}/events`);
  source.onmessage = (e) => onEvent(JSON.parse(e.data));
  return () => source.close();
}

export async function fetchResult(runId) {
  const res = await fetch(`${BASE}/api/runs/${runId}/result`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
```

**Test:** `npm run dev`, confirm the Vite dev server starts and serves a
blank page with no console errors.

---

## Task 4: Frontend -- parameter form, progress, and results

**Files:**
- Create: `web/src/App.jsx`
- Create: `web/src/components/ParamForm.jsx`
- Create: `web/src/components/ProgressLog.jsx`
- Create: `web/src/components/ResultsView.jsx`

`App.jsx` holds the top-level state machine: `idle -> running -> done`.
`ParamForm` renders `delta` when `marketMaker === "fixed"` and
`gamma`/`horizonSeconds` when `"optimal"`, since those are genuinely
different parameter sets, not one superset with unused fields.
`ProgressLog` renders the accumulating event messages during `running`.
`ResultsView` renders the stat row and two charts (price with buy/sell
markers, inventory over time) from the fetched result -- built as plain
SVG the same way the earlier artifact's charts were, no charting library
dependency needed for two line charts with markers.

**Test:** run a full simulation end to end through the UI (`npm run dev`
plus `uvicorn main:app` running), confirm progress messages appear live
and the results view renders after completion, matching what the same
parameters produce via the CLI.

## Self-review notes

- Spec coverage: orchestration (Task 1), API (Task 2), frontend scaffold
  (Task 3), UI (Task 4) all covered.
- `server/runs/` and `web/node_modules/`, `web/dist/` need adding to
  `.gitignore` as part of Task 1 and Task 3 respectively -- generated
  run artifacts and build output, not source.
