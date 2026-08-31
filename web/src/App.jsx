import { useState } from "react";
import Scene3D from "./components/Scene3D";
import ControlRail from "./components/ControlRail";
import Hud from "./components/Hud";
import SequencerHub from "./components/SequencerHub";
import { startRun, watchRun, fetchResult } from "./api";
import "./App.css";

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

  const addPulse = (pulse) => {
    const id = Math.random().toString(36).slice(2);
    setPulses((prev) => [...prev, { ...pulse, id }]);
    setTimeout(() => {
      setPulses((prev) => prev.filter((p) => p.id !== id));
    }, 900);
  };

  const handleRun = async (params) => {
    setStatus("running");
    setLog([]);
    setLastMessage(null);
    setLiveRows([]);
    setPulses([]);
    setResult(null);
    setErrorMessage(null);

    try {
      const { runId } = await startRun(params);
      watchRun(runId, async (event) => {
        if (event.type === "progress") {
          setLastMessage(event.message);
          setLog((prev) => [...prev, event.message]);
        } else if (event.type === "order") {
          addPulse({ kind: "order", from: `trader${event.trader}`, to: "sequencer", side: event.side });
        } else if (event.type === "sequenced") {
          addPulse({ kind: "sequenced", from: "sequencer", to: "sequencer" });
        } else if (event.type === "fill") {
          addPulse({ kind: "fill", from: "sequencer", to: "marketmaker", side: event.side });
          setLiveRows((prev) => [...prev, fillEventToRow(event)]);
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
        <Scene3D rows={sceneRows} />
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
