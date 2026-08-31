const NODES = {
  trader1: { x: 20, y: 24, label: "trader 1" },
  trader2: { x: 20, y: 96, label: "trader 2" },
  sequencer: { x: 180, y: 60, label: "sequencer" },
  marketmaker: { x: 340, y: 60, label: "market maker" },
};

function pulseClass(pulse) {
  if (pulse.kind === "sequenced") return "hub-flash";
  const hop = pulse.from === "sequencer" ? "seq-mm" : pulse.from === "trader1" ? "t1-seq" : "t2-seq";
  const side = pulse.side === "SELL" ? "sell" : "buy";
  return `hub-pulse hub-pulse-${hop} hub-pulse-${side}`;
}

export default function SequencerHub({ pulses }) {
  return (
    <div className="hub">
      <svg className="hub-lines" width="360" height="120" viewBox="0 0 360 120">
        <line x1={NODES.trader1.x} y1={NODES.trader1.y} x2={NODES.sequencer.x} y2={NODES.sequencer.y} />
        <line x1={NODES.trader2.x} y1={NODES.trader2.y} x2={NODES.sequencer.x} y2={NODES.sequencer.y} />
        <line x1={NODES.sequencer.x} y1={NODES.sequencer.y} x2={NODES.marketmaker.x} y2={NODES.marketmaker.y} />
      </svg>

      {Object.entries(NODES).map(([key, n]) => (
        <div
          key={key}
          className={`hub-node${key === "sequencer" ? " hub-node-center" : ""}`}
          style={{ left: n.x, top: n.y }}
        >
          <span className="hub-dot" />
          <span className="hub-label">{n.label}</span>
        </div>
      ))}

      {pulses.map((p) => (
        <span key={p.id} className={pulseClass(p)} />
      ))}
    </div>
  );
}
