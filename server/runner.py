import itertools
import json
import queue
import subprocess
import threading
import time
import uuid

from paths import BUILD_DIR, DRIVER_BINARY, RUNS_DIR, require_built

# Stream IDs just need to not collide between runs and between the three
# streams a single run uses (order / fill / quote); a simple incrementing
# counter is enough for this single-run-at-a-time backend.
_stream_id_counter = itertools.count(1000, step=10)
_counter_lock = threading.Lock()


def _next_stream_base() -> int:
    with _counter_lock:
        return next(_stream_id_counter)


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
            line = line.rstrip()
            if line:
                self._emit(f"[{name}] {line}")

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        try:
            ensure_driver_running()

            base = _next_stream_base()
            order_stream, fill_stream, quote_stream = base, base + 1, base + 2
            # Epoch a couple seconds in the future, not "now" -- this is the
            # exact fix for a real bug hit earlier in this project: too little
            # slack between generating the epoch and processes actually
            # starting made liquidity takers see themselves as already past
            # their duration, and they sent nothing at all.
            epoch = int(time.time()) + 2
            seed, sigma, s0, A, k = (
                self.params["seed"], self.params["sigma"], self.params["s0"],
                self.params["A"], self.params["k"],
            )

            self._emit("Starting sequencer...")
            sequencer = subprocess.Popen(
                [str(BUILD_DIR / "sequencer"), "aeron:ipc", str(order_stream), "aeron:ipc", str(fill_stream)],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
            )
            self._processes.append(sequencer)
            threading.Thread(target=self._stream_output, args=("sequencer", sequencer), daemon=True).start()

            if self.params["marketMaker"] == "fixed":
                self._emit("Starting fixed-delta market maker...")
                mm_cmd = [
                    str(BUILD_DIR / "market_maker"), "aeron:ipc", str(fill_stream), str(self.fill_log_path),
                    "aeron:ipc", str(quote_stream), str(epoch), str(seed), str(sigma), str(s0),
                    str(self.params["delta"]),
                ]
            else:
                self._emit("Starting Avellaneda-Stoikov market maker...")
                mm_cmd = [
                    str(BUILD_DIR / "optimal_market_maker"), "aeron:ipc", str(fill_stream), str(self.fill_log_path),
                    "aeron:ipc", str(quote_stream), str(epoch), str(seed), str(sigma), str(s0),
                    str(self.params["gamma"]), str(k), str(self.params["horizonSeconds"]),
                ]
            market_maker = subprocess.Popen(mm_cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
            self._processes.append(market_maker)
            threading.Thread(target=self._stream_output, args=("market_maker", market_maker), daemon=True).start()

            # Tied explicitly to which mode is active, not a truthiness
            # fallback -- durationSeconds always has a Pydantic default on
            # the API model, so "durationSeconds or horizonSeconds" would
            # never actually reach horizonSeconds even in optimal mode.
            duration = (
                self.params["durationSeconds"] if self.params["marketMaker"] == "fixed"
                else self.params["horizonSeconds"]
            )
            self._emit(f"Starting 2 liquidity takers for {duration}s...")
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

            self._emit("Liquidity takers finished, stopping market maker and sequencer...")
            market_maker.send_signal(2)  # SIGINT -- same clean-shutdown pattern used throughout this project
            market_maker.wait(timeout=5)
            sequencer.send_signal(2)
            sequencer.wait(timeout=5)

            self.result = self._summarize()
            self.events.put({"type": "done"})
        except Exception as exc:  # noqa: BLE001 -- surface any failure to the frontend, not just a server-side stack trace
            self.error = str(exc)
            self.events.put({"type": "error", "message": str(exc)})
            for proc in self._processes:
                if proc.poll() is None:
                    proc.kill()

    def _summarize(self):
        import pandas as pd

        df = pd.read_csv(self.fill_log_path)
        signed_pnl = (df["price"] - df["true_price_at_trade"]) * df["quantity"].where(
            df["side"] == "SELL", -df["quantity"]
        )
        return {
            "rows": json.loads(df.to_json(orient="records")),
            "stats": {
                "fills": len(df),
                "finalInventory": float(df["inventory_after"].iloc[-1]),
                "inventoryStd": float(df["inventory_after"].std()),
                "maxAbsInventory": float(df["inventory_after"].abs().max()),
                "realizedPnl": float(signed_pnl.sum()),
            },
        }
