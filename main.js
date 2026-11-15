import * as THREE from "three";
import { OrbitControls } from "./vendor/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "./vendor/renderers/CSS2DRenderer.js";
import { LineSegments2 } from "./vendor/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "./vendor/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "./vendor/lines/LineMaterial.js";
import { createTrains } from "./trains.js";

const $ = (id) => document.getElementById(id);
const msg = $("msg");

// Data coordinates: x = east, y = north, z = height (metres). Scene: X = east, Y = up, Z = -north.
const toW = (x, y, z) => [x, z, -y];

// When a shared track belongs to several lines it is drawn once, in the first of these that serves it.
const PRIORITY = ["Victoria", "Jubilee", "Central", "Northern", "Piccadilly", "Bakerloo", "Waterloo & City",
                  "Metropolitan", "Hammersmith & City", "District", "Circle"];
const primary = (lines) => PRIORITY.find((l) => lines.includes(l)) || lines[0];

const THEMES = {
  cream: { road: 0x6a6052, roadMajor: 0.38, roadMinor: 0.2, foot: 0xf6efdc, footOpacity: 0.8, surf: 0xddd1b6, surfOpacity: 0.26, shade: 0x7b8cc4, lit: 0xfff0c8, water: 0x4a9fd8, waterLight: 0x7fb9e0, bg: 0xf4efe3, ground: 0x9a9384, groundOpacity: 0.14, drop: 0x7a7266, marker: "#ffffff", ring: "#2b2620" },
  dark:  { road: 0xcfcfc8, roadMajor: 0.3, roadMinor: 0.15, foot: 0xe8e4da, footOpacity: 0.7, surf: 0xa8a8a0, surfOpacity: 0.2, shade: 0x2c3550, lit: 0xf2f4ff, water: 0x3f8fc9, waterLight: 0x6aa6d6, bg: 0x14161a, ground: 0xb8b8b0, groundOpacity: 0.13, drop: 0x9a9a94, marker: "#ffffff", ring: "#14161a" },
};
let theme = "cream";

const canvas = $("gl");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(THEMES.cream.bg);
const camera = new THREE.PerspectiveCamera(38, 1, 50, 400000);
const labelRenderer = new CSS2DRenderer({ element: $("labels") });
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };   // left-drag is handled below ("grab" panning)
controls.touches = { ONE: -1, TWO: THREE.TOUCH.DOLLY_ROTATE };
controls.zoomToCursor = true; controls.rotateSpeed = 0.6; controls.zoomSpeed = 1.0;
controls.maxPolarAngle = Math.PI * 0.985; controls.minDistance = 300; controls.maxDistance = 150000;
const home = { pos: new THREE.Vector3(0, 26000, 43000), target: new THREE.Vector3(0, 0, 0) };
// Grab-pan: the point of the map under the cursor stays under the cursor (like a web map).
const rc = new THREE.Raycaster(), groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), ndc = new THREE.Vector2();
const hitAt = (cx, cy, out) => { const r = canvas.getBoundingClientRect(); ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  rc.setFromCamera(ndc, camera); return rc.ray.intersectPlane(groundPlane, out); };
addEventListener("pointerdown", (e) => { if (e.target === canvas && e.button === 0) controls.mouseButtons.LEFT = e.altKey ? THREE.MOUSE.ROTATE : -1; }, true);   // Option/Alt + drag = turn (OrbitControls is told before it sees the click)
{
  let grab = null; const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), ptr = new Map(); let single = null;
  canvas.addEventListener("pointerdown", (e) => {
    ptr.set(e.pointerId, 1);
    if ((e.pointerType === "mouse" && e.button === 0 && !e.altKey) || (e.pointerType !== "mouse" && ptr.size === 1)) {
      if (hitAt(e.clientX, e.clientY, p0)) { grab = p0.clone(); single = e.pointerId; canvas.setPointerCapture(e.pointerId); }
    } else if (ptr.size > 1) grab = null;
    if (e.button === 2 || (e.button === 0 && e.altKey) || ptr.size > 1) { const c = new THREE.Vector3(); if (hitAt(innerWidth / 2, innerHeight / 2, c)) controls.target.copy(c); }   // turn around what you are looking at
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!grab || e.pointerId !== single) return;
    if (hitAt(e.clientX, e.clientY, p1)) { const d = grab.clone().sub(p1); camera.position.add(d); controls.target.add(d); }
  });
  const up = (e) => { ptr.delete(e.pointerId); if (e.pointerId === single) grab = null; };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
}
function resetView() { camera.position.copy(home.pos); controls.target.copy(home.target); controls.update(); }
resetView();

const world = new THREE.Group();   // vertical exaggeration is applied to this group only
scene.add(world);
let EX = 3; world.scale.y = EX;

const lineMats = [];               // LineMaterial instances, to update resolution
const lineGroups = {};             // line name -> {u: LineSegments2, s: LineSegments2}
const labelObjs = [];
let platformMarkers = [];          // for hover tooltip
const portalU = { m: { value: 7 }, h: { value: 450 } };   // portal arch half-width in metres; half drawing-buffer height in px
let terrainInfo = null, groundAt = () => 0, groundPts, surfMesh, roadsMajor, roadsMinor, footLines, waterGroup, dropLines, portalPts, stationPts, stationGround;

function circleTexture(fill, ring) {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d");
  g.beginPath(); g.arc(32, 32, 28, 0, 7); g.fillStyle = ring; g.fill();
  g.beginPath(); g.arc(32, 32, 19, 0, 7); g.fillStyle = fill; g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function hollowRingTexture(colour, edge) {   // open ring (portal marker) so the lines stay visible through it
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d");
  g.beginPath(); g.arc(64, 64, 58, 0, 7); g.arc(64, 64, 41, 0, 7, true); g.fillStyle = edge; g.fill("evenodd");
  g.beginPath(); g.arc(64, 64, 53, 0, 7); g.arc(64, 64, 46, 0, 7, true); g.fillStyle = colour; g.fill("evenodd");
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

async function main() {
  let net, tmeta, tbuf;
  try {
    [net, tmeta, tbuf] = await Promise.all([
      fetch("data/network.json").then((r) => r.json()),
      fetch("data/terrain.json").then((r) => r.json()),
      fetch("data/terrain.bin").then((r) => r.arrayBuffer()),
    ]);
  } catch (e) {
    msg.innerHTML = "Could not load the data files.<br>If you opened index.html directly from a folder, start a local server instead:<br><code>python -m http.server 8000</code> and open http://localhost:8000";
    return;
  }

  // ---------- lines (shared track = lengthwise stripes, one per line) ----------
  const allLines = new Set(); for (const w of net.ways) for (const l of w.lines) allLines.add(l);
  // The terrain as a float texture, so the track shader can tell per pixel whether it is above or below the ground and tint it exactly where it crosses.
  const dummyTex = new THREE.DataTexture(new Float32Array([0, 0, 0, 0]), 2, 2, THREE.RedFormat, THREE.FloatType); dummyTex.needsUpdate = true;
  const gUni = { tGround: { value: dummyTex }, uOrig: { value: new THREE.Vector4(0, 0, 100, 0) }, uDim: { value: new THREE.Vector2(2, 2) },
    uBelow: { value: 0 }, uFadeOn: { value: 1 }, uTint: { value: new THREE.Color(0xffffff) }, uTintMix: { value: 0.6 }, uFaint: { value: 1.0 } };
  // ---------- ground points ----------
  {
    const { w, h, xll, yll, cell, nodata, scale, full_rows } = tmeta;
    const [E0, N0] = net.origin_osgb;
    const v = new Int16Array(tbuf);
    // contour lines draped on the terrain (every 5 m, stronger every 25 m): they show where the ground surface is, near and far
    {
      const val = (r, c) => { const q = v[r * w + c]; return q === nodata ? NaN : q * scale; };
      const X = (c) => xll + c * cell + cell / 4 - E0, Z = (r) => -(yll + full_rows * 50 - r * cell - cell / 4 - N0);
      const minor = [], major = [], STEP = 5;
      for (let r = 0; r < h - 1; r++) for (let c = 0; c < w - 1; c++) {
        const a = val(r, c), b = val(r, c + 1), d = val(r + 1, c), e = val(r + 1, c + 1);
        const mn = Math.min(a, b, d, e), mx = Math.max(a, b, d, e);
        if (!(mn <= mx)) continue;   // nodata
        for (let L = Math.ceil(mn / STEP + 1e-9) * STEP; L <= mx; L += STEP) {
          const p = [];
          if ((a < L) !== (b < L)) p.push([c + (L - a) / (b - a), r]);
          if ((b < L) !== (e < L)) p.push([c + 1, r + (L - b) / (e - b)]);
          if ((d < L) !== (e < L)) p.push([c + (L - d) / (e - d), r + 1]);
          if ((a < L) !== (d < L)) p.push([c, r + (L - a) / (d - a)]);
          const out = L % 25 === 0 ? major : minor;
          for (let k = 0; k + 1 < p.length; k += 2) out.push(X(p[k][0]), L + 0.4, Z(p[k][1]), X(p[k + 1][0]), L + 0.4, Z(p[k + 1][1]));
        }
      }
      groundPts = new THREE.Group();
      const mkl = (arr) => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(arr), 3));
        const o = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ transparent: true, depthWrite: false })); o.frustumCulled = false; o.renderOrder = 3.5; return o; };
      groundPts.userData = { minor: mkl(minor), major: mkl(major) };
      groundPts.add(groundPts.userData.minor, groundPts.userData.major); world.add(groundPts);
    }

    // translucent ground surface: veils everything below it, leaves surface track crisp
    const SS = 1, cols = Math.ceil(w / SS), rows = Math.ceil(h / SS);
    const P = new Float32Array(cols * rows * 3), ok = new Uint8Array(cols * rows);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const r = j * SS, c = i * SS, q = v[Math.min(r, h - 1) * w + Math.min(c, w - 1)], k = j * cols + i;
      const x = xll + c * cell + cell / 4 - E0, north = yll + full_rows * 50 - r * cell - cell / 4 - N0;
      if (q === nodata) { P.set([x, 0, -north], k * 3); continue; }
      ok[k] = 1; P.set([x, q * scale, -north], k * 3);
    }
    {
      const ft = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) ft[i] = v[i] === nodata ? 0 : v[i] * scale;
      const tex = new THREE.DataTexture(ft, w, h, THREE.RedFormat, THREE.FloatType);
      tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.needsUpdate = true;
      gUni.tGround.value = tex; gUni.uDim.value.set(w, h);
      gUni.uOrig.value.set(xll + cell / 4 - E0, yll + full_rows * 50 - cell / 4 - N0, cell, 0);
    }
    groundAt = (x, y) => {   // terrain height (m) at data coordinates, bilinear
      const c = (x + E0 - xll - cell / 4) / cell, r = (yll + full_rows * 50 - cell / 4 - (y + N0)) / cell;
      const c0 = Math.max(0, Math.min(w - 2, Math.floor(c))), r0 = Math.max(0, Math.min(h - 2, Math.floor(r)));
      const fx = Math.max(0, Math.min(1, c - c0)), fy = Math.max(0, Math.min(1, r - r0));
      const g = (rr, cc) => { const q = v[rr * w + cc]; return q === nodata ? 0 : q * scale; };
      return (g(r0, c0) * (1 - fx) + g(r0, c0 + 1) * fx) * (1 - fy) + (g(r0 + 1, c0) * (1 - fx) + g(r0 + 1, c0 + 1) * fx) * fy;
    };
    terrainInfo = { P, ok, cols, rows, E0, N0 };
    const idx = [];
    for (let j = 0; j < rows - 1; j++) for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      if (ok[a] && ok[b] && ok[c] && ok[d]) idx.push(a, c, b, b, c, d);
    }
    const sg = new THREE.BufferGeometry(); sg.setAttribute("position", new THREE.BufferAttribute(P, 3));
    sg.setIndex(idx);
    {   // smooth shading normals from the height grid (slope over +-2 cells, relief exaggerated x6) - per-face normals of the 100 m grid look blocky
      const N = new Float32Array(cols * rows * 3), K = 6, Hh = (i, j) => P[(Math.max(0, Math.min(rows - 1, j)) * cols + Math.max(0, Math.min(cols - 1, i))) * 3 + 1];
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const dx = (Hh(i + 2, j) - Hh(i - 2, j)) / (4 * tmeta.cell) * K, dz = (Hh(i, j + 2) - Hh(i, j - 2)) / (4 * tmeta.cell) * K, l = Math.hypot(dx, 1, dz), k = (j * cols + i) * 3;
        N[k] = -dx / l; N[k + 1] = 1 / l; N[k + 2] = -dz / l;
      }
      sg.setAttribute("aN", new THREE.BufferAttribute(N, 3));
    }
    // Ground: see-through, with hillshading (light from the north-west) and a faint height tint so the surface reads even when nothing moves.
    // The shading uses its own fixed relief exaggeration, so it stays legible when the vertical exaggeration slider is low.
    surfMesh = new THREE.Mesh(sg, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uBase: { value: new THREE.Color(0xe6dcc4) }, uAlpha: { value: 0.28 }, uShade: { value: new THREE.Color(0x7b8cc4) }, uLit: { value: new THREE.Color(0xfff0c8) } },
      vertexShader: `attribute vec3 aN; varying vec3 vL, vN; void main() { vL = position; vN = aN; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
      fragmentShader: `
        uniform vec3 uBase, uShade, uLit; uniform float uAlpha; varying vec3 vL, vN;
        void main() {
          vec3 n = normalize( vN );
          float s = clamp( dot( n, normalize( vec3( - 0.55, 0.75, - 0.45 ) ) ) - 0.75, - 0.6, 0.6 );   // 0 on flat ground
          float h = clamp( vL.y / 160.0, 0.0, 1.0 );
          vec3 col = mix( uBase, s > 0.0 ? uLit : uShade, min( abs( s ) * 2.2, 0.9 ) );
          col = mix( col, col * vec3( 1.03, 1.02, 0.94 ), h );
          gl_FragColor = vec4( col, uAlpha + ( s < 0.0 ? abs( s ) * 0.30 : abs( s ) * 0.34 ) );
          #include <colorspace_fragment>
        }`,
    }));
    surfMesh.renderOrder = 2; surfMesh.frustumCulled = false; surfMesh.position.y = -0.4;   // just under the terrain model: everything deeper is behind it
    world.add(surfMesh);
  }

  const order = [...PRIORITY.filter((l) => allLines.has(l)), ...[...allLines].filter((l) => !PRIORITY.includes(l))];
  const buckets = {}; for (const l of order) buckets[l] = { u: { pos: [], st: [], dp: [] }, s: { pos: [], st: [], dp: [] } };
  for (const w of net.ways) {
    let pts = w.pts;
    const f = pts[0], l0 = pts[pts.length - 1];
    if (l0[0] < f[0] || (l0[0] === f[0] && l0[1] < f[1])) pts = pts.slice().reverse();   // same orientation for every line on this way
    const ls = order.filter((l) => w.lines.includes(l)), n = ls.length, H = 1 + 0.7 * (n - 1);
    // Tunnels are never above the rendered ground and surface track never below it (so a line only crosses the ground at its portals);
    // segments are cut every ~30 m first so the rule also holds between the original vertices.
    const dense = [];
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k];
      if (k > 0) {
        const p = pts[k - 1], m = Math.max(1, Math.ceil(Math.hypot(a[0] - p[0], a[1] - p[1]) / 30));
        for (let j = 1; j < m; j++) { const f = j / m; dense.push([p[0] + (a[0] - p[0]) * f, p[1] + (a[1] - p[1]) * f, p[2] + (a[2] - p[2]) * f]); }
      }
      dense.push(a);
    }
    for (const q of dense) { const g = groundAt(q[0], q[1]); q[2] = w.cls === "U" ? Math.min(q[2], g) : Math.max(q[2], g); q[3] = Math.abs(q[2] - g); }   // q[3]: metres from the ground
    ls.forEach((ln, i) => {
      const lo = -H + (2 * H * i) / n, hi = -H + (2 * H * (i + 1)) / n;
      const bk = w.cls === "U" ? buckets[ln].u : buckets[ln].s;
      for (let k = 0; k < dense.length - 1; k++) {
        const a = dense[k], c = dense[k + 1];
        bk.pos.push(...toW(a[0], a[1], a[2]), ...toW(c[0], c[1], c[2])); bk.st.push(lo, hi, H); bk.dp.push(a[3], c[3]);
      }
    });
  }
  // Each segment instance picks its own stripe extent (lo, hi, H = half-width of the whole bundle). Width is the larger of the pixel width
  // set in JS and the track's real width (uMetres) at the camera distance, so close up a tunnel has its true scale and from afar it stays visible.
  const TRACK_M = 4.5, trackScale = { value: TRACK_M };
  const patchStripe = (m, under) => {
    const v0 = m.vertexShader;
    m.uniforms.uMetres = trackScale; Object.assign(m.uniforms, gUni); m.uniforms.uUnder = { value: under ? 1 : 0 };
    m.fragmentShader = m.fragmentShader
      .replace("uniform float linewidth;", `uniform float linewidth;
		uniform float uUnder, uBelow, uFadeOn, uTintMix, uFaint; uniform vec3 uTint; varying float vDepth;`)
      // Tunnel (class U) vs surface (class S/E) is known from the data, so the tint follows that - it changes exactly at the portal,
      // whatever the terrain model says. From above the tunnels are the ones "behind" the ground, from below the surface lines are.
      .replace("float alpha = opacity;", `float behind_ = uFadeOn * ( ( uBelow > 0.5 ) ? 1.0 - uUnder : uUnder );   // tunnel vs surface: changes at once, exactly at the portal
			float alpha = opacity * ( 1.0 - behind_ * ( 1.0 - uFaint ) );`)
      .replace("gl_FragColor = vec4( diffuseColor.rgb, alpha );", "gl_FragColor = vec4( mix( diffuseColor.rgb, uTint, behind_ * uTintMix ), alpha );");
    m.vertexShader = v0
      .replace("uniform float linewidth;", "uniform float linewidth;\n\t\tuniform float uMetres;\n\t\tvarying vec3 vLoc;")
      .replace("attribute vec3 instanceColorEnd;", "attribute vec3 instanceColorEnd;\n\t\tattribute vec3 instanceStripe;\n\t\tattribute vec2 instanceDepth;\n\t\tvarying float vDepth;")
      .replace("if ( position.x < 0.0 ) offset *= - 1.0;", "offset *= ( position.x < 0.0 ) ? instanceStripe.x : instanceStripe.y;")
      .replace("offset *= linewidth;", `vDepth = ( position.y < 0.5 ) ? instanceDepth.x : instanceDepth.y;
				float cw_ = ( position.y < 0.5 ) ? clipStart.w : clipEnd.w;
				float worldPx = uMetres * 0.5 * resolution.y * projectionMatrix[1][1] / cw_;
				offset *= max( linewidth * instanceStripe.z, worldPx ) / instanceStripe.z;`);
    if (m.vertexShader.split("instanceStripe").length < 6 || !m.vertexShader.includes("worldPx") || !m.vertexShader.includes("vDepth =") || !m.fragmentShader.includes("behind_ * uTintMix")) console.warn("stripe shader patch did not apply");
  };
  const legend = $("legend");
  for (const ln of order) {
    const colour = new THREE.Color(net.line_colours[ln] || "#888888");
    const mk = (bk, width, opacity, rank, under) => {
      if (!bk.pos.length) return null;
      const g = new LineSegmentsGeometry(); g.setPositions(new Float32Array(bk.pos));
      g.setAttribute("instanceStripe", new THREE.InstancedBufferAttribute(new Float32Array(bk.st), 3));
      g.setAttribute("instanceDepth", new THREE.InstancedBufferAttribute(new Float32Array(bk.dp), 2));
      const m = new LineMaterial({ color: colour, linewidth: width, transparent: true, opacity });
      patchStripe(m, under); lineMats.push(m);
      const o = new LineSegments2(g, m); o.frustumCulled = false; o.renderOrder = rank; world.add(o); return o;
    };
    // underground drawn first (rank 1), the ground veil comes next (rank 2), surface track last (rank 3)
    lineGroups[ln] = { u: mk(buckets[ln].u, 3.2, 1, 1, 1), s: mk(buckets[ln].s, 3.2, 1, 3, 0), colour };
    const row = document.createElement("label");
    row.innerHTML = `<input type="checkbox" checked><span class="chip" style="background:${net.line_colours[ln]}"></span>${ln}`;
    row.querySelector("input").addEventListener("change", (e) => {
      for (const k of ["u", "s"]) if (lineGroups[ln][k]) lineGroups[ln][k].visible = e.target.checked;
      row.classList.toggle("off", !e.target.checked);
    });
    legend.appendChild(row);
  }
  // The ground acts as a see-through mask: any part of a line on the far side of the terrain from the camera is drawn fainter and tinted
  // (per pixel in the shader, so the change happens exactly where the line crosses the ground). Draw order follows the camera side so the veil lies in front.
  let below = false;
  const darkTint = new THREE.Color(0x24201a);
  const applyFade = () => {
    const tint = $("cFade").checked;
    gUni.uFadeOn.value = tint ? 1 : 0; gUni.uBelow.value = below ? 1 : 0;
    gUni.uTint.value.copy(below ? darkTint : new THREE.Color(THEMES[theme].bg)); gUni.uTintMix.value = below ? 0.6 : 0.6;
    for (const ln of order) {
      const g = lineGroups[ln];
      if (g.u) { g.u.material.color.copy(g.colour); g.u.material.linewidth = 3.2; g.u.renderOrder = below ? 3 : 1; }
      if (g.s) { g.s.material.color.copy(g.colour); g.s.material.linewidth = 3.2; g.s.renderOrder = below ? 1 : 3; }
    }
    if (waterGroup && waterGroup.userData.thames) {
      const { thames, others, canalsS, canalsU } = waterGroup.userData, [r1, r2] = below ? [1.5, 1.6] : [2.5, 2.6];
      thames.renderOrder = others.renderOrder = r1; if (canalsS) canalsS.renderOrder = r2; if (canalsU) canalsU.renderOrder = below ? 2.6 : 1.55;   // culverts sit behind the ground like the tunnels
    }
  };
  $("cFade").addEventListener("change", applyFade);

  // ---------- tunnel routes projected onto the ground ----------
  // Heights come from the same smoothed terrain the surface track is built on (w.g), so the route meets the surface track exactly at the portals.
  {
    const pos = [], LIFT = 0.5;
    for (const w of net.ways) if (w.cls === "U") {
      for (let k = 0; k < w.pts.length - 1; k++) {
        const a = w.pts[k], c = w.pts[k + 1], ga = w.g ? w.g[k] : groundAt(a[0], a[1]), gc = w.g ? w.g[k + 1] : groundAt(c[0], c[1]);
        pos.push(...toW(a[0], a[1], ga + LIFT), ...toW(c[0], c[1], gc + LIFT));
      }
    }
    const g = new LineSegmentsGeometry(); g.setPositions(new Float32Array(pos));
    const m = new LineMaterial({ linewidth: 2, transparent: true, opacity: 0.7, depthWrite: false });
    lineMats.push(m); footLines = new LineSegments2(g, m); footLines.frustumCulled = false; footLines.renderOrder = 4; world.add(footLines);
  }

  // ---------- water: Thames ribbon with slight visual thickness, canals as translucent lines ----------
  try {
    const wd = await fetch("data/water.json").then((r) => r.json());
    waterGroup = new THREE.Group(); world.add(waterGroup);
    const LIFT = (wd.depth || 4) * 0.9;   // the polygons were built at the bottom of their ditch; stand them back on the ground surface
    const mkMesh = (pm, name, rank) => {
      const V = new Float32Array(pm.v.length);
      for (let k = 0; k < pm.v.length; k += 3) V.set(toW(pm.v[k], pm.v[k + 1], pm.v[k + 2] + LIFT), k);
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(V, 3));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(pm.i), 1));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide }));
      m.renderOrder = rank; m.frustumCulled = false; m.name = name; waterGroup.add(m); return m;
    };
    // real OSM water polygons (Thames banks-to-banks, lakes, docks ...), sitting in a ditch cut into the terrain grid
    const thames = mkMesh(wd.polys.thames, "thames", 2.5), others = mkMesh(wd.polys.other, "other", 2.5);
    const wgrid = new Map();   // corners of the open-water polygons, binned in 250 m cells
    for (const pm of [wd.polys.thames, wd.polys.other]) for (let k = 0; k < pm.v.length; k += 3) { const key = `${Math.floor(pm.v[k] / 250)},${Math.floor(pm.v[k + 1] / 250)}`; (wgrid.get(key) || wgrid.set(key, []).get(key)).push([pm.v[k], pm.v[k + 1]]); }
    const cs = [], cu = [];
    for (const c of wd.canals) {
      const arr = c.u ? cu : cs;
      // surface waterways lie on the ground; a culverted stretch starts at the ground where the open water ends, slopes down to 3 m below it
      // and comes back up at the other end, so the underground water stays connected to the visible river
      let pts = c.pts;
      if (c.u) {   // reach the nearest open-water polygon corner at each end (OSM leaves small gaps between the culvert and the open stretch)
        const near = (p) => { let best = null, bd = 160 * 160; const gx = Math.floor(p[0] / 250), gy = Math.floor(p[1] / 250);
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const q of (wgrid.get(`${gx + dx},${gy + dy}`) || [])) { const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2; if (d < bd) { bd = d; best = q; } }
          return best; };
        const h = near(pts[0]), t = near(pts[pts.length - 1]);
        pts = [...(h ? [[h[0], h[1], 0]] : []), ...pts, ...(t ? [[t[0], t[1], 0]] : [])];
      }
      const cum = [0]; for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
      const L = cum[cum.length - 1];
      const zAt = (k) => { const p = pts[k], g = groundAt(p[0], p[1]); return c.u ? g + 0.6 - 3.6 * Math.min(1, Math.min(cum[k], L - cum[k]) / 90) : g + 0.6; };
      for (let k = 0; k < pts.length - 1; k++) { const a = pts[k], b = pts[k + 1]; arr.push(...toW(a[0], a[1], zAt(k)), ...toW(b[0], b[1], zAt(k + 1))); }
    }
    const mkc = (pos, dashed) => {
      if (!pos.length) return null;
      const g = new LineSegmentsGeometry(); g.setPositions(new Float32Array(pos));
      const m = new LineMaterial({ linewidth: dashed ? 2.6 : 2.2, transparent: true, opacity: dashed ? 0.5 : 0.8 });
      lineMats.push(m); const o = new LineSegments2(g, m); o.frustumCulled = false; o.renderOrder = 2.6;
      waterGroup.add(o); return o;
    };
    waterGroup.userData = { thames, others, canalsS: mkc(cs, false), canalsU: mkc(cu, true) };
  } catch (e) { console.warn("water layer not loaded", e); }


  // ---------- stations, drop lines, labels ----------
  const sp = [], dl = [], gd = [];
  for (const s of net.stations) {
    let lo = Infinity, hi = -Infinity;
    const nl = new Set(s.platforms.map((p) => p[0])).size;
    for (const p of s.platforms) {
      sp.push(...toW(p[1], p[2], p[3]));
      platformMarkers.push({ name: s.name, line: p[0], x: p[1], y: p[2], z: p[3], ground: s.ground });
      lo = Math.min(lo, p[3]); hi = Math.max(hi, p[3]);
    }
    // one drop line + ground dot per physical platform spot (platforms of one station can be 50 m apart), so each dot sits on its own track
    const spots = [];
    for (const p of s.platforms) {
      let sp_ = spots.find((q) => Math.hypot(q.x - p[1], q.y - p[2]) < 20);
      if (!sp_) spots.push((sp_ = { x: p[1], y: p[2], lo: Infinity, hi: -Infinity }));
      sp_.lo = Math.min(sp_.lo, p[3]); sp_.hi = Math.max(sp_.hi, p[3]);
    }
    for (const q of spots) {
      const gq = groundAt(q.x, q.y);
      dl.push(...toW(q.x, q.y, q.lo), ...toW(q.x, q.y, Math.max(gq, q.hi))); gd.push(...toW(q.x, q.y, gq));
    }
    const div = document.createElement("div"); div.className = "lbl"; div.textContent = s.name;
    const lab = new CSS2DObject(div); lab.position.set(...toW(s.x, s.y, hi));   // label sits at the platform, not up at ground level
    world.add(lab); labelObjs.push({ lab, div, major: nl >= 3 });
  }
  {
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(sp), 3));
    stationPts = new THREE.Points(g, new THREE.PointsMaterial({ size: 8, sizeAttenuation: false, transparent: true, alphaTest: 0.4 }));
    stationPts.frustumCulled = false; world.add(stationPts);
    const g4 = new THREE.BufferGeometry(); g4.setAttribute("position", new THREE.BufferAttribute(new Float32Array(gd), 3));
    stationGround = new THREE.Points(g4, new THREE.PointsMaterial({ size: 15, sizeAttenuation: false, transparent: true, alphaTest: 0.4 }));
    stationGround.frustumCulled = false; stationGround.renderOrder = 4; world.add(stationGround);
    const g2 = new THREE.BufferGeometry(); g2.setAttribute("position", new THREE.BufferAttribute(new Float32Array(dl), 3));
    dropLines = new THREE.LineSegments(g2, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.75 }));
    dropLines.frustumCulled = false; world.add(dropLines);
    // Tunnel mouths: an arch standing across the track (perpendicular to its direction, drawn as a distance field so it stays crisp at any zoom),
    // plus a flat threshold mark on the ground so it can still be seen from straight above. Size = max(portal metres, a minimum in pixels).
    {
      const n = net.portals.length, pos = new Float32Array(n * 3), ang = new Float32Array(n);
      net.portals.forEach((p, i) => { pos.set(toW(p[0], p[1], p[2]), i * 3); ang[i] = Math.atan2(-(p[4] ?? 0), p[3] ?? 1); });
      const mkGeom = (x0, x1, y0, y1) => {
        const g = new THREE.InstancedBufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0]), 3));
        g.setIndex([0, 1, 2, 0, 2, 3]);
        g.setAttribute("aPos", new THREE.InstancedBufferAttribute(pos, 3)); g.setAttribute("aAng", new THREE.InstancedBufferAttribute(ang, 1));
        g.instanceCount = n; return g;
      };
      const vert = `
        attribute vec3 aPos; attribute float aAng; uniform float uMetres, uHalfH, uPx; varying vec2 vP;
        void main() {
          vec3 t = vec3( cos( aAng ), 0.0, sin( aAng ) ), lat = vec3( - t.z, 0.0, t.x );
          float ex = modelMatrix[1][1];
          float depth = max( - ( modelViewMatrix * vec4( aPos, 1.0 ) ).z, 1.0 );
          float s = max( uMetres, uPx * depth / ( uHalfH * projectionMatrix[1][1] ) );
          vP = position.xy;
          #ifdef FLAT
            vec3 off = lat * position.x * s + t * position.y * s;
          #else
            vec3 off = lat * position.x * s + vec3( 0.0, position.y * s / ex, 0.0 );
          #endif
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4( aPos + off, 1.0 );
        }`;
      const frag = `
        uniform vec3 uRim, uEdge; varying vec2 vP;
        void main() {
          vec3 col = uEdge; float a = 0.0;
          #ifdef FLAT
            vec2 q = abs( vP ) - vec2( 1.15, 0.07 ); float d = length( max( q, 0.0 ) ) + min( max( q.x, q.y ), 0.0 ) - 0.05;
            float aa = fwidth( d ) + 1e-5;
            float fill = 1.0 - smoothstep( - aa, aa, d ), edge = ( 1.0 - smoothstep( - aa, aa, abs( d - 0.025 ) - 0.025 ) );
            col = mix( col, uRim, fill ); a = max( fill, edge ) * 0.95;
            col = mix( uEdge, uRim, smoothstep( 0.0, 0.05, - d - 0.0 ) );
          #else
            if ( vP.y < - 0.3 ) discard;   // open at the bottom: the arch stands on the ground
            float d = ( vP.y < 0.5 ) ? abs( vP.x ) - 1.0 : length( vP - vec2( 0.0, 0.5 ) ) - 1.0;
            float aa = fwidth( d ) + 1e-5;
            float rim = 1.0 - smoothstep( - aa, aa, abs( d + 0.07 ) - 0.07 );
            float edge = 1.0 - smoothstep( - aa, aa, abs( d - 0.025 ) - 0.025 );
            float inner = ( 1.0 - smoothstep( - aa, aa, d + 0.14 ) ) * 0.34 * smoothstep( - 0.85, - 0.14, d );
            a = inner; col = uEdge;
            col = mix( col, uRim, rim ); a = max( a, rim * 0.96 );
            col = mix( col, uEdge, edge ); a = max( a, edge * 0.9 );
          #endif
          if ( a < 0.01 ) discard;
          gl_FragColor = vec4( col, a );
          #include <colorspace_fragment>
        }`;
      portalPts = new THREE.Group();
      portalU.rim = { value: new THREE.Color(0xff7a1a) }; portalU.edge = { value: new THREE.Color(0x2a251d) };
      const mat = (flat) => new THREE.ShaderMaterial({
        vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false, side: THREE.DoubleSide, defines: flat ? { FLAT: 1 } : {},
        uniforms: { uMetres: portalU.m, uHalfH: portalU.h, uPx: { value: 6 }, uRim: portalU.rim, uEdge: portalU.edge },
      });
      const arch = new THREE.Mesh(mkGeom(-1.4, 1.4, -0.5, 1.75), mat(false)), mark = new THREE.Mesh(mkGeom(-1.4, 1.4, -0.3, 0.3), mat(true));
      for (const m of [arch, mark]) { m.frustumCulled = false; m.renderOrder = 5; portalPts.add(m); }
      world.add(portalPts);
    }
  }

  function applyTheme() {
    const t = THEMES[theme];
    document.body.classList.toggle("dark", theme === "dark");
    scene.background = new THREE.Color(t.bg);
    { const { minor, major } = groundPts.userData; minor.material.color.setHex(t.ground); major.material.color.setHex(t.ground); minor.material.opacity = t.groundOpacity * 1.6; major.material.opacity = t.groundOpacity * 3.2; }
    dropLines.material.color.setHex(t.drop);
    footLines.material.color.setHex(t.foot); footLines.material.opacity = t.footOpacity;
    if (roadsMajor) for (const [m, o] of [[roadsMajor, t.roadMajor], [roadsMinor, t.roadMinor]]) { if (m) { m.material.color.setHex(t.road); m.material.opacity = o; } }
    { const u = surfMesh.material.uniforms; u.uBase.value.setHex(t.surf); u.uAlpha.value = t.surfOpacity; u.uShade.value.setHex(t.shade); u.uLit.value.setHex(t.lit); }
    stationGround.material.map = circleTexture(t.marker, t.ring); stationGround.material.needsUpdate = true;
    if (waterGroup) {
      const { thames, others, canalsS, canalsU } = waterGroup.userData;
      thames.material.color.setHex(t.water); others.material.color.setHex(t.waterLight);
      if (canalsS) canalsS.material.color.setHex(t.water);
      if (canalsU) canalsU.material.color.setHex(t.waterLight);
    }
    stationPts.material.map = circleTexture(t.marker, t.ring); stationPts.material.needsUpdate = true;
    portalU.edge.value.set(t.ring);
  }
  applyTheme(); applyFade();
  $("bTheme").onclick = () => { theme = theme === "cream" ? "dark" : "cream"; applyTheme(); applyFade(); };
  $("bReset").onclick = resetView;
  $("ex").oninput = (e) => { EX = +e.target.value; $("exv").textContent = EX; world.scale.y = EX; };
  $("cSurface").onchange = (e) => (surfMesh.visible = e.target.checked);
  $("cWater").onchange = (e) => { if (waterGroup) waterGroup.visible = e.target.checked; };
  $("cScale").onchange = (e) => { trackScale.value = e.target.checked ? TRACK_M : 0; portalU.m.value = e.target.checked ? 7 : 0; };
  $("cFoot").onchange = (e) => (footLines.visible = e.target.checked);
  $("cGround").onchange = (e) => (groundPts.visible = e.target.checked);
  $("cDrops").onchange = (e) => (dropLines.visible = stationGround.visible = e.target.checked);
  $("cPortals").onchange = (e) => (portalPts.visible = e.target.checked);
  $("cLabels").onchange = (e) => (showLabels = e.target.checked);
  let showLabels = true;

  // ---------- street grid: faint vector roads draped on the terrain (optional data/roads.json, made by build_roads.py) ----------
  {
    const note = $("mapnote"), cb = $("cRoads");
    try {
      const rd = await fetch("data/roads.json").then((r) => { if (!r.ok) throw new Error("no roads.json"); return r.json(); });
      const mk = (cls, rank) => {
        if (!cls || !cls.o.length) return null;
        const c = cls.c, o = cls.o, pos = [];
        for (let p = 0; p < o.length - 1; p++) {
          let px = c[2 * o[p]], py = c[2 * o[p] + 1], pz = groundAt(px, py) + 3;
          for (let k = o[p] + 1; k < o[p + 1]; k++) {
            const X = c[2 * k], Y = c[2 * k + 1], n = Math.max(1, Math.ceil(Math.hypot(X - px, Y - py) / 100));   // long segments follow the terrain
            const sx = px, sy = py;
            for (let i = 1; i <= n; i++) {
              const x = sx + ((X - sx) * i) / n, y = sy + ((Y - sy) * i) / n, z = groundAt(x, y) + 3;
              pos.push(px, pz, -py, x, z, -y); px = x; py = y; pz = z;
            }
          }
        }
        const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
        const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ transparent: true, depthWrite: false }));
        l.frustumCulled = false; l.renderOrder = rank; world.add(l); return l;
      };
      roadsMinor = mk(rd.minor, 2.2); roadsMajor = mk(rd.major, 2.3);
      cb.disabled = false; cb.checked = true; note.textContent = "";
      cb.onchange = (e) => { if (roadsMinor) roadsMinor.visible = e.target.checked; if (roadsMajor) roadsMajor.visible = e.target.checked; };
      applyTheme();
    } catch (e) { note.textContent = "Add data/roads.json to enable (see README)."; }
  }

  // ---------- hover tooltip ----------
  const tip = $("tip"); const tmp = new THREE.Vector3();
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointermove", (ev) => {
    let best = null, bd = 12;
    for (const m of platformMarkers) {
      tmp.set(...toW(m.x, m.y, m.z)); tmp.y *= EX; tmp.project(camera);
      if (tmp.z > 1) continue;
      const sx = (tmp.x * 0.5 + 0.5) * innerWidth, sy = (-tmp.y * 0.5 + 0.5) * innerHeight;
      const d = Math.hypot(sx - ev.clientX, sy - ev.clientY);
      if (d < bd) { bd = d; best = m; }
    }
    if (!best) { tip.style.display = "none"; return; }
    const depth = best.ground - best.z;
    tip.innerHTML = `<b>${best.name}</b><br>${best.line} line<br>platform ${best.z.toFixed(0)} m above sea level<br>` +
      (depth > 1 ? `${depth.toFixed(0)} m below the terrain` : depth < -1 ? `${(-depth).toFixed(0)} m above the terrain` : "at ground level");
    tip.style.display = "block"; tip.style.left = ev.clientX + 14 + "px"; tip.style.top = ev.clientY + 14 + "px";
  });
  canvas.addEventListener("pointerleave", () => (tip.style.display = "none"));

  // ---------- simulated trains ----------
  const trains = createTrains({ net, world, scene, camera, groundAt, order, getEX: () => EX, getBg: () => new THREE.Color(THEMES[theme].bg), getBelow: () => below });
  $("cTrains").addEventListener("change", (e) => (trains.visible = e.target.checked));
  $("tSpeed").addEventListener("change", (e) => (trains.speed = +e.target.value));
  trains.speed = +$("tSpeed").value;
  $("tMode").addEventListener("change", (e) => { trains.mode = e.target.value; $("tSpeedWrap").style.display = trains.mode === "sim" ? "" : "none"; });
  const clockEl = $("tClock"); let lastT = performance.now();

  // ---------- loop ----------
  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false); labelRenderer.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    for (const m of lineMats) m.resolution.set(w, h);
  }
  addEventListener("resize", resize); resize();
  const wp = new THREE.Vector3();
  function frame() {
    controls.update();
    if (stationGround) stationGround.material.size = Math.min(15, Math.max(5, 15 * Math.pow(2500 / camera.position.distanceTo(controls.target), 0.6)));
    const nb = camera.position.y < (groundAt(camera.position.x, -camera.position.z) - 5) * EX;
    if (nb !== below) { below = nb; applyFade(); }
    for (const o of labelObjs) {
      o.lab.getWorldPosition(wp);
      const d = camera.position.distanceTo(wp);
      const limit = o.major ? 26000 : 9000;
      const op = showLabels ? Math.max(0, Math.min(1, (limit - d) / (limit * 0.35))) : 0;
      o.div.style.opacity = op; o.div.style.display = op > 0.02 ? "" : "none";
    }
    { const now = performance.now(), dt = Math.min(0.1, (now - lastT) / 1000); lastT = now; trains.update(dt);
      const L = trains.live, hhmm = (c0) => { const c = Math.floor(c0) % 86400; return String(Math.floor(c / 3600)).padStart(2, "0") + ":" + String(Math.floor((c % 3600) / 60)).padStart(2, "0"); };
      clockEl.textContent = trains.mode === "sim" ? hhmm(trains.clock) + " · " + trains.count + " trains"
        : L.loading ? "loading live data…" : L.ok ? "live · " + trains.count + " trains" : "feed unavailable · simulated " + hhmm(trains.clock); }
    portalU.h.value = renderer.domElement.height / 2;
    renderer.render(scene, camera); labelRenderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  msg.style.display = "none";
  window.__v = { camera, controls, world, THREE, trains, renderer, scene };
  window.__ready = true;
  frame();
}
main();
