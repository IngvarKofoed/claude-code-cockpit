// charts.js — hand-rolled inline-SVG charts, no libraries, no external assets.
// Exports: barChart, lineChart (existing, unchanged), plus stacked, grouped, donut,
// punch, calendar (History-view primitives). Each renders into a host element.

const NS = "http://www.w3.org/2000/svg";
const W = 640; // fallback viewBox width when a container can't be measured yet

// Responsive viewBox width: render at the host's actual pixel width so a line chart
// fills its card 1:1 (crisp text, no aspect-ratio stretch, no empty gutter), instead
// of drawing at a fixed 640 and letting CSS scale it. Falls back to W when the host
// isn't laid out yet (clientWidth 0). Used by lineChart; the fixed-geometry charts
// (bars/stacked/donut/punch/calendar) keep the 640 grid and scale via CSS.
function vw(host) {
  const w = host && host.clientWidth;
  return w && w > 80 ? Math.round(w) : W;
}

function el(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, String(attrs[k]));
  return e;
}

function text(x, y, str, cls, anchor) {
  const t = el("text", { x, y, class: "c-txt " + (cls || ""), "text-anchor": anchor || "middle" });
  t.textContent = str;
  return t;
}

function commas(n) {
  return Math.round(n).toLocaleString("en-US");
}

// A "nice" axis maximum >= max, plus the step between gridlines.
function niceScale(max, ticks) {
  ticks = ticks || 4;
  if (!(max > 0)) return { max: 1, step: 1 };
  const raw = max / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(max / step) * step, step };
}

function topRound(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}L${x},${y + r}Q${x},${y} ${x + r},${y}L${x + w - r},${y}Q${x + w},${y} ${x + w},${y + r}L${x + w},${y + h}Z`;
}
function rightRound(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w, h / 2));
  return `M${x},${y}L${x + w - r},${y}Q${x + w},${y} ${x + w},${y + r}L${x + w},${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}L${x},${y + h}Z`;
}

// ---- shared tooltip -------------------------------------------------------

let tip, tipK, tipV;
function ensureTip() {
  if (tip) return;
  tip = document.createElement("div");
  tip.className = "chart-tip";
  tipK = document.createElement("span");
  tipK.className = "chart-tip__k";
  tipV = document.createElement("span");
  tipV.className = "chart-tip__v";
  tip.append(tipK, tipV);
  document.body.appendChild(tip);
}
function showTip(k, v) {
  ensureTip();
  tipK.textContent = k;
  tipV.textContent = v;
  tip.style.opacity = "1";
}
function moveTip(e) {
  if (!tip) return;
  tip.style.left = e.clientX + "px";
  tip.style.top = e.clientY - 8 + "px";
}
function hideTip() {
  if (tip) tip.style.opacity = "0";
}
function bindTip(node, k, v) {
  node.addEventListener("mouseenter", () => showTip(k, v));
  node.addEventListener("mousemove", moveTip);
  node.addEventListener("mouseleave", hideTip);
}

// Legend row under a multi-series chart (stacked / grouped): one swatch + name per series.
function appendLegend(host, items) {
  const d = document.createElement("div");
  d.className = "chart-legend";
  items.forEach((it) => {
    const s = document.createElement("span");
    s.className = "chart-legend__item";
    const i = document.createElement("i");
    i.className = "chart-legend__swatch";
    i.style.background = it.color;
    s.append(i, document.createTextNode(it.name));
    d.appendChild(s);
  });
  host.appendChild(d);
}

function emptyState(host, msg) {
  host.replaceChildren();
  const d = document.createElement("div");
  d.className = "chart-empty";
  d.textContent = msg || "No data yet.";
  host.appendChild(d);
}

function styleTicks(svg) {
  // Axis/label text and gridlines inherit these via classes in the SVG.
  const style = el("style");
  style.textContent =
    ".c-txt{fill:var(--ink-muted);font-size:11px;font-family:var(--font-ui)}" +
    ".c-grid{stroke:var(--grid);stroke-width:1}" +
    ".c-axis{stroke:var(--axis);stroke-width:1}";
  svg.appendChild(style);
}

// ---- bar chart (vertical columns or horizontal bars) ----------------------

export function barChart(host, data, opts) {
  opts = opts || {};
  if (!host) return;
  if (!data || !data.length || data.every((d) => !d.value)) {
    return emptyState(host, opts.empty);
  }
  const W = vw(host); // render at the card's real width (shadows the module fallback)
  const fmt = opts.format || commas;
  const color = opts.color || "var(--series-1)";
  const horizontal = !!opts.horizontal;
  const H = opts.height || 240;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  styleTicks(svg);

  const max = Math.max(...data.map((d) => d.value || 0));
  const scale = niceScale(max);

  if (horizontal) {
    // Auto-size the label gutter to the longest category name (capped at a fraction of
    // the chart width) so long tool names aren't clipped; short-name charts stay tight.
    const longest = data.reduce((mx, d) => Math.max(mx, String(d.label).length), 0);
    const maxML = opts.labelWidth || Math.min(400, W * 0.5);
    const ml = Math.max(70, Math.min(maxML, 14 + longest * 7));
    const mr = opts.percent ? 72 : 46, mt = 8, mb = 22;
    const pw = W - ml - mr, ph = H - mt - mb;
    // opts.percent: append each bar's share of the total to its value label + tooltip.
    const total = opts.percent ? data.reduce((s, d) => s + (d.value || 0), 0) : 0;
    const valTxt = (d) => (opts.percent && total > 0 ? `${fmt(d.value)} · ${Math.round((d.value / total) * 100)}%` : fmt(d.value));
    // vertical gridlines
    for (let v = 0; v <= scale.max + 1e-9; v += scale.step) {
      const x = ml + (v / scale.max) * pw;
      svg.appendChild(el("line", { x1: x, y1: mt, x2: x, y2: mt + ph, class: "c-grid" }));
      svg.appendChild(text(x, H - 6, fmt(v)));
    }
    const band = ph / data.length;
    const thick = Math.min(24, band * 0.6);
    data.forEach((d, i) => {
      const y = mt + band * i + (band - thick) / 2;
      const bw = Math.max(0, (d.value / scale.max) * pw);
      const p = el("path", { d: rightRound(ml, y, bw, thick, 4), fill: color });
      bindTip(p, d.label, valTxt(d));
      svg.appendChild(p);
      // category (row) label: brighter + slightly larger than the muted axis text so
      // names read clearly; the value label stays muted/secondary.
      const cat = text(ml - 8, y + thick / 2 + 4, d.label, "", "end");
      cat.style.fill = "var(--ink-2)";
      cat.style.fontSize = "12px";
      svg.appendChild(cat);
      svg.appendChild(text(ml + bw + 6, y + thick / 2 + 4, valTxt(d), "", "start"));
    });
    svg.appendChild(el("line", { x1: ml, y1: mt, x2: ml, y2: mt + ph, class: "c-axis" }));
  } else {
    const ml = 46, mr = 12, mt = 12, mb = 26;
    const pw = W - ml - mr, ph = H - mt - mb;
    for (let v = 0; v <= scale.max + 1e-9; v += scale.step) {
      const y = mt + ph - (v / scale.max) * ph;
      svg.appendChild(el("line", { x1: ml, y1: y, x2: ml + pw, y2: y, class: "c-grid" }));
      svg.appendChild(text(ml - 8, y + 4, fmt(v), "", "end"));
    }
    const band = pw / data.length;
    const thick = Math.min(24, band * 0.62);
    const every = data.length <= 12 ? 1 : Math.ceil(data.length / 9);
    data.forEach((d, i) => {
      const cx = ml + band * i + band / 2;
      const bh = Math.max(0, (d.value / scale.max) * ph);
      const y = mt + ph - bh;
      const p = el("path", { d: topRound(cx - thick / 2, y, thick, bh, 4), fill: color });
      bindTip(p, d.label, fmt(d.value));
      svg.appendChild(p);
      if (i % every === 0) svg.appendChild(text(cx, H - 8, d.short || d.label));
    });
    svg.appendChild(el("line", { x1: ml, y1: mt + ph, x2: ml + pw, y2: mt + ph, class: "c-axis" }));
  }
  host.replaceChildren(svg);
}

// ---- line chart (change over time) ----------------------------------------
// series = [{ points:[{label, short, value}], name?, color?, fmt?, dash?, noAxis? }, …].
// ONE series: the original look (area wash, no legend). MULTIPLE series: each line is
// scaled to its OWN range so measures on very different scales all fill the plot and
// sit close. The first two AXIS-bearing series get the left/right tick scales (labels
// colour-matched to their line); a `noAxis` series is still drawn + self-scaled but
// labels no axis (a normalized correlation line — pair with `dash`/`dot` to signal it
// carries shape, not a readable magnitude; `dot` also fades it + drops its end marker
// so it reads as secondary). Each series' `fmt` formats its own axis +
// tooltip value. (Dual-axis is a deliberate tradeoff: the two axis scales are
// independent, so the crossing point isn't meaningful.)
export function lineChart(host, series, opts) {
  opts = opts || {};
  if (!host) return;
  series = (series || []).filter((s) => s && s.points && s.points.length);
  if (!series.length || series.every((s) => s.points.every((p) => !p.value))) {
    return emptyState(host, opts.empty);
  }

  const W = vw(host); // render at the card's real width (shadows the module fallback)
  const fmt = opts.format || opts.fmt || commas; // fallback y formatter
  const dual = series.length > 1; // 2+ series => each scaled to its own range
  // Axis-bearing series (those without `noAxis`) claim the left/right tick scales; a
  // `noAxis` series is still drawn + self-scaled to fill the plot, but labels no axis.
  const axisIdx = series.map((_s, i) => i).filter((i) => !series[i].noAxis);
  const leftI = axisIdx.length ? axisIdx[0] : 0;
  const rightI = axisIdx.length > 1 ? axisIdx[1] : -1;
  const hasRight = rightI >= 0;
  const H = opts.height || 240;
  const ml = 46, mr = hasRight ? 54 : 14, mt = 12, mb = 26;
  const pw = W - ml - mr, ph = H - mt - mb;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  styleTicks(svg);

  const n = Math.max(...series.map((s) => s.points.length));
  // Per-series scale in dual mode (each fills the plot); one shared scale otherwise.
  const scales = series.map((s) => niceScale(Math.max(...s.points.map((p) => p.value || 0), 0)));
  const scaleFor = (si) => (dual ? scales[si] : scales[0]);
  const xAt = (i) => (n === 1 ? ml + pw / 2 : ml + (pw / (n - 1)) * i);
  const yAt = (si, v) => mt + ph - (v / scaleFor(si).max) * ph;

  // Gridlines follow the left axis series' scale; in dual mode the right axis labels
  // the same gridline heights with the right series' scale (value = fraction × max).
  const left = scaleFor(leftI);
  for (let v = 0; v <= left.max + 1e-9; v += left.step) {
    const y = mt + ph - (v / left.max) * ph;
    svg.appendChild(el("line", { x1: ml, y1: y, x2: ml + pw, y2: y, class: "c-grid" }));
    const lt = text(ml - 8, y + 4, (series[leftI].fmt || fmt)(v), "", "end");
    if (dual) lt.style.fill = series[leftI].color;
    svg.appendChild(lt);
    if (hasRight) {
      const f = left.max ? v / left.max : 0;
      const rt = text(ml + pw + 8, y + 4, (series[rightI].fmt || fmt)(f * scales[rightI].max), "", "start");
      rt.style.fill = series[rightI].color;
      svg.appendChild(rt);
    }
  }

  const base = series[0].points;
  const every = base.length <= 12 ? 1 : Math.ceil(base.length / 9);
  base.forEach((p, i) => {
    if (i % every === 0) svg.appendChild(text(xAt(i), H - 8, p.short || p.label));
  });

  series.forEach((s, si) => {
    const color = s.color || opts.color || "var(--series-1)";
    const pts = s.points;
    const m = pts.length;
    const line = pts.map((p, i) => `${i ? "L" : "M"}${xAt(i)},${yAt(si, p.value)}`).join("");
    if (!dual) {
      // area wash under a lone line (10% opacity, per mark spec)
      svg.appendChild(el("path", { d: line + `L${xAt(m - 1)},${mt + ph}L${xAt(0)},${mt + ph}Z`, fill: color, "fill-opacity": 0.1 }));
    }
    const dashArr = s.dash ? "5 4" : s.dot ? "1 6" : null; // dot = fine round-capped dots
    svg.appendChild(el("path", { d: line, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": dashArr, "stroke-opacity": s.dot ? 0.8 : null }));
    // Solid end marker only on the primary (axis-backed) lines; a `dot` correlation
    // line skips it so it stays visually quiet.
    if (!s.dot) svg.appendChild(el("circle", { cx: xAt(m - 1), cy: yAt(si, pts[m - 1].value), r: 4.5, fill: color, stroke: "var(--surface-1)", "stroke-width": 2 }));
  });

  // shared-x crosshair with one dot per series (each at its own scale)
  const cross = el("line", { class: "c-axis", "stroke-dasharray": "3 3", opacity: 0 });
  svg.appendChild(cross);
  const dots = series.map((s) => el("circle", { r: 4.5, fill: s.color || opts.color || "var(--series-1)", stroke: "var(--surface-1)", "stroke-width": 2, opacity: 0 }));
  dots.forEach((d) => svg.appendChild(d));
  const hit = el("rect", { x: ml, y: mt, width: pw, height: ph, fill: "transparent" });
  hit.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * W;
    let i = Math.round(((sx - ml) / pw) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    cross.setAttribute("x1", xAt(i)); cross.setAttribute("x2", xAt(i));
    cross.setAttribute("y1", mt); cross.setAttribute("y2", mt + ph); cross.setAttribute("opacity", 1);
    const parts = series.map((s, si) => {
      const p = s.points[Math.min(i, s.points.length - 1)];
      dots[si].setAttribute("cx", xAt(i)); dots[si].setAttribute("cy", yAt(si, p.value)); dots[si].setAttribute("opacity", 1);
      const shown = s.fmt ? s.fmt(p.value) : fmt(p.value);
      return dual && s.name ? `${s.name} ${shown}` : shown;
    });
    showTip(base[Math.min(i, base.length - 1)].label, parts.join("  ·  "));
    moveTip(e);
  });
  hit.addEventListener("mouseleave", () => { cross.setAttribute("opacity", 0); dots.forEach((d) => d.setAttribute("opacity", 0)); hideTip(); });
  svg.appendChild(hit);
  host.replaceChildren(svg);
  if (dual && series.some((s) => s.name)) appendLegend(host, series.map((s) => ({ name: s.name, color: s.color || "var(--series-1)" })));
}

// ---- stacked bars (vertical, one segment per series; opts.normalize = 100% share) ----

export function stacked(host, cats, series, opts) {
  opts = opts || {};
  if (!host) return;
  const hasData = cats && cats.length && series && series.length &&
    series.some((s) => (s.values || []).some((v) => v));
  if (!hasData) return emptyState(host, opts.empty);

  const W = vw(host); // render at the card's real width (shadows the module fallback)
  const fmt = opts.fmt || commas;
  const H = opts.height || 220;
  const norm = !!opts.normalize;
  const ml = 46, mr = 12, mt = 12, mb = 26;
  const pw = W - ml - mr, ph = H - mt - mb;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  styleTicks(svg);

  const totals = cats.map((_, ci) => series.reduce((a, s) => a + (s.values[ci] || 0), 0));
  const scale = niceScale(norm ? 100 : Math.max(...totals, 0));
  for (let v = 0; v <= scale.max + 1e-9; v += scale.step) {
    const y = mt + ph - (v / scale.max) * ph;
    svg.appendChild(el("line", { x1: ml, y1: y, x2: ml + pw, y2: y, class: "c-grid" }));
    svg.appendChild(text(ml - 8, y + 4, norm ? Math.round(v) + "%" : fmt(v), "", "end"));
  }
  const yAt = (v) => mt + ph - (v / scale.max) * ph;
  const band = pw / cats.length;
  const thick = Math.min(30, band * 0.66);
  const every = cats.length <= 12 ? 1 : Math.ceil(cats.length / 9);
  cats.forEach((cat, ci) => {
    const cx = ml + band * ci + band / 2, x = cx - thick / 2;
    const denom = norm ? totals[ci] || 1 : 1;
    const factor = norm ? 100 / denom : 1;
    let cum = 0;
    const nz = series
      .map((s, si) => ({ si, v: (s.values[ci] || 0) * factor }))
      .filter((z) => z.v > 0);
    nz.forEach((z, k) => {
      const yTop = yAt(cum + z.v), yBot = yAt(cum);
      const h = Math.max(0, yBot - yTop - 2); // 2px surface gap between segments
      const isTop = k === nz.length - 1;
      const d = isTop ? topRound(x, yTop, thick, h, 3) : `M${x},${yTop}h${thick}v${h}h${-thick}z`;
      const p = el("path", { d, fill: series[z.si].color });
      const raw = series[z.si].values[ci];
      bindTip(p, `${cat.label} · ${series[z.si].name}`, norm ? `${Math.round(z.v)}% (${fmt(raw)})` : fmt(raw));
      svg.appendChild(p);
      cum += z.v;
    });
    if (ci % every === 0) svg.appendChild(text(cx, H - 8, cat.short || cat.label));
  });
  svg.appendChild(el("line", { x1: ml, y1: mt + ph, x2: ml + pw, y2: mt + ph, class: "c-axis" }));
  host.replaceChildren(svg);
  appendLegend(host, series.map((s) => ({ name: s.name, color: s.color })));
}

// ---- grouped bars (vertical, series side-by-side within each category) ----

export function grouped(host, cats, series, opts) {
  opts = opts || {};
  if (!host) return;
  const hasData = cats && cats.length && series && series.length &&
    series.some((s) => (s.values || []).some((v) => v));
  if (!hasData) return emptyState(host, opts.empty);

  const fmt = opts.fmt || commas;
  const H = opts.height || 210;
  const ml = 40, mr = 12, mt = 12, mb = 26;
  const pw = W - ml - mr, ph = H - mt - mb;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  styleTicks(svg);

  const max = Math.max(...cats.map((_, ci) => Math.max(...series.map((s) => s.values[ci] || 0))), 0);
  const scale = niceScale(max);
  for (let v = 0; v <= scale.max + 1e-9; v += scale.step) {
    const y = mt + ph - (v / scale.max) * ph;
    svg.appendChild(el("line", { x1: ml, y1: y, x2: ml + pw, y2: y, class: "c-grid" }));
    svg.appendChild(text(ml - 8, y + 4, fmt(v), "", "end"));
  }
  const band = pw / cats.length;
  const groupW = band * 0.66;
  const bw = (groupW - 2 * (series.length - 1)) / series.length;
  const every = cats.length <= 12 ? 1 : Math.ceil(cats.length / 9);
  cats.forEach((cat, ci) => {
    const gx = ml + band * ci + (band - groupW) / 2;
    series.forEach((s, si) => {
      const x = gx + si * (bw + 2);
      const bh = Math.max(0, ((s.values[ci] || 0) / scale.max) * ph);
      const y = mt + ph - bh;
      const p = el("path", { d: topRound(x, y, bw, bh, 3), fill: s.color });
      bindTip(p, `${cat.label} · ${s.name}`, fmt(s.values[ci] || 0));
      svg.appendChild(p);
    });
    if (ci % every === 0) svg.appendChild(text(ml + band * ci + band / 2, H - 8, cat.short || cat.label));
  });
  svg.appendChild(el("line", { x1: ml, y1: mt + ph, x2: ml + pw, y2: mt + ph, class: "c-axis" }));
  host.replaceChildren(svg);
  appendLegend(host, series.map((s) => ({ name: s.name, color: s.color })));
}

// ---- donut (share of a whole) ----------------------------------------------

export function donut(host, slices, opts) {
  opts = opts || {};
  if (!host) return;
  const total = (slices || []).reduce((a, s) => a + (s.value || 0), 0);
  if (!slices || !slices.length || !total) return emptyState(host, opts.empty);

  const fmt = opts.fmt || commas;
  const H = 210, cx = 150, cy = H / 2, rO = 82, rI = 50;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  styleTicks(svg);

  let ang = -Math.PI / 2;
  const gap = 0.028;
  slices.forEach((s) => {
    const frac = s.value / total;
    const a0 = ang + gap / 2, a1 = ang + frac * 2 * Math.PI - gap / 2;
    ang += frac * 2 * Math.PI;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const d =
      `M${cx + rI * Math.cos(a0)},${cy + rI * Math.sin(a0)}` +
      `L${cx + rO * Math.cos(a0)},${cy + rO * Math.sin(a0)}` +
      `A${rO},${rO} 0 ${large} 1 ${cx + rO * Math.cos(a1)},${cy + rO * Math.sin(a1)}` +
      `L${cx + rI * Math.cos(a1)},${cy + rI * Math.sin(a1)}` +
      `A${rI},${rI} 0 ${large} 0 ${cx + rI * Math.cos(a0)},${cy + rI * Math.sin(a0)}Z`;
    const p = el("path", { d, fill: s.color });
    bindTip(p, s.name, `${fmt(s.value)} · ${Math.round(frac * 100)}%`);
    svg.appendChild(p);
  });

  const c1 = text(cx, cy - 4, fmt(total), "", "middle");
  c1.style.fill = "var(--ink)";
  c1.style.fontSize = "17px";
  c1.style.fontWeight = "600";
  const c2 = text(cx, cy + 14, opts.centerLabel || "total", "", "middle");
  svg.append(c1, c2);

  // legend column on the right, with value + share per slice. Fit the rows inside
  // the viewBox height — a capped list runs up to 7 rows (6 series + "Other"), which
  // at the old fixed 30px step overflowed H=210 and clipped the last row; scale the
  // step down and vertically center instead.
  const lstep = Math.min(30, (H - 24) / Math.max(1, slices.length));
  const ly0 = (H - lstep * (slices.length - 1)) / 2;
  slices.forEach((s, i) => {
    const y = ly0 + i * lstep;
    svg.appendChild(el("rect", { x: 300, y: y - 9, width: 11, height: 11, rx: 3, fill: s.color }));
    const t1 = text(318, y, s.name, "", "start");
    t1.style.fill = "var(--ink-2)";
    const t2 = text(W - 6, y, `${fmt(s.value)} · ${Math.round((s.value / total) * 100)}%`, "", "end");
    t2.style.fill = "var(--ink)";
    svg.append(t1, t2);
  });
  host.replaceChildren(svg);
}

// ---- hour heatmap ramp (sequential blue, dark surface -> bright) ----------

function hexLerp(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}
// sequential blue ramp on the dark surface: low -> near-surface, high -> bright.
function ramp(t) {
  return t <= 0 ? "#171d27" : hexLerp("#1b3350", "#5598e7", Math.min(1, t));
}

function heatLegend(host) {
  const legend = document.createElement("div");
  legend.className = "heat-legend";
  legend.append(document.createTextNode("less"));
  [0.05, 0.35, 0.7, 1].forEach((t) => {
    const i = document.createElement("i");
    i.style.background = ramp(t);
    legend.appendChild(i);
  });
  legend.append(document.createTextNode("more"));
  host.appendChild(legend);
}

// ---- punchcard (day-of-week x hour heatmap) --------------------------------
// matrix7x24[weekday][hour]; weekday index follows Date#getDay() (0 = Sunday).

const PUNCH_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function punch(host, matrix7x24, opts) {
  opts = opts || {};
  if (!host) return;
  const hasData = matrix7x24 && matrix7x24.length && matrix7x24.some((row) => (row || []).some((v) => v));
  if (!hasData) return emptyState(host, opts.empty);

  const fmt = opts.fmt || commas;
  const ml = 34, mr = 6, mt = 8, mb = 20, gap = 2;
  const pw = W - ml - mr;
  const cw = (pw - gap * 23) / 24;
  const chh = 15;
  const H = mt + mb + 7 * (chh + gap);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  styleTicks(svg);

  const max = Math.max(...matrix7x24.flat(), 0) || 1;
  matrix7x24.forEach((row, d) => {
    const y = mt + d * (chh + gap);
    svg.appendChild(text(ml - 7, y + chh / 2 + 4, PUNCH_DAYS[d] || "", "", "end"));
    (row || []).forEach((v, h) => {
      const x = ml + h * (cw + gap);
      const r = el("rect", { x, y, width: cw, height: chh, rx: 2.5, fill: ramp((v || 0) / max) });
      bindTip(r, `${PUNCH_DAYS[d]} ${String(h).padStart(2, "0")}:00`, fmt(v || 0));
      svg.appendChild(r);
    });
  });
  for (let h = 0; h < 24; h += 3) {
    svg.appendChild(text(ml + h * (cw + gap) + cw / 2, H - 6, String(h)));
  }
  host.replaceChildren(svg);
  heatLegend(host);
}

// ---- calendar heatmap (GitHub-style, one cell per day) ---------------------
// dayVals = [{date: Date, value}], pre-aligned by the caller into Monday-start
// weeks (dayVals[0] is the Monday of its week; short weeks are padded).

export function calendar(host, dayVals, opts) {
  opts = opts || {};
  if (!host) return;
  const hasData = dayVals && dayVals.length;
  if (!hasData) return emptyState(host, opts.empty);

  const fmt = opts.fmt || commas;
  const ml = 30, mt = 18, cell = 15, gap = 3;
  const H = mt + 7 * (cell + gap) + 6;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  styleTicks(svg);

  const max = Math.max(...dayVals.map((d) => d.value || 0), 0) || 1;
  const dow = ["Mon", "", "Wed", "", "Fri", "", ""]; // dayVals[0] is a Monday (row 0)
  dow.forEach((s, i) => {
    if (s) svg.appendChild(text(ml - 6, mt + i * (cell + gap) + cell / 2 + 4, s, "", "end"));
  });
  let lastMonth = -1;
  dayVals.forEach((d, i) => {
    const wk = Math.floor(i / 7), dy = i % 7;
    const x = ml + wk * (cell + gap), y = mt + dy * (cell + gap);
    const fill = d.value ? ramp(0.18 + 0.82 * (d.value / max)) : "var(--surface-2)";
    const r = el("rect", { x, y, width: cell, height: cell, rx: 3, fill });
    bindTip(
      r,
      d.date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }),
      d.value ? fmt(d.value) : "no activity"
    );
    svg.appendChild(r);
    const m = d.date.getMonth();
    if (dy === 0 && m !== lastMonth) {
      svg.appendChild(text(x + 1, 12, d.date.toLocaleDateString("en-US", { month: "short" }), "", "start"));
      lastMonth = m;
    }
  });
  host.replaceChildren(svg);
}
