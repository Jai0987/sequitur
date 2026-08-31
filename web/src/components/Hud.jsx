function Reading({ label, value, tone }) {
  return (
    <div className="reading">
      <span className="reading-label">{label}</span>
      <span className={`reading-value${tone ? ` ${tone}` : ""}`}>{value}</span>
    </div>
  );
}

export default function Hud({ stats }) {
  if (!stats) return null;
  return (
    <div className="hud">
      <Reading label="fills" value={stats.fills} />
      <Reading label="inventory" value={stats.finalInventory.toFixed(1)} tone={stats.finalInventory < 0 ? "sell" : "buy"} />
      <Reading label="std dev" value={stats.inventoryStd.toFixed(2)} />
      <Reading label="worst" value={stats.maxAbsInventory.toFixed(1)} />
      <Reading label="p&l" value={stats.realizedPnl.toFixed(2)} tone={stats.realizedPnl < 0 ? "sell" : "buy"} />
    </div>
  );
}
