import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const BUY = new THREE.Color("#1fa37d");
const SELL = new THREE.Color("#e0522e");
const GROUND = "#12161f";
const MAX_LIVE_POINTS = 20000; // pre-allocated buffer capacity; a run this long would be unusual

function norm(v, lo, hi) {
  if (hi === lo) return 0;
  return ((v - lo) / (hi - lo)) * 2 - 1;
}

function buildIdlePoints() {
  const pts = [];
  for (let i = 0; i <= 160; i++) {
    const t = i / 160;
    pts.push(
      new THREE.Vector3(
        (t - 0.5) * 6,
        Math.sin(t * Math.PI * 3) * 0.35,
        Math.cos(t * Math.PI * 2) * 0.35,
      ),
    );
  }
  return pts;
}

// A single pre-allocated buffer, appended to in place. Positions already
// written are never touched again -- that's what makes adding the Nth
// point O(1) instead of O(N), which matters when fills arrive several
// times a second.
function makeGrowableGeometry(capacity) {
  const positions = new Float32Array(capacity * 3);
  const colors = new Float32Array(capacity * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setDrawRange(0, 0);
  return { geometry, positions, colors };
}

function writePoint(buf, index, x, y, z, color) {
  buf.positions[index * 3] = x;
  buf.positions[index * 3 + 1] = y;
  buf.positions[index * 3 + 2] = z;
  buf.colors[index * 3] = color.r;
  buf.colors[index * 3 + 1] = color.g;
  buf.colors[index * 3 + 2] = color.b;
}

export default function Scene3D({ rows, liveBounds }) {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const idleRef = useRef(null);
  const liveGroupRef = useRef(null);
  const stateRef = useRef({ userInteracted: false, datasetKey: null, count: 0 });

  // Scene, camera, renderer, controls, lights: set up once, never torn
  // down on data changes.
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(GROUND);
    scene.fog = new THREE.Fog(GROUND, 6, 15);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(3.4, 2.1, 3.4);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    const key = new THREE.DirectionalLight(0xf1cb84, 1.2);
    key.position.set(3, 4, 2);
    const fillLight = new THREE.DirectionalLight(0x1fa37d, 0.35);
    fillLight.position.set(-3, -2, -2);
    scene.add(ambient, key, fillLight);

    const grid = new THREE.GridHelper(10, 20, 0x2b3241, 0x232b39);
    grid.position.y = -1.7;
    scene.add(grid);

    // Idle ribbon: tiny and static, fine to build once up front.
    const idleLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(buildIdlePoints()),
      new THREE.LineBasicMaterial({ color: 0x3a4256, transparent: true, opacity: 0.6 }),
    );
    scene.add(idleLine);
    idleRef.current = idleLine;

    // Live/result data: one Line (the path) and one Points object (the
    // fill markers) sharing pre-allocated, incrementally-filled buffers --
    // a single draw call each, regardless of point count.
    const lineBuf = makeGrowableGeometry(MAX_LIVE_POINTS);
    const line = new THREE.Line(lineBuf.geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }));
    const pointsBuf = makeGrowableGeometry(MAX_LIVE_POINTS);
    const points = new THREE.Points(
      pointsBuf.geometry,
      new THREE.PointsMaterial({ size: 0.07, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.95 }),
    );
    // The buffer grows in place after its bounding volume is first
    // computed, which would otherwise leave later points incorrectly
    // frustum-culled -- points are always written within the fixed
    // normalized cube this scene uses, so culling buys nothing anyway.
    line.frustumCulled = false;
    points.frustumCulled = false;
    const liveGroup = new THREE.Group();
    liveGroup.add(line, points);
    liveGroup.visible = false;
    scene.add(liveGroup);
    liveGroupRef.current = { group: liveGroup, lineBuf, pointsBuf };

    // Axis reference lines -- x is time (start to end of the run), y is
    // price, z is inventory. Without these the path is just a pretty
    // shape with no way to tell what it means.
    function axisLine(from, to, hex) {
      const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
      return new THREE.Line(geo, new THREE.LineBasicMaterial({ color: hex, transparent: true, opacity: 0.5 }));
    }
    const axes = new THREE.Group();
    axes.add(
      axisLine(new THREE.Vector3(-3.2, 0, 0), new THREE.Vector3(3.2, 0, 0), 0x576073), // time
      axisLine(new THREE.Vector3(0, -1.8, 0), new THREE.Vector3(0, 1.8, 0), 0xd9a441), // price
      axisLine(new THREE.Vector3(0, 0, -1.8), new THREE.Vector3(0, 0, 1.8), 0x6b7fd7), // inventory
    );
    axes.visible = false;
    scene.add(axes);
    liveGroupRef.current.axes = axes;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.minDistance = 2.5;
    controls.maxDistance = 9;
    controls.enableDamping = true;
    controls.addEventListener("start", () => {
      stateRef.current.userInteracted = true;
    });

    function resize() {
      const w = container.clientWidth;
      const h = container.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    let frameId;
    function animate() {
      frameId = requestAnimationFrame(animate);
      if (idleLine.visible && !stateRef.current.userInteracted) {
        idleLine.rotation.y += 0.0025;
      }
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    sceneRef.current = { scene, camera, renderer, controls };

    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
      sceneRef.current = null;
    };
  }, []);

  // Data updates: append-only during a live run, one full (but cheap,
  // since it's O(final size) and happens once) rebuild at the moment the
  // authoritative result replaces the live stream.
  useEffect(() => {
    const ctx = sceneRef.current;
    const live = liveGroupRef.current;
    if (!ctx || !live) return;

    // Array.isArray guarantees a real boolean -- "rows && rows.length > 0"
    // evaluates to undefined (not false) when rows itself is undefined,
    // which left the axis lines rendering even in the idle state.
    const hasData = Array.isArray(rows) && rows.length > 0;
    idleRef.current.visible = !hasData;
    live.group.visible = hasData;
    live.axes.visible = hasData;
    if (!hasData) {
      stateRef.current.datasetKey = null;
      stateRef.current.count = 0;
      live.lineBuf.geometry.setDrawRange(0, 0);
      live.pointsBuf.geometry.setDrawRange(0, 0);
      return;
    }

    const datasetKey = rows[0].timestamp_ns;
    const isNewDataset = datasetKey !== stateRef.current.datasetKey || rows.length < stateRef.current.count;

    let bounds;
    if (isNewDataset && liveBounds) {
      // Live phase: fixed bounds derived from the run's own parameters, so
      // appending a point never requires re-deriving or re-writing every
      // point already on screen.
      bounds = liveBounds;
    } else if (isNewDataset) {
      // Final result: bounds fitted exactly to the finished dataset, a
      // one-time computation.
      const times = rows.map((r) => (r.timestamp_ns - rows[0].timestamp_ns) / 1e9);
      const prices = rows.map((r) => r.true_price_at_trade);
      const invs = rows.map((r) => r.inventory_after);
      bounds = {
        tMax: Math.max(...times) || 1,
        pMin: Math.min(...prices),
        pMax: Math.max(...prices),
        iMin: Math.min(...invs),
        iMax: Math.max(...invs),
      };
      stateRef.current.bounds = bounds;
    } else {
      bounds = stateRef.current.bounds;
    }

    const startIndex = isNewDataset ? 0 : stateRef.current.count;
    if (isNewDataset) {
      stateRef.current.datasetKey = datasetKey;
      stateRef.current.bounds = bounds;
    }

    const t0 = rows[0].timestamp_ns;
    for (let i = startIndex; i < rows.length && i < MAX_LIVE_POINTS; i++) {
      const r = rows[i];
      const x = norm((r.timestamp_ns - t0) / 1e9, 0, bounds.tMax) * 3;
      const y = norm(r.true_price_at_trade, bounds.pMin, bounds.pMax) * 1.6;
      const z = norm(r.inventory_after, bounds.iMin, bounds.iMax) * 1.6;
      const color = r.side === "BUY" ? BUY : SELL;
      writePoint(live.lineBuf, i, x, y, z, color);
      writePoint(live.pointsBuf, i, x, y, z, color);
    }

    const count = Math.min(rows.length, MAX_LIVE_POINTS);
    stateRef.current.count = count;
    live.lineBuf.geometry.setDrawRange(0, count);
    live.pointsBuf.geometry.setDrawRange(0, count);
    live.lineBuf.geometry.attributes.position.needsUpdate = true;
    live.lineBuf.geometry.attributes.color.needsUpdate = true;
    live.pointsBuf.geometry.attributes.position.needsUpdate = true;
    live.pointsBuf.geometry.attributes.color.needsUpdate = true;
  }, [rows, liveBounds]);

  return <div ref={mountRef} style={{ width: "100%", height: "100%" }} />;
}
