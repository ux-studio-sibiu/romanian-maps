// Romania's rivers, full screen, with water flowing down to the Black Sea.
// Zoom with the wheel, a pinch, a double-click, the buttons or +/-; move by
// dragging or with the arrow keys; 0 resets.
// No libraries: a hand-written projection, Canvas 2D, requestAnimationFrame.
//
// The data is window.RIVER_DATA from data/rivers.js (scripts/fetch-data.mjs):
//   outline     Romania, [[lon, lat], ...] rings
//   neighbours  [{ name, rings }]
//   sea         the Black Sea, [[lon, lat], ...] rings
//   terrain     { file, west, south, east, north, width, height }: the satellite
//               picture and the lon/lat box it covers
//   labels      [name, lon, lat, tier 1-3, and two points along the river]
//   cities      [name, lon, lat, population, tier 1-3], biggest first
//   chains      [size 1-9, km long, km from its downstream end to the sea,
//                flat lon/lat pairs running downstream]
(() => {
  const data = window.RIVER_DATA;
  const root = document.querySelector(".nsc-river-map");
  let fontsPending = true;
  const canvas = root.querySelector(".map-canvas");
  let ctx = canvas.getContext("2d");

  // Colours come from style.css, so the legend and the map share one palette.
  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(`--${name}`).trim();
  const COLORS = Object.fromEntries(["land", "border", "neighbour", "sea", "terrain-edge", "city", "road", "motorway", "accent", "river-small", "river-mid", "river-large"].map((n) => [n, color(n)]));

  // Layers the panel can hide. Rivers: the lines, the flowing water and the
  // river names. Cities: the outlines and the city names. Roads: motorways,
  // trunk and primary roads. Basins: the coloured areas each main river
  // drains, and their names. Border: Romania's border as a white dashed
  // line. Terrain: the satellite picture under everything. Roads and basins
  // start hidden: they are there to switch on, not part of the first look.
  const layers = { rivers: true, cities: false, roads: false, basins: false, border: true, terrain: true };
  root.querySelectorAll("[data-layer]").forEach((button) => {
    button.addEventListener("click", () => {
      const name = button.dataset.layer;
      layers[name] = !layers[name];
      button.setAttribute("aria-pressed", String(layers[name]));
      root.querySelector(`[data-layer-row=${name}]`).classList.toggle("is-hidden", !layers[name]);
      startLayerFade();
      invalidate(true);
    });
  });

  // --- Size ramp -------------------------------------------------------------
  // Size 1 (a headwater) to the Danube's, whatever the data says that is (10,
  // since the Tisa's headwaters joined). Colour runs small → mid → large
  // through the three CSS colours; width grows faster than linearly so the
  // big rivers carry the picture and the thousands of streams make a texture.
  const SIZES = data.stats.maxOrder;
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const ramp = Array.from({ length: SIZES + 1 }, (_, c) => {
    const t = Math.max(0, c - 1) / (SIZES - 1);
    const rgb = t < 0.5 ? mix(hex(COLORS["river-small"]), hex(COLORS["river-mid"]), t * 2) : mix(hex(COLORS["river-mid"]), hex(COLORS["river-large"]), t * 2 - 1);
    return { rgb: `rgb(${rgb})`, width: 0.35 + 0.11 * c ** 1.4, glow: c >= 6 };
  });

  // --- Projection ------------------------------------------------------------
  // Oblique stereographic centred on Romania, the family of Stereo 70, the
  // national projection.
  const RAD = Math.PI / 180;
  const LON0 = 25 * RAD;
  const LAT0 = 46 * RAD;
  const sin0 = Math.sin(LAT0);
  const cos0 = Math.cos(LAT0);
  const stereo = ([lon, lat]) => {
    const l = lon * RAD - LON0;
    const p = lat * RAD;
    const k = 2 / (1 + sin0 * Math.sin(p) + cos0 * Math.cos(p) * Math.cos(l));
    return [k * Math.cos(p) * Math.sin(l), -k * (cos0 * Math.sin(p) - sin0 * Math.cos(p) * Math.cos(l))];
  };
  // And back, for finding which lon/lat is on screen (the terrain detail).
  const unstereo = ([x, y]) => {
    const yy = -y;
    const rho = Math.hypot(x, yy);
    if (rho < 1e-12) return [LON0 / RAD, LAT0 / RAD];
    const c = 2 * Math.atan(rho / 2);
    const lat = Math.asin(Math.cos(c) * sin0 + (yy * Math.sin(c) * cos0) / rho);
    const lon = LON0 + Math.atan2(x * Math.sin(c), rho * cos0 * Math.cos(c) - yy * sin0 * Math.sin(c));
    return [lon / RAD, lat / RAD];
  };
  const pairs = (flat) => {
    const out = [];
    for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
    return out;
  };

  const unit = {
    outline: data.outline.map((ring) => ring.map(stereo)),
    neighbours: data.neighbours.flatMap((n) => n.rings.map((ring) => ring.map(stereo))),
    sea: data.sea.map((ring) => ring.map(stereo)),
    chains: data.chains.map(([size, km, sea, flat, danube]) => ({ size, km, sea, pts: pairs(flat).map(stereo), danube: danube === 1 })),
    labels: data.labels.map(([name, lon, lat, tier, ax, ay, bx, by]) => ({ name, tier, p: stereo([lon, lat]), a: stereo([ax, ay]), b: stereo([bx, by]) })),
    confluences: data.confluences.map(([river, into, lon, lat]) => ({ river, into, p: stereo([lon, lat]) })),
    cities: data.cities.map(([name, lon, lat, pop, tier, shape]) => ({
      name,
      pop,
      tier,
      p: stereo([lon, lat]),
      shape: shape ? shape.map((ring) => pairs(ring).map(stereo)) : [],
    })),
  };
  // Framed on Romania, plus room east of the coast for the sea and west for
  // the Tisa, down to where it meets the Danube.
  const framed = [...unit.outline.flat(), stereo([30.6, 44.6]), stereo([19.9, 45.1])];
  const bounds = {
    x0: Math.min(...framed.map((p) => p[0])),
    x1: Math.max(...framed.map((p) => p[0])),
    y0: Math.min(...framed.map((p) => p[1])),
    y1: Math.max(...framed.map((p) => p[1])),
  };

  // --- Layout ----------------------------------------------------------------
  // Two coordinate systems. "World" is the whole map fitted into the window,
  // recomputed on resize. "Screen" is world through the view: screen =
  // world * view.k + (view.x, view.y). Zooming and panning only change the
  // view, never the geometry. `s` scales strokes with the window, tuned at
  // 1000px.
  let W = 0;
  let H = 0;
  let dpr = 1;
  let s = 1;
  let shapes = null;
  // A spare context for asking "is this world point in Romania?".
  const hitTest = document.createElement("canvas").getContext("2d");
  let lonLatToWorld = null;
  let worldToLonLat = null;

  function fit() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    s = Math.min(W, H * 1.4) / 1000;

    // Contain: the whole map fits, centred, with a margin. On wide screens it
    // is fitted into the space right of the panel, which would otherwise sit
    // on the north-west (Oradea, the Someș); on narrow ones it can't be, and
    // the map goes under it.
    const padX = W * 0.04;
    const padY = H * 0.08;
    const panel = root.querySelector(".map-panel");
    const padLeft = W >= 900 ? panel.offsetLeft + panel.offsetWidth + 16 : padX;
    const k = Math.min((W - padLeft - padX) / (bounds.x1 - bounds.x0), (H - padY * 2) / (bounds.y1 - bounds.y0));
    const ox = padLeft + (W - padLeft - padX - (bounds.x1 - bounds.x0) * k) / 2;
    const oy = (H - (bounds.y1 - bounds.y0) * k) / 2;
    const toWorld = ([x, y]) => [ox + (x - bounds.x0) * k, oy + (y - bounds.y0) * k];
    // lon/lat to world and back, kept for the terrain detail tiles.
    lonLatToWorld = (p) => toWorld(stereo(p));
    worldToLonLat = ([wx, wy]) => unstereo([(wx - ox) / k + bounds.x0, (wy - oy) / k + bounds.y0]);

    shapes = {
      outline: unit.outline.map((ring) => ring.map(toWorld)),
      neighbours: unit.neighbours.map((ring) => ring.map(toWorld)),
      sea: unit.sea.map((ring) => ring.map(toWorld)),
      labels: unit.labels.map((l) => {
        // The river's direction at the label, and the side of it the name
        // goes on: the normal pointing up, or right where the river runs
        // nearly straight up and down. Direction survives zoom unchanged, so
        // it is worked out once here.
        const [ax, ay] = toWorld(l.a);
        const [bx, by] = toWorld(l.b);
        const len = Math.hypot(bx - ax, by - ay) || 1;
        let n = [-(by - ay) / len, (bx - ax) / len];
        if (Math.abs(n[1]) < 0.35 ? n[0] < 0 : n[1] > 0) n = [-n[0], -n[1]];
        return { ...l, xy: toWorld(l.p), n };
      }),
      confluences: unit.confluences.map((c) => ({ ...c, xy: toWorld(c.p) })),
      cities: unit.cities.map((c) => {
        const shape = c.shape.map((ring) => ring.map(toWorld));
        const xy = toWorld(c.p);
        // The outline's bounding box, which the name is placed above or below.
        const all = shape.flat();
        const box = all.length ? [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))] : [...xy, ...xy];
        return { ...c, xy, shape, box };
      }),
      // Where "Black Sea" is written: off the coast, east of Constanța.
      seaLabel: toWorld(stereo([29.95, 44.25])),
      terrain: gridCells(data.terrain, TERRAIN_GRID, toWorld),
      basinCells: gridCells(basinRaster, BASIN_GRID, toWorld),
      // Each road class as lines with a bounding box, to skip what is off
      // screen: there are ~11,000 of them.
      roads: Object.fromEntries(
        Object.entries(window.ROAD_DATA).map(([cls, lines]) => [
          cls,
          lines.map((flat) => {
            const pts = pairs(flat).map((p) => toWorld(stereo(p)));
            const xs = pts.map((p) => p[0]);
            const ys = pts.map((p) => p[1]);
            return { pts, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
          }),
        ]),
      ),
      chains: unit.chains.map((c) => {
        const pts = c.pts.map(toWorld);
        // Running length back from the downstream end, which the pulses are
        // placed from; and a bounding box, to skip what is off screen.
        const back = new Float32Array(pts.length);
        for (let i = pts.length - 2; i >= 0; i--) back[i] = back[i + 1] + Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        return { ...c, pts, back, px: back[0], box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
      }),
    };
    // Romania's outline as one reusable path, for the veil and for testing
    // which labels are inside.
    shapes.outlinePath = new Path2D();
    for (const ring of shapes.outline) {
      ring.forEach(([x, y], i) => (i ? shapes.outlinePath.lineTo(x, y) : shapes.outlinePath.moveTo(x, y)));
      shapes.outlinePath.closePath();
    }
    // Which stretches lie outside Romania (by their middle), for the pulses,
    // which are drawn over the veil and so dim themselves. The Danube stays
    // lit everywhere, like its line.
    for (const c of shapes.chains) c.outside = !c.danube && !hitTest.isPointInPath(shapes.outlinePath, ...c.pts[Math.floor(c.pts.length / 2)]);
    // Each basin's name goes on the sampled point of that basin, inside
    // Romania, closest to the middle of its part of Romania. (The plain middle
    // can fall outside a curved basin, the Siret's crescent.) Basins with too
    // little of Romania for a name get none.
    shapes.basinLabels = basinRaster.samples.flatMap((points, b) => {
      const inside = points.map((p) => toWorld(stereo(p))).filter((p) => hitTest.isPointInPath(shapes.outlinePath, ...p));
      if (inside.length < 20) return [];
      const mx = inside.reduce((sum, p) => sum + p[0], 0) / inside.length;
      const my = inside.reduce((sum, p) => sum + p[1], 0) / inside.length;
      const xy = inside.reduce((best, p) => (Math.hypot(p[0] - mx, p[1] - my) < Math.hypot(best[0] - mx, best[1] - my) ? p : best));
      return [{ name: data.basins[b], color: BASIN_COLORS[b], xy }];
    });
    invalidate(true);
  }

  // --- View --------------------------------------------------------------------
  // 1 is the starting view, Romania filling the window. A little below it
  // shows the Danube's run in from Budapest and Esztergom, west of the frame.
  const MIN_ZOOM = 0.7;
  const MAX_ZOOM = 24;
  const view = { k: 1, x: 0, y: 0 };
  let dirty = true; // the ground-and-rivers layer needs repainting
  let tween = null;

  // Asks for a repaint on the next frame. `everything` repaints the overview
  // behind the stretched picture too: for changes to what the map shows (a
  // layer, the window size, the terrain arriving), not only to where it looks.
  function invalidate(everything = false) {
    dirty = true;
    if (everything) overviewDirty = true;
    requestRender();
  }

  // Keeps at least a fifth of the window covered by the map, so it cannot be
  // flung away, and keeps zoom between the wider region and street level.
  function clampView(k, x, y) {
    k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
    const mx = W * 0.2;
    const my = H * 0.2;
    return { k, x: Math.min(mx, Math.max(W - W * k - mx, x)), y: Math.min(my, Math.max(H - H * k - my, y)) };
  }
  // A drag, wheel or glide is "moving". While it lasts, the last full picture
  // is only moved and scaled (render), which is one drawImage; the full
  // repaint (every river, road, the terrain, the veil) waits until the view
  // has been still for SETTLE ms. Repainting all of it on every frame of a
  // drag is what made moving the map lag.
  const SETTLE = 150;
  let moving = false;
  let settleTimer = 0;
  let flowResumed = 0;
  function noteMotion() {
    moving = true;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      moving = false;
      flowResumed = performance.now();
      invalidate();
    }, SETTLE);
  }

  // `motion` false for changes that are not the user moving the map (a
  // resize): those repaint straight away.
  function setView(k, x, y, motion = true) {
    Object.assign(view, clampView(k, x, y));
    if (!motion) return invalidate();
    noteMotion();
    requestRender();
  }

  // Zoom by `factor`, keeping the point under (sx, sy) where it is.
  function zoomAt(factor, sx, sy, animate = false) {
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * factor));
    const wx = (sx - view.x) / view.k;
    const wy = (sy - view.y) / view.k;
    const target = [k, sx - wx * k, sy - wy * k];
    animate ? animateTo(...target) : setView(...target);
  }

  // Buttons, keys and double-clicks glide; the wheel and drags follow the hand.
  // The target is clamped up front: clamped only as it went, the glide used
  // to hit the edge part-way and jolt.
  function animateTo(k, x, y) {
    const to = clampView(k, x, y);
    if (reduced.matches) return setView(to.k, to.x, to.y);
    tween = { from: { ...view }, to, start: performance.now(), duration: 320 };
    requestRender();
  }
  function stepTween(now) {
    const t = Math.min(1, (now - tween.start) / tween.duration);
    const e = 1 - (1 - t) ** 3;
    const { from, to } = tween;
    // Zoom eases in log space, so a 2x step feels as even as a 10x one.
    const k = Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * e);
    if (from.k === to.k) {
      setView(k, from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
    } else {
      // A change of zoom is a scaling about one fixed point on screen, the
      // point both views agree on. The glide holds that point still and only
      // scales. Easing the offsets on their own instead, out of step with the
      // log-eased zoom, swung the map sideways and back: the "dance".
      const r = to.k / from.k;
      const px = (to.x - from.x * r) / (1 - r);
      const py = (to.y - from.y * r) / (1 - r);
      setView(k, px - ((px - from.x) / from.k) * k, py - ((py - from.y) / from.k) * k);
    }
    if (t === 1) tween = null;
  }

  const reset = () => animateTo(1, 0, 0);

  // --- Input -------------------------------------------------------------------
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      tween = null;
      // Lines (deltaMode 1) from some mice, pixels from trackpads.
      const delta = e.deltaY * (e.deltaMode === 1 ? 33 : 1);
      zoomAt(Math.exp(-delta * 0.0015), ...local(e));
    },
    { passive: false },
  );

  // One pointer drags; two pinch (zoom about their midpoint) and drag together.
  const pointers = new Map();
  let gesture = null;
  const gestureOf = () => {
    const [a, b] = [...pointers.values()];
    if (!b) return { mid: a, dist: 0 };
    return { mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dist: Math.hypot(a[0] - b[0], a[1] - b[1]) };
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    gesture = gestureOf();
    tween = null;
    canvas.classList.add("is-dragging");
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, local(e));
    const next = gestureOf();
    if (next.dist && gesture.dist) zoomAt(next.dist / gesture.dist, ...gesture.mid);
    setView(view.k, view.x + next.mid[0] - gesture.mid[0], view.y + next.mid[1] - gesture.mid[1]);
    gesture = next;
  });
  const lift = (e) => {
    pointers.delete(e.pointerId);
    gesture = pointers.size ? gestureOf() : null;
    if (!pointers.size) canvas.classList.remove("is-dragging");
  };
  canvas.addEventListener("pointerup", lift);
  canvas.addEventListener("pointercancel", lift);

  canvas.addEventListener("dblclick", (e) => zoomAt(e.shiftKey ? 0.5 : 2, ...local(e), true));

  canvas.addEventListener("keydown", (e) => {
    const step = 80;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) animateTo(view.k, view.x + moves[e.key][0], view.y + moves[e.key][1]);
    else if (e.key === "+" || e.key === "=") zoomAt(1.6, W / 2, H / 2, true);
    else if (e.key === "-" || e.key === "_") zoomAt(1 / 1.6, W / 2, H / 2, true);
    else if (e.key === "0") reset();
    else return;
    e.preventDefault();
  });

  root.querySelector("[data-zoom=in]").addEventListener("click", () => zoomAt(1.6, W / 2, H / 2, true));
  root.querySelector("[data-zoom=out]").addEventListener("click", () => zoomAt(1 / 1.6, W / 2, H / 2, true));

  // --- Drawing -----------------------------------------------------------------
  // The part of the world on screen, with a margin, for skipping the rest.
  const visible = () => {
    const m = 20 / view.k;
    return [-view.x / view.k - m, -view.y / view.k - m, (W - view.x) / view.k + m, (H - view.y) / view.k + m];
  };
  const onScreen = (box, [x0, y0, x1, y1]) => box[2] >= x0 && box[0] <= x1 && box[3] >= y0 && box[1] <= y1;
  const worldTransform = (c) => c.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);

  function traceRings(rings) {
    ctx.beginPath();
    for (const ring of rings) {
      ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    }
  }

  // --- Terrain ---------------------------------------------------------------
  // data/terrain.jpg has longitude and latitude evenly spaced; the map is an
  // oblique stereographic. The picture is bent into the map's projection by
  // cutting it into a grid of small cells and drawing each with its own
  // affine transform (where the projection takes the cell's corners). Within
  // one cell the projection is as good as flat, so the seams do not show; and
  // since nothing reads the picture's pixels, it works opened from disk too,
  // where the browser would refuse getImageData on a local file.
  const TERRAIN_GRID = [54, 32]; // cells across, down
  const terrainImage = new Image();
  terrainImage.addEventListener("load", () => invalidate(true));
  terrainImage.src = data.terrain.file;

  // The cells of any picture laid out with longitude and latitude evenly
  // spaced over `box` ({ west, south, east, north, width, height }), each with
  // the affine transform that puts it where the projection says. Used for the
  // terrain and the basin fills.
  function gridCells(box, [nx, ny], toWorld) {
    const { west, south, east, north, width, height } = box;
    const at = (i, j) => toWorld(stereo([west + ((east - west) * i) / nx, north - ((north - south) * j) / ny]));
    const cells = [];
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const tl = at(i, j);
        const tr = at(i + 1, j);
        const bl = at(i, j + 1);
        const br = at(i + 1, j + 1);
        const xs = [tl[0], tr[0], bl[0], br[0]];
        const ys = [tl[1], tr[1], bl[1], br[1]];
        cells.push({
          src: [(width * i) / nx, (height * j) / ny, width / nx, height / ny],
          // The unit square onto the cell: x along its top edge, y down its side.
          m: [tr[0] - tl[0], tr[1] - tl[1], bl[0] - tl[0], bl[1] - tl[1], tl[0], tl[1]],
          box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        });
      }
    return cells;
  }

  // --- Basins (bazine hidrografice) -------------------------------------------
  // The data labels each river stretch with its basin: the main river that
  // carries its water into the Danube (scripts/fetch-data.mjs). Areas come
  // from that here, at load: a grid of ~2 km cells over Romania, each taking
  // the basin of the nearest labelled river. So the borders fall halfway
  // between neighbouring rivers, not along the real ridges (there is no
  // elevation data); at country scale that reads true enough. The grid is a
  // small picture, made once and bent into the projection like the terrain,
  // then drawn translucent and clipped to Romania.
  // One hue each, and chosen by neighbour: every two basins that touch sit
  // far apart on the colour wheel (the first palette had the Cerna and the
  // Jiu both green, the Crișuri and the Mureș both orange). Look-alikes, where
  // any remain, are kept to basins that never meet: the Someș and the Olt,
  // the Crișuri and the Siret.
  const BASIN_COLORS = [
    "#00b4d8", // Someș      teal    (by Tisa, Crișuri, Mureș, Siret)
    "#c77dff", // Crișuri    purple  (by Someș, Mureș)
    "#fb8500", // Mureș      orange  (by Someș, Crișuri, Timiș, Jiu, Olt, Siret)
    "#a0c4ff", // Timiș-Bega light blue (by Mureș, Caraș, Cerna, Jiu)
    "#d4a373", // Caraș-Nera tan     (by Timiș, Cerna)
    "#f15bb5", // Cerna      magenta (by Caraș, Timiș, Jiu)
    "#b5e48c", // Jiu        lime    (by Cerna, Timiș, Mureș, Olt)
    "#4cc9f0", // Olt        cyan    (by Mureș, Jiu, Siret, Argeș, Vedea, Ialomița)
    "#ffb703", // Vedea      amber   (by Olt, Argeș)
    "#ef476f", // Argeș      red     (by Olt, Vedea, Ialomița)
    "#fee440", // Ialomița   yellow  (by Argeș, Olt, Siret)
    "#9d4edd", // Siret      violet  (by Tisa, Someș, Mureș, Olt, Ialomița, Prut)
    "#06d6a0", // Prut       green   (by Siret)
    "#ff8fab", // Tisa       pink    (by Someș, Siret)
  ];
  const BASIN_ALPHA = 0.3;
  const BASIN_GRID = [48, 24];
  const basinRaster = (() => {
    const box = { west: 20.2, south: 43.55, east: 29.8, north: 48.3 };
    const STEP = 0.02; // degrees, ~2 km
    const width = Math.round((box.east - box.west) / STEP);
    const height = Math.round((box.north - box.south) / STEP);
    // River points, hashed into 0.1° buckets for the nearest search. The
    // Danube and the unlabelled streams (straight into the Danube or the sea)
    // count too, as "no basin": land nearest them is left clear, rather than
    // borrowing a neighbouring basin's colour, as Dobrogea did.
    const BUCKET = 0.1;
    const KX = Math.cos(46 * RAD); // a degree of longitude is shorter here
    const buckets = new Map();
    const key = (i, j) => i * 10000 + j;
    for (const [, , , flat, , basin] of data.chains) {
      for (let i = 0; i < flat.length; i += 2) {
        const k = key(Math.floor(flat[i] / BUCKET), Math.floor(flat[i + 1] / BUCKET));
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(flat[i], flat[i + 1], basin);
      }
    }
    const rgb = BASIN_COLORS.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
    const pixels = new ImageData(width, height);
    const samples = BASIN_COLORS.map(() => []);
    for (let y = 0; y < height; y++) {
      const lat = box.north - (y + 0.5) * STEP;
      for (let x = 0; x < width; x++) {
        const lon = box.west + (x + 0.5) * STEP;
        const bi = Math.floor(lon / BUCKET);
        const bj = Math.floor(lat / BUCKET);
        let best = -1;
        let bestD = Infinity;
        // Rings of buckets outwards, until the next ring cannot be closer.
        for (let r = 0; r <= 15; r++) {
          if (bestD < Infinity && (r - 1) * BUCKET * KX > bestD) break;
          for (let i = bi - r; i <= bi + r; i++)
            for (let j = bj - r; j <= bj + r; j++) {
              if (Math.max(Math.abs(i - bi), Math.abs(j - bj)) !== r) continue;
              const pts = buckets.get(key(i, j));
              if (!pts) continue;
              for (let p = 0; p < pts.length; p += 3) {
                const d = Math.hypot((pts[p] - lon) * KX, pts[p + 1] - lat);
                if (d < bestD) (bestD = d), (best = pts[p + 2]);
              }
            }
        }
        if (best < 0) continue;
        const o = (y * width + x) * 4;
        [pixels.data[o], pixels.data[o + 1], pixels.data[o + 2]] = rgb[best];
        pixels.data[o + 3] = 255;
        if (x % 4 === 0 && y % 4 === 0) samples[best].push([lon, lat]);
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").putImageData(pixels, 0, 0);
    return { ...box, width, height, canvas, samples };
  })();

  // Drawn opaque onto a scratch canvas first, then laid over the map
  // translucent in one go: the grid's cells overlap a little, and drawn
  // translucent one by one those overlaps came out darker, a visible grid.
  const basinScratch = document.createElement("canvas");
  function drawBasins() {
    basinScratch.width = canvas.width;
    basinScratch.height = canvas.height;
    const onscreen = ctx;
    ctx = basinScratch.getContext("2d");
    ctx.setTransform(onscreen.getTransform());
    ctx.imageSmoothingQuality = "high";
    drawWarped(basinRaster.canvas, basinRaster, shapes.basinCells, visible());
    ctx = onscreen;
    ctx.save();
    ctx.clip(shapes.outlinePath);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = BASIN_ALPHA;
    ctx.drawImage(basinScratch, 0, 0);
    ctx.restore();
  }

  // --- Terrain detail ----------------------------------------------------------
  // Blue Marble is ~0.4 km a pixel, soft past a few times zoom. Closer in, the
  // page loads Sentinel-2 cloudless (EOX, 10 m a pixel, the 2016 edition: CC BY
  // 4.0) for just what is on screen: square tiles of 2^-n degrees, with n
  // picked so a tile comes out 384-768 px across, fetched from EOX's map
  // service like the base picture and bent into the projection the same way,
  // in a grid of DETAIL_CELLS per side. The base picture shows until a tile
  // arrives; tiles are kept, so panning back costs nothing.
  const DETAIL_URL = "https://tiles.maps.eox.at/wms?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS=s2cloudless&SRS=EPSG:4326&FORMAT=image/jpeg&WIDTH=512&HEIGHT=512&BBOX=";
  const DETAIL_FROM = 250; // screen px per degree of latitude where detail starts (the base has ~190)
  const DETAIL_CELLS = 4;
  const DETAIL_MAX_TILES = 400;
  const detailCache = new Map();

  function detailTile(n, i, j) {
    const key = `${n}/${i}/${j}`;
    let tile = detailCache.get(key);
    if (!tile) {
      const span = 2 ** -n;
      const img = new Image();
      tile = { img, ready: false, west: i * span, south: j * span, span };
      img.addEventListener("load", () => {
        tile.ready = true;
        invalidate();
      });
      img.src = DETAIL_URL + [i * span, j * span, (i + 1) * span, (j + 1) * span].join(",");
      detailCache.set(key, tile);
      // Oldest out first once the cache is full.
      if (detailCache.size > DETAIL_MAX_TILES) detailCache.delete(detailCache.keys().next().value);
    }
    return tile;
  }

  function drawDetail(area) {
    // Screen px per degree of latitude here, from the map's centre.
    const a = lonLatToWorld([25, 45.5]);
    const b = lonLatToWorld([25, 46.5]);
    const pxPerDeg = Math.hypot(b[0] - a[0], b[1] - a[1]) * view.k;
    if (pxPerDeg < DETAIL_FROM) return;
    const n = Math.floor(Math.log2(pxPerDeg / 384));
    const span = 2 ** -n;

    // The lon/lat range on screen: the edges of the visible area, unprojected.
    const [x0, y0, x1, y1] = area;
    const lons = [];
    const lats = [];
    for (let t = 0; t <= 1; t += 0.25)
      for (const p of [[x0 + (x1 - x0) * t, y0], [x0 + (x1 - x0) * t, y1], [x0, y0 + (y1 - y0) * t], [x1, y0 + (y1 - y0) * t]]) {
        const [lon, lat] = worldToLonLat(p);
        lons.push(lon);
        lats.push(lat);
      }
    const { west, south, east, north } = data.terrain;
    const i0 = Math.floor(Math.max(west, Math.min(...lons)) / span);
    const i1 = Math.floor(Math.min(east, Math.max(...lons)) / span);
    const j0 = Math.floor(Math.max(south, Math.min(...lats)) / span);
    const j1 = Math.floor(Math.min(north, Math.max(...lats)) / span);

    const base = ctx.getTransform();
    const step = 512 / DETAIL_CELLS;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const tile = detailTile(n, i, j);
        if (!tile.ready) continue;
        const d = tile.span / DETAIL_CELLS;
        const at = (ci, cj) => lonLatToWorld([tile.west + ci * d, tile.south + tile.span - cj * d]);
        for (let cj = 0; cj < DETAIL_CELLS; cj++)
          for (let ci = 0; ci < DETAIL_CELLS; ci++) {
            const tl = at(ci, cj);
            const tr = at(ci + 1, cj);
            const bl = at(ci, cj + 1);
            ctx.setTransform(base);
            ctx.transform(tr[0] - tl[0], tr[1] - tl[1], bl[0] - tl[0], bl[1] - tl[1], tl[0], tl[1]);
            // Overlap into the next cell, except at the tile's own far edges.
            const fx = ci === DETAIL_CELLS - 1 ? 1 : OVERLAP;
            const fy = cj === DETAIL_CELLS - 1 ? 1 : OVERLAP;
            ctx.drawImage(tile.img, ci * step, cj * step, step * fx, step * fy, 0, 0, fx, fy);
          }
      }
    ctx.setTransform(base);
  }

  // Each cell borrows 3% of its neighbours' picture, drawn where it really
  // belongs, so anti-aliased cell edges overlap instead of leaving hairlines.
  const OVERLAP = 1.03;
  // Draws `image`, laid out over `box`, through its grid `cells`.
  function drawWarped(image, { width, height }, cells, area) {
    const base = ctx.getTransform();
    for (const { src, m, box } of cells) {
      if (!onScreen(box, area)) continue;
      const [sx, sy, sw, sh] = src;
      const fx = Math.min(OVERLAP, (width - sx) / sw);
      const fy = Math.min(OVERLAP, (height - sy) / sh);
      ctx.setTransform(base);
      ctx.transform(...m);
      ctx.drawImage(image, sx, sy, sw * fx, sh * fy, 0, 0, fx, fy);
    }
    ctx.setTransform(base);
  }

  function drawTerrain() {
    if (!terrainImage.complete || !terrainImage.naturalWidth) return;
    const area = visible();
    ctx.save();
    ctx.imageSmoothingQuality = "high";
    drawWarped(terrainImage, data.terrain, shapes.terrain, area);
    drawDetail(area);
    // At full strength inside Romania; beyond it the veil over every layer
    // dims it (paintVeil).
    ctx.restore();
  }

  function drawGround() {
    ctx.save();
    // With the satellite picture on, everything starts as its edge colour, so
    // the land past the picture (Croatia, Bosnia: no outline here at all, the
    // canvas was left empty and the veil's grey showed through) blends into it
    // once both are under the veil. The flat land colours would only stand out
    // against it, so they are left off; the picture covers Romania anyway.
    if (layers.terrain) {
      const [x0, y0, x1, y1] = visible();
      ctx.fillStyle = COLORS["terrain-edge"];
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    // The sea first, so the land covers wherever the two outlines disagree.
    traceRings(shapes.sea);
    ctx.fillStyle = COLORS.sea;
    ctx.fill();
    if (!layers.terrain) {
      traceRings(shapes.neighbours);
      ctx.fillStyle = COLORS.neighbour;
      ctx.fill();
      traceRings(shapes.outline);
      ctx.fillStyle = COLORS.land;
      ctx.fill();
    }
    // The satellite picture over that. The coast and the border are drawn
    // after it, on top.
    if (layers.terrain) drawTerrain();
    // The coast glows faintly in the river blue, the colour the rivers bring.
    traceRings(shapes.sea);
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = COLORS["river-mid"];
    for (const [w, a] of [[6, 0.06], [2, 0.25]]) {
      ctx.lineWidth = (w * s) / Math.sqrt(view.k);
      ctx.globalAlpha = a;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    // A thin border line, on the flat map only and only while the Border
    // layer is off: over the satellite picture the veil's soft edge already
    // marks the country (a line on top read as a hard cut), and with the
    // Border layer on its dashed line does the job.
    if (!layers.terrain && !layers.border) {
      traceRings(shapes.outline);
      ctx.lineWidth = 1 / view.k;
      ctx.strokeStyle = COLORS.border;
      ctx.stroke();
    }
    ctx.restore();
  }

  // Line widths grow with the square root of the zoom: thicker close up, so
  // a river still reads as a river, but not so much that it turns into a band.
  // Divided by the zoom because they are drawn in world units.
  const strokeScale = () => (s * Math.sqrt(view.k)) / view.k;

  // All rivers on screen. One path per size, so thousands of stretches cost
  // nine strokes (plus glow).
  function drawRivers() {
    const area = visible();
    const scale = strokeScale();
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = "lighter";
    for (let size = 1; size <= SIZES; size++) {
      const { rgb, width, glow } = ramp[size];
      ctx.beginPath();
      let any = false;
      for (const c of shapes.chains) {
        if (c.size !== size || !onScreen(c.box, area)) continue;
        c.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        any = true;
      }
      if (!any) continue;
      ctx.strokeStyle = rgb;
      const passes = glow ? [[4, 0.05], [2, 0.12], [1, 0.9]] : [[1, 0.85]];
      for (const [k, a] of passes) {
        ctx.lineWidth = width * k * scale;
        ctx.globalAlpha = a;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Roads: colour, screen width (px), opacity, and the zoom a class starts at.
  // Motorways green, the rest yellow, wider and stronger the more important.
  // Trunk (national) roads show at every zoom; primary roads join from 2x,
  // where there is room for them. Smallest first, so a bigger road is drawn
  // over the ones it crosses. Widths grow a little with zoom, like the
  // rivers'. Drawn in world units.
  const ROAD_STYLE = {
    primary: { color: "road", width: 1.05, alpha: 0.45, from: 2 },
    trunk: { color: "road", width: 1.65, alpha: 0.7, from: 0 },
    motorway: { color: "motorway", width: 3, alpha: 0.95, from: 0 },
  };

  function drawRoads() {
    const area = visible();
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const [cls, { color, width, alpha, from }] of Object.entries(ROAD_STYLE)) {
      if (view.k < from) continue;
      ctx.beginPath();
      for (const { pts, box } of shapes.roads[cls]) {
        if (!onScreen(box, area)) continue;
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      }
      ctx.strokeStyle = COLORS[color];
      ctx.globalAlpha = alpha;
      ctx.lineWidth = (width * view.k ** 0.3) / view.k;
      ctx.stroke();
    }
    ctx.restore();
  }

  // Romania's border: a wide white dashed line, the way a printed school map
  // draws a frontier. Sizes in screen px, drawn in world units. The veil
  // leaves a gap for it (paintVeil), so the half outside Romania is as bright
  // as the half inside.
  const BORDER_WIDTH = 2.5;
  const BORDER_DASH = [10, 7];
  function drawBorder() {
    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = BORDER_WIDTH / view.k;
    ctx.lineJoin = "round";
    ctx.setLineDash(BORDER_DASH.map((d) => d / view.k));
    ctx.stroke(shapes.outlinePath);
    ctx.restore();
  }

  // Each city's rough outline (its administrative boundary, simplified): a
  // yellow line over a faint yellow wash, shown with the same zoom tiers as
  // the names. A plain line, no glow, so it reads as a boundary and not as one
  // more river. Drawn in world units, the line kept ~2.2px on screen.
  function drawCityShapes() {
    ctx.save();
    ctx.strokeStyle = COLORS.city;
    ctx.fillStyle = COLORS.city;
    ctx.lineJoin = "round";
    ctx.lineWidth = 2.2 / view.k;
    for (const c of shapes.cities) {
      if (!c.shape.length || view.k < CITY_ZOOM[c.tier]) continue;
      traceRings(c.shape);
      ctx.globalAlpha = 0.15;
      ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.stroke();
    }
    ctx.restore();
  }

  // In screen space: names stay the same size at any zoom. Tier 1 (the big
  // rivers) always shows; tier 2 from LABEL_ZOOM[2], tier 3 from
  // LABEL_ZOOM[3], each a touch smaller and dimmer. Tiers draw in order and a
  // name that would overlap one already drawn is skipped, so the big rivers
  // keep their names and the map never fills up with text.
  const LABEL_ZOOM = [0, 0, 2.5, 5];
  const LABEL_STYLE = [null, { size: 13, alpha: 1 }, { size: 12, alpha: 0.85 }, { size: 11, alpha: 0.7 }];

  // Cities: the ten biggest always, ten more from 1.4x, the rest from 3x.
  // Yellow, upright and a little bolder than the italic river names, so the
  // two never read as the same kind of thing.
  const CITY_ZOOM = [0, 0, 1.4, 3];

  function drawLabels() {
    const toScreen = ([x, y]) => [x * view.k + view.x, y * view.k + view.y];
    const taken = [];
    const overlaps = (r) => taken.some((t) => r[0] < t[2] && r[2] > t[0] && r[1] < t[3] && r[3] > t[1]);
    ctx.save();
    ctx.textBaseline = "middle";
    // A dark outline round the letters, so a name stays legible where another
    // river or a pulse runs behind it.
    ctx.strokeStyle = "rgba(7, 11, 22, 0.9)";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3.5;

    // Cities first, so their names win any overlap with a river's. A name sits
    // centred just above its city's outline, or just below if that is taken,
    // or is left out (the outline still shows).
    const cityPx = Math.max(11, 12.5 * s);
    ctx.font = `600 ${cityPx}px system-ui, sans-serif`;
    ctx.fillStyle = COLORS.city;
    ctx.textAlign = "center";
    for (const c of layers.cities ? shapes.cities : []) {
      if (view.k < CITY_ZOOM[c.tier]) continue;
      const [x] = toScreen(c.xy);
      const top = c.box[1] * view.k + view.y;
      const bottom = c.box[3] * view.k + view.y;
      if (x < -80 || x > W + 80 || bottom < -40 || top > H + 40) continue;
      const half = ctx.measureText(c.name).width / 2 + 2;
      const gap = 5 + cityPx / 2;
      const above = [x - half, top - gap - cityPx / 2 - 2, x + half, top - gap + cityPx / 2 + 2];
      const below = [x - half, bottom + gap - cityPx / 2 - 2, x + half, bottom + gap + cityPx / 2 + 2];
      const box = !overlaps(above) ? above : !overlaps(below) ? below : null;
      if (!box) continue;
      taken.push(box);
      const ty = (box[1] + box[3]) / 2;
      ctx.strokeText(c.name, x, ty);
      ctx.fillText(c.name, x, ty);
    }

    // Confluences (the Tisa into the Danube): a small ring on the meeting
    // point and "Tisa → Dunărea" beside it, placed before the river names so
    // they make way for it. Part of the rivers layer.
    for (const c of layers.rivers ? shapes.confluences : []) {
      const [x, y] = toScreen(c.xy);
      if (x < -80 || x > W + 80 || y < -40 || y > H + 40) continue;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLORS["river-large"];
      ctx.shadowColor = COLORS.accent;
      ctx.shadowBlur = 8;
      ctx.stroke();
      ctx.restore();
      taken.push([x - 8, y - 8, x + 8, y + 8]);
      const text = `${c.river} → ${c.into}`;
      const px = Math.max(11, 12.5 * s);
      ctx.font = `italic 600 ${px}px system-ui, sans-serif`;
      ctx.fillStyle = COLORS["river-large"];
      ctx.globalAlpha = outsideFade(c.xy);
      ctx.textAlign = "left";
      const w = ctx.measureText(text).width;
      taken.push([x + 10, y - px / 2 - 2, x + 14 + w, y + px / 2 + 2]);
      ctx.strokeText(text, x + 12, y);
      ctx.fillText(text, x + 12, y);
      ctx.globalAlpha = 1;
    }

    ctx.textAlign = "center";
    ctx.fillStyle = COLORS.accent;
    // River names give way to the basin names while those are shown: one set
    // of names at a time, and a basin's already names its river. Past
    // BASIN_LABEL_ZOOM, where the basin names go, the river names come back.
    const basinNamesShown = layers.basins && view.k < BASIN_LABEL_ZOOM;
    for (let tier = 1; tier <= 3 && layers.rivers && !basinNamesShown; tier++) {
      if (view.k < LABEL_ZOOM[tier]) break;
      const { size, alpha } = LABEL_STYLE[tier];
      const px = Math.max(size - 2, size * s);
      ctx.font = `italic ${px}px system-ui, sans-serif`;
      ctx.globalAlpha = alpha;
      for (const l of shapes.labels) {
        if (l.tier !== tier) continue;
        const [rx, ry] = toScreen(l.xy);
        if (rx < -80 || rx > W + 80 || ry < -40 || ry > H + 40) continue;
        // Beside the river, not on it: the centre of the text moves out along
        // the normal far enough that its box clears the line, plus a gap for
        // the river's own width and glow.
        const halfW = ctx.measureText(l.name).width / 2;
        const halfH = px / 2;
        const clear = halfW * Math.abs(l.n[0]) + halfH * Math.abs(l.n[1]) + 7;
        const x = rx + l.n[0] * clear;
        const y = ry + l.n[1] * clear;
        const box = [x - halfW - 4, y - halfH - 2, x + halfW + 4, y + halfH + 2];
        if (overlaps(box)) continue;
        taken.push(box);
        ctx.globalAlpha = alpha * outsideFade(l.xy);
        ctx.strokeText(l.name, x, y);
        ctx.fillText(l.name, x, y);
      }
    }
    ctx.globalAlpha = 1;
    const [sx, sy] = toScreen(shapes.seaLabel);
    ctx.fillStyle = COLORS["river-large"];
    ctx.globalAlpha = 0.75 * outsideFade(shapes.seaLabel);
    ctx.font = `italic ${Math.max(12, 16 * s)}px system-ui, sans-serif`;
    ctx.fillText("Black Sea", sx, sy);

    // Basin names last, so every other name keeps its place and a basin's is
    // left out where it would overlap one. Spaced capitals in the basin's
    // colour, like a region name on a printed map; only up to BASIN_LABEL_ZOOM,
    // past which a basin is bigger than the screen and its name means little.
    if (layers.basins && view.k < BASIN_LABEL_ZOOM) {
      const px = Math.max(10, 11 * s);
      ctx.font = `700 ${px}px system-ui, sans-serif`;
      ctx.letterSpacing = "0.12em";
      ctx.textAlign = "center";
      for (const b of shapes.basinLabels) {
        const [x, y] = toScreen(b.xy);
        const text = b.name.toUpperCase();
        const half = ctx.measureText(text).width / 2 + 4;
        const box = [x - half, y - px / 2 - 3, x + half, y + px / 2 + 3];
        if (overlaps(box)) continue;
        taken.push(box);
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = b.color;
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
      }
      ctx.letterSpacing = "0px";
    }
    ctx.restore();
  }
  const BASIN_LABEL_ZOOM = 3;

  // --- Flowing water -----------------------------------------------------------
  // Pulses are placed by distance to the sea: one every `spacing` km of that
  // distance, all moving `speed` km/s towards it. Because every river uses the
  // same spacing and speed, a pulse leaving a tributary carries on down the
  // main river without a jump.
  //
  // Both halve each time the zoom doubles, so on screen the pulses keep about
  // the same gap and pace, and zooming in shows more water rather than the
  // same few pulses racing further apart. Smaller rivers join in as you get
  // closer; at the whole-country view headwaters stay still, or the map would
  // fizz.
  const SPACING = 22; // km, at the whole-country view
  const SPEED = 34; // km per second, likewise

  const glowSprite = (() => {
    const size = 64;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255, 255, 255, 1)");
    grad.addColorStop(0.18, "rgba(200, 245, 255, 0.9)");
    grad.addColorStop(0.4, "rgba(95, 216, 255, 0.3)");
    grad.addColorStop(1, "rgba(95, 216, 255, 0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  })();

  const mod = (a, n) => ((a % n) + n) % n;

  function drawFlow(time, alpha) {
    if (alpha <= 0) return;
    const level = 2 ** Math.floor(Math.log2(view.k));
    const spacing = SPACING / level;
    const travelled = ((time / 1000) * SPEED) / level;
    const minSize = view.k >= 4 ? 1 : view.k >= 2 ? 2 : 3;
    const area = visible();
    // Pulse size in screen px, a little larger close up; drawn in world units.
    const grow = Math.min(view.k, 4) ** 0.35 / view.k;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const c of shapes.chains) {
      if (c.size < minSize || c.km <= 0 || !onScreen(c.box, area)) continue;
      const t = (c.size - 1) / (SIZES - 1);
      const size = (3 + 6 * t) * s * grow;
      ctx.globalAlpha = alpha * (0.3 + 0.6 * t) * (c.outside ? OUTSIDE_FADE : 1);
      const pxPerKm = c.px / c.km;
      // x: km up from this chain's mouth. A pulse sits wherever the distance
      // to the sea (c.sea + x) plus the distance travelled is a whole number
      // of spacings; as time runs, x shrinks and the pulse moves to the sea.
      const { pts, back } = c;
      let i = pts.length - 2;
      for (let x = mod(-(c.sea + travelled), spacing); x < c.km; x += spacing) {
        const at = x * pxPerKm;
        while (i > 0 && back[i] < at) i--;
        const seg = back[i] - back[i + 1] || 1;
        const f = (at - back[i + 1]) / seg;
        const px = pts[i + 1][0] + (pts[i][0] - pts[i + 1][0]) * f;
        const py = pts[i + 1][1] + (pts[i][1] - pts[i + 1][1]) * f;
        ctx.drawImage(glowSprite, px - size / 2, py - size / 2, size, size);
      }
    }
    ctx.restore();
  }

  // Ground, roads, cities, rivers and the veil only change when the view does,
  // so they are painted onto an offscreen canvas and copied each frame in
  // between. `painted` is the view they were painted for, which lets render
  // stretch them while the map moves.
  const staticLayer = document.createElement("canvas");
  let painted = null;

  // Paints the map layers onto `target` as seen from `at`. The draw functions
  // read `ctx` and `view`, so both are pointed at the target for the moment.
  function paintLayer(target, at) {
    target.width = canvas.width;
    target.height = canvas.height;
    const onscreen = ctx;
    const current = { ...view };
    ctx = target.getContext("2d");
    Object.assign(view, at);
    worldTransform(ctx);
    drawGround();
    // The basin fills right over the ground, under everything drawn on it.
    if (layers.basins) drawBasins();
    // Roads lowest, then cities, then rivers on top: a river reads as running
    // through its town, and a road as running to it.
    if (layers.roads) drawRoads();
    if (layers.cities) drawCityShapes();
    // The border just under the rivers: where a river is the border (the
    // Danube, the Prut, the Tisa) it runs over the dashes.
    if (layers.border) drawBorder();
    if (layers.rivers) drawRivers();
    // The veil, baked in here once per view rather than blended over the
    // whole screen on every frame.
    drawVeil(paintVeil(target));
    Object.assign(view, current);
    ctx = onscreen;
  }

  function paintStatic() {
    paintLayer(staticLayer, view);
    painted = { ...view };
    dirty = false;
  }

  // An overview behind the stretched picture. Moving the map shows parts the
  // last picture never covered, and those came up black: a pan past its edge,
  // a zoom out beyond it. This is the whole region at a far-out zoom, about
  // twice the window each way, painted only when the window or a layer
  // changes; while the map moves it is stretched underneath, so a gap shows a
  // softer copy of the map rather than nothing.
  const OVERVIEW_ZOOM = 0.5;
  const overviewLayer = document.createElement("canvas");
  let overview = null;
  let overviewDirty = true;
  function paintOverview() {
    const at = { k: OVERVIEW_ZOOM, x: (W * (1 - OVERVIEW_ZOOM)) / 2, y: (H * (1 - OVERVIEW_ZOOM)) / 2 };
    paintLayer(overviewLayer, at);
    overview = at;
    overviewDirty = false;
  }
  // It is only seen once the map moves, so it is not painted in the same
  // frame as the picture itself (which doubled the wait after a layer
  // switch), but when the browser is next idle. Still moving by then, it is
  // left for render to ask again once the view settles.
  const whenIdle = window.requestIdleCallback ? (f) => requestIdleCallback(f, { timeout: 1000 }) : (f) => setTimeout(f, 200);
  let overviewQueued = false;
  function scheduleOverview() {
    if (overviewQueued) return;
    overviewQueued = true;
    whenIdle(() => {
      overviewQueued = false;
      if (overviewDirty && !moving) paintOverview();
    });
  }

  // A layer switch cross-fades: the picture from before the switch is kept
  // and laid over the new one, fading out over LAYER_FADE ms. It hides the
  // moment the repaint takes, and the map changes softly instead of blinking.
  const LAYER_FADE = 180;
  const fadeLayer = document.createElement("canvas");
  let fade = null; // { from: the view it was painted for, start }
  function startLayerFade() {
    if (reduced.matches || !painted || !staticLayer.width) return;
    fadeLayer.width = staticLayer.width;
    fadeLayer.height = staticLayer.height;
    fadeLayer.getContext("2d").drawImage(staticLayer, 0, 0);
    fade = { from: painted, start: performance.now() };
  }

  // --- Outside Romania -----------------------------------------------------------
  // One veil over everything outside the country, whatever layer it belongs
  // to — terrain, roads, the Tisa — drawn after all of them, so a new layer is
  // dimmed without any code of its own. It is a grey mask: opaque outside
  // Romania, a hole inside, its edge blurred so the border fades rather than
  // cuts. Applied in two passes: `saturation` takes the colour out (by
  // --outside-grey), `multiply` darkens (by --outside-dim). Baked into the
  // static layer, so only when the view changes; the moving pulses, drawn
  // after it, dim themselves instead (drawFlow).
  const OUTSIDE_DIM = parseFloat(color("outside-dim")) || 0.5;
  const OUTSIDE_GREY = parseFloat(color("outside-grey")) || 0.75;
  const VEIL_BLUR = 8; // px
  // The mask is the costly part (a blur over the whole window) and depends
  // only on the view and two switches, so each target (the picture, the
  // overview) keeps its own and remakes it only when one of those changes:
  // switching cities, roads, basins or terrain reuses it as it is.
  const veils = new Map();
  function paintVeil(target) {
    let veil = veils.get(target);
    if (!veil) veils.set(target, (veil = { layer: document.createElement("canvas"), key: "" }));
    const key = [canvas.width, canvas.height, view.k, view.x, view.y, layers.border, layers.rivers].join();
    const veilLayer = veil.layer;
    if (veil.key === key) return veilLayer;
    veil.key = key;
    veilLayer.width = canvas.width;
    veilLayer.height = canvas.height;
    const v = veilLayer.getContext("2d");
    // Mid grey: a multiply by it at full strength halves brightness, so the
    // pass's alpha (2 x dim) sets how much.
    v.fillStyle = "#808080";
    v.fillRect(0, 0, veilLayer.width, veilLayer.height);
    v.globalCompositeOperation = "destination-out";
    v.filter = `blur(${VEIL_BLUR * dpr}px)`;
    worldTransform(v);
    v.fill(shapes.outlinePath);
    // A gap along the border line, a little wider than it, so its outer half
    // is not dimmed: the veil's soft edge sits right on the border.
    if (layers.border) {
      v.filter = `blur(${1 * dpr}px)`;
      v.lineWidth = (BORDER_WIDTH + 3) / view.k;
      v.lineJoin = "round";
      v.stroke(shapes.outlinePath);
    }
    // The one exception: the Danube keeps its full brightness all the way,
    // in Hungary and Serbia too. Cut out along its course, a little wider than
    // its line and with a tighter blur than Romania's edge: as wide as the
    // whole glow, the cut let an undimmed band of terrain show either side,
    // like a halo.
    if (layers.rivers) {
      const area = visible();
      v.filter = `blur(${2 * dpr}px)`;
      v.lineCap = "round";
      v.lineJoin = "round";
      for (const c of shapes.chains) {
        if (!c.danube || !onScreen(c.box, area)) continue;
        v.beginPath();
        c.pts.forEach(([x, y], i) => (i ? v.lineTo(x, y) : v.moveTo(x, y)));
        v.lineWidth = ramp[c.size].width * 2 * strokeScale() + 2 / view.k;
        v.stroke();
      }
    }
    return veilLayer;
  }
  function drawVeil(veilLayer) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "saturation";
    ctx.globalAlpha = OUTSIDE_GREY;
    ctx.drawImage(veilLayer, 0, 0);
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = Math.min(1, OUTSIDE_DIM * 2);
    ctx.drawImage(veilLayer, 0, 0);
    ctx.restore();
  }

  // Names are drawn after the veil, so they stay crisp, and fade themselves
  // instead: a name outside Romania (the Tisa, "Tisa → Dunărea", the Black
  // Sea) takes the same dimming as the map under it.
  const OUTSIDE_FADE = 1 - OUTSIDE_DIM * 0.9;
  const outsideFade = ([wx, wy]) => (hitTest.isPointInPath(shapes.outlinePath, wx, wy) ? 1 : OUTSIDE_FADE);

  // --- Loop --------------------------------------------------------------------
  // Rivers and names are there from the first frame; only the water fades in.
  // Under reduced motion nothing loops: a frame is drawn when something
  // changes, and the water stays still.
  const FLOW_IN = 1200;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const easeOut = (t) => 1 - (1 - t) ** 3;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  let start = 0;
  let frame = 0;

  function render(now) {
    frame = 0;
    // The canvas can be 0px for a frame while the page lays out, and an empty
    // offscreen layer cannot be drawn. Wait for a size.
    if (!canvas.width || !canvas.height) return requestRender();
    if (tween) stepTween(now);
    // While the map moves, the last full picture is stretched to the new view
    // instead of repainted: a pixel painted for view `from` lands where the
    // current view puts it. Under it, the overview fills whatever that
    // picture never covered; the repaint once the view settles sharpens all.
    const stretching = moving && painted;
    if (dirty && !stretching) paintStatic();
    // The overview is painted while the map is still, never mid-gesture.
    if (overviewDirty && !moving && !fade) scheduleOverview();
    const stretch = (from) => {
      const r = view.k / from.k;
      ctx.setTransform(r, 0, 0, r, dpr * (view.x - from.x * r), dpr * (view.y - from.y * r));
    };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (stretching) {
      if (overview) {
        stretch(overview);
        ctx.drawImage(overviewLayer, 0, 0);
      }
      stretch(painted);
    }
    ctx.drawImage(staticLayer, 0, 0);
    if (fade) {
      const t = clamp01((now - fade.start) / LAYER_FADE);
      if (t >= 1 || moving) fade = null;
      else {
        stretch(fade.from);
        ctx.globalAlpha = 1 - t;
        ctx.drawImage(fadeLayer, 0, 0);
        ctx.globalAlpha = 1;
      }
    }
    // The water pauses while the map moves (it would be drawn at the new view
    // over a stretched old one), and fades back in once it settles.
    if (!reduced.matches && !moving && layers.rivers) {
      worldTransform(ctx);
      const intro = easeOut(clamp01((now - start) / FLOW_IN));
      const resume = flowResumed ? easeOut(clamp01((now - flowResumed) / 300)) : 1;
      drawFlow(now, Math.min(intro, resume));
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawLabels();
    if (!reduced.matches || tween) requestRender();
  }

  // Nothing is drawn while the page waits for its fonts (see the end).
  function requestRender() {
    if (!frame && !fontsPending) frame = requestAnimationFrame(render);
  }

  reduced.addEventListener("change", () => {
    start = performance.now();
    requestRender();
  });

  new ResizeObserver(() => {
    fit();
    setView(view.k, view.x, view.y, false);
  }).observe(canvas);

  // Hold the first paint until the panel's fonts have arrived, so the page
  // does not show the fallback font and then jump. Offline or on a slow
  // line, give up after FONT_WAIT and show it with the fallback.
  const FONT_WAIT = 1500;
  const fonts = document.fonts
    ? Promise.all(['800 1em "Baloo 2"', '800 1em "Nunito"', '700 1em "Nunito"', '600 1em "Nunito"'].map((f) => document.fonts.load(f)))
    : Promise.resolve();
  Promise.race([fonts, new Promise((r) => setTimeout(r, FONT_WAIT))])
    .catch(() => {})
    .then(() => {
      fontsPending = false;
      root.classList.remove("is-loading");
      fit();
      start = performance.now();
      requestRender();
    });
})();
