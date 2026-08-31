import { useEffect, useRef, useState } from "react";
import Scene3D from "./components/Scene3D";
import ControlRail from "./components/ControlRail";
import Hud from "./components/Hud";
import SequencerHub from "./components/SequencerHub";
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
  const [result, setResult] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);
  const [liveBounds, setLiveBounds] = useState(null);

  // Incoming SSE events can arrive far faster than React should actually
  // re-render at. These buffer everything between flushes; a timer drains
  // them into state at a fixed rate instead of one setState per event.
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
          // Drop the oldest excess pulses outright rather than let a burst
          // pile up hundreds of animating DOM nodes at once.
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
    setResult(null);
    setErrorMessage(null);
    pendingRowsRef.current = [];
    pendingLogRef.current = [];
    pendingPulsesRef.current = [];

    // Fixed bounds for the live view, derived from the run's own
    // parameters rather than the data seen so far -- this is what lets
    // Scene3D append new points without ever having to re-derive or
    // rewrite points already on screen. Generous on purpose: it only
    // needs to comfortably contain what the run will plausibly produce,
    // not fit it tightly (the final result gets an exactly-fitted view).
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
          setResult(res);
          setStatus("done");
        }
      });
    } catch (err) {
      setErrorMessage(err.message);
      setStatus("error");
    }
  };

  const sceneRows = status === "done" ? result?.rows : liveRows;
  const hudStats = status === "done" ? result?.stats : null;

  return (
    <div className="stage">
      <div className="stage-scene">
        <Scene3D rows={sceneRows} liveBounds={status === "done" ? null : liveBounds} />
      </div>

      <header className="mark">
        <span className="mark-title">sequitur</span>
        <span className="mark-sub">
          {status === "idle" && "awaiting a run"}
          {status === "running" && "in progress"}
          {status === "done" && "run complete"}
          {status === "error" && "run failed"}
        </span>
      </header>

      {(status === "running" || status === "done") && <SequencerHub pulses={pulses} />}

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
