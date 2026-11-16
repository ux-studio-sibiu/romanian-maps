// Builds data/grid.js: Romania's outline, its power plants and its 220/400 kV
// lines, cut down to what the page draws. Plain Node 18+, no dependencies.
//
//   node scripts/fetch-data.mjs
//
// Plants, lines, substations and towns come from OpenStreetMap through the
// Overpass API; the outline from scripts/source/romania.geojson, Romania cut out
// of the Natural Earth 1:50m countries file in ../../carbon-divide, so this folder
// stands on its own. Each line also gets a modelled flow (flow-model.mjs).
// Overpass answers are cached in
// scripts/.cache, so re-running only re-shapes the data. Delete the cache to
// fetch fresh.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { modelFlows } from "./flow-model.mjs";

const ROOT = new URL("../", import.meta.url);
const CACHE = new URL("scripts/.cache/", ROOT);
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];

const AREA = 'area["ISO3166-1"="RO"][admin_level=2]->.ro;';
const QUERIES = {
  // `out center` gives every plant one point, whether it is mapped as a node,
  // an outline or a relation of several outlines.
  plants: `[out:json][timeout:180];${AREA}nwr["power"="plant"](area.ro);out center tags;`,
  lines: `[out:json][timeout:180];${AREA}way["power"="line"]["voltage"~"220000|400000"](area.ro);out geom tags;`,
  // For the flow model (flow-model.mjs): the substations where lines meet, and
  // where people live, which stands in for where power is used.
  substations: `[out:json][timeout:180];${AREA}nwr["power"="substation"]["voltage"~"220000|400000"](area.ro);out center tags;`,
  towns: `[out:json][timeout:180];${AREA}node["place"~"^(city|town)$"]["population"](area.ro);out body;`,
};

async function overpass(name) {
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
          "user-agent": "romanian-maps-electric-grid/0.1 (personal map prototype)",
        },
        body: "data=" + encodeURIComponent(QUERIES[name]),
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

// Five decimals is about a metre; four is about 10 m, plenty at country scale.
const round = (n) => Math.round(n * 1e4) / 1e4;

// The tag is free text: "700 MW", "1.4 GW", "35000 kW", "12,5 MW", "yes".
function parseMW(raw) {
  if (!raw) return null;
  const m = String(raw).replace(",", ".").match(/([\d.]+)\s*(gw|mw|kw|w)?/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || "mw").toLowerCase();
  return { gw: n * 1000, mw: n, kw: n / 1000, w: n / 1e6 }[unit];
}

// Collapsed onto the page's legend. Everything unrecognised is "other".
const SOURCES = {
  nuclear: "nuclear",
  hydro: "hydro",
  water: "hydro",
  wind: "wind",
  solar: "solar",
  coal: "coal",
  lignite: "coal",
  gas: "gas",
  oil: "gas",
};
function sourceOf(tags) {
  const raw = (tags["plant:source"] || tags["generator:source"] || "").toLowerCase();
  for (const part of raw.split(/[;,]/)) {
    const hit = SOURCES[part.trim()];
    if (hit) return hit;
  }
  return "other";
}

// Drops points closer than `tol` degrees to the last one kept. Crude next to
// Douglas-Peucker, but lines at this scale are near-straight between pylons.
function thin(coords, tol = 0.004) {
  const out = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    const [x, y] = out[out.length - 1];
    const [a, b] = coords[i];
    if (Math.hypot(a - x, b - y) >= tol) out.push(coords[i]);
  }
  out.push(coords[coords.length - 1]);
  return out;
}

const plantsRaw = await overpass("plants");
const plants = [];
for (const el of plantsRaw.elements) {
  const p = el.type === "node" ? el : el.center;
  if (!p) continue;
  const mw = parseMW(el.tags?.["plant:output:electricity"]);
  plants.push([round(p.lon), round(p.lat), sourceOf(el.tags || {}), mw === null ? null : Math.round(mw * 10) / 10]);
}
// Biggest last, so they are drawn on top of the small dots around them.
plants.sort((a, b) => (a[3] ?? 0) - (b[3] ?? 0));

const linesRaw = await overpass("lines");
const lines = [];
for (const el of linesRaw.elements) {
  if (!el.geometry?.length) continue;
  // "400000;220000" is a pylon line carrying both: draw it once, as the higher.
  const kv = el.tags.voltage.includes("400000") ? 400 : 220;
  lines.push({ kv, c: thin(el.geometry.map((g) => [round(g.lon), round(g.lat)])) });
}

// Modelled flow per line, in MW, positive in the direction its coordinates
// run. Rounded: it is an estimate, and the page only needs its size and sign.
const substations = (await overpass("substations")).elements.map((el) => (el.type === "node" ? el : el.center)).filter(Boolean).map((p) => [p.lon, p.lat]);
const towns = (await overpass("towns")).elements
  .map((el) => [el.lon, el.lat, parseInt(String(el.tags.population).replace(/\D/g, ""), 10)])
  .filter((t) => t[2] > 0);
const { flows, info } = modelFlows({ lines, plants, substations, towns });
lines.forEach((l, i) => (l.f = Math.round(flows[i])));
console.log(`flow model: ${substations.length} substations, ${towns.length} towns, ${info.nodes} nodes in ${info.pieces} pieces, ${info.solvedNodes} solved`);

const ro = JSON.parse(await readFile(new URL("scripts/source/romania.geojson", ROOT), "utf8"));
const polys = ro.geometry.type === "Polygon" ? [ro.geometry.coordinates] : ro.geometry.coordinates;
const outline = polys.map((poly) => poly[0].map(([x, y]) => [round(x), round(y)]));

// The neighbouring countries, only hinted at on the page: Natural Earth 1:50m
// (scripts/source/neighbours.geojson, a copy of the rivers map's), rounded to
// ~1 km, which is plenty for a faint line round the edge.
const approx = (v) => Math.round(v * 100) / 100;
const neighbours = JSON.parse(await readFile(new URL("scripts/source/neighbours.geojson", ROOT), "utf8")).features.flatMap((f) =>
  (f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates).map((poly) =>
    poly[0].map(([x, y]) => [approx(x), approx(y)]).filter((p, i, ring) => !i || p[0] !== ring[i - 1][0] || p[1] !== ring[i - 1][1]),
  ),
);

// Length along the earth, for the subtitle — haversine, km.
const km = (a, b) => {
  const r = Math.PI / 180;
  const d = Math.sin(((b[1] - a[1]) * r) / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(d));
};
const lineKm = lines.reduce((sum, l) => sum + l.c.slice(1).reduce((s, p, i) => s + km(l.c[i], p), 0), 0);
const gw = plants.reduce((sum, p) => sum + (p[3] ?? 0), 0) / 1000;

const grid = {
  stats: { plants: plants.length, gw: Math.round(gw * 10) / 10, km: Math.round(lineKm) },
  outline,
  neighbours,
  lines,
  plants,
};
// A script rather than a .json file, so index.html also works opened straight
// from disk: browsers refuse fetch() over file://, but load a <script> fine.
await mkdir(new URL("data/", ROOT), { recursive: true });
await writeFile(new URL("data/grid.js", ROOT), `window.GRID_DATA = ${JSON.stringify(grid)};\n`);
console.log(`data/grid.js: ${plants.length} plants, ${grid.stats.gw} GW tagged, ${lines.length} lines, ~${grid.stats.km} km`);
