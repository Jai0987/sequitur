import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const BUY = "#1fa37d";
const SELL = "#e0522e";
const GROUND = "#12161f";

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

function buildFillPoints(rows) {
  const t0 = rows[0].timestamp_ns;
  const times = rows.map((r) => (r.timestamp_ns - t0) / 1e9);
  const prices = rows.map((r) => r.true_price_at_trade);
  const invs = rows.map((r) => r.inventory_after);
  const tMax = Math.max(...times) || 1;
  const pMin = Math.min(...prices), pMax = Math.max(...prices);
  const iMin = Math.min(...invs), iMax = Math.max(...invs);

  return rows.map(
    (r, i) =>
      new THREE.Vector3(
        norm(times[i], 0, tMax) * 3,
        norm(prices[i], pMin, pMax) * 1.6,
        norm(invs[i], iMin, iMax) * 1.6,
      ),
  );
}

function buildContentGroup(rows) {
  const group = new THREE.Group();
  const hasData = rows && rows.length > 0;

  if (hasData) {
    const points = buildFillPoints(rows);
    const positions = new Float32Array(points.length * 3);
    const colors = new Float32Array(points.length * 3);
    const buyColor = new THREE.Color(BUY);
    const sellColor = new THREE.Color(SELL);

    points.forEach((p, i) => {
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      const c = rows[i].side === "BUY" ? buyColor : sellColor;
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    });

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    lineGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 });
    group.add(new THREE.Line(lineGeo, lineMat));

    const sphereGeo = new THREE.SphereGeometry(0.028, 12, 12);
    points.forEach((p, i) => {
      const isBuy = rows[i].side === "BUY";
      const mat = new THREE.MeshStandardMaterial({
        color: isBuy ? BUY : SELL,
        emissive: isBuy ? BUY : SELL,
        emissiveIntensity: 0.4,
      });
      const mesh = new THREE.Mesh(sphereGeo, mat);
      mesh.position.copy(p);
      group.add(mesh);
    });
  } else {
    const points = buildIdlePoints();
    const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x3a4256, transparent: true, opacity: 0.6 });
    group.add(new THREE.Line(lineGeo, lineMat));
  }

  return group;
}

function disposeGroup(group) {
  group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
      else obj.material.dispose();
    }
  });
}

export default function Scene3D({ rows }) {
  const mountRef = useRef(null);
  const sceneRef = useRef(null);
  const contentGroupRef = useRef(null);
  const stateRef = useRef({ userInteracted: false });

  // Scene, camera, renderer, controls, lights: set up once and never torn
  // down on data changes -- rebuilding all of this on every single fill
  // during a live run would reset the camera/orbit position constantly.
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
      const group = contentGroupRef.current;
      if (group && group.userData.idle && !stateRef.current.userInteracted) {
        group.rotation.y += 0.0025;
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

  // Content only: swap the line/points group in place when the data
  // changes, leaving the camera and orbit state exactly where the viewer
  // left it.
  useEffect(() => {
    const ctx = sceneRef.current;
    if (!ctx) return;

    const newGroup = buildContentGroup(rows);
    newGroup.userData.idle = !(rows && rows.length > 0);

    if (contentGroupRef.current) {
      ctx.scene.remove(contentGroupRef.current);
      disposeGroup(contentGroupRef.current);
    }
    ctx.scene.add(newGroup);
    contentGroupRef.current = newGroup;

    return () => {
      ctx.scene.remove(newGroup);
      disposeGroup(newGroup);
      if (contentGroupRef.current === newGroup) {
        contentGroupRef.current = null;
      }
    };
  }, [rows]);

  return <div ref={mountRef} style={{ width: "100%", height: "100%" }} />;
}
