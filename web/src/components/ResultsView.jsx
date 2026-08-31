const BUY = "#1FA37D";
const SELL = "#E0522E";

function StatRow({ stats }) {
  const items = [
    { label: "Fills", value: stats.fills },
    { label: "Final inventory", value: stats.finalInventory.toFixed(1) },
    { label: "Inventory std dev", value: stats.inventoryStd.toFixed(2) },
    { label: "Max |inventory|", value: stats.maxAbsInventory.toFixed(1) },
    { label: "Realized P&L", value: stats.realizedPnl.toFixed(2) },
  ];
  return (
    <div className="stat-row">
      {items.map((item) => (
        <div className="stat" key={item.label}>
          <div className="stat-label">{item.label}</div>
          <div className="stat-value">{item.value}</div>
        </div>
      ))}
    </div>
  );
}

function withTime(rows) {
  const t0 = rows[0].timestamp_ns;
  return rows.map((r) => ({ ...r, t: (r.timestamp_ns - t0) / 1e9 }));
}

function PriceChart({ rows }) {
  const W = 720, H = 260, padL = 50, padR = 12, padT = 12, padB = 26;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const data = withTime(rows);
  const tMax = data[data.length - 1].t || 1;
  const prices = data.map((d) => d.true_price_at_trade);
  let pMin = Math.min(...prices), pMax = Math.max(...prices);
  const pad = (pMax - pMin) * 0.08 || 1;
  pMin -= pad;
  pMax += pad;

  const x = (t) => padL + (t / tMax) * innerW;
  const y = (p) => padT + innerH - ((p - pMin) / (pMax - pMin)) * innerH;

  const linePath = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(d.t).toFixed(1)},${y(d.true_price_at_trade).toFixed(1)}`).join(" ");

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`}>
      {[0, 1, 2, 3, 4].map((i) => {
        const p = pMin + (i / 4) * (pMax - pMin);
        const gy = y(p);
        return (
          <g key={i}>
            <line className="grid-line" x1={padL} x2={W - padR} y1={gy} y2={gy} />
            <text className="axis-label" x={padL - 6} y={gy + 3} textAnchor="end">{p.toFixed(2)}</text>
          </g>
        );
      })}
      <path className="price-line" d={linePath} />
      {data.map((d, i) => (
        <circle
          key={i}
          className={`trade-dot ${d.side === "BUY" ? "buy" : "sell"}`}
          cx={x(d.t)}
          cy={y(d.price)}
          r={3.5}
        />
      ))}
    </svg>
  );
}

function InventoryChart({ rows }) {
  const W = 720, H = 180, padL = 50, padR = 12, padT = 12, padB = 26;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const data = withTime(rows);
  const tMax = data[data.length - 1].t || 1;
  const invs = data.map((d) => d.inventory_after);
  let iMin = Math.min(...invs), iMax = Math.max(...invs);
  const pad = Math.max(1, (iMax - iMin) * 0.1);
  iMin -= pad;
  iMax += pad;

  const x = (t) => padL + (t / tMax) * innerW;
  const y = (v) => padT + innerH - ((v - iMin) / (iMax - iMin)) * innerH;

  const linePath = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(d.t).toFixed(1)},${y(d.inventory_after).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${x(tMax).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z`;

  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`}>
      {[0, 1, 2, 3].map((i) => {
        const v = iMin + (i / 3) * (iMax - iMin);
        const gy = y(v);
        return (
          <g key={i}>
            <line className="grid-line" x1={padL} x2={W - padR} y1={gy} y2={gy} />
            <text className="axis-label" x={padL - 6} y={gy + 3} textAnchor="end">{v.toFixed(0)}</text>
          </g>
        );
      })}
      {iMin < 0 && iMax > 0 && <line className="zero-line" x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} />}
      <path className="inv-area" d={areaPath} />
      <path className="inv-line" d={linePath} />
    </svg>
  );
}

export default function ResultsView({ result }) {
  const { rows, stats } = result;
  return (
    <div className="results">
      <StatRow stats={stats} />

      <section className="panel">
        <div className="panel-head">
          <h2>Price and fills</h2>
          <div className="legend">
            <span className="legend-item"><span className="swatch" style={{ background: BUY }} />buy</span>
            <span className="legend-item"><span className="swatch" style={{ background: SELL }} />sell</span>
          </div>
        </div>
        <div className="panel-body">
          <PriceChart rows={rows} />
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Market maker inventory</h2>
        </div>
        <div className="panel-body">
          <InventoryChart rows={rows} />
        </div>
      </section>
    </div>
  );
}
