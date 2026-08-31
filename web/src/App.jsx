import { useEffect, useRef, useState } from "react";
import Scene3D from "./components/Scene3D";
import ControlRail from "./components/ControlRail";
import Hud from "./components/Hud";
import SequencerHub from "./components/SequencerHub";
import Legend from "./components/Legend";
import RunHistory from "./components/RunHistory";
import { startRun, watchRun, fetchResult } from "./api";
import "./App.css";

const MAX_LOG_LINES = 300;
const FLUSH_INTERVAL_MS = 100; // batches bursts of fills into ~10 UI updates/sec, however fast they actually arrive
const MAX_CONCURRENT_PULSES = 24; // caps DOM/animation load when fills arrive faster than the 900ms pulse lifetime

function fillEventToRow(event) {
  return {
    timestamp_ns: event.receivedAtNs,
    side: event.side,
    price: event.price,
    true_price_at_trade: event.truePrice,
    inventory_after: event.inventory,
  };
}

export default function App() {
  const [status, setStatus] = useState("idle"); // idle | running | done | error
  const [lastMessage, setLastMessage] = useState(null);
  const [log, setLog] = useState([]);
  const [logOpen, setLogOpen] = useState(false);
  const [liveRows, setLiveRows] = useState([]);
  const [pulses, setPulses] = useState([]);
  const [errorMessage, setErrorMessage] = useState(null);
  const [liveBounds, setLiveBounds] = useState(null);

  // Every completed run stays here rather than being replaced by the next
  // one -- starting a new run doesn't erase the last one, so a fixed-delta
  // run and an Avellaneda-Stoikov run can be flipped between and compared.
  const [runHistory, setRunHistory] = useState([]);
  const [viewingRunId, setViewingRunId] = useState(null); // null = auto-follow whatever's live/most recent

  const pendingRowsRef = useRef([]);
  const pendingLogRef = useRef([]);
  const pendingPulsesRef = useRef([]);
  const flushTimerRef = useRef(null);

  useEffect(() => {
    flushTimerRef.current = setInterval(() => {
      if (pendingRowsRef.current.length > 0) {
        const newRows = pendingRowsRef.current;
        pendingRowsRef.current = [];
        setLiveRows((prev) => (prev.length ? prev.concat(newRows) : newRows));
      }
      if (pendingLogRef.current.length > 0) {
        const newLines = pendingLogRef.current;
        pendingLogRef.current = [];
        setLastMessage(newLines[newLines.length - 1]);
        setLog((prev) => prev.concat(newLines).slice(-MAX_LOG_LINES));
      }
      if (pendingPulsesRef.current.length > 0) {
        const newPulses = pendingPulsesRef.current;
        pendingPulsesRef.current = [];
        setPulses((prev) => {
          const next = prev.concat(newPulses);
          return next.length > MAX_CONCURRENT_PULSES ? next.slice(next.length - MAX_CONCURRENT_PULSES) : next;
        });
        newPulses.forEach((p) => {
          setTimeout(() => {
            setPulses((prev) => prev.filter((x) => x.id !== p.id));
          }, 900);
        });
      }
    }, FLUSH_INTERVAL_MS);
    return () => clearInterval(flushTimerRef.current);
  }, []);

  const queuePulse = (pulse) => {
    pendingPulsesRef.current.push({ ...pulse, id: Math.random().toString(36).slice(2) });
  };

  const handleRun = async (params) => {
    setStatus("running");
    setLog([]);
    setLastMessage(null);
    setLiveRows([]);
    setPulses([]);
    setErrorMessage(null);
    setViewingRunId(null); // a fresh run always takes over the main view; history is untouched
    pendingRowsRef.current = [];
    pendingLogRef.current = [];
    pendingPulsesRef.current = [];

    const duration = params.marketMaker === "fixed" ? params.durationSeconds : params.horizonSeconds;
    setLiveBounds({
      tMax: duration,
      pMin: params.s0 - 4 * params.sigma * Math.sqrt(duration),
      pMax: params.s0 + 4 * params.sigma * Math.sqrt(duration),
      iMin: -40,
      iMax: 40,
    });

    try {
      const { runId } = await startRun(params);
      watchRun(runId, async (event) => {
        if (event.type === "progress") {
          pendingLogRef.current.push(event.message);
        } else if (event.type === "order") {
          queuePulse({ kind: "order", from: `trader${event.trader}`, to: "sequencer", side: event.side });
        } else if (event.type === "sequenced") {
          queuePulse({ kind: "sequenced", from: "sequencer", to: "sequencer" });
        } else if (event.type === "fill") {
          queuePulse({ kind: "fill", from: "sequencer", to: "marketmaker", side: event.side });
          pendingRowsRef.current.push(fillEventToRow(event));
        } else if (event.type === "error") {
          setErrorMessage(event.message);
          setStatus("error");
        } else if (event.type === "done") {
          const res = await fetchResult(runId);
          setRunHistory((prev) => [...prev, { id: runId, marketMaker: params.marketMaker, rows: res.rows, stats: res.stats }]);
          setStatus("done");
        }
      });
    } catch (err) {
      setErrorMessage(err.message);
      setStatus("error");
    }
  };

  const isLive = status === "running" && viewingRunId === null;
  const latestRun = runHistory.length ? runHistory[runHistory.length - 1] : null;
  const viewedRun = viewingRunId ? runHistory.find((r) => r.id === viewingRunId) : latestRun;

  const sceneRows = isLive ? liveRows : viewedRun?.rows;
  const hudStats = !isLive ? viewedRun?.stats : null;
  const showLegend = isLive ? liveRows.length > 0 : Boolean(viewedRun);

  return (
    <div className="stage">
      <div className="stage-scene">
        <Scene3D rows={sceneRows} liveBounds={isLive ? liveBounds : null} />
      </div>

      <header className="mark">
        <span className="mark-title">sequitur</span>
        <span className="mark-sub">
          {status === "idle" && runHistory.length === 0 && "awaiting a run"}
          {isLive && "in progress"}
          {!isLive && status === "running" && "in progress (viewing another run)"}
          {status === "done" && viewingRunId === null && "run complete"}
          {status === "error" && "run failed"}
          {status !== "running" && status !== "error" && viewingRunId !== null && "viewing a past run"}
        </span>
        {showLegend && <Legend />}
      </header>

      <RunHistory runs={runHistory} viewingRunId={viewingRunId} isLive={isLive} onSelect={setViewingRunId} />

      {(status === "running" || runHistory.length > 0) && <SequencerHub pulses={pulses} />}

      {hudStats && <Hud stats={hudStats} />}

      {status === "error" && <div className="toast toast-error">{errorMessage}</div>}

      <div className="deck">
        {status === "running" && (
          <button type="button" className="ticker" onClick={() => setLogOpen((v) => !v)}>
            {lastMessage || "starting..."}
          </button>
        )}

        {logOpen && (
          <div className="log-panel">
            {log.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        )}

        <ControlRail onSubmit={handleRun} disabled={status === "running"} />
      </div>
    </div>
  );
}
