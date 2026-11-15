// Simulated trains. Every route relation in network.json is one direction of one service: a continuous path with an ordered station list.
// Trains are a pure function of the clock (position = f(time)), so the speed control, pausing and later swapping in live data are all trivial.
// Nothing here is real timetable data: frequencies are typical-day headways per line, running times come from a simple accelerate/cruise/brake model.
import * as THREE from "three";
import { createLive } from "./live.js";

const HEADWAY = { Victoria: 105, Central: 150, Northern: 135, Jubilee: 150, Piccadilly: 150, Bakerloo: 180, District: 240, Circle: 330, "Hammersmith & City": 330, Metropolitan: 300, "Waterloo & City": 270 };
const MARK_PX = 9, ACC = 1.0, V_TUNNEL = 17, V_SURFACE = 22, DWELL = 25, CARS = 6, CAR_L = 17, CAR_W = 2.9, CAR_H = 3.6, STEP = 30, HALF_BUNDLE = 2.25;

export function createTrains({ net, world, scene, camera, groundAt, order, getEX, getBg, getBelow }) {
  const ways = new Map(net.ways.map((w) => [w.id, w]));
  const stByName = new Map(net.stations.map((s) => [s.name, s]));
  const findSt = (name) => stByName.get(name) || stByName.get(name.replace(/\s*\(.*\)\s*$/, "")) || stByName.get(name.replace(/^London /, "")) || null;
  const nRel = {}; for (const r of net.relations) nRel[r.line] = (nRel[r.line] || 0) + 1;

  const routes = [];
  for (const r of net.relations) {
    // --- path: ways joined in order, densified every 30 m, snapped to the same ground rule as the drawn lines (tunnels never above it, surface never below) ---
    const X = [], Y = [], Z = [], U = [], OX = [], OY = [];
    for (const [wid, rev] of r.ways) {
      const w = ways.get(wid); if (!w) continue;
      let pts = rev ? w.pts.slice().reverse() : w.pts;
      const f = w.pts[0], l = w.pts[w.pts.length - 1];
      const canonFwd = !(l[0] < f[0] || (l[0] === f[0] && l[1] < f[1])), same = canonFwd === !rev;   // is the direction of travel the canonical one the drawn stripes use?
      const ls = order.filter((n) => w.lines.includes(n)), n = ls.length, i = Math.max(0, ls.indexOf(r.line)), H = 1 + 0.7 * (n - 1);
      const lo = -H + (2 * H * i) / n, hi = -H + (2 * H * (i + 1)) / n, c = (((lo + hi) / 2) / H) * HALF_BUNDLE;   // lateral centre of this line's stripe, metres
      const dense = [];
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k];
        if (k > 0) { const p = pts[k - 1], m = Math.max(1, Math.ceil(Math.hypot(a[0] - p[0], a[1] - p[1]) / STEP)); for (let j = 1; j < m; j++) { const t = j / m; dense.push([p[0] + (a[0] - p[0]) * t, p[1] + (a[1] - p[1]) * t, p[2] + (a[2] - p[2]) * t]); } }
        dense.push(a);
      }
      for (let k = 0; k < dense.length; k++) {
        if (X.length && k === 0 && Math.hypot(dense[0][0] - X[X.length - 1], dense[0][1] - Y[Y.length - 1]) < 1) continue;   // shared joint
        const q = dense[k], p0 = dense[Math.max(0, k - 1)], p1 = dense[Math.min(dense.length - 1, k + 1)];
        let dx = p1[0] - p0[0], dy = p1[1] - p0[1]; const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
        if (!same) { dx = -dx; dy = -dy; }                    // canonical direction
        const g = groundAt(q[0], q[1]);
        X.push(q[0]); Y.push(q[1]); Z.push(w.cls === "U" ? Math.min(q[2], g) : Math.max(q[2], g)); U.push(w.cls === "U" ? 1 : 0);
        OX.push(dy * c); OY.push(-dx * c);                    // right of the canonical direction, as the line shader does
      }
    }
    if (X.length < 2 || r.stations.length < 2) continue;
    const cum = [0]; for (let k = 1; k < X.length; k++) cum.push(cum[k - 1] + Math.hypot(X[k] - X[k - 1], Y[k] - Y[k - 1]));
    // --- stations: project each onto the path, moving forward only ---
    const S = []; let prev = 0;
    for (const [name, ch] of r.stations) {
      const st = findSt(name); let sx, sy;
      if (st) { const pl = st.platforms.find((p) => p[0] === r.line); sx = pl ? pl[1] : st.x; sy = pl ? pl[2] : st.y; }
      let exp = 0; { let lo = 0, hi = cum.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cum[m] <= ch) lo = m; else hi = m - 1; } exp = lo; }
      let best = -1, bd = Infinity;
      for (let k = Math.max(prev, exp - 25); k < Math.min(X.length, exp + 25); k++) { const d = st ? Math.hypot(X[k] - sx, Y[k] - sy) : Math.abs(k - exp); if (d < bd) { bd = d; best = k; } }
      if (best < 0) best = Math.min(X.length - 1, Math.max(prev, exp));
      S.push(cum[best]); prev = best;
    }
    for (let i = 1; i < S.length; i++) if (S[i] <= S[i - 1]) S[i] = S[i - 1] + 50;   // keep strictly increasing
    // --- timetable for one run: arrival / departure at each stop, and the speed profile of each hop ---
    const arr = [0], dep = [0], seg = [];
    const idxAt = (s) => { let lo = 0, hi = cum.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cum[m] <= s) lo = m; else hi = m - 1; } return lo; };
    for (let i = 0; i < S.length - 1; i++) {
      const d = S[i + 1] - S[i], a = idxAt(S[i]), b = idxAt(S[i + 1]); let su = 0; for (let k = a; k <= b; k++) su += U[k];
      const vmax = su / (b - a + 1) > 0.5 ? V_TUNNEL : V_SURFACE, tri = d < (vmax * vmax) / ACC, vp = tri ? Math.sqrt(d * ACC) : vmax;
      const ta = vp / ACC, tc = tri ? 0 : (d - vmax * vmax / ACC) / vmax;
      seg.push({ d, vp, ta, tc, T: 2 * ta + tc });
      arr.push(dep[i] + 2 * ta + tc); dep.push(arr[i + 1] + DWELL);
    }
    dep[dep.length - 1] = arr[arr.length - 1];
    const dur = arr[arr.length - 1] + 8;
    const head = Math.min(900, Math.max(100, (HEADWAY[r.line] || 240) * nRel[r.line] / 2));
    routes.push({ stNames: r.stations.map((x) => x[0]), line: r.line, name: r.name, X, Y, Z, U, OX, OY, cum, S, arr, dep, seg, dur, head, phase: (routes.length * 37.7) % head, L: cum[cum.length - 1] });
  }

  // ---- drawing: one instanced box per car plus a slightly larger dark back-face hull as its outline; tunnel cars and surface cars are separate meshes so tunnel cars sit behind the ground veil ----
  const MAXC = 6000, geo = new THREE.BoxGeometry(1, 1, 1);
  const mkMesh = (side, col) => { const m = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial(side ? { color: col, side } : {}), MAXC); m.frustumCulled = false; world.add(m); return m; };
  const meshU = mkMesh(), meshS = mkMesh(), outU = mkMesh(THREE.BackSide, 0xf4eee0), outS = mkMesh(THREE.BackSide, 0xf4eee0);
  // far-away markers: a train is only ~1 px wide from high up, so each train also gets a screen-sized disc (line colour, white + dark ring) that fades out as the real cars become visible
  const MAXT = 2000;
  const mkMarkers = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAXT * 3), 3)); g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(MAXT * 3), 3)); g.setAttribute("size", new THREE.BufferAttribute(new Float32Array(MAXT), 1));
    const m = new THREE.Points(g, new THREE.ShaderMaterial({
      transparent: true, depthTest: false, depthWrite: false, uniforms: { uPR: { value: Math.min(window.devicePixelRatio || 1, 2) } },
      vertexShader: "attribute float size; attribute vec3 color; varying vec3 vC; uniform float uPR; void main(){ vC = color; gl_PointSize = size * uPR; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader: "varying vec3 vC; void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard; vec3 c = r > 0.80 ? vec3(0.09, 0.07, 0.05) : (r > 0.58 ? vec3(1.0, 0.98, 0.94) : vC); gl_FragColor = vec4(c, 1.0); }",
    }));
    m.frustumCulled = false; world.add(m); return m;
  };
  const markU = mkMarkers(), markS = mkMarkers();
  const colour = {}; for (const l in net.line_colours) colour[l] = new THREE.Color(net.line_colours[l]);
  const dummy = new THREE.Object3D(), tmpC = new THREE.Color(), bgC = new THREE.Color(), dark = new THREE.Color(0x16120e), wp = new THREE.Vector3(), fwd = new THREE.Vector3();
  const api = { visible: true, clock: 8 * 3600, speed: 30, count: 0, mode: "live" };
  const live = createLive({ routes }); let fb = false; api.live = live;

  const posOn = (r, s, out) => {   // s metres along the route -> out = [x, y, z, fx, fy, fz, class]
    s = Math.max(0, Math.min(r.L, s));
    let lo = 0, hi = r.cum.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (r.cum[m] <= s) lo = m; else hi = m - 1; }
    const a = lo, b = Math.min(r.cum.length - 1, a + 1), seglen = r.cum[b] - r.cum[a] || 1, t = (s - r.cum[a]) / seglen;
    out[0] = r.X[a] + (r.X[b] - r.X[a]) * t + r.OX[a] + (r.OX[b] - r.OX[a]) * t;
    out[1] = r.Y[a] + (r.Y[b] - r.Y[a]) * t + r.OY[a] + (r.OY[b] - r.OY[a]) * t;
    out[2] = r.Z[a] + (r.Z[b] - r.Z[a]) * t;
    out[3] = r.X[b] - r.X[a]; out[4] = r.Y[b] - r.Y[a]; out[5] = r.Z[b] - r.Z[a]; out[6] = r.U[a];
    return out;
  };
  const headS = (r, age) => {   // distance of the train's front along the route at a given age
    const { arr, dep, seg, S } = r; let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (arr[m] <= age) lo = m; else hi = m - 1; }
    const i = lo; if (i >= seg.length) return S[S.length - 1];
    if (age <= dep[i]) return S[i];
    const u = age - dep[i], sg = seg[i]; let x;
    if (u < sg.ta) x = 0.5 * ACC * u * u; else if (u < sg.ta + sg.tc) x = 0.5 * ACC * sg.ta * sg.ta + sg.vp * (u - sg.ta); else { const w = sg.T - u; x = sg.d - 0.5 * ACC * w * w; }
    return S[i] + Math.min(sg.d, Math.max(0, x));
  };

  const p = [0, 0, 0, 0, 0, 0, 0];
  api.update = (dtReal) => {
    for (const m of [meshU, meshS, outU, outS, markU, markS]) m.visible = api.visible; if (!api.visible) return;
    const EX = getEX(), below = getBelow(), fov = Math.tan((camera.fov * Math.PI) / 360) * 2 / innerHeight;
    bgC.copy(getBg());
    let nU = 0, nS = 0, mU = 0, mS = 0;
    // which trains to draw: live TfL predictions, or (fallback / by choice) the simulated timetable
    const items = [], liveOn = api.mode === "live";
    if (liveOn) live.start();
    if (liveOn && live.ok) { fb = false; live.collect(items, dtReal); }
    else if (!(liveOn && live.loading)) {
      if (liveOn && !fb) { fb = true; const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(new Date()); api.clock = +p[0].value * 3600 + +p[2].value * 60 + +p[4].value; }
      api.clock += dtReal * (liveOn ? 1 : api.speed);
      for (const r of routes) {
        const nMax = Math.floor((api.clock - r.phase) / r.head), nMin = Math.ceil((api.clock - r.phase - r.dur) / r.head);
        for (let n = nMin; n <= nMax; n++) items.push({ r, hs: headS(r, api.clock - r.phase - n * r.head) });
      }
    }
    api.live_ = liveOn && live.ok;
    for (const { r, hs } of items) {
      {
        posOn(r, hs, p); wp.set(p[0], p[2] * EX, -p[1]);
        const trainPx = (CARS * CAR_L * 1.1) / (camera.position.distanceTo(wp) * fov), msz = MARK_PX * Math.min(1, Math.max(0, (140 - trainPx) / 100));
        if (msz > 0.8) {
          const tun = p[6] === 1, mk = tun ? markU : markS, j = tun ? mU++ : mS++;
          if (j < MAXT) {
            const a = mk.geometry.attributes; a.position.setXYZ(j, p[0], p[2], -p[1]); a.size.setX(j, msz);
            tmpC.copy(colour[r.line] || dark); const bh = tun ? !below : below; if (bh) tmpC.lerp(below ? dark : bgC, 0.22); a.color.setXYZ(j, tmpC.r, tmpC.g, tmpC.b);
          }
        }
        wp.set(r.X[0], 0, 0);
        for (let k = 0; k < CARS; k++) {
          const s0 = hs - (k - (CARS - 1) / 2) * CAR_L * 1.1; if (s0 < 0 || s0 > r.L) continue;
          posOn(r, s0, p); wp.set(p[0], p[2] * EX, -p[1]);
          // size grows with distance so a car never drops below about 1.5 px (same idea as the tunnels), but stays slim when zoomed out
          const mpp = camera.position.distanceTo(wp) * fov, L = Math.max(CAR_L, 2.4 * mpp), W = Math.max(CAR_W, 1.3 * mpp), Hh = Math.max(CAR_H, 1.3 * mpp), o = Math.max(0.4, 0.7 * mpp);
          const sc = hs - (k - (CARS - 1) / 2) * L * 1.1; if (sc < 0 || sc > r.L) continue;
          posOn(r, sc, p);
          const tunnel = p[6] === 1, i = tunnel ? nU++ : nS++; if (i >= MAXC) continue;
          const mesh = tunnel ? meshU : meshS, out = tunnel ? outU : outS;
          dummy.position.set(p[0], p[2], -p[1]);   // centred on the track line, so the car sits inside the tube
          fwd.set(p[3], p[5], -p[4]); dummy.lookAt(dummy.position.x + fwd.x, dummy.position.y + fwd.y, dummy.position.z + fwd.z);
          dummy.scale.set(W, Hh / EX, L); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
          dummy.scale.set(W + 2 * o, (Hh + 2 * o) / EX, L + 2 * o); dummy.updateMatrix(); out.setMatrixAt(i, dummy.matrix);
          tmpC.copy(colour[r.line] || dark).lerp(dark, 0.38);                                  // darker than the line, on the surface and in tunnels alike
          const behind = tunnel ? !below : below; if (behind) tmpC.lerp(below ? dark : bgC, 0.22);   // behind the ground: slightly tinted, like the lines
          mesh.setColorAt(i, tmpC);
        }
      }
    }
    meshU.count = outU.count = Math.min(nU, MAXC); meshS.count = outS.count = Math.min(nS, MAXC); api.count = items.length;
    for (const m of [meshU, meshS, outU, outS]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    for (const [mk, n] of [[markU, mU], [markS, mS]]) { mk.visible = api.visible; mk.geometry.setDrawRange(0, Math.min(n, MAXT)); for (const k of ["position", "color", "size"]) mk.geometry.attributes[k].needsUpdate = true; }
    markU.renderOrder = below ? 3.4 : 1.4; markS.renderOrder = below ? 1.4 : 3.4;
    meshU.renderOrder = below ? 3.2 : 1.2; meshS.renderOrder = below ? 1.2 : 3.2;
    outU.renderOrder = meshU.renderOrder - 0.01; outS.renderOrder = meshS.renderOrder - 0.01;
  };
  api.routes = routes;
  api.sample = () => { const out = []; for (const r of routes) { const nMax = Math.floor((api.clock - r.phase) / r.head), nMin = Math.ceil((api.clock - r.phase - r.dur) / r.head); for (let n = nMin; n <= nMax; n++) { const age = api.clock - r.phase - n * r.head; posOn(r, headS(r, age), p); out.push([r.line, p[0], p[1], p[2], p[6], age < 0 ? 0 : 1]); } } return out; };
  api.counts = () => [meshU.count, meshS.count];
  api.stopError = () => { let w = [0, '', 0, 0]; for (const r of routes) for (let i = 0; i < r.S.length; i++) { posOn(r, r.S[i], p); const st = findSt(r.stNames[i]); if (!st) continue; const pl = st.platforms.find((q) => q[0] === r.line), sx = pl ? pl[1] : st.x, sy = pl ? pl[2] : st.y, d = Math.hypot(p[0] - sx, p[1] - sy); w[3]++; if (d > 80) w[2]++; if (d > w[0]) { w[0] = d; w[1] = r.line + ' ' + r.stNames[i]; } } return w; };
  return api;
}
