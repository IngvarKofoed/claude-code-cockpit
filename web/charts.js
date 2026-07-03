// charts.js — hand-rolled inline-SVG charts, no libraries, no external assets.
// Exports: barChart, lineChart, hourHeatmap. Each renders into a host element.

const NS = "http://www.w3.org/2000/svg";
const W = 640; // viewBox width; SVG scales to 100% of its container.

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
  const fmt = opts.format || commas;
  const color = opts.color || "var(--series-1)";
  const horizontal = !!opts.horizontal;
  const H = opts.height || 240;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  styleTicks(svg);

  const max = Math.max(...data.map((d) => d.value || 0));
  const scale = niceScale(max);

  if (horizontal) {
    const ml = Math.min(180, opts.labelWidth || 130);
    const mr = 46, mt = 8, mb = 22;
    const pw = W - ml - mr, ph = H - mt - mb;
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
      bindTip(p, d.label, fmt(d.value));
      svg.appendChild(p);
      svg.appendChild(text(ml - 8, y + thick / 2 + 4, d.label, "", "end"));
      svg.appendChild(text(ml + bw + 6, y + thick / 2 + 4, fmt(d.value), "", "start"));
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

export function lineChart(host, series, opts) {
  opts = opts || {};
  if (!host) return;
  const points = (series && series[0] && series[0].points) || [];
  if (!points.length || points.every((p) => !p.value)) return emptyState(host, opts.empty);

  const fmt = opts.format || commas;
  const color = opts.color || "var(--series-1)";
  const H = opts.height || 240;
  const ml = 46, mr = 14, mt = 12, mb = 26;
  const pw = W - ml - mr, ph = H - mt - mb;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  styleTicks(svg);

  const max = Math.max(...points.map((p) => p.value || 0));
  const scale = niceScale(max);
  const n = points.length;
  const xAt = (i) => (n === 1 ? ml + pw / 2 : ml + (pw / (n - 1)) * i);
  const yAt = (v) => mt + ph - (v / scale.max) * ph;

  for (let v = 0; v <= scale.max + 1e-9; v += scale.step) {
    const y = yAt(v);
    svg.appendChild(el("line", { x1: ml, y1: y, x2: ml + pw, y2: y, class: "c-grid" }));
    svg.appendChild(text(ml - 8, y + 4, fmt(v), "", "end"));
  }
  const every = n <= 12 ? 1 : Math.ceil(n / 9);
  points.forEach((p, i) => {
    if (i % every === 0) svg.appendChild(text(xAt(i), H - 8, p.short || p.label));
  });

  const line = points.map((p, i) => `${i ? "L" : "M"}${xAt(i)},${yAt(p.value)}`).join("");
  // area wash under the line (10% opacity, per mark spec)
  const area = line + `L${xAt(n - 1)},${mt + ph}L${xAt(0)},${mt + ph}Z`;
  svg.appendChild(el("path", { d: area, fill: color, "fill-opacity": 0.1 }));
  svg.appendChild(el("path", { d: line, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));

  // end marker with surface ring
  const last = n - 1;
  svg.appendChild(el("circle", { cx: xAt(last), cy: yAt(points[last].value), r: 4.5, fill: color, stroke: "var(--surface-1)", "stroke-width": 2 }));

  // crosshair overlay for hover
  const cross = el("line", { class: "c-axis", "stroke-dasharray": "3 3", opacity: 0 });
  const dot = el("circle", { r: 4.5, fill: color, stroke: "var(--surface-1)", "stroke-width": 2, opacity: 0 });
  svg.append(cross, dot);
  const hit = el("rect", { x: ml, y: mt, width: pw, height: ph, fill: "transparent" });
  hit.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * W;
    let i = Math.round(((sx - ml) / pw) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    const p = points[i];
    cross.setAttribute("x1", xAt(i)); cross.setAttribute("x2", xAt(i));
    cross.setAttribute("y1", mt); cross.setAttribute("y2", mt + ph); cross.setAttribute("opacity", 1);
    dot.setAttribute("cx", xAt(i)); dot.setAttribute("cy", yAt(p.value)); dot.setAttribute("opacity", 1);
    showTip(p.label, fmt(p.value));
    moveTip(e);
  });
  hit.addEventListener("mouseleave", () => { cross.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); hideTip(); });
  svg.appendChild(hit);
  host.replaceChildren(svg);
}

// ---- hour heatmap (activity by hour of day) -------------------------------

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

export function hourHeatmap(host, data, opts) {
  opts = opts || {};
  if (!host) return;
  const arr = Array.from({ length: 24 }, (_, h) => {
    const found = (data || []).find((d) => d.hour === h);
    return { hour: h, value: found ? found.value || 0 : 0 };
  });
  if (arr.every((d) => !d.value)) return emptyState(host, opts.empty);
  const fmt = opts.format || commas;
  const max = Math.max(...arr.map((d) => d.value));
  const H = 74, mt = 8, mb = 20, ml = 4, mr = 4;
  const gap = 3;
  const pw = W - ml - mr;
  const cw = (pw - gap * 23) / 24;
  const ch = H - mt - mb;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  styleTicks(svg);
  arr.forEach((d, h) => {
    const x = ml + h * (cw + gap);
    const c = el("rect", { x, y: mt, width: cw, height: ch, rx: 3, fill: ramp(d.value / max) });
    bindTip(c, `${String(h).padStart(2, "0")}:00`, fmt(d.value));
    svg.appendChild(c);
    if (h % 3 === 0) svg.appendChild(text(x + cw / 2, H - 6, String(h)));
  });
  host.replaceChildren(svg);

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
