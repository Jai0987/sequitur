// Axis identity now lives on the axes themselves (name + live min/max,
// anchored in 3D via Scene3D's CSS2DObject labels) -- this only needs to
// carry what the 3D scene can't show on its own: what a point's color means.
export default function Legend() {
  return (
    <div className="legend">
      <div className="legend-group">
        <span className="legend-swatch" style={{ background: "#1fa37d" }} />
        <span>buy</span>
        <span className="legend-swatch" style={{ background: "#e0522e" }} />
        <span>sell</span>
      </div>
    </div>
  );
}
