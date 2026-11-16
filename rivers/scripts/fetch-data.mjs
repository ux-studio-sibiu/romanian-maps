// Builds data/rivers.js: Romania's river network, ready to draw and animate.
// Plain Node 18+, no dependencies.
//
//   node scripts/fetch-data.mjs
//
// Rivers come from OpenStreetMap through the Overpass API (every
// waterway=river in Romania plus the border rivers, cached in scripts/.cache —
// delete it to fetch fresh). Outlines come from scripts/source/, cut out of the Natural
// Earth 1:50m countries file in ../../carbon-divide, and the Black Sea, cut out of the
// 1:10m marine areas in ../romanian-borders.
//
// OSM draws a waterway in the direction it flows, so the ways chain into a
// directed network, sources to the sea. From that, per stretch of river:
//   - size class: 1 + log2 of how many distinct headwaters feed it. A measure
//     of size that needs no discharge data (see `order` below for why not
//     Strahler order, the textbook choice).
//   - distance to the sea (or to wherever the network leaves the map), which
//     times the animation: the page reveals rivers from the mouth upstream,
//     and the flowing pulses line up across junctions because they are placed
//     by it.
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

const ROOT = new URL("../", import.meta.url);
const CACHE = new URL("scripts/.cache/", ROOT);
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];

// Every river in Romania's area, plus the border rivers from a box around it:
// the Danube, Prut and Tisa run along the border, and an area query alone cuts
// every stretch whose nodes fall just outside. (A plain box was the first
// version — 42 MB, half of it the neighbours' rivers.) Ways are filtered back
// down to Romania below.
//
// `out tags geom`: tags and coordinates, without each way's list of node ids.
// Ways that meet share a node, and a shared node has identical coordinates,
// so the coordinates alone say where the network joins.
const BBOX = "43.4,20.0,48.5,30.2";
const BORDER_NAMES = "Dun[aă]r|Дунав|Danube|Duna|Prut|Tisa|Tisza|Тиса|Chilia|Кілі";
const QUERY = `[out:json][timeout:300];area["ISO3166-1"="RO"][admin_level=2]->.ro;(way["waterway"="river"](area.ro);way["waterway"="river"]["name"~"${BORDER_NAMES}"](${BBOX}););out tags geom;`;
// Motorways, trunk roads (the main national roads) and primary roads, for
// the Highways and Roads layers. ~51 MB, the biggest download here; cut to a
// few hundred kB below.
const ROADS_QUERY = `[out:json][timeout:300];area["ISO3166-1"="RO"][admin_level=2]->.ro;way["highway"~"^(motorway|trunk|primary)$"](area.ro);out tags geom;`;
// Cities and towns with a population, for the city layer. A few hundred
// nodes, so a few kB.
const TOWNS_QUERY = `[out:json][timeout:120];area["ISO3166-1"="RO"][admin_level=2]->.ro;node["place"~"^(city|town)$"]["population"](area.ro);out body;`;

async function overpass(name, query) {
  const file = new URL(`${name}.json`, CACHE);
  if (existsSync(file)) return JSON.parse(await readFile(file, "utf8"));
  // The public servers are often full (502/504/429). Back off and retry,
  // cycling through the mirrors.
  let json;
  for (let attempt = 0; attempt < 6 && !json; attempt++) {
    const server = OVERPASS[attempt % OVERPASS.length];
    console.log(`fetching ${name} from ${new URL(server).host}…`);
    try {
      const res = await fetch(server, {
        method: "POST",
        // Overpass turns away requests that do not say who is asking (406).
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          "user-agent": "romanian-maps-rivers/0.1 (personal map prototype)",
        },
        body: "data=" + encodeURIComponent(query),
      });
      if (res.ok) json = await res.json();
      else console.log(`  ${res.status}, retrying`);
    } catch (err) {
      console.log(`  ${err.message}, retrying`);
    }
    if (!json) await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  if (!json) throw new Error(`Overpass ${name}: every attempt failed`);
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, JSON.stringify(json));
  return json;
}

const round = (n) => Math.round(n * 1e4) / 1e4;

// Great-circle distance, km.
const R = Math.PI / 180;
function km(a, b) {
  const d = Math.sin(((b[1] - a[1]) * R) / 2) ** 2 + Math.cos(a[1] * R) * Math.cos(b[1] * R) * Math.sin(((b[0] - a[0]) * R) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(d));
}

// --- Outlines ---------------------------------------------------------------
const rings = (geometry) => (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates).map((poly) => poly[0]);
const romania = rings(JSON.parse(await readFile(new URL("scripts/source/romania.geojson", ROOT), "utf8")).geometry);
const neighbours = JSON.parse(await readFile(new URL("scripts/source/neighbours.geojson", ROOT), "utf8")).features.map((f) => ({
  name: f.properties.name,
  rings: rings(f.geometry).map((ring) => ring.map(([x, y]) => [round(x), round(y)])),
}));

// Ray casting. The Natural Earth outline is coarse and the border follows the
// middle of the Danube and the Prut, so a point also counts if it is inside
// once nudged ~4 km in any direction.
function inside([x, y]) {
  let hit = false;
  for (const ring of romania)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
  return hit;
}
const nearRomania = ([x, y], nudge) => inside([x, y]) || inside([x + nudge, y]) || inside([x - nudge, y]) || inside([x, y + nudge]) || inside([x, y - nudge]);

// The three border rivers get a wider margin (~12 km). Against the coarse
// outline, whole stretches of the Danube sit more than 4 km "outside" — one
// near Giurgiu was dropped, and the river upstream of it ended in a false sea.
const BORDER_RIVER = /Dun[aă]r|Дунав|Danube|\bDuna\b|Dunav|Prut|Tisa|Tisza|Тиса/i;
const isBorderRiver = (tags = {}) => [tags.name, tags["name:ro"], tags["name:en"]].some((n) => n && BORDER_RIVER.test(n));

// --- West: on to the Tisza and the Danube ------------------------------------
// The rivers that leave Romania westwards do not end at the border: they cross
// Hungary and Serbia, under other names, into the Tisza, which meets the
// Danube at Slankamen. A second, small query fetches that onward water: the
// Tisza from its source in Ukraine, the continuations (the Mureș is the Maros
// there, the Someș the Szamos, the Crișuri and the Barcău the Körös rivers and
// the Berettyó, the Timiș the Tamiš, the Caraș the Karaš, the Bega the
// Begej), and the Danube upstream from the Romanian border, past the Tisza's
// mouth and Budapest, to where the terrain picture begins (18.5° E, by
// Esztergom).
const WEST_NAMES = "Tisza|Тиса|Tisa|Szamos|Kraszna|Túr|Berettyó|Sebes-Körös|Fekete-Körös|Fehér-Körös|Kettős-Körös|Hármas-Körös|Körös|Maros|Бегеј|Begej|Тамиш|Tamiš|Караш|Karaš";
const WEST_QUERY =
  `[out:json][timeout:300];(way["waterway"="river"]["name"~"^(${WEST_NAMES})"](43.4,19.0,48.6,25.0);` +
  `way["waterway"="river"]["name"~"Дунав|Dunav|Duna"](44.5,18.5,48.0,21.6););out tags geom;`;
// And the Chilia arm's own little delta. The Delta's northern arm, the border
// with Ukraine, splits at Vylkove into arms named only in Ukrainian
// (Старостамбульське, Очаківське, Білгородське гирло...), so neither query
// above caught them, and the arm stopped ~15 km short of the sea. Every river
// in that small box is fetched.
const CHILIA_QUERY = `[out:json][timeout:120];way["waterway"="river"](45.2,29.4,45.6,29.85);out tags geom;`;
const westIds = new Set();
const westWays = [
  ...(await overpass("rivers-west-danube", WEST_QUERY)).elements,
  ...(await overpass("chilia-delta", CHILIA_QUERY)).elements,
].filter((el, i, all) => el.type === "way" && el.geometry?.length > 1 && all.findIndex((o) => o.id === el.id) === i);
westWays.forEach((w) => westIds.add(w.id));

// --- Network ----------------------------------------------------------------
const raw = await overpass("rivers-ro", QUERY);
const ways = [...raw.elements.filter((el) => el.type === "way" && el.geometry?.length > 1 && !westIds.has(el.id)), ...westWays];
// Old riverbeds are left out: where a river was straightened, OSM keeps the
// abandoned meanders as a river too ("Jijia Veche", the old Jijia), and drawn
// beside the new course they read as a tangle. Not round the Danube, whose
// old channels are real arms of the Delta.
const OLD_BED = /\b(Veche|Vechi)\b/;
const isOldBed = (tags = {}) => OLD_BED.test(tags.name ?? "") && !/Dun[aă]r/.test(tags.name);
// Every 5th node is enough to decide whether a way touches Romania. The
// western ways are kept wherever they are.
const kept = ways.filter((w) => {
  if (isOldBed(w.tags)) return false;
  if (westIds.has(w.id)) return true;
  const nudge = isBorderRiver(w.tags) ? 0.15 : 0.05;
  return w.geometry.some((g, i) => (i % 5 === 0 || i === w.geometry.length - 1) && nearRomania([g.lon, g.lat], nudge));
});
console.log(`${ways.length} river ways fetched (${westWays.length} west, to the Tisza), ${kept.length} kept`);

// Nodes by their exact coordinates; edges run downstream, one per pair of
// consecutive nodes.
const index = new Map();
const pos = [];
const nodeIndex = (g) => {
  const key = `${g.lon},${g.lat}`;
  if (!index.has(key)) {
    index.set(key, pos.length);
    pos.push([g.lon, g.lat]);
  }
  return index.get(key);
};
const edges = [];
kept.forEach((w, way) => {
  const name = w.tags?.name ?? "";
  for (let i = 1; i < w.geometry.length; i++) {
    const a = nodeIndex(w.geometry[i - 1]);
    const b = nodeIndex(w.geometry[i]);
    if (a !== b) edges.push({ a, b, km: km(pos[a], pos[b]), name, way });
  }
});
const N = pos.length;
const out = Array.from({ length: N }, () => []);
const inc = Array.from({ length: N }, () => []);
const link = (k) => {
  out[edges[k].a].push(k);
  inc[edges[k].b].push(k);
};
edges.forEach((_, k) => link(k));

// Bridges over mapping gaps. Consecutive ways of one river sometimes end a few
// dozen metres apart instead of sharing a node — just below the Iron Gates the
// Danube did, and everything above that point "reached the sea" there. A dead
// end within GAP km of a node of a different way that carries on is joined to
// the closest such node.
const GAP = 1.2;
const waysAt = (n) => new Set([...out[n], ...inc[n]].map((k) => edges[k].way));
const cells = new Map();
const cellKey = (p) => `${Math.floor(p[0] / 0.01)},${Math.floor(p[1] / 0.01)}`;
pos.forEach((p, n) => {
  if (!out[n].length) return;
  const key = cellKey(p);
  if (!cells.has(key)) cells.set(key, []);
  cells.get(key).push(n);
});
let bridges = 0;
for (let n = 0; n < N; n++) {
  if (out[n].length) continue;
  const own = waysAt(n);
  const [cx, cy] = cellKey(pos[n]).split(",").map(Number);
  let best = -1;
  let bestKm = GAP;
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (const m of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
        if ([...waysAt(m)].some((w) => own.has(w))) continue;
        const d = km(pos[n], pos[m]);
        if (d < bestKm) (best = m), (bestKm = d);
      }
  if (best < 0) continue;
  edges.push({ a: n, b: best, km: bestKm, name: edges[inc[n][0]]?.name ?? "", way: -1 });
  link(edges.length - 1);
  bridges++;
}
console.log(`${bridges} gaps bridged`);

// Outlets: where water really leaves the network. The Black Sea coast and the
// Delta's mouths, or the point where a river leaves the country (the Mureș,
// Someș and Crișuri go on through Hungary). Every other dead end — a side arm
// that stops, a gap too wide to bridge — would otherwise pass for the sea, and
// the Danube "reached" it at a dead side arm by Cernavodă.
const atSea = ([lon, lat]) => lon > 29.3 || (lat < 44.95 && lon > 28.55);
const leftRomania = (p) => !nearRomania(p, 0.15);
// The area query cuts every river that flows out of the country at the
// border, so the Timiș, Bega, Crișuri and Barcău simply stop there, inside
// Romania. A dead end within 6 km of the western or northern border is where
// such a river leaves. (Not along the Danube: there a dead end is a side arm.)
const KM_PER_DEG_X = 111.32 * Math.cos(46 * R);
function kmToBorder([x, y]) {
  let best = Infinity;
  for (const ring of romania)
    for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = [ring[i - 1][0] * KM_PER_DEG_X, ring[i - 1][1] * 110.57];
      const [bx, by] = [ring[i][0] * KM_PER_DEG_X, ring[i][1] * 110.57];
      const [px, py] = [x * KM_PER_DEG_X, y * 110.57];
      const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2 || 1)));
      best = Math.min(best, Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay))));
    }
  return best;
}
const leavesWestOrNorth = ([lon, lat]) => (lon < 22.4 || lat > 47.5) && kmToBorder([lon, lat]) < 6;
const isOutlet = (n) => atSea(pos[n]) || leftRomania(pos[n]) || leavesWestOrNorth(pos[n]);

// Tributaries stopping short. Many named rivers (the Bârzava, the Cașin...)
// end a few km before the river they flow into: the data stops at a lake, a
// dam or just short of the bank. A dead end whose water cannot reach an outlet
// is joined to the nearest point within RECONNECT km whose water can, so it
// counts towards its parent's size. What is still stranded after this is
// dropped further down.
const RECONNECT = 4;
const reachesOutlet = new Uint8Array(N);
{
  const queue = [];
  for (let n = 0; n < N; n++) if (!out[n].length && isOutlet(n)) (reachesOutlet[n] = 1), queue.push(n);
  while (queue.length) {
    const n = queue.pop();
    for (const k of inc[n]) if (!reachesOutlet[edges[k].a]) (reachesOutlet[edges[k].a] = 1), queue.push(edges[k].a);
  }
}
const CELL = 0.05; // degrees, ~4-5 km
const reachCells = new Map();
pos.forEach((p, n) => {
  if (!reachesOutlet[n]) return;
  const key = `${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`;
  if (!reachCells.has(key)) reachCells.set(key, []);
  reachCells.get(key).push(n);
});
let reconnected = 0;
for (let n = 0; n < N; n++) {
  if (out[n].length || reachesOutlet[n]) continue;
  const cx = Math.floor(pos[n][0] / CELL);
  const cy = Math.floor(pos[n][1] / CELL);
  let best = -1;
  let bestKm = RECONNECT;
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (const m of reachCells.get(`${cx + dx},${cy + dy}`) ?? []) {
        const d = km(pos[n], pos[m]);
        if (d < bestKm) (best = m), (bestKm = d);
      }
  if (best < 0) continue;
  edges.push({ a: n, b: best, km: bestKm, name: edges[inc[n][0]]?.name ?? "", way: -1 });
  link(edges.length - 1);
  reconnected++;
}
console.log(`${reconnected} tributaries reconnected to their parent`);

// Loops. A side channel drawn against the flow (or a bridge above) can close a
// loop, and the network has to be loop-free to be ordered. A depth-first walk
// from every headwater finds them: an edge back to a node still on the walk's
// path is the one closing a loop, and only those are marked `broken` — ignored
// from then on, as if the mis-drawn piece were not there. Starting from the
// headwaters means the walk enters a loop from upstream, so the edge it cuts
// is the one pointing back up. (The first try cut every inflow of whichever
// node was waiting when a sort stalled, which severed healthy rivers mid-way.)
const broken = new Uint8Array(edges.length);
const state = new Uint8Array(N); // 0 unseen, 1 on the current path, 2 done
let loops = 0;
function dfs(root) {
  const stack = [[root, 0]];
  state[root] = 1;
  while (stack.length) {
    const top = stack[stack.length - 1];
    const [n, i] = top;
    if (i === out[n].length) {
      state[n] = 2;
      stack.pop();
      continue;
    }
    top[1]++;
    const k = out[n][i];
    const m = edges[k].b;
    if (state[m] === 1) (broken[k] = 1), loops++;
    else if (state[m] === 0) {
      state[m] = 1;
      stack.push([m, 0]);
    }
  }
}
for (let n = 0; n < N; n++) if (!inc[n].length && !state[n]) dfs(n);
for (let n = 0; n < N; n++) if (!state[n]) dfs(n);
const live = (list) => list.filter((k) => !broken[k]);

// Topological order on what is left, sources first (Kahn).
const indeg = inc.map((l) => live(l).length);
const topo = [];
const queue = [];
for (let n = 0; n < N; n++) if (indeg[n] === 0) queue.push(n);
while (queue.length) {
  const n = queue.pop();
  topo.push(n);
  for (const k of live(out[n])) if (--indeg[edges[k].b] === 0) queue.push(edges[k].b);
}
if (topo.length !== N) throw new Error(`network still has a loop: ${N - topo.length} nodes unordered`);

// Size of the river leaving each node: how many distinct headwaters feed it,
// on a log scale. Strahler order was the first idea, but it counts every
// braid that splits and rejoins (the Danube, the Delta) as a new confluence and
// ran past 100. Counting distinct sources is immune: a source reached twice is
// still one. Kept as bitsets; a pass-through node shares its parent's set.
const sourceOf = new Int32Array(N).fill(-1);
let sourceCount = 0;
for (const n of topo) if (!live(inc[n]).length) sourceOf[n] = sourceCount++;
const WORDS = Math.ceil(sourceCount / 32);
const sets = new Array(N);
const popcount = (set) => {
  let c = 0;
  for (let v of set) for (; v; v &= v - 1) c++;
  return c;
};
// The Danube is the exception: it enters the map at 18.5° E with its real
// headwaters (Germany, Austria) off it, so by count it would start as a brook
// at Budapest. Its entry point counts as size DANUBE_ENTRY_SIZE instead, and
// everything downstream of it is at least that big.
const DANUBE_ENTRY_SIZE = 9;
const isDanubeMain = (name) => /^(Duna|Dunaj \/ Duna|Dunav|Дунав)$/.test(name);
const danubeEntry = topo
  .filter((n) => !live(inc[n]).length && out[n].some((k) => isDanubeMain(edges[k].name)))
  .sort((a, b) => pos[a][0] - pos[b][0])[0];
const belowEntry = new Uint8Array(N);
const order = new Int8Array(N);
for (const n of topo) {
  const feeds = live(inc[n]);
  if (!feeds.length) {
    sets[n] = new Uint32Array(WORDS);
    sets[n][sourceOf[n] >> 5] |= 1 << (sourceOf[n] & 31);
  } else if (feeds.length === 1) sets[n] = sets[edges[feeds[0]].a];
  else {
    sets[n] = new Uint32Array(WORDS);
    for (const k of feeds) {
      const s = sets[edges[k].a];
      for (let w = 0; w < WORDS; w++) sets[n][w] |= s[w];
    }
  }
  order[n] = 1 + Math.floor(Math.log2(popcount(sets[n])));
  belowEntry[n] = n === danubeEntry || feeds.some((k) => belowEntry[edges[k].a]) ? 1 : 0;
  if (belowEntry[n]) order[n] = Math.max(order[n], DANUBE_ENTRY_SIZE);
}
console.log(`Danube enters the map at ${pos[danubeEntry]?.map((v) => v.toFixed(2)).join(", ")}, as size ${DANUBE_ENTRY_SIZE}`);

// Distance downstream to where the water leaves the network, km. Where a river
// splits (the Delta), the shorter way. Only outlets (above) count as the sea.
const downstream = (base) => {
  const d = new Float64Array(N).fill(Infinity);
  for (let i = topo.length - 1; i >= 0; i--) {
    const n = topo[i];
    const drains = live(out[n]);
    if (!drains.length) d[n] = base(n);
    for (const k of drains) d[n] = Math.min(d[n], edges[k].km + d[edges[k].b]);
  }
  return d;
};
// Water that cannot reach an outlet comes out at Infinity: a stranded piece,
// cut off from its parent river by a gap in the data. Those are dropped below
// rather than drawn floating loose.
const toSea = downstream((n) => (isOutlet(n) ? 0 : Infinity));

// --- Chains -----------------------------------------------------------------
// Stretches between junctions, drawn as one polyline each. A chain breaks at
// any node that is not a plain pass-through (one edge in, one out).
const passThrough = (n) => inc[n].length === 1 && out[n].length === 1;
const used = new Uint8Array(edges.length);
const chains = [];
function walk(k) {
  const first = edges[k].a;
  const pts = [pos[first]];
  const o = order[first];
  const name = edges[k].name;
  let length = 0;
  let n;
  for (;;) {
    used[k] = 1;
    length += edges[k].km;
    n = edges[k].b;
    pts.push(pos[n]);
    if (!passThrough(n)) break;
    k = out[n][0];
    if (used[k]) break;
  }
  // Downstream of the Danube's entry is the Danube itself, its side arms and
  // the Delta's arms, and nothing else, so a stretch that starts there is the
  // Danube's (one that only ends there is a tributary). The page keeps those
  // bright beyond Romania.
  chains.push({ o, name, km: length, sea: toSea[n], pts, danube: belowEntry[first] === 1, first, last: n });
}
for (let n = 0; n < N; n++) if (!passThrough(n)) for (const k of out[n]) if (!used[k]) walk(k);
// Whatever is left is a closed loop with no way in: start it anywhere.
edges.forEach((_, k) => !used[k] && walk(k));

// Stranded pieces: stretches whose water never reaches the sea or the border.
// Drawn, they float beside the river they belong to and read as mistakes.
const strandedKm = chains.filter((c) => !Number.isFinite(c.sea)).reduce((sum, c) => sum + c.km, 0);
const strandedCount = chains.filter((c) => !Number.isFinite(c.sea)).length;
chains.splice(0, chains.length, ...chains.filter((c) => Number.isFinite(c.sea)));
console.log(`${strandedCount} stranded stretches dropped (~${Math.round(strandedKm)} km)`);

// Douglas-Peucker: keeps the points that matter to a line's shape, within
// `tol` degrees. The tolerance follows river size: size 1 has ~80 m of slack,
// size 9 ~25 m, fine enough to hold the bends when the map is zoomed in. The
// whole file comes to ~790 KB; the next step down ran to ~1 MB. Ends are
// always kept, so the network stays joined.
const TOLERANCE = [0, 0.001, 0.0009, 0.0008, 0.0007, 0.0006, 0.0005, 0.0004, 0.0004, 0.0003];
// Rivers drawn rougher on purpose, by name: the Jijia's canalised lower course
// still zigzags between bits of old meander, and reads cleaner as a smooth
// line ~250 m from exact.
const ROUGHER = { Jijia: 0.003 };
const KM_X = Math.cos(46 * R); // a degree of longitude is shorter than one of latitude here
function simplify(coords, tol) {
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = [coords[a][0] * KM_X, coords[a][1]];
    const [bx, by] = [coords[b][0] * KM_X, coords[b][1]];
    const len = Math.hypot(bx - ax, by - ay) || 1e-12;
    let worst = -1;
    let worstD = tol;
    for (let i = a + 1; i < b; i++) {
      const x = coords[i][0] * KM_X;
      const y = coords[i][1];
      const d = Math.abs((bx - ax) * (ay - y) - (ax - x) * (by - ay)) / len;
      if (d > worstD) (worst = i), (worstD = d);
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([a, worst], [worst, b]);
  }
  return coords.filter((_, i) => keep[i]);
}

// --- Labels -----------------------------------------------------------------
// River names in three tiers; the page shows tier 1 always and the others
// only once zoomed in (main.js). Each name goes at the middle of the biggest,
// then longest, stretch carrying it, so a name shared by several rivers (two
// Timiș, several Bistrița) lands on the one people mean. Preferably stretches
// whose middle is 12 km or more inside Romania, or the Timiș is labelled on
// the Serbian border. OSM writes some
// names as "Râul X", the Danube's border stretches as "Dunărea - Дунав". (No
// Bega: OSM maps it as a canal.) The Tisa goes by its Hungarian and Serbian
// names for most of its length (LABEL_ALIASES); it is labelled in Romanian,
// like the rest.
const LABELS = [
  ["Dunărea", "Mureș", "Olt", "Siret", "Prut", "Jiu", "Argeș", "Ialomița", "Someș", "Bistrița", "Crișul Alb", "Timiș", "Buzău", "Tisa"],
  ["Cibin", "Târnava Mare", "Târnava Mică", "Arieș", "Someșul Mic", "Someșul Mare", "Crișul Repede", "Crișul Negru", "Cerna", "Vedea", "Dâmbovița", "Prahova", "Trotuș", "Moldova", "Bârlad", "Jijia", "Lotru", "Motru", "Strei"],
  ["Teleorman", "Suceava", "Râmnicu Sărat", "Neajlov", "Vișeu", "Iza", "Bârsa", "Olteț", "Lăpuș", "Nera", "Caraș", "Barcău", "Bahlui", "Tazlău", "Milcov", "Putna", "Gilort", "Sebeș", "Ampoi", "Hârtibaciu"],
];
const LABEL_ALIASES = { Tisa: ["Tisza", "Тиса"] };
const carries = (chainName, name) => [name, ...(LABEL_ALIASES[name] ?? [])].some((n) => chainName === n || chainName === `Râul ${n}` || chainName.startsWith(n + " "));
const labels = [];
LABELS.forEach((names, tier) => {
  for (const name of names) {
    const middle = (c) => c.pts[Math.floor(c.pts.length / 2)];
    const named = chains.filter((c) => carries(c.name, name));
    const wellInside = named.filter((c) => inside(middle(c)) && kmToBorder(middle(c)) > 12);
    const best = (wellInside.length ? wellInside : named).sort((a, b) => b.o - a.o || b.km - a.km)[0];
    if (!best) continue;
    // The label point, plus two points a little either side of it along the
    // river: the page uses them for the river's direction there, to set the
    // name beside the line rather than on it.
    const i = Math.floor(best.pts.length / 2);
    const a = best.pts[Math.max(0, i - 3)];
    const b = best.pts[Math.min(best.pts.length - 1, i + 3)];
    const mid = best.pts[i];
    labels.push([name, round(mid[0]), round(mid[1]), tier + 1, round(a[0]), round(a[1]), round(b[0]), round(b[1])]);
  }
});

// Where the Tisa meets the Danube: the downstream end of the Tisa stretch
// nearest the sea, which is where its water joins the Danube's.
const tisa = chains.filter((c) => carries(c.name, "Tisa")).sort((a, b) => a.sea - b.sea)[0];
const confluences = tisa ? [["Tisa", "Dunărea", ...tisa.pts[tisa.pts.length - 1].map(round)]] : [];
console.log(`confluence: ${confluences.map((c) => `${c[0]} into the ${c[1]} at ${c[2]}, ${c[3]}`).join("")}`);

// --- Basins (bazine hidrografice) --------------------------------------------
// Each stretch is labelled with the main river that carries its water into
// the Danube: follow it downstream, stretch by stretch, until the next one is
// the Danube (or the Tisa, for the western rivers, which reach the Danube
// through it); the name of the last stretch before that is the basin. Names
// change at the border (the Mureș leaves as the Maros, the Crișuri join the
// Tisa as the Hármas-Körös), so each basin lists every name it goes by.
// Water that reaches the Danube by none of these (a short stream straight
// into it, the Dobrogea coast) is left unlabelled. The page turns the labels
// into areas (main.js).
const BASINS = [
  ["Someș", /Some[șs]|Szamos/],
  ["Crișuri", /Cri[șs]|Körös|Berettyó|Barcău/],
  ["Mureș", /Mure[șs]|Maros/],
  ["Timiș-Bega", /Timi[șs]|Tamiš|Тамиш|Bega|Begej|Бегеј/],
  ["Caraș-Nera", /Cara[șs]|Karaš|Караш|Nera|Нера/],
  ["Cerna", /Cerna/],
  ["Jiu", /\bJiu/],
  ["Olt", /\bOlt\b/],
  ["Vedea", /Vedea/],
  ["Argeș", /Arge[șs]/],
  ["Ialomița", /Ialomi[țt]a/],
  ["Siret", /Siret/],
  ["Prut", /Prut/],
  ["Tisa", /Tisa|Tisza|Тиса|\bIza\b|Vi[șs]eu/],
];
const basinOfName = (name) => BASINS.findIndex(([, re]) => re.test(name));
const startingAt = new Map();
chains.forEach((c) => {
  if (!startingAt.has(c.first)) startingAt.set(c.first, []);
  startingAt.get(c.first).push(c);
});
const isTisa = (c) => carries(c.name, "Tisa");
const basinCache = new Map();
function basinOf(c) {
  if (basinCache.has(c)) return basinCache.get(c);
  basinCache.set(c, -1); // a guard while it is being worked out
  let b = -1;
  if (isTisa(c)) b = basinOfName("Tisa");
  else if (!c.danube) {
    const next = (startingAt.get(c.last) ?? []).sort((x, y) => x.sea - y.sea)[0];
    if (next && (next.danube || isTisa(next))) b = basinOfName(c.name);
    else if (next) b = basinOf(next);
  }
  basinCache.set(c, b);
  return b;
}
chains.forEach((c) => (c.basin = basinOf(c)));
const basinKm = BASINS.map((_, i) => Math.round(chains.filter((c) => c.basin === i).reduce((s, c) => s + c.km, 0)));
console.log(`basins: ${BASINS.map(([n], i) => `${n} ${basinKm[i]} km`).join(", ")}; unlabelled ${Math.round(chains.filter((c) => c.basin < 0 && !c.danube).reduce((s, c) => s + c.km, 0))} km`);

// --- Cities -----------------------------------------------------------------
// The largest cities that stand on a larger river: within CITY_KM of one of
// the rivers named in label tiers 1-2, or of a stretch of size
// CITY_MIN_SIZE or more (the Danube's arms, which have other names). The 30
// biggest of those, then the big cities off the rivers (further down), all
// split by population into three zoom tiers (main.js shows tier 1 always,
// the others zoomed in).
//
// By name rather than by size alone: size counts mapped headwaters, and that
// undercounts where the city is — the Dâmbovița through Bucharest, the Mureș
// at Târgu Mureș and the Crișul Repede at Oradea all come out small. But a
// name can belong to several rivers (a brook called Timiș runs through
// Brașov, seven sizes below the Banat Timiș), so a stretch only counts if it
// is within 5 sizes of the biggest river of that name. (3 was too strict: the
// upper Mureș at Târgu Mureș is four below the lower Mureș.)
const CITY_KM = 5;
const CITY_MIN_SIZE = 6;
const CITY_COUNT = 30;
const majorNames = [...LABELS[0], ...LABELS[1]];
const baseName = (name) => majorNames.find((n) => name === n || name === `Râul ${n}` || name.startsWith(n + " "));
const biggestOf = new Map();
for (const c of chains) {
  const n = baseName(c.name);
  if (n) biggestOf.set(n, Math.max(biggestOf.get(n) ?? 0, c.o));
}
const majorRiver = (c) => {
  const n = baseName(c.name);
  return n !== undefined && c.o >= biggestOf.get(n) - 5;
};
const bigRiverPoints = chains.filter((c) => c.o >= CITY_MIN_SIZE || majorRiver(c)).flatMap((c) => c.pts.map((p) => ({ p, name: c.name, o: c.o })));
const riverCells = new Map();
for (const r of bigRiverPoints) {
  const key = `${Math.floor(r.p[0] / CELL)},${Math.floor(r.p[1] / CELL)}`;
  if (!riverCells.has(key)) riverCells.set(key, []);
  riverCells.get(key).push(r);
}
const nearestBigRiver = (p) => {
  const cx = Math.floor(p[0] / CELL);
  const cy = Math.floor(p[1] / CELL);
  let best = null;
  let bestKm = CITY_KM;
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (const r of riverCells.get(`${cx + dx},${cy + dy}`) ?? []) {
        const d = km(p, r.p);
        if (d < bestKm) (best = r), (bestKm = d);
      }
  return best;
};
const towns = (await overpass("towns", TOWNS_QUERY)).elements
  .map((el) => ({ name: el.tags.name, p: [el.lon, el.lat], pop: parseInt(String(el.tags.population).replace(/\D/g, ""), 10) }))
  .filter((t) => t.name && t.pop > 0);
// Biggest first; a town within 15 km of a bigger one already taken is its
// suburb (Popești-Leordeni by Bucharest) and is skipped.
//
// One exception the rules above cannot tell apart: Brașov's "Timiș" is a
// brook that shares its name with the Banat river, and no size cut-off keeps
// it out without also dropping Târgu Mureș on the upper Mureș.
const NOT_ON_A_LARGER_RIVER = new Set(["Brașov"]);
const cities = [];
for (const t of towns.sort((a, b) => b.pop - a.pop)) {
  if (cities.length === CITY_COUNT) break;
  if (NOT_ON_A_LARGER_RIVER.has(t.name)) continue;
  const river = nearestBigRiver(t.p);
  if (!river || cities.some((c) => km(c.p, t.p) < 15)) continue;
  cities.push({ ...t, river });
}
console.log(`cities on larger rivers: ${cities.map((c) => `${c.name} (${c.river.name || "?"})`).join(", ")}`);

// Plus the big cities off the larger rivers, where the map would otherwise be
// empty of them (Timișoara, Iași, Constanța, Brașov, Suceava...): the biggest
// towns at least CITY_SPREAD_KM from any city already on the map, up to
// CITY_EXTRA of them.
const CITY_EXTRA = 12;
const CITY_SPREAD_KM = 30;
const extras = [];
for (const t of towns) {
  if (extras.length === CITY_EXTRA) break;
  if ([...cities, ...extras].some((c) => km(c.p, t.p) < CITY_SPREAD_KM)) continue;
  extras.push({ ...t, river: null });
}
cities.push(...extras);
cities.sort((a, b) => b.pop - a.pop);
// Cities shown at every zoom whatever their size, where the zoomed-out map
// would otherwise have an empty patch: Bistrița, alone in the north-east of
// Transylvania, and Suceava, in Bucovina.
const ALWAYS_SHOWN = new Set(["Bistrița", "Suceava"]);
console.log(`cities off the rivers: ${extras.map((c) => c.name).join(", ")}`);

// City shapes: each city's administrative boundary, very roughly. Not the
// built-up area — a Romanian municipality takes in some fields and villages
// round the town — but close enough to outline a city on a country map.
// Bucharest is admin_level 4, the other municipalities 8; some are named
// "Municipiul X". Cached under a hash of the names, so a different city list
// fetches afresh.
const cityNames = cities.map((c) => c.name);
const SHAPES_QUERY = `[out:json][timeout:180];area["ISO3166-1"="RO"][admin_level=2]->.ro;relation["boundary"="administrative"]["admin_level"~"^(4|8)$"]["name"~"^(Municipiul )?(${cityNames.join("|")})$"](area.ro);out geom;`;
const shapesKey = createHash("md5").update(cityNames.join("|")).digest("hex").slice(0, 8);
const boundaries = (await overpass(`city-shapes-${shapesKey}`, SHAPES_QUERY)).elements.filter((el) => el.type === "relation");
// The caches of earlier city lists are dead weight (2.5-4 MB each): only the
// current list's is kept.
for (const file of await readdir(CACHE)) {
  if (file.startsWith("city-shapes-") && file !== `city-shapes-${shapesKey}.json`) await unlink(new URL(file, CACHE));
}

// A relation's outline comes as separate ways, in no set order or direction;
// chain them end to end into closed rings.
function stitch(relation) {
  const pieces = relation.members.filter((m) => m.type === "way" && m.role !== "inner" && m.geometry?.length > 1).map((m) => m.geometry.map((g) => [g.lon, g.lat]));
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const result = [];
  while (pieces.length) {
    const ring = pieces.shift();
    for (let grew = true; grew && !same(ring[0], ring[ring.length - 1]); ) {
      grew = false;
      const end = ring[ring.length - 1];
      const i = pieces.findIndex((p) => same(p[0], end) || same(p[p.length - 1], end));
      if (i < 0) break;
      const next = pieces.splice(i, 1)[0];
      ring.push(...(same(next[0], end) ? next : next.reverse()).slice(1));
      grew = true;
    }
    if (ring.length > 3) result.push(ring);
  }
  return result;
}
const pointInRings = ([x, y], rs) => {
  let hit = false;
  for (const ring of rs)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
  return hit;
};
// Each city takes the boundary of its name that contains its point; shapes
// are simplified to ~400 m, plenty for an outline.
//
// A closed ring starts and ends on the same point, which leaves
// Douglas-Peucker measuring everything against a line of no length: it kept
// two points per city. So the ring is split at its point farthest from the
// start, and the two halves simplified on their own.
const SHAPE_TOLERANCE = 0.004;
function simplifyRing(ring, tol) {
  let far = 1;
  for (let i = 1; i < ring.length; i++) if (km(ring[0], ring[i]) > km(ring[0], ring[far])) far = i;
  return [...simplify(ring.slice(0, far + 1), tol), ...simplify(ring.slice(far), tol).slice(1)];
}
let shaped = 0;
// Many counties share their seat's name (Giurgiu, Călărași, Buzău...) and
// contain its point too, so the smallest boundary that does is the city's.
const area = (rs) => rs.reduce((sum, ring) => sum + Math.abs(ring.reduce((a, [x, y], i) => a + x * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * y, 0)) / 2, 0);
for (const c of cities) {
  const candidates = boundaries
    .filter((b) => [c.name, `Municipiul ${c.name}`].includes(b.tags?.name))
    .map((b) => stitch(b))
    .filter((rs) => rs.length && pointInRings(c.p, rs))
    .sort((a, b) => area(a) - area(b));
  // Only the main ring. Some municipalities own a detached piece far from the
  // town — Sibiu the Păltiniș resort up in the mountains — which on the map
  // reads as a stray yellow scrap.
  const main = candidates[0]?.sort((a, b) => area([b]) - area([a]))[0];
  c.shape = main ? [simplifyRing(main, SHAPE_TOLERANCE)] : null;
  if (c.shape) shaped++;
}
console.log(`city shapes: ${shaped} of ${cities.length}${shaped < cities.length ? ` (none for ${cities.filter((c) => !c.shape).map((c) => c.name).join(", ")})` : ""}`);

// --- Terrain ----------------------------------------------------------------
// The satellite picture for the terrain layer: NASA Blue Marble Next
// Generation with shaded relief and sea depth (public domain, NASA Earth
// Observatory) — the same picture ../romanian-borders uses. That project crops
// it out of the 88 MB world tile and reprojects it at build time with sharp
// and d3-geo; here NASA's GIBS map service hands over just this box, as a
// plain JPEG with longitude and latitude evenly spaced, and the page bends it
// into the map's projection itself (main.js). No image libraries either way.
//
// The box reaches past Romania on every side: Hungary and Serbia west, the
// Black Sea east. ~190 px a degree, about 0.4 km a pixel here, close to the
// source's own ~0.5 km.
const TERRAIN = { west: 18.5, south: 42, east: 32, north: 50, width: 2592, height: 1536 };
const terrainFile = new URL("data/terrain.jpg", ROOT);
if (!existsSync(terrainFile)) {
  const url =
    "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1" +
    `&LAYERS=BlueMarble_ShadedRelief_Bathymetry&SRS=EPSG:4326&BBOX=${TERRAIN.west},${TERRAIN.south},${TERRAIN.east},${TERRAIN.north}` +
    `&WIDTH=${TERRAIN.width}&HEIGHT=${TERRAIN.height}&FORMAT=image/jpeg`;
  console.log("fetching the terrain picture from NASA GIBS…");
  const res = await fetch(url);
  if (!res.ok || !res.headers.get("content-type")?.startsWith("image/")) throw new Error(`GIBS: ${res.status} ${await res.text()}`);
  await mkdir(new URL("data/", ROOT), { recursive: true });
  await writeFile(terrainFile, Buffer.from(await res.arrayBuffer()));
}

// --- Roads ------------------------------------------------------------------
// OSM cuts roads into short ways (a bridge, a speed limit, a lane change each
// start a new one): 53,000 of them. Ways of one class that meet end to end,
// with nothing else meeting there, are joined into one line, then the lines
// are simplified like the rivers. Directions are ignored, so a way drawn the
// other way round is flipped to fit.
const ROAD_CLASSES = ["motorway", "trunk", "primary"];
// Degrees of slack, ~45-90 m: a road is straighter than a river, and these are
// drawn thin.
const ROAD_TOLERANCE = { motorway: 0.0006, trunk: 0.0009, primary: 0.0012 };

function mergeLines(lines) {
  const key = (p) => `${p[0]},${p[1]}`;
  const ends = new Map();
  lines.forEach((l, i) => {
    for (const [end, p] of [[0, l[0]], [1, l[l.length - 1]]]) {
      const k = key(p);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push({ i, end });
    }
  });
  const used = new Uint8Array(lines.length);
  const merged = [];
  // From one end of line i, follow the joins as far as they go.
  const grow = (path, at) => {
    for (;;) {
      const here = ends.get(key(at));
      if (here.length !== 2) return;
      const next = here.find((e) => !used[e.i]);
      if (!next) return;
      used[next.i] = 1;
      const l = lines[next.i];
      const piece = next.end === 0 ? l : [...l].reverse();
      path.push(...piece.slice(1));
      at = piece[piece.length - 1];
    }
  };
  const walkFrom = (i) => {
    used[i] = 1;
    const path = [...lines[i]];
    grow(path, path[path.length - 1]);
    path.reverse();
    grow(path, path[path.length - 1]);
    merged.push(path);
  };
  // Lines with a free or busy end first, so chains start at their real ends;
  // whatever is left is a closed loop.
  lines.forEach((l, i) => !used[i] && (ends.get(key(l[0])).length !== 2 || ends.get(key(l[l.length - 1])).length !== 2) && walkFrom(i));
  lines.forEach((_, i) => !used[i] && walkFrom(i));
  return merged;
}

const roadWays = (await overpass("roads-ro", ROADS_QUERY)).elements.filter((el) => el.type === "way" && el.geometry?.length > 1);
const roads = {};
for (const cls of ROAD_CLASSES) {
  const lines = roadWays.filter((w) => w.tags.highway === cls).map((w) => w.geometry.map((g) => [g.lon, g.lat]));
  roads[cls] = mergeLines(lines).map((l) => simplify(l, ROAD_TOLERANCE[cls]).flatMap(([x, y]) => [round(x), round(y)]));
  console.log(`roads: ${cls} ${lines.length} ways → ${roads[cls].length} lines, ${roads[cls].reduce((s, l) => s + l.length / 2, 0)} points`);
}
await mkdir(new URL("data/", ROOT), { recursive: true });
await writeFile(new URL("data/roads.js", ROOT), `window.ROAD_DATA = ${JSON.stringify(roads)};\n`);

const totalKm = chains.reduce((s, c) => s + c.km, 0);
const named = new Set(chains.map((c) => c.name).filter(Boolean));
// The Black Sea, from the Natural Earth 1:10m marine areas (copied in from
// ../romanian-borders), so the map can colour it rather than leave it as
// background.
const sea = rings(JSON.parse(await readFile(new URL("scripts/source/black-sea.geojson", ROOT), "utf8")).geometry).map((ring) => ring.map(([x, y]) => [round(x), round(y)]));

// --- Drawn outline ----------------------------------------------------------
// The Natural Earth 1:50m outline is fine for deciding what is "in Romania"
// above, but drawn, its border wanders a few km off the Danube and the Prut it
// is meant to follow. The page draws OpenStreetMap's own border instead,
// which follows the rivers' real courses, like the river data.
//
// OSM's border also runs 12 nautical miles out into the Black Sea, round the
// territorial waters. That run (the points inside the sea polygon) is cut
// out and the gap closed along the sea polygon's own coast, between the
// coast points nearest to where the border leaves the land and comes back.
const BORDER_QUERY = `[out:json][timeout:180];relation["boundary"="administrative"]["admin_level"="2"]["ISO3166-1"="RO"];out geom;`;
const borderRelation = (await overpass("border-ro", BORDER_QUERY)).elements.find((el) => el.type === "relation");
const borderRing = stitch(borderRelation).sort((a, b) => area([b]) - area([a]))[0].slice(0, -1);
const coast = sea[0].slice(0, -1);
const nearestCoast = (p) => coast.reduce((best, q, i) => (km(p, q) < km(p, coast[best]) ? i : best), 0);
// Coast points from a to b, the short way round the sea polygon.
function coastBetween(a, b) {
  const n = coast.length;
  const forward = (b - a + n) % n;
  const path = [];
  if (forward <= n - forward) for (let i = 0; i <= forward; i++) path.push(coast[(a + i) % n]);
  else for (let i = 0; i <= n - forward; i++) path.push(coast[(a - i + n) % n]);
  return path;
}
function landOutline(ring) {
  const wet = ring.map((p) => pointInRings(p, sea));
  if (!wet.some(Boolean)) return ring;
  // Start on the land just after a run of sea, so no run wraps the start.
  const n = ring.length;
  const start = ring.findIndex((_, i) => !wet[i] && wet[(i - 1 + n) % n]);
  const out = [];
  for (let s = 0; s < n; s++) {
    const i = (start + s) % n;
    if (!wet[i]) {
      out.push(ring[i]);
      continue;
    }
    // A run of sea from here: skip to the land after it and bridge the gap.
    let e = s;
    while (e < n && wet[(start + e) % n]) e++;
    const before = ring[(start + s - 1 + n) % n];
    const after = ring[(start + e) % n];
    out.push(...coastBetween(nearestCoast(before), nearestCoast(after)));
    s = e - 1;
  }
  return out;
}
const outlineRing = landOutline(borderRing);
const drawnOutline = [simplifyRing([...outlineRing, outlineRing[0]], 0.0004)];
console.log(`outline: OSM border ${borderRing.length} points, ${borderRing.filter((p) => pointInRings(p, sea)).length} out at sea replaced by coast → ${drawnOutline[0].length} points`);
const rivers = {
  stats: { rivers: named.size, km: Math.round(totalKm), maxOrder: Math.max(...chains.map((c) => c.o)), maxSea: Math.round(Math.max(...chains.map((c) => c.sea + c.km))) },
  outline: drawnOutline.map((ring) => ring.map(([x, y]) => [round(x), round(y)])),
  neighbours,
  sea,
  // data/terrain.jpg and the box it covers, evenly spaced in lon/lat
  terrain: { file: "data/terrain.jpg", ...TERRAIN },
  labels,
  // [river, the river it joins, lon, lat]
  confluences,
  // [name, lon, lat, population, tier 1-3, shape: rings of flat lon/lat pairs
  // or null], biggest first
  cities: cities.map((c, i) => [
    c.name,
    round(c.p[0]),
    round(c.p[1]),
    c.pop,
    ALWAYS_SHOWN.has(c.name) ? 1 : 1 + Math.floor((i * 3) / cities.length),
    c.shape ? c.shape.map((ring) => ring.flatMap(([x, y]) => [round(x), round(y)])) : null,
  ]),
  // basin names, in the order the chains' basin index refers to
  basins: BASINS.map(([name]) => name),
  // [order, km of the chain, km from its downstream end to the sea, flat lon/lat pairs,
  //  1 if the Danube's else 0, basin index or -1]
  chains: chains
    .sort((a, b) => a.o - b.o)
    // Sizes past the table (the Danube below the Tisa is 10) take its last row.
    .map((c) => [
      c.o,
      Math.round(c.km * 100) / 100,
      Math.round(c.sea * 10) / 10,
      simplify(c.pts, ROUGHER[c.name] ?? TOLERANCE[Math.min(c.o, TOLERANCE.length - 1)]).flatMap(([x, y]) => [round(x), round(y)]),
      c.danube ? 1 : 0,
      c.basin,
    ]),
};

// A script rather than a .json file, so index.html also works opened straight
// from disk: browsers refuse fetch() over file://, but load a <script> fine.
await mkdir(new URL("data/", ROOT), { recursive: true });
await writeFile(new URL("data/rivers.js", ROOT), `window.RIVER_DATA = ${JSON.stringify(rivers)};\n`);
const byOrder = {};
chains.forEach((c) => (byOrder[c.o] = (byOrder[c.o] ?? 0) + 1));
console.log(`data/rivers.js: ${named.size} named rivers, ${chains.length} stretches, ~${rivers.stats.km} km, orders ${JSON.stringify(byOrder)}, ${loops} loop edges cut, longest run to the sea ${rivers.stats.maxSea} km`);
