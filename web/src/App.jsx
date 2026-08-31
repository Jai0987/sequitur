import { useState } from "react";
import ParamForm from "./components/ParamForm";
import ProgressLog from "./components/ProgressLog";
import ResultsView from "./components/ResultsView";
import { startRun, watchRun, fetchResult } from "./api";
import "./App.css";

export default function App() {
  const [status, setStatus] = useState("idle"); // idle | running | done | error
  const [log, setLog] = useState([]);
  const [result, setResult] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);

  const handleRun = async (params) => {
    setStatus("running");
    setLog([]);
    setResult(null);
    setErrorMessage(null);

    try {
      const { runId } = await startRun(params);
      watchRun(runId, async (event) => {
        if (event.type === "progress") {
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
    <div className="app">
      <header className="app-header">
        <span className="brand">sequitur</span>
        <span className="brand-sub">simulation runner</span>
      </header>

      <p className="intro">
        Configure a market simulation and run it for real -- this launches the
        actual sequencer, market maker, and liquidity taker binaries, the same
        ones documented in the README, and shows you the resulting fill log.
      </p>

      <ParamForm onSubmit={handleRun} disabled={status === "running"} />

      {status === "running" && <ProgressLog lines={log} />}

      {status === "error" && (
        <div className="error-banner">{errorMessage}</div>
      )}

      {status === "done" && result && <ResultsView result={result} />}
    </div>
  );
}
