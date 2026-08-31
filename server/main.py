import json
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from runner import SimulationRun

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_current_run: Optional[SimulationRun] = None


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


def _run_in_progress() -> bool:
    return _current_run is not None and _current_run.result is None and _current_run.error is None


@app.post("/api/runs")
def create_run(params: RunParams):
    global _current_run
    if _run_in_progress():
        raise HTTPException(409, "A simulation is already running")
    try:
        _current_run = SimulationRun(params.model_dump())
    except RuntimeError as exc:
        raise HTTPException(400, str(exc))
    _current_run.start()
    return {"runId": _current_run.run_id}


@app.get("/api/runs/{run_id}/events")
def stream_events(run_id: str):
    if _current_run is None or _current_run.run_id != run_id:
        raise HTTPException(404, "Unknown run")

    def gen():
        while True:
            event = _current_run.events.get()
            yield f"data: {json.dumps(event)}\n\n"
            if event["type"] in ("done", "error"):
                break

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/api/runs/{run_id}/result")
def get_result(run_id: str):
    if _current_run is None or _current_run.run_id != run_id:
        raise HTTPException(404, "Unknown run")
    if _current_run.error is not None:
        raise HTTPException(500, _current_run.error)
    if _current_run.result is None:
        raise HTTPException(409, "Run not finished yet")
    return _current_run.result
