// Romania's power grid as a neon constellation, full screen. Zoom with the
// wheel, a pinch, a double-click, the buttons or +/-; move by dragging or
// with the arrow keys; 0 resets.
// No libraries: a hand-written projection, Canvas 2D for drawing, and
// requestAnimationFrame for the timeline.
//
// The data is window.GRID_DATA from data/grid.js (built by scripts/fetch-data.mjs):
//   outline     [[lon, lat], ...] rings
//   neighbours  [[lon, lat], ...] rings of the countries around, approximate
//   lines    { kv: 400 | 220, f: modelled MW, c: [[lon, lat], ...] }
//   plants   [lon, lat, source, mw | null], smallest first
(() => {
  const data = window.GRID_DATA;
  const root = document.querySelector(".nsc-grid-map");
  const canvas = root.querySelector(".map-canvas");
  let ctx = canvas.getContext("2d");

  // Colours come from style.css, so the legend and the map share one palette.
  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(`--${name}`).trim();
  const COLORS = Object.fromEntries(["nuclear", "hydro", "wind", "solar", "coal", "gas", "other", "kv400", "kv220", "land", "neighbour"].map((n) => [n, color(n)]));

  let fontsPending = true;

  // --- Layers ------------------------------------------------------------------
  // What the panel's switches show or hide. Plants, the two line voltages and
  // the flow pulses each have a switch; the plant types have chips of their
  // own, which also serve as the colour key. The flow follows its lines: a
  // hidden voltage hides its pulses too.
  const layers = { plants: true, kv400: true, kv220: true, flow: true };
  const sources = new Set(["nuclear", "hydro", "wind", "solar", "coal", "gas", "other"]);
  const sourceList = root.querySelector(".source-list");
  root.querySelectorAll("[data-layer]").forEach((button) => {
    button.addEventListener("click", () => {
      const name = button.dataset.layer;
      layers[name] = !layers[name];
      button.setAttribute("aria-pressed", String(layers[name]));
      root.querySelector(`[data-layer-row=${name}]`).classList.toggle("is-hidden", !layers[name]);
      if (name === "plants") sourceList.classList.toggle("is-hidden", !layers.plants);
      dirty = true;
      requestRender();
    });
  });
  root.querySelectorAll("[data-source]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const name = chip.dataset.source;
      sources.has(name) ? sources.delete(name) : sources.add(name);
      chip.setAttribute("aria-pressed", String(sources.has(name)));
      requestRender();
    });
  });

  // --- Projection ------------------------------------------------------------
  // Oblique stereographic centred on Romania: the same family as Stereo 70, the
  // national projection, so the country keeps its familiar shape. Returns unit
  // coordinates; fit() scales them to the window.
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

  const unit = {
    outline: data.outline.map((ring) => ring.map(stereo)),
    neighbours: data.neighbours.map((ring) => ring.map(stereo)),
    lines: data.lines.map((l) => ({ kv: l.kv, f: l.f ?? 0, c: l.c.map(stereo) })),
    plants: data.plants.map(([lon, lat, source, mw]) => ({ p: stereo([lon, lat]), source, mw })),
  };
  const xs = unit.outline.flat().map((p) => p[0]);
  const ys = unit.outline.flat().map((p) => p[1]);
  const bounds = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };

  // --- Layout ----------------------------------------------------------------
  // Two coordinate systems. "World" is the whole map fitted into the window,
  // recomputed on resize. "Screen" is world through the view: screen =
  // world * view.k + (view.x, view.y). Zooming and panning only change the
  // view, never the geometry. `s` scales strokes and dots with the window,
  // tuned at 900px.
  let W = 0;
  let H = 0;
  let dpr = 1;
  let s = 1;
  let shapes = null;

  function fit() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    s = Math.min(W, H * 1.4) / 900;

    // Contain: the whole map fits, with a margin. On a wide window the map is
    // fitted into the space right of the panel, which would otherwise sit
    // over the west of the country; on a narrow one the panel floats over it.
    const padX = W * 0.04;
    const padY = H * 0.08;
    const panel = root.querySelector(".map-panel");
    const padLeft = W >= 900 ? panel.offsetLeft + panel.offsetWidth + 16 : padX;
    const k = Math.min((W - padLeft - padX) / (bounds.x1 - bounds.x0), (H - padY * 2) / (bounds.y1 - bounds.y0));
    const ox = padLeft + (W - padLeft - padX - (bounds.x1 - bounds.x0) * k) / 2;
    const oy = padY + (H - padY * 2 - (bounds.y1 - bounds.y0) * k) / 2;
    const toWorld = ([x, y]) => [ox + (x - bounds.x0) * k, oy + (y - bounds.y0) * k];
    const mapWidth = (bounds.x1 - bounds.x0) * k;

    const lines = unit.lines.map((l) => {
      const pts = l.c.map(toWorld);
      // Running length along the line, which the flow pulses are placed by;
      // `west` staggers their start so lines do not pulse in step; and a
      // bounding box, to skip what is off screen.
      const len = [0];
      for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const lx = pts.map((p) => p[0]);
      const ly = pts.map((p) => p[1]);
      return {
        kv: l.kv,
        f: l.f,
        pts,
        len,
        total: len[len.length - 1],
        west: (Math.min(...lx) - ox) / mapWidth,
        box: [Math.min(...lx), Math.min(...ly), Math.max(...lx), Math.max(...ly)],
      };
    });

    shapes = {
      outline: unit.outline.map((ring) => ring.map(toWorld)),
      neighbours: unit.neighbours.map((ring) => ring.map(toWorld)),
      lines,
      plants: unit.plants.map((pl) => ({ ...pl, xy: toWorld(pl.p), r: radius(pl.mw) * s })),
    };
    dirty = true;
  }

  // Area grows with capacity, so the radius goes with its square root. Plants
  // without a capacity tag get a small fixed dot. Matches the legend sizes.
  const radius = (mw) => (mw ? 1.9 + 0.355 * Math.sqrt(mw) : 2.1);

  // --- Glow sprites ----------------------------------------------------------
  // One pre-rendered radial glow per colour, stamped with drawImage. Far cheaper
  // than shadowBlur on 762 dots every frame.
  const SPRITE = 64;
  const sprites = {};
  for (const name of ["nuclear", "hydro", "wind", "solar", "coal", "gas", "other", "kv400", "kv220"]) {
    const c = document.createElement("canvas");
    c.width = c.height = SPRITE;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(SPRITE / 2, SPRITE / 2, 0, SPRITE / 2, SPRITE / 2, SPRITE / 2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    // A solid coloured core out to ~a fifth of the sprite, then the halo, so a
    // small dot still reads as its colour rather than as a faint smudge.
    grad.addColorStop(0.08, COLORS[name]);
    grad.addColorStop(0.2, COLORS[name]);
    grad.addColorStop(0.32, withAlpha(COLORS[name], 0.4));
    grad.addColorStop(1, withAlpha(COLORS[name], 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, SPRITE, SPRITE);
    sprites[name] = c;
  }

  function withAlpha(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  // --- View --------------------------------------------------------------------
  const MAX_ZOOM = 24;
  const view = { k: 1, x: 0, y: 0 };
  let dirty = true; // the outline-and-lines layer needs repainting
  let tween = null;

  // Keeps at least a fifth of the window covered by the map, so it cannot be
  // flung away, and keeps zoom between the whole country and street level.
  function clampView(k, x, y) {
    k = Math.min(MAX_ZOOM, Math.max(1, k));
    const mx = W * 0.2;
    const my = H * 0.2;
    return { k, x: Math.min(mx, Math.max(W - W * k - mx, x)), y: Math.min(my, Math.max(H - H * k - my, y)) };
  }
  function setView(k, x, y) {
    Object.assign(view, clampView(k, x, y));
    dirty = true;
    requestRender();
  }

  // Zoom by `factor`, keeping the point under (sx, sy) where it is.
  function zoomAt(factor, sx, sy, animate = false) {
    const k = Math.min(MAX_ZOOM, Math.max(1, view.k * factor));
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
    const m = 30 / view.k;
    return [-view.x / view.k - m, -view.y / view.k - m, (W - view.x) / view.k + m, (H - view.y) / view.k + m];
  };
  const boxOnScreen = (box, [x0, y0, x1, y1]) => box[2] >= x0 && box[0] <= x1 && box[3] >= y0 && box[1] <= y1;
  const pointOnScreen = ([x, y], [x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const worldTransform = (c) => c.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * view.x, dpr * view.y);

  // Strokes grow with the square root of the zoom, dots and pulses a little
  // less: close up a line still reads as a line and a plant as a point, without
  // either turning into a blob. Divided by the zoom because they are drawn in
  // world units.
  const strokeScale = () => Math.sqrt(view.k) / view.k;
  const dotScale = () => view.k ** 0.35 / view.k;

  // The neighbouring countries, only suggested: a fill a shade off the
  // background and the same dashed line as Romania's border, a bit darker,
  // drawn first so Romania's own land and border cover their shared edge.
  function drawNeighbours() {
    ctx.save();
    ctx.beginPath();
    for (const ring of shapes.neighbours) {
      ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    }
    ctx.fillStyle = COLORS.neighbour;
    ctx.fill();
    ctx.lineWidth = BORDER_WIDTH / view.k;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.setLineDash(BORDER_DASH.map((d) => d / view.k));
    ctx.stroke();
    ctx.restore();
  }

  function drawOutline() {
    ctx.save();
    ctx.beginPath();
    for (const ring of shapes.outline) {
      ring.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    }
    ctx.fillStyle = COLORS.land;
    ctx.fill();
    // Romania's border: a wide white dashed line, the way a printed school
    // map draws a frontier, as on the rivers map. Always shown, under the
    // lines. Sizes in screen px, drawn in world units.
    ctx.lineWidth = BORDER_WIDTH / view.k;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.setLineDash(BORDER_DASH.map((d) => d / view.k));
    ctx.stroke();
    ctx.restore();
  }
  const BORDER_WIDTH = 4;
  const BORDER_DASH = [10, 7];

  // Neon is the same stroke three times, wide and faint to thin and bright.
  // `lighter` adds overlapping light, so junctions and parallel lines glow.
  const LINE_PASSES = {
    400: [[7, 0.05], [3.5, 0.14], [1.4, 0.95]],
    220: [[5, 0.04], [2.4, 0.12], [0.9, 0.85]],
  };

  function drawLines(kv) {
    const area = visible();
    const scale = s * strokeScale();
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = kv === 400 ? COLORS.kv400 : COLORS.kv220;
    for (const [w, a] of LINE_PASSES[kv]) {
      ctx.lineWidth = w * scale;
      ctx.globalAlpha = a;
      ctx.beginPath();
      for (const line of shapes.lines) {
        if (line.kv !== kv || !boxOnScreen(line.box, area)) continue;
        line.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPlants(scaleOf, time) {
    const area = visible();
    const scale = dotScale();
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    shapes.plants.forEach((pl, i) => {
      if (!sources.has(pl.source) || !pointOnScreen(pl.xy, area)) return;
      const k = scaleOf(pl, i);
      if (k <= 0) return;
      // A slow, out-of-step twinkle once everything has arrived.
      const twinkle = time === null ? 1 : 0.82 + 0.18 * Math.sin(time * 0.0016 + i * 2.39);
      const size = pl.r * 5.5 * k * scale;
      ctx.globalAlpha = Math.min(1, k) * twinkle;
      ctx.drawImage(sprites[pl.source], pl.xy[0] - size / 2, pl.xy[1] - size / 2, size, size);
    });
    ctx.restore();
  }

  // Pulses travelling along each line in the direction of its modelled flow
  // (scripts/flow-model.mjs). More flow: faster and brighter. Lines the model
  // gives almost nothing stay still.
  //
  // Spacing and speed halve each time the zoom doubles, so on screen the
  // pulses keep about the same gap and pace: zooming in shows more of them
  // rather than a few racing further apart.
  const maxFlow = Math.max(...data.lines.map((l) => Math.abs(l.f ?? 0)), 1);
  const MIN_FLOW = 10;

  function drawFlows(time, alpha) {
    if (alpha <= 0) return;
    const level = 2 ** Math.floor(Math.log2(view.k));
    const spacing = (34 * s) / level;
    const area = visible();
    const scale = dotScale();
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const line of shapes.lines) {
      const flow = Math.abs(line.f);
      if (flow < MIN_FLOW || !layers[`kv${line.kv}`] || !boxOnScreen(line.box, area)) continue;
      const share = Math.sqrt(flow / maxFlow);
      const speed = ((14 + 70 * share) * s) / level; // world units per second
      const size = (line.kv === 400 ? 10.5 : 8.25) * s * (0.75 + 0.5 * share) * scale;
      const sprite = sprites[line.kv === 400 ? "kv400" : "kv220"];
      ctx.globalAlpha = alpha * (0.35 + 0.65 * share);

      // Pulses sit every `spacing`, shifted along by time. Walked in one
      // pass: the distances only grow, so the segment index only moves on.
      const { pts, len, total } = line;
      let d = ((time / 1000) * speed + line.west * 997) % spacing;
      // A negative flow runs against the coordinate order: walk it backwards.
      const forward = line.f > 0;
      let i = forward ? 1 : pts.length - 1;
      for (; d < total; d += spacing) {
        const at = forward ? d : total - d;
        if (forward) while (i < pts.length - 1 && len[i] < at) i++;
        else while (i > 1 && len[i - 1] > at) i--;
        const t = (at - len[i - 1]) / (len[i] - len[i - 1] || 1);
        const x = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t;
        const y = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
        ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
      }
    }
    ctx.restore();
  }

  // Outline and lines only change when the view does, so they are painted
  // onto an offscreen canvas and copied each frame between.
  const staticLayer = document.createElement("canvas");
  function paintStatic() {
    staticLayer.width = canvas.width;
    staticLayer.height = canvas.height;
    // The draw functions paint on `ctx`, so point it offscreen for the moment.
    const onscreen = ctx;
    ctx = staticLayer.getContext("2d");
    worldTransform(ctx);
    drawNeighbours();
    drawOutline();
    if (layers.kv220) drawLines(220);
    if (layers.kv400) drawLines(400);
    ctx = onscreen;
    dirty = false;
  }

  // --- Timeline --------------------------------------------------------------
  // The outline and lines are there from the first frame; only the plants
  // arrive, quickly. Times in ms from the start.
  const PLANTS = [150, 1350];
  // Plants arrive by source, the heavy base load first, solar's swarm last.
  const ORDER = ["nuclear", "hydro", "coal", "gas", "wind", "other", "solar"];
  const END = PLANTS[1] + 200;

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const phase = ([a, b], t) => clamp01((t - a) / (b - a));
  const easeOut = (t) => 1 - (1 - t) ** 3;
  // Overshoots past 1 and settles: the "pop" of a plant switching on.
  const easeBack = (t) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2;

  // Each plant's start inside the plants phase: its source's slot, plus a
  // random spread so a group does not light up in one frame.
  const plantDelay = unit.plants.map((pl) => {
    const slot = ORDER.indexOf(pl.source) / ORDER.length;
    return slot * 0.75 + Math.random() * 0.22;
  });

  let start = 0;
  let frame = 0;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  // The plants arrive in the view as it is, so you can zoom in while they do.
  // Under reduced motion they are simply there and nothing loops: a frame is
  // drawn when something changes.
  function render(now) {
    frame = 0;
    // The canvas can be 0px for a frame while the page lays out, and an empty
    // offscreen layer cannot be drawn. Wait for a size.
    if (!canvas.width || !canvas.height) return requestRender();
    if (tween) stepTween(now);
    const t = reduced.matches ? END : now - start;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (dirty) paintStatic();
    ctx.drawImage(staticLayer, 0, 0);
    worldTransform(ctx);

    if (t < END) {
      const p = phase(PLANTS, t);
      if (layers.plants) {
        drawPlants((pl, i) => {
          const local = clamp01((p - plantDelay[i]) / 0.12);
          return local === 0 ? 0 : easeBack(local);
        }, null);
      }
    } else {
      // Power starts moving once the plants are on. Not at all under reduced
      // motion, where t is pinned at END.
      if (!reduced.matches && layers.flow) drawFlows(now, easeOut(clamp01((t - END) / 700)));
      if (layers.plants) drawPlants(() => 1, reduced.matches ? null : now);
    }
    if (!reduced.matches || tween) requestRender();
  }

  // Nothing is drawn while the page waits for its fonts (see the end).
  function requestRender() {
    if (!frame && !fontsPending) frame = requestAnimationFrame(render);
  }

  function play() {
    start = performance.now();
    requestRender();
  }

  reduced.addEventListener("change", play);

  new ResizeObserver(() => {
    fit();
    setView(view.k, view.x, view.y);
  }).observe(canvas);

  // Hold the first paint until the panel's fonts have arrived, so the page
  // does not show the fallback font and then jump (and the map is fitted to
  // the panel at its final width). Offline or on a slow line, give up after
  // FONT_WAIT and show it with the fallback.
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
      play();
    });
})();
