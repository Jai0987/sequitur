import { useState } from "react";
import Scene3D from "./components/Scene3D";
import ControlRail from "./components/ControlRail";
import Hud from "./components/Hud";
import { startRun, watchRun, fetchResult } from "./api";
import "./App.css";

export default function App() {
  const [status, setStatus] = useState("idle"); // idle | running | done | error
  const [lastMessage, setLastMessage] = useState(null);
  const [log, setLog] = useState([]);
  const [logOpen, setLogOpen] = useState(false);
  const [result, setResult] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);

  const handleRun = async (params) => {
    setStatus("running");
    setLog([]);
    setLastMessage(null);
    setResult(null);
    setErrorMessage(null);

    try {
      const { runId } = await startRun(params);
      watchRun(runId, async (event) => {
        if (event.type === "progress") {
          setLastMessage(event.message);
          setLog((prev) => [...prev, event.message]);
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

  return (
    <div className="stage">
      <div className="stage-scene">
        <Scene3D rows={result?.rows} />
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

      {status === "done" && <Hud stats={result?.stats} />}

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
