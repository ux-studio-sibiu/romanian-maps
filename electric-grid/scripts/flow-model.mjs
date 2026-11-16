// A rough, modelled answer to "which way does power flow on each line?".
// OpenStreetMap says where lines are, never what they carry, so this works it
// out with a DC power flow: the simplified grid model engineers use for quick
// studies. It is a plausible picture of a typical moment, not a measurement.
//
//   1. Network. Line ends are joined into nodes: ends that touch, and ends
//      inside the same substation, become one node.
//   2. Supply. Every plant with a capacity tag feeds its typical output
//      (capacity x a capacity factor for its source) into its nearest node.
//   3. Demand. Town populations are fed in as consumption at their nearest
//      node, scaled so that, within each connected piece of the network,
//      consumption matches generation.
//   4. Solve B·θ = P for the voltage angles θ (B is the network's susceptance
//      Laplacian, P the injections) and read the flow on each line as
//      b·(θ_from − θ_to). Susceptance goes with kV² / length: a long line
//      carries less than a short one, a 400 kV line more than a 220 kV one.
//
// Ignored on purpose: line limits, transformers, real-time load and exports.

// Typical output as a share of capacity. Round numbers in line with Romania's
// yearly averages; only the ratios between sources really matter here.
const CAPACITY_FACTOR = { nuclear: 0.9, hydro: 0.4, coal: 0.45, gas: 0.4, wind: 0.25, solar: 0.14, other: 0.35 };

// Joining distances, km.
const JOIN_ENDS = 0.3;
const JOIN_SUBSTATION = 1.2;
const JOIN_SUBSTATIONS = 1.0;
// A plant or town further than this from any node is not on this grid (it
// hangs off the 110 kV network, which is not mapped here).
const MAX_ATTACH = 60;

// Flat km coordinates: plenty accurate over a few km, and close enough over
// Romania for "nearest node".
const KM_LAT = 110.57;
const KM_LON = 111.32 * Math.cos((46 * Math.PI) / 180);
const toKm = ([lon, lat]) => [lon * KM_LON, lat * KM_LAT];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Union-find, for merging points into nodes.
function unionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => {
    parent[find(a)] = find(b);
  };
  return { find, union };
}

// Pairs of points within `radius` km, found through a grid of radius-sized
// cells so the search is not every point against every other.
function closePairs(points, radius, visit) {
  const cells = new Map();
  const key = (x, y) => `${x},${y}`;
  points.forEach((p, i) => {
    const k = key(Math.floor(p[0] / radius), Math.floor(p[1] / radius));
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(i);
  });
  points.forEach((p, i) => {
    const cx = Math.floor(p[0] / radius);
    const cy = Math.floor(p[1] / radius);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of cells.get(key(cx + dx, cy + dy)) ?? []) if (j > i && dist(p, points[j]) <= radius) visit(i, j);
  });
}

// Solves A·x = b in place by Gaussian elimination with partial pivoting. The
// systems here are a few hundred unknowns, so dense is fine.
function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[pivot][c])) pivot = r;
    [A[c], A[pivot]] = [A[pivot], A[c]];
    [b[c], b[pivot]] = [b[pivot], b[c]];
    const d = A[c][c];
    if (Math.abs(d) < 1e-12) continue;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = Math.abs(A[r][r]) < 1e-12 ? 0 : s / A[r][r];
  }
  return x;
}

/**
 * @param lines        [{ kv, c: [[lon, lat], ...] }]  (c runs first → last)
 * @param plants       [[lon, lat, source, mw | null]]
 * @param substations  [[lon, lat]]
 * @param towns        [[lon, lat, population]]
 * @returns flows      signed MW per line, positive along c's order
 */
export function modelFlows({ lines, plants, substations, towns }) {
  // --- 1. Network ----------------------------------------------------------
  // Points 0..S-1 are substations, then two per line: its first and last end.
  const S = substations.length;
  const points = [...substations.map(toKm), ...lines.flatMap((l) => [toKm(l.c[0]), toKm(l.c[l.c.length - 1])])];
  const isSub = (i) => i < S;
  const uf = unionFind(points.length);
  closePairs(points, JOIN_SUBSTATION, (i, j) => {
    const d = dist(points[i], points[j]);
    const limit = isSub(i) && isSub(j) ? JOIN_SUBSTATIONS : isSub(i) || isSub(j) ? JOIN_SUBSTATION : JOIN_ENDS;
    if (d <= limit) uf.union(i, j);
  });

  // Compact node ids, and each node's position (the mean of its points).
  const nodeOf = new Map();
  const nodePos = [];
  const nodeCount = [];
  points.forEach((p, i) => {
    const r = uf.find(i);
    if (!nodeOf.has(r)) {
      nodeOf.set(r, nodePos.length);
      nodePos.push([0, 0]);
      nodeCount.push(0);
    }
    const n = nodeOf.get(r);
    nodePos[n][0] += p[0];
    nodePos[n][1] += p[1];
    nodeCount[n]++;
  });
  nodePos.forEach((p, n) => ((p[0] /= nodeCount[n]), (p[1] /= nodeCount[n])));
  const node = (i) => nodeOf.get(uf.find(i));

  const edges = lines.map((l, k) => {
    const from = node(S + 2 * k);
    const to = node(S + 2 * k + 1);
    let km = 0;
    for (let i = 1; i < l.c.length; i++) km += dist(toKm(l.c[i - 1]), toKm(l.c[i]));
    return { from, to, b: (l.kv / 400) ** 2 / Math.max(km, 0.5) };
  });

  // Only nodes a line actually reaches carry flow; a substation with no line
  // ending in it is left out.
  const N = nodePos.length;
  const adj = Array.from({ length: N }, () => []);
  edges.forEach((e, k) => {
    if (e.from === e.to) return;
    adj[e.from].push(k);
    adj[e.to].push(k);
  });
  const onGrid = adj.map((a) => a.length > 0);

  const nearest = (p) => {
    let best = -1;
    let bestD = MAX_ATTACH;
    nodePos.forEach((q, n) => {
      if (!onGrid[n]) return;
      const d = dist(p, q);
      if (d < bestD) (best = n), (bestD = d);
    });
    return best;
  };

  // --- 2. Supply, 3. demand -------------------------------------------------
  const gen = new Float64Array(N);
  for (const [lon, lat, source, mw] of plants) {
    if (!mw) continue;
    const n = nearest(toKm([lon, lat]));
    if (n >= 0) gen[n] += mw * (CAPACITY_FACTOR[source] ?? 0.3);
  }
  const people = new Float64Array(N);
  for (const [lon, lat, pop] of towns) {
    const n = nearest(toKm([lon, lat]));
    if (n >= 0) people[n] += pop;
  }

  // --- 4. Solve, one connected piece at a time -----------------------------
  // Each piece has to balance on its own: a piece with generation but no towns
  // (or the reverse) has nowhere for its power to go, and carries nothing.
  const flows = new Float64Array(lines.length);
  const piece = new Int32Array(N).fill(-1);
  let pieces = 0;
  let solvedNodes = 0;
  for (let s = 0; s < N; s++) {
    if (!onGrid[s] || piece[s] >= 0) continue;
    const members = [];
    const stack = [s];
    piece[s] = pieces;
    while (stack.length) {
      const n = stack.pop();
      members.push(n);
      for (const k of adj[n]) {
        const m = edges[k].from === n ? edges[k].to : edges[k].from;
        if (piece[m] < 0) (piece[m] = pieces), stack.push(m);
      }
    }
    pieces++;

    const G = members.reduce((sum, n) => sum + gen[n], 0);
    const Pop = members.reduce((sum, n) => sum + people[n], 0);
    if (members.length < 2 || G <= 0 || Pop <= 0) continue;

    // Injection: generation minus this node's share of the piece's demand.
    const index = new Map(members.map((n, i) => [n, i]));
    const P = members.map((n) => gen[n] - (people[n] / Pop) * G);

    // The first member is the reference: its angle is 0, so its row and
    // column drop out, which is what makes the Laplacian solvable.
    const size = members.length - 1;
    const A = Array.from({ length: size }, () => new Float64Array(size));
    const rhs = P.slice(1);
    const pieceEdges = [];
    members.forEach((n) => adj[n].forEach((k) => edges[k].from === n && pieceEdges.push(k)));
    for (const k of new Set(pieceEdges)) {
      const { from, to, b } = edges[k];
      const i = index.get(from) - 1;
      const j = index.get(to) - 1;
      if (i >= 0) A[i][i] += b;
      if (j >= 0) A[j][j] += b;
      if (i >= 0 && j >= 0) (A[i][j] -= b), (A[j][i] -= b);
    }
    const theta = solve(A, rhs);
    const angle = (n) => (index.get(n) === 0 ? 0 : theta[index.get(n) - 1]);
    for (const k of new Set(pieceEdges)) {
      const { from, to, b } = edges[k];
      flows[k] = b * (angle(from) - angle(to));
    }
    solvedNodes += members.length;
  }

  return { flows: Array.from(flows), info: { nodes: N, pieces, solvedNodes } };
}
