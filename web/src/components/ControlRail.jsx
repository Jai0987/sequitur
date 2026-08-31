import { useState } from "react";

const DEFAULTS = {
  marketMaker: "fixed",
  seed: 42,
  sigma: 0.5,
  s0: 100.0,
  A: 10.0,
  k: 20.0,
  delta: 0.05,
  gamma: 0.001,
  horizonSeconds: 60,
  durationSeconds: 60,
};

function Field({ label, value, onChange, step = "any" }) {
  return (
    <label className="rail-field">
      <span>{label}</span>
      <input type="number" step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </label>
  );
}

export default function ControlRail({ onSubmit, disabled }) {
  const [params, setParams] = useState(DEFAULTS);
  const [expanded, setExpanded] = useState(false);
  const set = (key) => (value) => setParams((p) => ({ ...p, [key]: value }));

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(params);
  };

  return (
    <form className="control-rail" onSubmit={handleSubmit}>
      <div className="rail-row">
        <div className="mm-switch">
          <button type="button" className={params.marketMaker === "fixed" ? "on" : ""} onClick={() => set("marketMaker")("fixed")}>
            fixed
          </button>
          <button type="button" className={params.marketMaker === "optimal" ? "on" : ""} onClick={() => set("marketMaker")("optimal")}>
            avellaneda-stoikov
          </button>
        </div>

        {params.marketMaker === "fixed" ? (
          <>
            <Field label="delta" value={params.delta} onChange={set("delta")} />
            <Field label="duration" value={params.durationSeconds} step="1" onChange={set("durationSeconds")} />
          </>
        ) : (
          <>
            <Field label="gamma" value={params.gamma} onChange={set("gamma")} />
            <Field label="horizon" value={params.horizonSeconds} step="1" onChange={set("horizonSeconds")} />
          </>
        )}

        <button type="button" className="rail-more" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {expanded ? "less" : "more"}
        </button>

        <button type="submit" className="rail-run" disabled={disabled}>
          {disabled ? "running" : "run"}
        </button>
      </div>

      {expanded && (
        <div className="rail-row rail-row-extra">
          <Field label="seed" value={params.seed} step="1" onChange={set("seed")} />
          <Field label="sigma" value={params.sigma} onChange={set("sigma")} />
          <Field label="s0" value={params.s0} onChange={set("s0")} />
          <Field label="A" value={params.A} onChange={set("A")} />
          <Field label="k" value={params.k} onChange={set("k")} />
        </div>
      )}
    </form>
  );
}
