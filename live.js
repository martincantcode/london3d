// Live trains from the TfL Unified API (arrivals predictions). TfL publishes NO train positions: only "vehicle X reaches station Y at time T" predictions.
// So each train is placed between the stations of its predicted stops by interpolating those times along our route geometry. This is an estimate, not GPS.
// No API key: anonymous access is rate limited per caller (50 requests/min); we make 1 request per 30 s (or 11 if the combined request is refused).
// Data: Transport for London Open Data (Powered by TfL Open Data).
const LINES = { bakerloo: "Bakerloo", central: "Central", circle: "Circle", district: "District", "hammersmith-city": "Hammersmith & City", jubilee: "Jubilee", metropolitan: "Metropolitan", northern: "Northern", piccadilly: "Piccadilly", victoria: "Victoria", "waterloo-city": "Waterloo & City" };
const BASE = "https://api.tfl.gov.uk/Line/", POLL_MS = 30000, ACC = 1.0, DWELL = 25;

const norm = (s, keepParen) => (keepParen ? s.replace(/[()]/g, " ") : s.replace(/\(.*?\)/g, " "))
  .toLowerCase().replace(/&/g, " and ").replace(/\b(underground|rail|station|dlr)\b/g, " ").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

export function createLive({ routes }) {
  const api = { ok: false, loading: true, error: "", lastOk: 0, vehicles: 0, unmatched: new Map(), perLine: false, polls: 0, badVeh: [] };
  // per route: normalised station name -> indices in the route (a loop can visit a station twice)
  const byLine = {};
  for (const r of routes) {
    const m = new Map(); r.stNames.forEach((n, i) => { for (const k of new Set([norm(n), norm(n, true)])) { if (!m.has(k)) m.set(k, []); m.get(k).push(i); } });
    r.nameIdx = m; r.destNorm = norm(r.stNames[r.stNames.length - 1]); (byLine[r.line] = byLine[r.line] || []).push(r);
  }
  const veh = new Map();   // "line|vehicleId" -> { r, ix[], t[] (local ms), disp }

  function ingest(preds, fetchedAt) {
    // expectedArrival is absolute and does not depend on how old the cached response is; if the visitor's clock is far off, fall back to arrival-relative times
    const diffs = preds.slice(0, 400).map((p) => Date.parse(p.expectedArrival) - (fetchedAt + p.timeToStation * 1000)).filter((d) => !isNaN(d)).sort((a, b) => a - b);
    const useAbs = diffs.length > 0 && Math.abs(diffs[diffs.length >> 1]) < 60000;
    const groups = new Map();
    for (const p of preds) {
      const line = LINES[p.lineId]; if (!line || !p.vehicleId || p.vehicleId === "000" || typeof p.timeToStation !== "number" || !byLine[line]) continue;
      const k = line + "|" + p.vehicleId; let g = groups.get(k); if (!g) groups.set(k, (g = { line, list: [] }));
      g.list.push({ name: p.stationName || "", t: useAbs ? Date.parse(p.expectedArrival) : fetchedAt + p.timeToStation * 1000, dest: norm(p.destinationName || p.towards || "") });
    }
    api.badVeh = [];
    for (const [k, g] of groups) {
      g.list.sort((a, b) => a.t - b.t);
      let best = null;
      for (const r of byLine[g.line]) {
        const ix = [], t = []; let prev = -1, score = 0;
        for (const q of g.list) {
          const c = r.nameIdx.get(norm(q.name)) || r.nameIdx.get(norm(q.name, true)); if (!c) continue;
          const j = c.find((i) => i > prev); if (j === undefined) continue;
          ix.push(j); t.push(q.t); prev = j; score += 10;
        }
        if (!ix.length) continue;
        if (g.list[0].dest && g.list[0].dest === r.destNorm) score += 5;
        if (!best || score > best.score) best = { r, ix, t, score };
      }
      if (!best) { for (const q of g.list) api.unmatched.set(q.name, (api.unmatched.get(q.name) || 0) + 1); api.badVeh.push({ k, stops: g.list.map((q) => q.name + " @" + Math.round((q.t - fetchedAt) / 1000) + "s") }); continue; }
      const old = veh.get(k); let ix = best.ix, t = best.t;
      if (old && old.r === best.r) {   // the feed only lists upcoming stops: remember the stop it just left so the motion stays continuous
        let a = -1; for (let i = 0; i < old.ix.length; i++) if (old.ix[i] < ix[0] && old.t[i] <= Date.now() + 5000) a = i;
        if (a >= 0) { ix = [old.ix[a], ...ix]; t = [old.t[a], ...t]; }
      }
      veh.set(k, { r: best.r, ix, t, disp: old && old.r === best.r ? old.disp : undefined, seen: Date.now() });
    }
    for (const [k, v] of [...veh]) if (Date.now() - v.seen > 75000 || v.t[v.t.length - 1] < Date.now() - 60000) veh.delete(k);
    api.vehicles = veh.size;
  }

  async function getJSON(url) { const res = await fetch(url, { cache: "no-store" }); if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); }
  async function poll() {
    api.polls++;
    try {
      let preds;
      if (!api.perLine) {
        try { preds = await getJSON(BASE + Object.keys(LINES).join(",") + "/Arrivals"); }
        catch (e) { api.perLine = true; }
      }
      if (api.perLine) preds = (await Promise.all(Object.keys(LINES).map((l) => getJSON(BASE + l + "/Arrivals").catch(() => [])))).flat();
      if (!Array.isArray(preds) || !preds.length) throw new Error("empty response");
      ingest(preds, Date.now()); api.ok = true; api.loading = false; api.lastOk = Date.now(); api.error = "";
    } catch (e) { api.error = String(e.message || e); api.loading = false; if (Date.now() - api.lastOk > 120000) api.ok = false; }
  }
  let timer = 0;
  api.start = () => { if (timer) return; poll(); timer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS); };
  api.stop = () => { clearInterval(timer); timer = 0; };

  // distance a train covers in `rem` seconds before arriving: braking at ACC for the last 17 s, cruising before that
  const brakeD = (rem) => (rem < 17 ? 0.5 * ACC * rem * rem : 144.5 + 17 * (rem - 17));
  const target = (v, now) => {
    const { r, ix, t } = v, n = ix.length, S = r.S;
    if (now <= t[0]) {   // before the first known stop: assume the hop from the previous station takes dist/14 s (at least 30 s)
      const prev = ix[0] > 0 ? S[ix[0] - 1] : S[ix[0]], d = S[ix[0]] - prev, T = Math.max(30, d / 14) * 1000, u = Math.max(0, 1 - (t[0] - now) / T);
      return prev + d * (u * u * (3 - 2 * u));
    }
    for (let k = 1; k < n; k++) {
      if (now <= t[k]) {
        const gap = t[k] - t[k - 1], dw = Math.min(DWELL * 1000, gap * 0.4), u = Math.max(0, (now - t[k - 1] - dw) / (gap - dw || 1));
        return S[ix[k - 1]] + (S[ix[k]] - S[ix[k - 1]]) * (u * u * (3 - 2 * u));
      }
    }
    return S[ix[n - 1]];
  };
  // each train is moved by a follower with a speed limit (0..22 m/s, never backwards): when a refresh revises the estimate the train glides to it over ~15 s instead of jumping
  api.collect = (items, dt) => {
    const now = Date.now();
    for (const v of veh.values()) {
      const tg = target(v, now);
      if (v.disp === undefined || Math.abs(tg - v.disp) > 1500) v.disp = tg;
      else { const rate = target(v, now + 1000) - tg, vel = Math.min(22, Math.max(0, rate + (tg - v.disp) / 15)); v.disp += vel * dt; }
      items.push({ r: v.r, hs: v.disp });
    }
  };
  api.stats = () => ({ vehicles: veh.size, ok: api.ok, error: api.error, perLine: api.perLine, ageS: api.lastOk ? Math.round((Date.now() - api.lastOk) / 1000) : null, unmatchedVehicles: api.badVeh.slice(0, 6), unmatchedStations: [...api.unmatched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20) });
  return api;
}
