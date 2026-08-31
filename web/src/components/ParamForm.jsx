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

function NumberField({ label, hint, value, onChange, step = "any" }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export default function ParamForm({ onSubmit, disabled }) {
  const [params, setParams] = useState(DEFAULTS);

  const set = (key) => (value) => setParams((p) => ({ ...p, [key]: value }));

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(params);
  };

  return (
    <form className="param-form" onSubmit={handleSubmit}>
      <div className="mm-toggle">
        <button
          type="button"
          className={params.marketMaker === "fixed" ? "active" : ""}
          onClick={() => set("marketMaker")("fixed")}
        >
          Fixed-delta
        </button>
        <button
          type="button"
          className={params.marketMaker === "optimal" ? "active" : ""}
          onClick={() => set("marketMaker")("optimal")}
        >
          Avellaneda-Stoikov
        </button>
      </div>

      <div className="field-grid">
        <NumberField label="Seed" hint="shared price path" value={params.seed} step="1" onChange={set("seed")} />
        <NumberField label="Sigma" hint="volatility" value={params.sigma} onChange={set("sigma")} />
        <NumberField label="S0" hint="starting price" value={params.s0} onChange={set("s0")} />
        <NumberField label="A" hint="arrival intensity" value={params.A} onChange={set("A")} />
        <NumberField label="k" hint="intensity decay" value={params.k} onChange={set("k")} />

        {params.marketMaker === "fixed" ? (
          <>
            <NumberField label="Delta" hint="fixed quote distance" value={params.delta} onChange={set("delta")} />
            <NumberField
              label="Duration (s)"
              hint="run length"
              value={params.durationSeconds}
              step="1"
              onChange={set("durationSeconds")}
            />
          </>
        ) : (
          <>
            <NumberField label="Gamma" hint="risk aversion" value={params.gamma} onChange={set("gamma")} />
            <NumberField
              label="Horizon (s)"
              hint="trading session length"
              value={params.horizonSeconds}
              step="1"
              onChange={set("horizonSeconds")}
            />
          </>
        )}
      </div>

      <button type="submit" className="run-button" disabled={disabled}>
        {disabled ? "Running..." : "Run simulation"}
      </button>
    </form>
  );
}
