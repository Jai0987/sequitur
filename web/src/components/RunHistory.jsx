export default function RunHistory({ runs, viewingRunId, isLive, onSelect }) {
  if (runs.length === 0) return null;

  return (
    <div className="run-history">
      {isLive && <span className="run-pill run-pill-live on">live</span>}
      {runs.map((run, i) => (
        <button
          key={run.id}
          type="button"
          className={`run-pill${!isLive && viewingRunId === run.id ? " on" : ""}`}
          onClick={() => onSelect(run.id)}
        >
          {i + 1} · {run.marketMaker === "fixed" ? "fixed" : "avellaneda-stoikov"}
        </button>
      ))}
    </div>
  );
}
