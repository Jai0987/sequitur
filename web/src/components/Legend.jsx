export default function Legend() {
  return (
    <div className="legend">
      <div className="legend-group">
        <span className="legend-swatch" style={{ background: "#576073" }} />
        <span>time</span>
        <span className="legend-swatch" style={{ background: "#d9a441" }} />
        <span>price</span>
        <span className="legend-swatch" style={{ background: "#6b7fd7" }} />
        <span>inventory</span>
      </div>
      <div className="legend-group">
        <span className="legend-swatch" style={{ background: "#1fa37d" }} />
        <span>buy</span>
        <span className="legend-swatch" style={{ background: "#e0522e" }} />
        <span>sell</span>
      </div>
    </div>
  );
}
