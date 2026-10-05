/* =============================================================================
   FlowCast — Traffic Congestion Detection & Prediction System
   File: script.js
   -----------------------------------------------------------------------------
   Pairs with: index.html (design system styles are embedded in the page)
   External (optional, deferred, with local fallbacks):
     Chart.js 4.x  ·  Leaflet 1.9.x  ·  Mermaid 10.x
   -----------------------------------------------------------------------------
   index.html loads the optional libraries first, then this deferred script.
   Serve the project directory with a static web server (for example, VS Code
   Live Server); no build step or backend is required in Demo Mode.
   -----------------------------------------------------------------------------
   RUN THE BUILT-IN TEST SUITE
     Open the page with ?selftest=1, or call FlowCast.test() in the console.
     A pass/fail table is logged and rendered if #selftestPanel exists.
   -----------------------------------------------------------------------------
   FILE MAP
     00 CONFIG            01 UTILITIES         02 LOGGER
     03 STORAGE           04 API CLIENT        05 DATA SOURCE FACADE
     06 DEMO DATA ENGINE  07 ML / MODEL SERVICE 08 AUTH
     09 VALIDATORS        10 APP / ROUTER      11 CHARTS
     12 MAPS              13 DASHBOARD         14 PREDICTION
     15 ANALYTICS         16 ALERTS            17 DATA MANAGEMENT
     18 DOCS              19 LANDING           20 AUTH UI
     21 CHROME            22 SELF TEST         23 BOOT
   ============================================================================= */

(function () {
"use strict";

/* =============================================================================
   00. CONFIG
   ============================================================================= */
const CONFIG = {
  version: "1.0.0",
  build: "2026.10.05",

  /* Demo Mode is the default so the prototype runs with no paid API and no
     backend. Set flowcast.apiBase to point at FastAPI and it takes over. */
  demoMode: true,
  apiBase: (read("flowcast.apiBase") || "http://localhost:8000").replace(/\/+$/, ""),
  apiTimeoutMs: 4000,
  apiProbeOnBoot: false,

  /* Reproducible random seed */
  seed: 20261005,
  days: 30,

  /* Model identity — the backend serves the trained Python model in production */
  modelVersion: "gbdt_stumps_js_v1",
  baselineVersion: "historical_average_v1",

  /* Chronological split: train / validation / test */
  split: { train: 0.70, val: 0.85 },

  /* Session + login policy (client-side demo only — see Docs > Security) */
  sessionTtlMs: 12 * 60 * 60 * 1000,
  maxLoginAttempts: 5,
  lockoutMs: 30 * 1000,
  minPasswordLength: 8,

  /* Congestion label thresholds on the speed / free-flow ratio.
     Defensible, fixed thresholds — never random labels. */
  thresholds: { low: 0.75, moderate: 0.50, high: 0.30 },

  keys: {
    users: "flowcast.users",
    session: "flowcast.session",
    theme: "flowcast.theme",
    thresholds: "flowcast.thresholds",
    alerts: "flowcast.alerts",
    notifications: "flowcast.notify",
    attempts: "flowcast.attempts"
  },

  levels: ["LOW", "MODERATE", "HIGH", "SEVERE"]
};

const CALABAR_CENTER = [4.9550, 8.3250];

/* Approximate synthetic monitoring points in Calabar South, not surveyed GPS locations. */
const ROADS = [
  { road_id: "R-01", name: "Marian Road — North",          lat: 4.9600, lng: 8.3330, free_flow_kmh: 50, lanes: 2, cls: "arterial" },
  { road_id: "R-02", name: "Marian Road — Central",        lat: 4.9580, lng: 8.3310, free_flow_kmh: 45, lanes: 2, cls: "urban" },
  { road_id: "R-03", name: "Marian Road — South",          lat: 4.9560, lng: 8.3290, free_flow_kmh: 40, lanes: 2, cls: "urban" },
  { road_id: "R-04", name: "Marian Road — South Junction", lat: 4.9540, lng: 8.3270, free_flow_kmh: 35, lanes: 1, cls: "local" },
  { road_id: "R-05", name: "Ekpo Abasi Street — North",    lat: 4.9580, lng: 8.3240, free_flow_kmh: 40, lanes: 2, cls: "urban" },
  { road_id: "R-06", name: "Ekpo Abasi Street — Central",  lat: 4.9550, lng: 8.3230, free_flow_kmh: 35, lanes: 2, cls: "urban" },
  { road_id: "R-07", name: "Ekpo Abasi Street — South",    lat: 4.9520, lng: 8.3220, free_flow_kmh: 30, lanes: 1, cls: "local" },
  { road_id: "R-08", name: "Ekpo Abasi Street — Junction", lat: 4.9490, lng: 8.3210, free_flow_kmh: 30, lanes: 1, cls: "local" }
];

const WEATHER_PENALTY = { clear: 0, rain: 0.12, heavy_rain: 0.24, fog: 0.18 };
const WEATHER_LABEL = { clear: "Clear", rain: "Rain", heavy_rain: "Heavy rain", fog: "Fog" };
const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HORIZONS = [
  { value: 15,   label: "15 minutes" },
  { value: 30,   label: "30 minutes" },
  { value: 60,   label: "1 hour" },
  { value: 120,  label: "2 hours" },
  { value: 360,  label: "6 hours" },
  { value: 1440, label: "24 hours" }
];
const LEVEL_COLOR = { LOW: "#22c55e", MODERATE: "#eab308", HIGH: "#f97316", SEVERE: "#ef4444" };

/* =============================================================================
   01. UTILITIES
   ============================================================================= */
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
function byId(id) { return document.getElementById(id); }
function exists(id) { return !!byId(id); }

function el(tag, attrs, html) {
  const n = document.createElement(tag);
  if (attrs) Object.keys(attrs).forEach(function (k) {
    if (k === "class") n.className = attrs[k]; else n.setAttribute(k, attrs[k]);
  });
  if (html != null) n.innerHTML = html;
  return n;
}
function on(node, evt, fn, opts) { if (node) node.addEventListener(evt, fn, opts); }
function setText(node, v) { if (node) node.textContent = v; }
function setHTML(node, v) { if (node) node.innerHTML = v; }
function show(node, v) { if (node) node.classList.toggle("hidden", v === false); }
function toggleClass(node, cls, v) { if (node) node.classList.toggle(cls, !!v); }

/* XSS-safe text for any value that came from a user (CSV upload, form input) */
function escapeHtml(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/`/g, "&#96;");
}
/* Strip path components and unsafe characters from an uploaded filename */
function sanitizeFilename(name) {
  return String(name || "upload.csv")
    .replace(/^.*[\\/]/, "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 120) || "upload.csv";
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function round(v, d) { const p = Math.pow(10, d == null ? 0 : d); return Math.round(v * p) / p; }
function mean(a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : 0; }
function sum(a) { return a.reduce(function (s, v) { return s + v; }, 0); }
function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce(function (s, v) { return s + Math.pow(v - m, 2); }, 0) / (a.length - 1));
}
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos), rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const mx = mean(xs.slice(0, n)), my = mean(ys.slice(0, n));
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return (dx && dy) ? num / Math.sqrt(dx * dy) : 0;
}
/* Abramowitz & Stegun 7.1.26 error function, then standard normal CDF */
function erf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
function normalCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

function debounce(fn, ms) {
  let t;
  return function () {
    const args = arguments, ctx = this;
    clearTimeout(t);
    t = setTimeout(function () { fn.apply(ctx, args); }, ms || 150);
  };
}
function throttle(fn, ms) {
  let last = 0, timer = null;
  return function () {
    const args = arguments, ctx = this, now = Date.now();
    if (now - last >= (ms || 100)) { last = now; fn.apply(ctx, args); }
    else if (!timer) {
      timer = setTimeout(function () { timer = null; last = Date.now(); fn.apply(ctx, args); }, ms - (now - last));
    }
  };
}

function pad2(n) { return String(n).padStart(2, "0"); }
function fmtDate(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
function fmtTime(d) { return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
function fmtStamp(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return fmtDate(d) + " " + fmtTime(d);
}
function fmtNum(v, d) {
  const n = Number(v);
  if (!isFinite(n)) return "—";
  return n.toFixed(d == null ? 1 : d);
}
function fmtInt(v) { return Number(v).toLocaleString("en-GB"); }
function nowIso() { return new Date().toISOString(); }
function isWeekend(dow) { return dow === 0 || dow === 6; }

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime || "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1200);
}
function toCSV(rows, headers) {
  const esc = function (v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return headers.join(",") + "\n" + rows.map(function (r) {
    return headers.map(function (h) { return esc(r[h]); }).join(",");
  }).join("\n");
}

function animateCounter(node, target, decimals) {
  if (!node) return;
  if (prefersReducedMotion()) { node.textContent = fmtNum(target, decimals); return; }
  const from = 0, dur = 720, t0 = performance.now();
  node.dataset.animating = "1";
  (function step(t) {
    const k = clamp((t - t0) / dur, 0, 1);
    const eased = 1 - Math.pow(1 - k, 3);
    node.textContent = fmtNum(from + (target - from) * eased, decimals);
    if (k < 1) requestAnimationFrame(step); else delete node.dataset.animating;
  })(t0);
}
function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/* ---- Toast notifications ---- */
function toast(title, message, kind, timeout) {
  const host = byId("toasts");
  if (!host) { Log.info(title + (message ? " — " + message : "")); return null; }
  const node = el("div", { class: "toast " + (kind || ""), role: "status" });
  node.innerHTML = "<b>" + escapeHtml(title) + "</b>" + (message ? escapeHtml(message) : "");
  host.appendChild(node);
  const life = timeout || 4200;
  setTimeout(function () {
    node.style.transition = "opacity .3s, transform .3s";
    node.style.opacity = "0";
    node.style.transform = "translateX(24px)";
  }, life - 420);
  setTimeout(function () { node.remove(); }, life);
  return node;
}

/* ---- Modal with focus trap ---- */
function openModal(title, bodyHtml, actions, opts) {
  opts = opts || {};
  const back = el("div", { class: "modal-back", role: "dialog", "aria-modal": "true", "aria-label": title });
  const modal = el("div", { class: "modal" });
  modal.innerHTML = "<h3>" + escapeHtml(title) + "</h3><div>" + (bodyHtml || "") + "</div>";
  const row = el("div", { style: "display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap" });
  const acts = actions && actions.length ? actions : [{ label: "Close", kind: "primary" }];
  acts.forEach(function (a) {
    const b = el("button", { class: "btn " + (a.kind || ""), type: "button" }, escapeHtml(a.label));
    on(b, "click", function () {
      if (a.onClick) a.onClick();
      if (a.close !== false) close();
    });
    row.appendChild(b);
  });
  modal.appendChild(row);
  back.appendChild(modal);
  byId("modalRoot").appendChild(back);

  const focusables = function () {
    return $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', modal)
      .filter(function (n) { return n.offsetParent !== null; });
  };
  const first = focusables()[0];
  if (first) first.focus();

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key !== "Tab") return;
    const f = focusables();
    if (!f.length) return;
    const firstEl = f[0], lastEl = f[f.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
  }
  function close() {
    document.removeEventListener("keydown", onKey, true);
    back.remove();
    if (opts.onClose) opts.onClose();
  }
  document.addEventListener("keydown", onKey, true);
  on(back, "click", function (e) { if (e.target === back) close(); });
  return { close: close, node: back };
}

function confirmDialog(title, body, confirmLabel, onConfirm, danger) {
  return openModal(title, body, [
    { label: "Cancel", kind: "ghost" },
    { label: confirmLabel || "Confirm", kind: danger ? "danger" : "primary", onClick: onConfirm }
  ]);
}

/* =============================================================================
   02. LOGGER  (ring buffer + console, never throws)
   ============================================================================= */
const Log = {
  entries: [],
  max: 300,
  push(level, msg, data) {
    const e = { t: nowIso(), level: level, msg: msg, data: data === undefined ? null : data };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    try { fn.call(console, "[FlowCast] " + msg, data === undefined ? "" : data); } catch (x) {}
    return e;
  },
  info(m, d) { return this.push("info", m, d); },
  warn(m, d) { return this.push("warn", m, d); },
  error(m, d) { return this.push("error", m, d); }
};

/* =============================================================================
   03. STORAGE  (localStorage → sessionStorage → memory, swappable for tests)
   ============================================================================= */
const Store = {
  memory: {},
  forced: null,

  useMemory() { this.forced = "memory"; },
  useReal() { this.forced = null; },

  _read(area, key) {
    try { return window[area] ? window[area].getItem(key) : null; }
    catch (e) { return null; }
  },
  _write(area, key, value) {
    try { if (window[area]) window[area].setItem(key, value); return true; }
    catch (e) { return false; }
  },
  _remove(area, key) {
    try { if (window[area]) window[area].removeItem(key); } catch (e) {}
  },

  get(key) {
    if (this.forced === "memory") {
      const localKey = "local:" + key, sessionKey = "session:" + key;
      if (Object.prototype.hasOwnProperty.call(this.memory, localKey)) return this.memory[localKey];
      if (Object.prototype.hasOwnProperty.call(this.memory, sessionKey)) return this.memory[sessionKey];
      return Object.prototype.hasOwnProperty.call(this.memory, key) ? this.memory[key] : null;
    }
    return this._read("localStorage", key) !== null ? this._read("localStorage", key) : this._read("sessionStorage", key);
  },
  getSession(key) {
    if (this.forced === "memory") return this.memory["session:" + key] || null;
    return this._read("sessionStorage", key);
  },
  getLocal(key) {
    if (this.forced === "memory") return this.memory["local:" + key] || null;
    return this._read("localStorage", key);
  },
  set(key, value, persistent) {
    const area = persistent === false ? "sessionStorage" : "localStorage";
    if (this.forced === "memory") { this.memory[(persistent === false ? "session:" : "local:") + key] = value; return true; }
    return this._write(area, key, value);
  },
  remove(key) {
    if (this.forced === "memory") {
      delete this.memory[key]; delete this.memory["local:" + key]; delete this.memory["session:" + key];
      return;
    }
    this._remove("localStorage", key);
    this._remove("sessionStorage", key);
  },
  getJSON(key, fallback) {
    const raw = this.get(key);
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (e) { Log.warn("Corrupt storage entry discarded", key); return fallback; }
  },
  setJSON(key, value, persistent) { return this.set(key, JSON.stringify(value), persistent); },
  clearAll() {
    Object.keys(CONFIG.keys).forEach(function (k) { Store.remove(CONFIG.keys[k]); });
  }
};
function read(key) { try { return window.localStorage ? localStorage.getItem(key) : null; } catch (e) { return null; } }

/* =============================================================================
   04. API CLIENT  (FastAPI JSON endpoints, graceful failure)
   ============================================================================= */
const Api = {
  available: false,
  lastError: null,

  async request(path, options) {
    const opts = options || {};
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, CONFIG.apiTimeoutMs);
    try {
      const res = await fetch(CONFIG.apiBase + path, {
        method: opts.method || "GET",
        headers: Object.assign({ "Content-Type": "application/json", "Accept": "application/json" }, opts.headers || {}),
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
        mode: "cors"
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error("HTTP " + res.status + " " + res.statusText);
      const json = await res.json();
      this.available = true;
      this.lastError = null;
      return json;
    } catch (err) {
      clearTimeout(timer);
      this.available = false;
      this.lastError = err && err.message ? err.message : String(err);
      throw err;
    }
  },

  /* Endpoint surface from the brief */
  health()            { return this.request("/api/health"); },
  summary()           { return this.request("/api/dashboard/summary"); },
  current()           { return this.request("/api/traffic/current"); },
  history(params)     { return this.request("/api/traffic/history" + qs(params)); },
  predict(payload)    { return this.request("/api/predict", { method: "POST", body: payload }); },
  predictBatch(list)  { return this.request("/api/predict/batch", { method: "POST", body: { items: list } }); },
  upload(csv, name)   { return this.request("/api/data/upload", { method: "POST", body: { filename: name, content: csv } }); },
  trends()            { return this.request("/api/analytics/trends"); },
  hotspots()          { return this.request("/api/analytics/hotspots"); },
  models()            { return this.request("/api/models"); },
  alerts()            { return this.request("/api/alerts"); },
  testAlert()         { return this.request("/api/alerts/test", { method: "POST", body: {} }); },

  async probe() {
    try { await this.health(); return true; }
    catch (e) { return false; }
  }
};
function qs(params) {
  if (!params) return "";
  const parts = Object.keys(params).filter(function (k) { return params[k] !== "" && params[k] != null; })
    .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); });
  return parts.length ? "?" + parts.join("&") : "";
}

/* =============================================================================
   05. DATA SOURCE FACADE
   Every module asks DataSource, never Api or Demo directly. The facade tries the
   backend when it is reachable and falls back to the seeded demo engine, so the
   prototype always works without a paid API or a running server.
   ============================================================================= */
const DataSource = {
  mode: "demo",           // "api" | "demo"

  async init() {
    if (CONFIG.demoMode && !CONFIG.apiProbeOnBoot) { this.mode = "demo"; return this.mode; }
    const ok = await Api.probe();
    this.mode = ok ? "api" : "demo";
    return this.mode;
  },

  async health() {
    if (this.mode === "api") { try { return await Api.health(); } catch (e) { this.degrade(e); } }
    return { status: "ok", mode: "demo", version: CONFIG.version, records: Demo.records.length };
  },
  async summary() {
    if (this.mode === "api") { try { return await Api.summary(); } catch (e) { this.degrade(e); } }
    return Demo.summary();
  },
  async current() {
    if (this.mode === "api") { try { return await Api.current(); } catch (e) { this.degrade(e); } }
    return Demo.latestAll();
  },
  async history(params) {
    if (this.mode === "api") { try { return await Api.history(params); } catch (e) { this.degrade(e); } }
    return Demo.records;
  },
  async predict(payload) {
    if (this.mode === "api") { try { return await Api.predict(payload); } catch (e) { this.degrade(e); } }
    return ModelService.predictForm(payload);
  },
  async trends() {
    if (this.mode === "api") { try { return await Api.trends(); } catch (e) { this.degrade(e); } }
    return Analytics.computeTrends();
  },
  async hotspots() {
    if (this.mode === "api") { try { return await Api.hotspots(); } catch (e) { this.degrade(e); } }
    return Analytics.ranking();
  },
  async models() {
    if (this.mode === "api") { try { return await Api.models(); } catch (e) { this.degrade(e); } }
    return ModelService.registry();
  },
  async alerts() {
    if (this.mode === "api") { try { return await Api.alerts(); } catch (e) { this.degrade(e); } }
    return App.alerts;
  },
  async upload(csv, name) {
    if (this.mode === "api") { try { return await Api.upload(csv, name); } catch (e) { this.degrade(e); } }
    return DataView.ingestLocally(csv, name);
  },

  degrade(err) {
    if (this.mode === "api") {
      Log.warn("API unavailable — switching to Demo Mode", err && err.message);
      toast("Backend unavailable", "Switched to Demo Mode with seeded data.", "warn");
    }
    this.mode = "demo";
  }
};

/* =============================================================================
   06. DEMO DATA ENGINE  (seeded, reproducible, defensible labels)
   ============================================================================= */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const Demo = {
  rand: mulberry32(CONFIG.seed),
  seed: CONFIG.seed,
  records: [],
  byRoad: {},
  generatedAt: null,

  reseed(seed) {
    this.seed = seed == null ? CONFIG.seed : seed;
    this.rand = mulberry32(this.seed);
  },
  rnd(lo, hi) { return lo + this.rand() * (hi - lo); },
  pick(arr) { return arr[Math.floor(this.rand() * arr.length)]; },

  /* Congestion label from the speed / free-flow ratio using fixed thresholds */
  labelFor(speed, freeFlow) {
    const ratio = speed / (freeFlow || 1);
    if (ratio >= CONFIG.thresholds.low) return "LOW";
    if (ratio >= CONFIG.thresholds.moderate) return "MODERATE";
    if (ratio >= CONFIG.thresholds.high) return "HIGH";
    return "SEVERE";
  },
  indexFor(speed, freeFlow) { return clamp(1 - speed / (freeFlow || 1), 0, 1); },

  /* Bimodal commuter demand curve, damped at weekends and overnight */
  peakIntensity(hour, weekend) {
    const morning = Math.exp(-Math.pow((hour - 8) / 2.0, 2));
    const evening = Math.exp(-Math.pow((hour - 18) / 2.2, 2));
    let f = 0.55 * Math.max(morning, evening) + 0.12;
    if (weekend) f *= 0.72;
    if (hour < 5 || hour >= 23) f *= 0.45;
    return clamp(f, 0, 0.95);
  },

  generate(seed) {
    this.reseed(seed);
    const out = [];
    const end = new Date();
    end.setMinutes(0, 0, 0);
    const hours = CONFIG.days * 24;

    for (let ri = 0; ri < ROADS.length; ri++) {
      const road = ROADS[ri];
      for (let h = hours; h >= 0; h--) {
        const ts = new Date(end.getTime() - h * 3600 * 1000);
        const hour = ts.getHours();
        const dow = ts.getDay();
        const weekend = isWeekend(dow);

        const wxRoll = this.rand();
        const weather = wxRoll > 0.88 ? "heavy_rain" : wxRoll > 0.72 ? "rain" : wxRoll > 0.66 ? "fog" : "clear";
        const rainfall = weather === "heavy_rain" ? round(this.rnd(6, 14), 1)
                       : weather === "rain" ? round(this.rnd(1, 6), 1) : 0;
        const eventFlag = this.rand() > 0.965 ? 1 : 0;

        const intensity = this.peakIntensity(hour, weekend)
          + WEATHER_PENALTY[weather]
          + (eventFlag ? 0.14 : 0)
          + (road.cls === "urban" || road.cls === "local" ? 0.05 : 0);

        const ratio = clamp(1 - intensity - this.rnd(0, 0.10), 0.16, 1);
        const speed = round(clamp(road.free_flow_kmh * ratio, 5, road.free_flow_kmh), 1);
        const volume = Math.round(clamp((1 - ratio) * 2200 + road.lanes * 180 + this.rnd(-120, 120), 60, 4200));
        const occupancy = round(clamp((1 - ratio) * 88 + this.rnd(-6, 6), 3, 98), 1);
        const incidentCount = this.rand() > (0.90 - (1 - ratio) * 0.35) ? (this.rand() > 0.85 ? 2 : 1) : 0;
        const density = round(volume / Math.max(road.lanes * 2, 1) / Math.max(speed, 1) * 10, 2);

        out.push({
          timestamp: ts.toISOString(),
          road_id: road.road_id,
          road_name: road.name,
          latitude: round(road.lat + this.rnd(-0.004, 0.004), 5),
          longitude: round(road.lng + this.rnd(-0.004, 0.004), 5),
          speed_kmh: round(speed, 1),
          free_flow_kmh: road.free_flow_kmh,
          traffic_volume: volume,
          occupancy: occupancy,
          density: density,
          rainfall_mm: rainfall,
          weather: weather,
          incident_count: incidentCount,
          event_flag: eventFlag,
          day_of_week: dow,
          hour: hour,
          minute: 0,
          weekend: weekend ? 1 : 0,
          peak_indicator: this.peakIntensity(hour, weekend) > 0.4 ? 1 : 0,
          congestion_level: this.labelFor(speed, road.free_flow_kmh),
          congestion_index: round(this.indexFor(speed, road.free_flow_kmh), 3)
        });
      }
    }

    this.records = out;
    this.generatedAt = nowIso();
    this.reindex();
    Log.info("Demo dataset generated", { records: out.length, roads: ROADS.length, days: CONFIG.days, seed: this.seed });
    return out;
  },

  reindex() {
    this.byRoad = {};
    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i];
      (this.byRoad[r.road_id] = this.byRoad[r.road_id] || []).push(r);
    }
    Object.keys(this.byRoad).forEach(function (id) {
      Demo.byRoad[id].sort(function (a, b) { return a.timestamp < b.timestamp ? -1 : 1; });
    });
  },

  regenerate() {
    this.generate(this.seed + 7919);
    return this.records;
  },

  latestFor(roadId) {
    const arr = this.byRoad[roadId];
    return arr && arr.length ? arr[arr.length - 1] : null;
  },
  latestAll() {
    return ROADS.map(function (r) { return Demo.latestFor(r.road_id); }).filter(Boolean);
  },
  road(roadId) {
    return ROADS.filter(function (r) { return r.road_id === roadId; })[0] || ROADS[0];
  },

  summary() {
    const all = this.latestAll();
    const idx = mean(all.map(function (r) { return r.congestion_index; }));
    const spd = mean(all.map(function (r) { return r.speed_kmh; }));
    const window24 = this.records.slice(-24 * ROADS.length);
    return {
      generated_at: this.generatedAt,
      roads: ROADS.length,
      records: this.records.length,
      congestion_index: round(idx, 3),
      average_speed_kmh: round(spd, 1),
      incidents_24h: sum(window24.map(function (r) { return r.incident_count; })),
      worst_level: all.length ? all.slice().sort(function (a, b) { return b.congestion_index - a.congestion_index; })[0].congestion_level : "LOW",
      mode: "demo"
    };
  }
};

/* =============================================================================
   07. ML / MODEL SERVICE
   -----------------------------------------------------------------------------
   A real, lightweight gradient-boosting model (regression trees on tabular
   features) trained in the browser on the chronological training split, compared
   against a historical-average / moving-average baseline, with the better model
   selected on validation metrics. It stands in for the Python scikit-learn /
   XGBoost model the FastAPI backend serves in production; the same features,
   the same chronological split and the same metrics are used so the swap is
   transparent to the UI.
   ============================================================================= */
const ModelService = {
  FEATURES: [
    { key: "hour",           label: "Hour of day" },
    { key: "dow",            label: "Day of week" },
    { key: "weekend",        label: "Weekend flag" },
    { key: "peak_indicator", label: "Peak-hour indicator" },
    { key: "lag1_speed",     label: "Previous-hour speed" },
    { key: "roll3_speed",    label: "Rolling mean speed (3 h)" },
    { key: "roll24_speed",   label: "Rolling mean speed (24 h)" },
    { key: "traffic_volume", label: "Traffic volume" },
    { key: "occupancy",      label: "Road occupancy" },
    { key: "rainfall_mm",    label: "Rainfall" },
    { key: "incident_count", label: "Incident count" },
    { key: "event_flag",     label: "Event flag" },
    { key: "free_flow_kmh",  label: "Free-flow speed" }
  ],

  matrix: null,
  split: null,
  gbdt: null,
  baseline: null,
  chosen: null,
  metrics: null,
  comparison: [],
  importance: [],
  correlations: [],
  predVsActual: null,
  sigma: 5,
  trained: false,
  trainedAt: null,
  error: null,

  /* ---------- feature matrix (lag + rolling features, per road, in time order) */
  buildMatrix(records) {
    const X = [], y = [], meta = [];
    const grouped = {};
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      (grouped[r.road_id] = grouped[r.road_id] || []).push(r);
    }
    Object.keys(grouped).forEach(function (id) {
      const arr = grouped[id].slice().sort(function (a, b) { return a.timestamp < b.timestamp ? -1 : 1; });
      for (let i = 0; i < arr.length; i++) {
        const r = arr[i];
        const lag1 = i > 0 ? arr[i - 1].speed_kmh : r.speed_kmh;
        const w3 = arr.slice(Math.max(0, i - 2), i + 1).map(function (x) { return x.speed_kmh; });
        const w24 = arr.slice(Math.max(0, i - 23), i + 1).map(function (x) { return x.speed_kmh; });
        X.push([
          r.hour,
          r.day_of_week,
          r.weekend || 0,
          r.peak_indicator || 0,
          lag1,
          round(mean(w3), 2),
          round(mean(w24), 2),
          r.traffic_volume,
          r.occupancy,
          r.rainfall_mm,
          r.incident_count,
          r.event_flag,
          r.free_flow_kmh
        ]);
        y.push(r.speed_kmh);
        meta.push(r);
      }
    });
    return { X: X, y: y, meta: meta };
  },

  /* ---------- chronological split: train 70 / validation 15 / test 15 ---------- */
  chronologicalSplit(n) {
    const trainEnd = Math.floor(n * CONFIG.split.train);
    const valEnd = Math.floor(n * CONFIG.split.val);
    const train = [], val = [], test = [];
    for (let i = 0; i < n; i++) {
      if (i < trainEnd) train.push(i);
      else if (i < valEnd) val.push(i);
      else test.push(i);
    }
    return { train: train, val: val, test: test, trainEnd: trainEnd, valEnd: valEnd };
  },

  /* ---------- regression tree on residuals (depth-limited, variance reduction) */
  fitTree(X, target, idx, depth, maxDepth, minLeaf, gains) {
    const node = { value: mean(idx.map(function (i) { return target[i]; })) };
    if (depth >= maxDepth || idx.length < minLeaf * 2) return node;

    let best = null;
    for (let f = 0; f < this.FEATURES.length; f++) {
      const vals = idx.map(function (i) { return X[i][f]; }).slice().sort(function (a, b) { return a - b; });
      const cand = [];
      for (let q = 1; q <= 7; q++) cand.push(quantile(vals, q / 8));
      for (let c = 0; c < cand.length; c++) {
        const t = cand[c];
        const left = [], right = [];
        for (let k = 0; k < idx.length; k++) {
          if (X[idx[k]][f] <= t) left.push(idx[k]); else right.push(idx[k]);
        }
        if (left.length < minLeaf || right.length < minLeaf) continue;
        const gain = this.sse(target, idx) - this.sse(target, left) - this.sse(target, right);
        if (!best || gain > best.gain) best = { feature: f, threshold: t, left: left, right: right, gain: gain };
      }
    }
    if (!best || best.gain <= 1e-9) return node;

    gains[best.feature] = (gains[best.feature] || 0) + best.gain;
    node.feature = best.feature;
    node.threshold = best.threshold;
    node.gain = best.gain;
    node.left = this.fitTree(X, target, best.left, depth + 1, maxDepth, minLeaf, gains);
    node.right = this.fitTree(X, target, best.right, depth + 1, maxDepth, minLeaf, gains);
    return node;
  },

  sse(target, idx) {
    let s = 0, sq = 0;
    for (let i = 0; i < idx.length; i++) { const v = target[idx[i]]; s += v; sq += v * v; }
    return sq - (s * s) / (idx.length || 1);
  },

  predictTree(node, x) {
    while (node && node.feature !== undefined) node = x[node.feature] <= node.threshold ? node.left : node.right;
    return node ? node.value : 0;
  },

  /* ---------- gradient boosting with shrinkage + early stopping on validation */
  trainGBDT(X, y, idxTrain, idxVal, opts) {
    const o = Object.assign({ nEstimators: 60, learningRate: 0.10, maxDepth: 2, minLeaf: 40, subsample: 1 }, opts || {});
    const base = mean(idxTrain.map(function (i) { return y[i]; }));
    const trainIdx = idxTrain.slice();
    const F = trainIdx.map(function () { return base; });
    const trees = [], gains = new Array(this.FEATURES.length).fill(0);
    let best = { iter: 0, valRmse: Infinity, trees: [] };

    for (let m = 0; m < o.nEstimators; m++) {
      const resid = trainIdx.map(function (i, k) { return y[i] - F[k]; });
      const tree = this.fitTree(X, resid, trainIdx.map(function (_, k) { return k; }), 0, o.maxDepth, o.minLeaf, gains);
      trees.push(tree);
      for (let k = 0; k < trainIdx.length; k++) {
        F[k] += o.learningRate * this.predictTree(tree, X[trainIdx[k]]);
      }
      const valPred = idxVal.map((function (self) {
        return function (i) {
          let p = base;
          for (let t = 0; t < trees.length; t++) p += o.learningRate * self.predictTree(trees[t], X[i]);
          return p;
        };
      })(this));
      const rmse = Math.sqrt(mean(idxVal.map(function (i, k) { return Math.pow(y[i] - valPred[k], 2); })));
      if (rmse < best.valRmse - 1e-6) best = { iter: m + 1, valRmse: rmse, trees: trees.slice() };
    }

    const totalGain = sum(gains) || 1;
    return {
      base: base,
      learningRate: o.learningRate,
      trees: best.trees,
      iterations: best.iter,
      valRmse: best.valRmse,
      importance: gains.map(function (g) { return g / totalGain; })
    };
  },

  gbdtPredict(model, x) {
    let p = model.base;
    for (let t = 0; t < model.trees.length; t++) p += model.learningRate * this.predictTree(model.trees[t], x);
    return p;
  },

  /* ---------- baseline: historical average per road × hour, blended with a
     moving average of the most recent observations ---------- */
  trainBaseline(records, idxTrain, X, y) {
    const table = {};
    for (let i = 0; i < idxTrain.length; i++) {
      const r = records[idxTrain[i]];
      const key = r.road_id + "|" + r.hour;
      (table[key] = table[key] || []).push(r.speed_kmh);
    }
    const avg = {};
    Object.keys(table).forEach(function (k) { avg[k] = mean(table[k]); });
    const roadAvg = {};
    Object.keys(table).forEach(function (k) {
      const rid = k.split("|")[0];
      (roadAvg[rid] = roadAvg[rid] || []).concat(table[k]);
    });
    Object.keys(roadAvg).forEach(function (rid) {
      const vals = [];
      Object.keys(table).forEach(function (k) { if (k.indexOf(rid + "|") === 0) vals.push.apply(vals, table[k]); });
      roadAvg[rid] = mean(vals);
    });
    return { table: avg, roadAvg: roadAvg };
  },

  baselinePredict(model, record) {
    const key = record.road_id + "|" + record.hour;
    if (model.table[key] !== undefined) return model.table[key];
    if (model.roadAvg[record.road_id] !== undefined) return model.roadAvg[record.road_id];
    return record.free_flow_kmh * 0.6;
  },

  /* ---------- heuristic fallback, used only if training fails ---------- */
  heuristicPredict(record, horizonMin) {
    const peak = Demo.peakIntensity(record.hour, isWeekend(record.day_of_week));
    const wx = WEATHER_PENALTY[record.weather] || 0;
    const target = record.free_flow_kmh * clamp(1 - (peak + wx + (record.event_flag ? 0.14 : 0)) * 0.75, 0.18, 1);
    const hp = clamp(Math.log10(1 + (horizonMin || 60) / 60) * 0.10, 0, 0.25);
    return target * (1 - hp * 0.5);
  },

  /* ---------- evaluation helpers ---------- */
  metricsFor(records, idx, predictor, sigma) {
    const actual = [], pred = [], actualLevels = [], predLevels = [];
    for (let k = 0; k < idx.length; k++) {
      const r = records[idx[k]];
      const p = predictor(r);
      actual.push(r.speed_kmh);
      pred.push(p);
      actualLevels.push(r.congestion_level);
      predLevels.push(Demo.labelFor(p, r.free_flow_kmh));
    }
    const n = actual.length;
    if (!n) return null;
    const mae = mean(actual.map(function (v, i) { return Math.abs(v - pred[i]); }));
    const rmse = Math.sqrt(mean(actual.map(function (v, i) { return Math.pow(v - pred[i], 2); })));
    const mape = 100 * mean(actual.map(function (v, i) { return Math.abs((v - pred[i]) / (v || 1)); }));
    const mActual = mean(actual);
    const ssTot = sum(actual.map(function (v) { return Math.pow(v - mActual, 2); }));
    const ssRes = sum(actual.map(function (v, i) { return Math.pow(v - pred[i], 2); }));
    const r2 = ssTot ? 1 - ssRes / ssTot : 0;

    const classes = CONFIG.levels, tp = {}, fp = {}, fn = {};
    classes.forEach(function (c) { tp[c] = 0; fp[c] = 0; fn[c] = 0; });
    let correct = 0;
    for (let i = 0; i < n; i++) {
      if (predLevels[i] === actualLevels[i]) { correct++; tp[actualLevels[i]]++; }
      else { fp[predLevels[i]]++; fn[actualLevels[i]]++; }
    }
    const precisions = classes.map(function (c) { const d = tp[c] + fp[c]; return d ? tp[c] / d : 0; });
    const recalls = classes.map(function (c) { const d = tp[c] + fn[c]; return d ? tp[c] / d : 0; });
    const f1s = classes.map(function (c, i) {
      const p = precisions[i], r = recalls[i];
      return (p + r) ? 2 * p * r / (p + r) : 0;
    });

    return {
      n: n, mae: mae, rmse: rmse, mape: mape, r2: r2,
      accuracy: correct / n,
      precision: mean(precisions),
      recall: mean(recalls),
      f1: mean(f1s),
      per_class: classes.map(function (c, i) {
        return { level: c, precision: precisions[i], recall: recalls[i], f1: f1s[i], support: tp[c] + fn[c] };
      }),
      sigma: sigma || rmse
    };
  },

  /* ---------- full training + model selection ---------- */
  fit(records, force) {
    if (this.trained && !force) return this.metrics;
    try {
      const built = this.buildMatrix(records);
      const split = this.chronologicalSplit(built.X.length);
      if (!split.train.length || !split.val.length || !split.test.length) throw new Error("Insufficient rows for a chronological split");

      const baseline = this.trainBaseline(records, split.train, built.X, built.y);
      const gbdt = this.trainGBDT(built.X, built.y, split.train, split.val);

      const self = this;
      const baselinePredictor = function (r) { return self.baselinePredict(baseline, r); };
      const gbdtPredictor = function (r) {
        const i = built.meta.indexOf(r);
        if (i === -1) return self.heuristicPredict(r, 60);
        return self.gbdtPredict(gbdt, built.X[i]);
      };

      const baseVal = this.metricsFor(records, split.val, baselinePredictor);
      const gbdtVal = this.metricsFor(records, split.val, gbdtPredictor);
      const gbdtWins = gbdtVal && baseVal ? gbdtVal.rmse < baseVal.rmse : true;

      const chosenName = gbdtWins ? CONFIG.modelVersion : CONFIG.baselineVersion;
      const chosenPredictor = gbdtWins ? gbdtPredictor : baselinePredictor;

      const testBase = this.metricsFor(records, split.test, baselinePredictor);
      const testGbdt = this.metricsFor(records, split.test, gbdtPredictor);
      const chosenTest = gbdtWins ? testGbdt : testBase;

      this.matrix = built;
      this.split = split;
      this.baseline = baseline;
      this.gbdt = gbdt;
      this.chosen = { name: chosenName, kind: gbdtWins ? "gbdt" : "baseline", predictor: chosenPredictor };
      this.sigma = Math.max(chosenTest ? chosenTest.rmse : 5, 0.75);
      this.metrics = Object.assign({}, chosenTest, { model: chosenName, sigma: this.sigma, split: { train: split.train.length, val: split.val.length, test: split.test.length } });
      this.comparison = [
        { name: CONFIG.baselineVersion, family: "Baseline (historical average + moving average)", valRmse: baseVal ? baseVal.rmse : null, valMae: baseVal ? baseVal.mae : null, testRmse: testBase ? testBase.rmse : null, selected: !gbdtWins },
        { name: CONFIG.modelVersion, family: "Gradient boosting (regression trees)", valRmse: gbdtVal ? gbdtVal.rmse : null, valMae: gbdtVal ? gbdtVal.mae : null, testRmse: testGbdt ? testGbdt.rmse : null, selected: gbdtWins }
      ];
      this.importance = this.FEATURES.map(function (f, i) {
        return { name: f.label, key: f.key, value: gbdt.importance[i] || 0 };
      }).sort(function (a, b) { return b.value - a.value; });
      this.correlations = this.computeCorrelations(built);
      this.predVsActual = this.buildPredVsActual(records, split.test, chosenPredictor);

      this.trained = true;
      this.trainedAt = nowIso();
      this.error = null;
      Log.info("Model trained and selected", {
        selected: chosenName,
        iterations: gbdt.iterations,
        baselineValRmse: baseVal ? round(baseVal.rmse, 3) : null,
        gbdtValRmse: gbdtVal ? round(gbdtVal.rmse, 3) : null
      });
      return this.metrics;
    } catch (err) {
      this.trained = false;
      this.error = err && err.message ? err.message : String(err);
      Log.error("Model training failed — heuristic fallback active", this.error);
      return null;
    }
  },

  computeCorrelations(built) {
    const y = built.y;
    const out = [];
    const idx = built.X.map(function (_, i) { return i; });
    const sample = idx.length > 3000 ? idx.filter(function (i) { return i % 2 === 0; }) : idx;
    for (let f = 0; f < this.FEATURES.length; f++) {
      const xs = sample.map(function (i) { return built.X[i][f]; });
      const ys = sample.map(function (i) { return y[i]; });
      out.push({ name: this.FEATURES[f].label, key: this.FEATURES[f].key, r: pearson(xs, ys) });
    }
    return out.sort(function (a, b) { return Math.abs(b.r) - Math.abs(a.r); });
  },

  buildPredVsActual(records, idx, predictor) {
    const step = Math.max(1, Math.floor(idx.length / 40));
    const labels = [], actual = [], pred = [];
    for (let k = 0; k < idx.length; k += step) {
      const r = records[idx[k]];
      labels.push(r.timestamp.slice(5, 10));
      actual.push(r.speed_kmh);
      pred.push(round(predictor(r), 1));
    }
    return { labels: labels, actual: actual, pred: pred };
  },

  /* ---------- inference for the prediction form ---------- */
  featureRowFor(roadId, dateStr, timeStr, weather, dow, eventFlag) {
    const road = Demo.road(roadId);
    const hour = parseInt(String(timeStr).split(":")[0], 10) || 0;
    const minute = parseInt(String(timeStr).split(":")[1], 10) || 0;
    const target = new Date(dateStr + "T" + timeStr + ":00");
    const hist = (Demo.byRoad[road.road_id] || []).filter(function (r) {
      return new Date(r.timestamp).getTime() <= target.getTime();
    });
    const recent = hist.slice(-24);
    const last3 = hist.slice(-3);
    const lag1 = hist.length ? hist[hist.length - 1].speed_kmh : road.free_flow_kmh * 0.6;
    const roll3 = last3.length ? mean(last3.map(function (r) { return r.speed_kmh; })) : lag1;
    const roll24 = recent.length ? mean(recent.map(function (r) { return r.speed_kmh; })) : lag1;
    const sameHour = hist.filter(function (r) { return r.hour === hour; });
    const volume = sameHour.length ? mean(sameHour.map(function (r) { return r.traffic_volume; })) : 1200;
    const occupancy = sameHour.length ? mean(sameHour.map(function (r) { return r.occupancy; })) : 45;
    const incidents = sameHour.length ? mean(sameHour.map(function (r) { return r.incident_count; })) : 0;
    const rainfall = weather === "heavy_rain" ? 9 : weather === "rain" ? 3 : weather === "fog" ? 0.5 : 0;

    return {
      road: road,
      hour: hour,
      minute: minute,
      dow: dow,
      target: target,
      x: [
        hour, dow, isWeekend(dow) ? 1 : 0,
        Demo.peakIntensity(hour, isWeekend(dow)) > 0.4 ? 1 : 0,
        round(lag1, 2), round(roll3, 2), round(roll24, 2),
        round(volume, 0), round(occupancy, 1), rainfall,
        round(incidents, 1), eventFlag ? 1 : 0, road.free_flow_kmh
      ],
      weather: weather
    };
  },

  predictForm(payload) {
    const f = this.featureRowFor(payload.road_id, payload.date, payload.time, payload.weather, payload.dow, payload.event_flag);
    const horizon = payload.horizon_min || 60;
    let speed, modelName, usedFallback = false;

    if (this.trained && this.chosen) {
      modelName = this.chosen.name;
      speed = this.chosen.kind === "gbdt" ? this.gbdtPredict(this.gbdt, f.x) : this.baselinePredict(this.baseline, {
        road_id: f.road.road_id, hour: f.hour, free_flow_kmh: f.road.free_flow_kmh
      });
    } else {
      modelName = "heuristic_fallback_v1";
      speed = this.heuristicPredict({ hour: f.hour, day_of_week: f.dow, weather: f.weather, event_flag: payload.event_flag ? 1 : 0, free_flow_kmh: f.road.free_flow_kmh }, horizon);
      usedFallback = true;
    }

    /* longer horizons widen the uncertainty band and damp the point estimate */
    const horizonPenalty = clamp(Math.log10(1 + horizon / 60) * 0.22, 0, 0.5);
    speed = clamp(speed * (1 - horizonPenalty * 0.35), 4, f.road.free_flow_kmh);

    const sigma = Math.max(this.sigma, 1) * (1 + horizonPenalty);
    const level = Demo.labelFor(speed, f.road.free_flow_kmh);
    const index = Demo.indexFor(speed, f.road.free_flow_kmh);
    /* probability that speed falls below the MODERATE boundary (50% of free flow) */
    const probability = clamp(normalCdf((0.5 * f.road.free_flow_kmh - speed) / sigma), 0.01, 0.99);
    const confidence = clamp(1 - sigma / (f.road.free_flow_kmh * 0.6) - horizonPenalty * 0.2, 0.30, 0.95);

    const top = (this.importance.length ? this.importance.slice(0, 3) : [
      { name: "Peak-hour indicator", key: "peak_indicator" },
      { name: "Rolling mean speed (24 h)", key: "roll24_speed" },
      { name: "Road occupancy", key: "occupancy" }
    ]);
    const keyIndex = { hour: 0, dow: 1, weekend: 2, peak_indicator: 3, lag1_speed: 4, roll3_speed: 5, roll24_speed: 6, traffic_volume: 7, occupancy: 8, rainfall_mm: 9, incident_count: 10, event_flag: 11, free_flow_kmh: 12 };
    const explanation = top.map(function (t) {
      const i = keyIndex[t.key];
      const v = i === undefined ? "n/a" : f.x[i];
      return "Top driver — " + t.name + " = " + v + " (relative importance " + Math.round((t.value || 0) * 100) + "%)";
    });
    explanation.push("Weather context: " + WEATHER_LABEL[f.weather] + " (penalty " + fmtNum(WEATHER_PENALTY[f.weather] || 0, 2) + ")");
    explanation.push(payload.event_flag ? "Event flag set: local demand uplift assumed" : "No event flag set");
    explanation.push("Forecast horizon " + horizon + " min widens the uncertainty band (σ ≈ " + fmtNum(sigma, 1) + " km/h)");
    explanation.push("Historical baseline for this road and hour: " + fmtNum(this.baseline && this.baseline.table ? (this.baseline.table[f.road.road_id + "|" + f.hour] || f.road.free_flow_kmh * 0.6) : f.road.free_flow_kmh * 0.6, 1) + " km/h");

    return {
      location: f.road.name,
      road_id: f.road.road_id,
      forecast_time: payload.date + "T" + payload.time + ":00",
      horizon_min: horizon,
      predicted_congestion: level,
      congestion_index: round(index, 3),
      probability: round(probability, 2),
      probability_definition: "P(speed < 50% of free-flow speed) — i.e. MODERATE or worse",
      expected_speed_kmh: round(speed, 1),
      free_flow_kmh: f.road.free_flow_kmh,
      confidence: round(confidence, 2),
      uncertainty_kmh: round(sigma, 1),
      model: modelName,
      fallback: usedFallback,
      generated_at: nowIso(),
      data_timestamp: Demo.generatedAt,
      explanation: explanation
    };
  },

  registry() {
    return {
      generated_at: this.trainedAt,
      selected: this.chosen ? this.chosen.name : null,
      seed: Demo.seed,
      features: this.FEATURES.map(function (f) { return f.key; }),
      models: this.comparison.length ? this.comparison : [
        { name: CONFIG.baselineVersion, family: "Baseline (historical average + moving average)", selected: true },
        { name: CONFIG.modelVersion, family: "Gradient boosting (regression trees)", selected: false }
      ],
      metrics: this.metrics
    };
  }
};

/* =============================================================================
   08. AUTH
   -----------------------------------------------------------------------------
   Client-side demo authentication so the prototype runs with no backend. It is
   deliberately structured so the same call sites work when auth moves to
   FastAPI: swap Auth.signin/signup for POST /api/auth/login|register and keep
   everything else. The hash below is NOT a security control — production must
   hash with bcrypt/Argon2 server-side and issue short-lived tokens.
   ============================================================================= */
const Auth = {
  session: null,
  listeners: [],

  /* ---------- password hash: deterministic, 16 hex chars (demo only) ---------- */
  hash(str) {
    str = String(str);
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
  },

  /* 0–4 strength score used by the signup meter */
  strength(pw) {
    pw = String(pw || "");
    let score = 0;
    if (pw.length >= CONFIG.minPasswordLength) score++;
    if (/[A-Z]/.test(pw)) score++;
    if (/[0-9]/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;
    return clamp(score, 0, 4);
  },

  /* ---------- user store ---------- */
  users() { return Store.getJSON(CONFIG.keys.users, []) || []; },
  saveUsers(list) { return Store.setJSON(CONFIG.keys.users, list); },

  find(email) {
    const e = String(email || "").trim().toLowerCase();
    return this.users().filter(function (u) { return u.email === e; })[0] || null;
  },

  /* ---------- signup ---------- */
  signup(name, email, password) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    const cleanName = String(name || "").trim();
    if (!Validator.name(cleanName)) return { ok: false, code: "invalid_name", message: "Please enter your full name." };
    if (!Validator.email(cleanEmail)) return { ok: false, code: "invalid_email", message: "Enter a valid email address." };
    if (!Validator.password(password)) return { ok: false, code: "weak_password", message: "Use at least " + CONFIG.minPasswordLength + " characters." };
    if (this.find(cleanEmail)) return { ok: false, code: "duplicate_email", message: "An account with that email already exists." };

    const user = {
      id: "u_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3),
      name: cleanName,
      email: cleanEmail,
      role: "analyst",
      password: this.hash(password),
      created: nowIso()
    };
    const list = this.users();
    list.push(user);
    if (!this.saveUsers(list)) return { ok: false, code: "storage_failed", message: "Could not save the account in this browser." };
    Log.info("Account created", { email: user.email });
    return { ok: true, user: user };
  },

  /* ---------- failed-attempt lockout (demo-grade) ---------- */
  attemptsFor(email) {
    const all = Store.getJSON(CONFIG.keys.attempts, {}) || {};
    return all[String(email || "").toLowerCase()] || { count: 0, until: 0 };
  },
  recordFailure(email) {
    const all = Store.getJSON(CONFIG.keys.attempts, {}) || {};
    const key = String(email || "").toLowerCase();
    const rec = all[key] || { count: 0, until: 0 };
    rec.count++;
    if (rec.count >= CONFIG.maxLoginAttempts) { rec.until = Date.now() + CONFIG.lockoutMs; rec.count = 0; }
    all[key] = rec;
    Store.setJSON(CONFIG.keys.attempts, all);
    return rec;
  },
  clearFailures(email) {
    const all = Store.getJSON(CONFIG.keys.attempts, {}) || {};
    delete all[String(email || "").toLowerCase()];
    Store.setJSON(CONFIG.keys.attempts, all);
  },
  lockedFor(email) {
    const rec = this.attemptsFor(email);
    const ms = (rec.until || 0) - Date.now();
    return ms > 0 ? Math.ceil(ms / 1000) : 0;
  },

  /* ---------- signin ---------- */
  signin(email, password, remember) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (!Validator.email(cleanEmail)) return { ok: false, code: "invalid_email", message: "Enter a valid email address." };
    if (!password) return { ok: false, code: "missing_password", message: "Password is required." };

    const lock = this.lockedFor(cleanEmail);
    if (lock) return { ok: false, code: "locked", message: "Too many attempts. Try again in " + lock + "s.", retryIn: lock };

    const user = this.find(cleanEmail);
    if (!user) {
      this.recordFailure(cleanEmail);
      return { ok: false, code: "no_account", message: "No account found for that email." };
    }
    if (user.password !== this.hash(password)) {
      const rec = this.recordFailure(cleanEmail);
      const left = CONFIG.maxLoginAttempts - (rec.count || 0);
      return { ok: false, code: "bad_password", message: "Incorrect password." + (left > 0 && left < 3 ? " " + left + " attempt(s) left." : "") };
    }

    this.clearFailures(cleanEmail);
    this.startSession(user, remember !== false);
    Log.info("Sign-in successful", { email: user.email });
    return { ok: true, user: user };
  },

  /* ---------- session ---------- */
  startSession(user, persistent) {
    this.session = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      token: "demo." + btoa(unescape(encodeURIComponent(user.id + ":" + Date.now()))).replace(/=/g, ""),
      started: nowIso(),
      expires: Date.now() + CONFIG.sessionTtlMs
    };
    Store.setJSON(CONFIG.keys.session, this.session, persistent !== false);
    this.emit();
    return this.session;
  },

  restore() {
    const s = Store.getJSON(CONFIG.keys.session, null);
    if (!s || !s.token) return null;
    if (!Number.isFinite(Number(s.expires)) || Date.now() > Number(s.expires)) {
      Log.info("Session expired or invalid — signing out");
      this.logout(true);
      return null;
    }
    this.session = s;
    this.emit();
    return s;
  },

  isAuthed() { return !!(this.session && this.session.token); },

  logout(silent) {
    this.session = null;
    Store.remove(CONFIG.keys.session);
    this.emit();
    if (!silent) Log.info("Signed out");
  },

  /* ---------- simulated password reset (Demo Mode) ---------- */
  requestReset(email) {
    const clean = String(email || "").trim().toLowerCase();
    if (!Validator.email(clean)) return { ok: false, code: "invalid_email", message: "Enter a valid email address." };
    const user = this.find(clean);
    return {
      ok: !!user,
      exists: !!user,
      message: user ? "A reset link was sent to " + clean + " (simulated — nothing leaves your browser)."
                    : "No account exists for " + clean + "."
    };
  },

  onChange(fn) { this.listeners.push(fn); },
  emit() {
    const s = this.session;
    this.listeners.forEach(function (fn) { try { fn(s); } catch (e) { Log.error("Auth listener failed", e); } });
  }
};

/* =============================================================================
   09. VALIDATORS  (shared by auth forms, prediction form and CSV ingestion)
   ============================================================================= */
const Validator = {
  email(v) { return /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(String(v || "").trim()); },
  name(v) { return String(v || "").trim().length >= 2; },
  password(v) { return String(v || "").length >= CONFIG.minPasswordLength; },
  match(a, b) { return String(a) === String(b) && String(a).length > 0; },
  required(v) { return String(v == null ? "" : v).trim().length > 0; },
  number(v, lo, hi) {
    const n = Number(v);
    if (!isFinite(n)) return false;
    if (lo !== undefined && n < lo) return false;
    if (hi !== undefined && n > hi) return false;
    return true;
  },
  isoDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) && !isNaN(new Date(v).getTime()); },
  time(v) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || "")); },

  /* form field helper: marks .field invalid, returns boolean */
  field(fieldId, ok) {
    const f = byId(fieldId);
    if (f) f.classList.toggle("invalid", !ok);
    return !!ok;
  },
  clearForm(formEl) {
    if (!formEl) return;
    $$(".field.invalid", formEl).forEach(function (f) { f.classList.remove("invalid"); });
  }
};

/* =============================================================================
   10. APP / ROUTER
   ============================================================================= */
const App = {
  route: "home",
  intended: null,
  alerts: [],
  thresholds: { high: 0.55, severe: 0.75 },
  charts: {},
  map: null,
  metrics: null,
  ready: false,
  mounted: {},

  titles: {
    home:       ["FlowCast", "Calabar South · Traffic intelligence prototype"],
    dashboard:  ["Dashboard", "Calabar South traffic snapshot · Demo Mode"],
    prediction: ["Prediction", "Short-term congestion forecasting"],
    analytics:  ["Analytics", "Historical patterns & model evaluation"],
    alerts:     ["Alerts", "Threshold breaches & incident notifications"],
    data:       ["Data management", "Upload, validate and export traffic data"],
    docs:       ["Documentation", "Architecture, API & setup"]
  },

  protectedRoutes: { dashboard: 1, prediction: 1, analytics: 1, alerts: 1, data: 1 },

  init() {
    this.thresholds = Store.getJSON(CONFIG.keys.thresholds, { high: 0.55, severe: 0.75 }) || { high: 0.55, severe: 0.75 };
    this.alerts = Store.getJSON(CONFIG.keys.alerts, []) || [];
  },

  saveThresholds() { Store.setJSON(CONFIG.keys.thresholds, this.thresholds); },
  saveAlerts() { Store.setJSON(CONFIG.keys.alerts, this.alerts.slice(0, 200)); },

  go(route, opts) {
    opts = opts || {};
    if (!this.titles[route]) route = "home";
    if (route === "home" && Auth.isAuthed()) route = "dashboard";

    if (this.protectedRoutes[route] && !Auth.isAuthed()) {
      this.intended = route;
      showAuth(true);
      return;
    }

    this.route = route;
    $$(".view").forEach(function (v) { v.classList.toggle("active", v.id === "view-" + route); });
    $$("#nav button").forEach(function (b) {
      const active = b.dataset.route === route;
      b.classList.toggle("active", active);
      if (active) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });

    const meta = this.titles[route];
    setText(byId("pageTitle"), meta[0]);
    setText(byId("pageSub"), meta[1]);
    toggleClass(byId("sidebar"), "open", false);
    if (byId("menuBtn")) byId("menuBtn").setAttribute("aria-expanded", "false");

    if (!opts.keepScroll) window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });

    /* mount the module after the view is visible so canvases have real size */
    this.mount(route);
  },

  mount(route) {
    try {
      if (route === "dashboard") Dashboard.render();
      if (route === "prediction") Prediction.prepare();
      if (route === "analytics") Analytics.render();
      if (route === "alerts") Alerts.render();
      if (route === "data") DataView.render();
      if (route === "docs") Docs.render();
      if (route === "home") Landing.render();
    } catch (err) {
      Log.error("Failed to render view: " + route, err);
      toast("Something went wrong", "The " + route + " view could not be rendered.", "err");
    }
  },

  remount() { this.mount(this.route); }
};

/* =============================================================================
   11. CHARTS  (Chart.js with a dependency-free canvas fallback)
   ============================================================================= */
const Charts = {
  instances: {},

  palette(i) { return ["#38e1ff", "#7c5cff", "#22c55e", "#eab308", "#f97316"][i % 5]; },
  themeColors() {
    const light = document.documentElement.getAttribute("data-theme") === "light";
    return {
      text: light ? "#4a5a72" : "#9aa8bd",
      grid: light ? "rgba(15,23,42,.10)" : "rgba(148,163,184,.12)"
    };
  },

  hasLib() { return typeof window.Chart !== "undefined"; },

  draw(canvasId, type, labels, datasets, opts) {
    const canvas = byId(canvasId);
    if (!canvas) return null;
    opts = opts || {};
    const wrap = canvas.parentElement;

    /* a hidden view has zero size — defer until it is visible */
    if (wrap && (wrap.offsetWidth === 0 || wrap.offsetHeight === 0)) {
      if (!canvas.dataset.pending) {
        canvas.dataset.pending = "1";
        requestAnimationFrame(function () { delete canvas.dataset.pending; Charts.draw(canvasId, type, labels, datasets, opts); });
      }
      return null;
    }

    if (this.instances[canvasId]) {
      try { this.instances[canvasId].destroy(); } catch (e) {}
      delete this.instances[canvasId];
    }

    const empty = !labels || !labels.length || !datasets || !datasets.length;
    if (empty) {
      if (wrap) wrap.innerHTML = '<div class="chart-empty">No data available for this chart.</div>';
      return null;
    }

    if (this.hasLib()) {
      const tc = this.themeColors();
      const ds = datasets.map(function (d, i) {
        const color = d.color || Charts.palette(i);
        return Object.assign({
          borderColor: color,
          backgroundColor: type === "bar" ? color + "99" : color + "22",
          borderWidth: 2,
          tension: 0.35,
          fill: type === "line" && d.fill !== false,
          pointRadius: 2.5,
          pointHoverRadius: 5,
          borderDash: d.borderDash || []
        }, d);
      });
      const options = Object.assign({
        responsive: true,
        maintainAspectRatio: false,
        animation: prefersReducedMotion() ? false : { duration: 500 },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: datasets.length > 1, labels: { color: tc.text, boxWidth: 12, usePointStyle: true, padding: 14 } },
          tooltip: {
            backgroundColor: "rgba(11,18,32,.94)",
            borderColor: "rgba(255,255,255,.16)",
            borderWidth: 1,
            padding: 10,
            titleColor: "#e9eef8",
            bodyColor: "#cbd5e1",
            displayColors: true
          }
        },
        scales: {
          x: { grid: { color: tc.grid, drawBorder: false }, ticks: { color: tc.text, maxTicksLimit: 12, autoSkip: true } },
          y: { grid: { color: tc.grid, drawBorder: false }, ticks: { color: tc.text, maxTicksLimit: 6 } }
        }
      }, opts);
      if (options.plugins && options.plugins.legend) options.plugins.legend.display = opts.forceLegend || datasets.length > 1;
      this.instances[canvasId] = new window.Chart(canvas, { type: type, data: { labels: labels, datasets: ds }, options: options });
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", (opts.ariaLabel || (type + " chart")) + " with " + labels.length + " points");
      return this.instances[canvasId];
    }

    this.fallback(canvas, type, labels, datasets);
    return null;
  },

  fallback(canvas, type, labels, datasets) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 600, h = canvas.clientHeight || 260;
    canvas.width = Math.max(1, w * dpr);
    canvas.height = Math.max(1, h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const tc = this.themeColors();
    const pad = { l: 46, r: 14, t: 18, b: 32 };
    const values = datasets.reduce(function (a, d) { return a.concat(d.data); }, []);
    const max = Math.max.apply(null, values.concat([1]));
    const min = Math.min.apply(null, values.concat([0]));
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    const X = function (i) { return pad.l + (labels.length <= 1 ? iw / 2 : (i / (labels.length - 1)) * iw); };
    const Y = function (v) { return pad.t + ih - ((v - min) / ((max - min) || 1)) * ih; };

    ctx.strokeStyle = tc.grid; ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const y = pad.t + (g / 4) * ih;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillStyle = tc.text; ctx.font = "10px system-ui";
      ctx.fillText(fmtNum(max - (g / 4) * (max - min), 0), 6, y + 3);
    }

    datasets.forEach(function (d, di) {
      const color = d.color || Charts.palette(di);
      ctx.strokeStyle = color; ctx.fillStyle = color;
      if (type === "bar") {
        const slot = iw / Math.max(labels.length, 1);
        const bw = Math.max(3, slot * 0.6);
        d.data.forEach(function (v, i) {
          const x = pad.l + (i + 0.5) * slot - bw / 2;
          const y = Y(v);
          ctx.globalAlpha = 0.78;
          ctx.fillRect(x, y, bw, pad.t + ih - y);
        });
        ctx.globalAlpha = 1;
      } else {
        ctx.lineWidth = 2;
        ctx.beginPath();
        d.data.forEach(function (v, i) { const x = X(i), y = Y(v); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
        ctx.stroke();
        if (d.fill !== false && d.data.length > 1) {
          ctx.globalAlpha = 0.14;
          ctx.lineTo(X(d.data.length - 1), pad.t + ih);
          ctx.lineTo(X(0), pad.t + ih);
          ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
        }
      }
    });

    ctx.fillStyle = tc.text; ctx.font = "11px system-ui";
    const step = Math.ceil(labels.length / 8);
    labels.forEach(function (l, i) {
      if (i % step !== 0 && i !== labels.length - 1) return;
      ctx.fillText(String(l), X(i) - 10, h - 10);
    });
  },

  resizeAll() {
    Object.keys(this.instances).forEach(function (id) {
      try { Charts.instances[id].resize(); } catch (e) {}
    });
  },

  destroyAll() {
    const self = this;
    Object.keys(this.instances).forEach(function (id) {
      try { self.instances[id].destroy(); } catch (e) {}
    });
    this.instances = {};
  }
};

/* =============================================================================
   12. MAPS  (Leaflet with an inline SVG fallback)
   ============================================================================= */
const Maps = {
  instance: null,
  layer: null,
  fallbackUsed: false,
  currentRows: [],

  render(rows) {
    const host = byId("map");
    if (!host) return;
    this.currentRows = rows || [];
    if (!rows || !rows.length) {
      if (this.instance) {
        this.instance.remove();
        this.instance = null;
        this.layer = null;
      }
      host.innerHTML = '<div class="chart-empty">No roads match the current filters.</div>';
      return;
    }

    if (typeof window.L !== "undefined" && !this.fallbackUsed) {
      try {
        if (!this.instance) {
          this.instance = window.L.map("map", { zoomControl: true, attributionControl: true, scrollWheelZoom: false })
            .setView(CALABAR_CENTER, 13);
          const tiles = window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 18,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          }).addTo(this.instance);
          tiles.on("tileerror", function () {
            if (Maps.fallbackUsed || !Maps.instance) return;
            Maps.fallbackUsed = true;
            Maps.instance.remove();
            Maps.instance = null;
            Maps.layer = null;
            Maps.renderFallback(host, Maps.currentRows);
            Log.warn("Map tiles unavailable — using SVG map fallback");
          });
        }
        if (this.layer) this.layer.remove();
        this.layer = window.L.layerGroup().addTo(this.instance);
        rows.forEach(function (r) {
          const color = LEVEL_COLOR[r.congestion_level] || "#38e1ff";
          window.L.circleMarker([r.latitude, r.longitude], {
            radius: 8 + r.congestion_index * 9,
            color: color,
            fillColor: color,
            fillOpacity: 0.62,
            weight: 2
          }).bindPopup(
            "<b>" + escapeHtml(r.road_name) + "</b><br>" +
            '<span class="pill ' + r.congestion_level + '">' + r.congestion_level + "</span><br>" +
            "Speed " + fmtNum(r.speed_kmh, 1) + " km/h · Index " + fmtNum(r.congestion_index, 2) + "<br>" +
            "Volume " + fmtInt(r.traffic_volume) + " · Occupancy " + fmtNum(r.occupancy, 1) + "%"
          ).addTo(this.layer);
        });
        setTimeout(function () { try { Maps.instance.invalidateSize(); } catch (e) {} }, 120);
        return;
      } catch (err) {
        Log.warn("Leaflet failed — using SVG map fallback", err && err.message);
        this.fallbackUsed = true;
      }
    }
    this.renderFallback(host, rows);
  },

  renderFallback(host, rows) {
    const w = 900, h = 460;
    const lats = rows.map(function (r) { return r.latitude; });
    const lngs = rows.map(function (r) { return r.longitude; });
    const minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
    const minLng = Math.min.apply(null, lngs), maxLng = Math.max.apply(null, lngs);
    const px = function (r) { return 70 + ((r.longitude - minLng) / ((maxLng - minLng) || 1)) * (w - 140); };
    const py = function (r) { return 70 + (1 - (r.latitude - minLat) / ((maxLat - minLat) || 1)) * (h - 140); };

    let svg = '<svg viewBox="0 0 ' + w + " " + h + '" style="width:100%;height:100%" role="img" aria-label="Congestion map of ' + rows.length + ' road segments">';
    svg += '<rect width="' + w + '" height="' + h + '" fill="none"/>';
    svg += '<text x="18" y="28" fill="rgba(203,213,225,.72)" font-size="14">Calabar South, Nigeria · approximate demo locations</text>';
    for (let i = 1; i < 7; i++) {
      svg += '<line x1="0" y1="' + (i * h / 7) + '" x2="' + w + '" y2="' + (i * h / 7) + '" stroke="rgba(148,163,184,.10)"/>';
      svg += '<line x1="' + (i * w / 7) + '" y1="0" x2="' + (i * w / 7) + '" y2="' + h + '" stroke="rgba(148,163,184,.10)"/>';
    }
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        svg += '<line x1="' + px(rows[i]) + '" y1="' + py(rows[i]) + '" x2="' + px(rows[j]) + '" y2="' + py(rows[j]) +
               '" stroke="rgba(56,225,255,.16)" stroke-width="1.2" stroke-dasharray="5 9"/>';
      }
    }
    rows.forEach(function (r) {
      const c = LEVEL_COLOR[r.congestion_level] || "#38e1ff";
      svg += '<circle cx="' + px(r) + '" cy="' + py(r) + '" r="' + (12 + r.congestion_index * 16) + '" fill="' + c + '" opacity="0.15"/>';
      svg += '<circle cx="' + px(r) + '" cy="' + py(r) + '" r="6" fill="' + c + '"><title>' +
             escapeHtml(r.road_name) + " — " + r.congestion_level + ", " + fmtNum(r.speed_kmh, 1) + " km/h</title></circle>";
      svg += '<text x="' + (px(r) + 12) + '" y="' + (py(r) + 4) + '" fill="#cbd5e1" font-size="12">' + escapeHtml(r.road_name) + "</text>";
    });
    svg += "</svg>";
    host.innerHTML = svg;
  },

  invalidate() { if (this.instance) { try { this.instance.invalidateSize(); } catch (e) {} } }
};

/* =============================================================================
   13. DASHBOARD
   ============================================================================= */
const Dashboard = {
  filters() {
    return {
      date: (byId("fltDate") && byId("fltDate").value) || fmtDate(new Date()),
      time: (byId("fltTime") && byId("fltTime").value) || "08:00",
      road: (byId("fltRoad") && byId("fltRoad").value) || "",
      severity: (byId("fltSeverity") && byId("fltSeverity").value) || ""
    };
  },

  snapshot() {
    const f = this.filters();
    let rows = Demo.latestAll();
    if (f.road) rows = rows.filter(function (r) { return r.road_id === f.road; });
    if (f.severity) rows = rows.filter(function (r) { return r.congestion_level === f.severity; });
    return rows;
  },

  init() {
    const dateInput = byId("fltDate");
    if (dateInput) {
      dateInput.value = fmtDate(new Date());
      dateInput.max = fmtDate(new Date());
      const min = new Date();
      min.setDate(min.getDate() - CONFIG.days);
      dateInput.min = fmtDate(min);
    }
    const sel = byId("fltRoad");
    if (sel && sel.options.length <= 1) {
      ROADS.forEach(function (r) { sel.appendChild(el("option", { value: r.road_id }, escapeHtml(r.name))); });
    }
    const self = this;
    ["fltDate", "fltTime", "fltRoad", "fltSeverity"].forEach(function (id) {
      on(byId(id), "change", debounce(function () { self.render(); }, 140));
    });
    on(byId("refreshDemo"), "click", function () {
      Demo.regenerate();
      ModelService.fit(Demo.records, true);
      Alerts.seed();
      self.render();
      if (App.route === "analytics") Analytics.render();
      toast("Demo data refreshed", "A new seeded draw was generated and the model retrained.", "ok");
    });
  },

  render() {
    const all = Demo.latestAll();
    const rows = this.snapshot();
    if (!all.length) return;

    const idx = mean(all.map(function (r) { return r.congestion_index; }));
    const spd = mean(all.map(function (r) { return r.speed_kmh; }));
    const inc = sum(Demo.records.slice(-24 * ROADS.length).map(function (r) { return r.incident_count; }));

    animateCounter(byId("kpiIndex"), idx, 2);
    animateCounter(byId("kpiSpeed"), spd, 1);
    animateCounter(byId("kpiIncidents"), inc, 0);

    const worst = all.slice().sort(function (a, b) { return b.congestion_index - a.congestion_index; })[0];
    setText(byId("kpiRisk"), worst ? worst.congestion_level : "—");

    const prevSlice = Demo.records.slice(-(48 * ROADS.length), -(24 * ROADS.length));
    const prevIdx = prevSlice.length ? mean(prevSlice.map(function (r) { return r.congestion_index; })) : idx;
    const delta = idx - prevIdx;
    const dEl = byId("kpiIndexDelta");
    if (dEl) {
      dEl.className = "delta " + (delta > 0.01 ? "up" : delta < -0.01 ? "down" : "flat");
      dEl.textContent = (delta >= 0 ? "▲ +" : "▼ ") + fmtNum(delta, 3) + " vs previous day";
    }
    const sEl = byId("kpiSpeedDelta");
    if (sEl) {
      const prevSpeed = prevSlice.length ? mean(prevSlice.map(function (r) { return r.speed_kmh; })) : spd;
      sEl.textContent = fmtNum(prevSpeed, 1) + " km/h previous day";
    }
    const iEl = byId("kpiIncidentsDelta");
    if (iEl) iEl.textContent = "across " + ROADS.length + " monitored roads";
    const rEl = byId("kpiRiskDelta");
    if (rEl) rEl.textContent = "highest current index · " + (worst ? fmtNum(worst.congestion_index, 2) : "—");

    /* Road status bars */
    const list = byId("roadList");
    if (list) {
      list.innerHTML = "";
      rows.slice().sort(function (a, b) { return b.congestion_index - a.congestion_index; }).forEach(function (r) {
        const row = el("div", { class: "bar-row" });
        row.innerHTML =
          '<span title="' + escapeHtml(r.road_name) + '">' + escapeHtml(r.road_name) + "</span>" +
          '<span class="bar-track"><span class="bar-fill" style="width:' + (r.congestion_index * 100).toFixed(1) + '%"></span></span>' +
          '<span class="bar-val">' + fmtNum(r.speed_kmh, 0) + "</span>";
        list.appendChild(row);
      });
      if (!rows.length) list.innerHTML = '<div class="chart-empty">No roads match these filters.</div>';
    }

    /* Incidents table */
    const body = byId("incidentBody");
    if (body) {
      const recent = Demo.records.filter(function (r) { return r.incident_count > 0; }).slice(-12).reverse();
      if (!recent.length) {
        body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted2)">No incidents in this window.</td></tr>';
      } else {
        body.innerHTML = recent.map(function (r) {
          return "<tr><td>" + escapeHtml(fmtStamp(r.timestamp)) + "</td><td>" + escapeHtml(r.road_name) + "</td>" +
            '<td><span class="pill ' + r.congestion_level + '">' + r.congestion_level + "</span></td>" +
            '<td class="num">' + fmtNum(r.speed_kmh, 1) + "</td>" +
            '<td><span class="badge-code">' + (r.incident_count > 1 ? "multi-vehicle" : "reported") + "</span></td></tr>";
        }).join("");
      }
    }

    Maps.render(rows.length ? rows : all);
  }
};

/* =============================================================================
   14. PREDICTION
   ============================================================================= */
const Prediction = {
  lastResult: null,

  init() {
    const sel = byId("p_road");
    if (sel && sel.options.length === 0) {
      ROADS.forEach(function (r) { sel.appendChild(el("option", { value: r.road_id }, escapeHtml(r.name))); });
    }
    const d = byId("p_date");
    if (d) {
      d.value = fmtDate(new Date());
      const max = new Date(); max.setDate(max.getDate() + 7);
      d.max = fmtDate(max);
    }
    const h = byId("p_horizon");
    if (h && h.options.length === 0) {
      HORIZONS.forEach(function (o) { h.appendChild(el("option", { value: o.value, selected: o.value === 60 ? "selected" : null }, o.label)); });
    }

    on(byId("predictForm"), "submit", function (e) { e.preventDefault(); Prediction.run(); });

    ["p_road", "p_date", "p_time", "p_weather", "p_dow", "p_horizon"].forEach(function (id) {
      on(byId(id), "change", debounce(function () { Prediction.renderHorizons(); }, 200));
    });
  },

  prepare() {
    this.renderHorizons();
    if (this.lastResult) this.renderResult(this.lastResult);
  },

  payload(horizonOverride) {
    const dateStr = (byId("p_date") && byId("p_date").value) || fmtDate(new Date());
    const timeStr = (byId("p_time") && byId("p_time").value) || "08:00";
    const dowSel = byId("p_dow") ? parseInt(byId("p_dow").value, 10) : new Date(dateStr).getDay();
    return {
      road_id: (byId("p_road") && byId("p_road").value) || ROADS[0].road_id,
      date: dateStr,
      time: timeStr,
      weather: (byId("p_weather") && byId("p_weather").value) || "clear",
      dow: isNaN(dowSel) ? 1 : dowSel,
      event_flag: !!(byId("p_event") && byId("p_event").checked),
      horizon_min: horizonOverride || parseInt((byId("p_horizon") && byId("p_horizon").value) || "60", 10)
    };
  },

  validate(p) {
    let ok = true;
    ok = Validator.field("f_p_road", !!p.road_id) && ok;
    ok = Validator.field("f_p_date", Validator.isoDate(p.date)) && ok;
    ok = Validator.field("f_p_time", Validator.time(p.time)) && ok;
    ok = Validator.field("f_p_horizon", Validator.number(p.horizon_min, 1, 10080)) && ok;
    return ok;
  },

  async run() {
    const p = this.payload();
    if (!this.validate(p)) { toast("Check the form", "Some required fields are missing or invalid.", "err"); return; }

    const card = byId("predictResultCard");
    const btn = byId("p_submit");
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Forecasting…'; }
    let overlay = null;
    if (card) {
      overlay = el("div", { class: "loading-overlay" }, '<span class="spinner" style="width:26px;height:26px;border-width:3px"></span>');
      card.appendChild(overlay);
    }

    try {
      const result = await DataSource.predict(p);
      this.lastResult = result;
      this.renderResult(result);
      this.renderHorizons();
      toast("Forecast ready", result.location + " → " + result.predicted_congestion + " (" + Math.round(result.probability * 100) + "% ≥ moderate)", "ok");
      Alerts.evaluatePrediction(result);
    } catch (err) {
      Log.error("Prediction failed", err);
      toast("Forecast failed", err && err.message ? err.message : "Unexpected error.", "err");
    } finally {
      if (overlay) overlay.remove();
      if (btn) { btn.disabled = false; btn.textContent = "Generate forecast"; }
    }
  },

  renderResult(p) {
    const card = byId("predictResult");
    if (!card) return;
    setText(byId("predictStamp"),
      "Model " + p.model + " · generated " + fmtStamp(p.generated_at) + " · data " + fmtStamp(p.data_timestamp || Demo.generatedAt));

    const horizonLabel = (HORIZONS.filter(function (h) { return h.value === p.horizon_min; })[0] || { label: p.horizon_min + " min" }).label;
    const dash = p.fallback ? '<span class="tag">fallback model</span>' : "";

    card.innerHTML =
      '<div class="row row--between" style="margin-bottom:14px">' +
        '<span class="pill ' + p.predicted_congestion + '">' + p.predicted_congestion + "</span>" +
        "<span style=\"font-size:.82rem;color:var(--muted)\">" + escapeHtml(p.location) + " · " +
          escapeHtml(String(p.forecast_time).replace("T", " ")) + " · " + escapeHtml(horizonLabel) + "</span>" +
        dash +
      "</div>" +
      '<div class="grid g-3" style="margin-bottom:14px">' +
        '<div><div class="kpi-label" style="font-size:.7rem;color:var(--muted2);text-transform:uppercase;letter-spacing:.08em">Probability ≥ moderate</div>' +
          '<div style="font-size:1.5rem;font-weight:800">' + Math.round(p.probability * 100) + "%</div></div>" +
        '<div><div style="font-size:.7rem;color:var(--muted2);text-transform:uppercase;letter-spacing:.08em">Expected speed</div>' +
          '<div style="font-size:1.5rem;font-weight:800">' + fmtNum(p.expected_speed_kmh, 1) + '</div>' +
          '<div style="font-size:.72rem;color:var(--muted2)">km/h · free-flow ' + fmtNum(p.free_flow_kmh, 0) + "</div></div>" +
        '<div><div style="font-size:.7rem;color:var(--muted2);text-transform:uppercase;letter-spacing:.08em">Confidence</div>' +
          '<div style="font-size:1.5rem;font-weight:800">' + Math.round(p.confidence * 100) + "%</div>" +
          '<div style="font-size:.72rem;color:var(--muted2)">σ ± ' + fmtNum(p.uncertainty_kmh, 1) + " km/h</div></div>" +
      "</div>" +
      '<div style="font-size:.82rem;color:var(--muted);border-top:1px solid var(--border);padding-top:12px">' +
        '<b style="color:var(--text)">Why this forecast</b>' +
        '<ul style="margin:8px 0 0;padding-left:18px">' +
          p.explanation.map(function (e) { return "<li>" + escapeHtml(e) + "</li>"; }).join("") +
        "</ul>" +
        '<p style="margin:10px 0 0;font-size:.76rem;color:var(--muted2)">' +
          "Probability definition: " + escapeHtml(p.probability_definition || "") +
          ". Demo Mode metrics are computed on synthetic data and are not a claim about real-world accuracy." +
        "</p>" +
      "</div>";
  },

  renderHorizons() {
    if (!exists("horizonChart")) return;
    const base = this.payload();
    const speeds = HORIZONS.map(function (h) {
      return ModelService.predictForm(Object.assign({}, base, { horizon_min: h.value })).expected_speed_kmh;
    });
    Charts.draw("horizonChart", "bar",
      HORIZONS.map(function (h) { return h.value >= 60 ? (h.value / 60) + "h" : h.value + "m"; }),
      [{ label: "Expected speed (km/h)", data: speeds }],
      { forceLegend: false, ariaLabel: "Expected speed by forecast horizon" });
  }
};

/* =============================================================================
   15. ANALYTICS
   ============================================================================= */
const Analytics = {
  daily() {
    const map = {};
    Demo.records.forEach(function (r) {
      const d = r.timestamp.slice(0, 10);
      (map[d] = map[d] || []).push(r.congestion_index);
    });
    const keys = Object.keys(map).sort();
    return { labels: keys.map(function (k) { return k.slice(5); }), values: keys.map(function (k) { return round(mean(map[k]), 4); }) };
  },

  byHour() {
    const buckets = [];
    for (let i = 0; i < 24; i++) buckets.push([]);
    Demo.records.forEach(function (r) { buckets[r.hour].push(r.congestion_index); });
    return { labels: buckets.map(function (_, i) { return pad2(i) + ":00"; }), values: buckets.map(function (b) { return round(mean(b), 4); }) };
  },

  byDow() {
    const buckets = [];
    for (let i = 0; i < 7; i++) buckets.push([]);
    Demo.records.forEach(function (r) { buckets[r.day_of_week].push(r.congestion_index); });
    return { labels: DOW_SHORT.slice(), values: buckets.map(function (b) { return round(mean(b), 4); }) };
  },

  peakHour() {
    const h = this.byHour();
    let best = 0;
    h.values.forEach(function (v, i) { if (v > h.values[best]) best = i; });
    return { hour: best, value: h.values[best] };
  },

  ranking() {
    return ROADS.map(function (r) {
      const rows = Demo.byRoad[r.road_id] || [];
      const idx = rows.length ? mean(rows.map(function (x) { return x.congestion_index; })) : 0;
      const worst = rows.length ? rows.slice().sort(function (a, b) { return b.congestion_index - a.congestion_index; })[0] : null;
      return {
        road_id: r.road_id, name: r.name, index: round(idx, 4),
        peak_level: worst ? worst.congestion_level : "LOW",
        mean_speed_kmh: round(rows.length ? mean(rows.map(function (x) { return x.speed_kmh; })) : 0, 1)
      };
    }).sort(function (a, b) { return b.index - a.index; });
  },

  computeTrends() {
    const d = this.daily(), h = this.byHour(), w = this.byDow();
    return { daily: d, hourly: h, weekly: w, peak_hour: this.peakHour(), hotspots: this.ranking() };
  },

  /* Model comparison + evaluation metrics for the selected model */
  evaluate() {
    if (!ModelService.trained) ModelService.fit(Demo.records);
    return ModelService.metrics;
  },

  render() {
    if (!Demo.records.length) return;

    const daily = this.daily();
    Charts.draw("trendChart", "line", daily.labels, [{ label: "Congestion index", data: daily.values }],
      { ariaLabel: "Historical congestion trend by day" });

    const hourly = this.byHour();
    Charts.draw("hourChart", "bar", hourly.labels, [{ label: "Congestion index", data: hourly.values, color: "#7c5cff" }],
      { forceLegend: false, ariaLabel: "Mean congestion index by hour of day" });

    const dow = this.byDow();
    Charts.draw("dowChart", "bar", dow.labels, [{ label: "Congestion index", data: dow.values, color: "#38e1ff" }],
      { forceLegend: false, ariaLabel: "Mean congestion index by day of week" });

    /* Feature importance from the trained model */
    const impList = byId("importanceList");
    if (impList) {
      const imp = ModelService.importance.length ? ModelService.importance.slice(0, 7) : [];
      if (!imp.length) {
        impList.innerHTML = '<div class="chart-empty">Model not trained yet.</div>';
      } else {
        const top = imp[0].value || 1;
        impList.innerHTML = imp.map(function (f) {
          const pct = (f.value * 100);
          const rel = top ? (f.value / top) * 100 : 0;
          return '<div class="bar-row"><span title="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + "</span>" +
            '<span class="bar-track"><span class="bar-fill" style="width:' + rel.toFixed(1) + '%"></span></span>' +
            '<span class="bar-val">' + pct.toFixed(1) + "%</span></div>";
        }).join("") +
        '<p style="margin:12px 0 0;font-size:.74rem;color:var(--muted2)">Relative importance from the gradient-boosting model trained on the chronological training split.</p>';
      }
    }

    /* Location ranking */
    const rankList = byId("rankList");
    if (rankList) {
      const rank = this.ranking();
      const top = rank.length ? rank[0].index || 1 : 1;
      rankList.innerHTML = rank.map(function (r) {
        return '<div class="bar-row"><span title="' + escapeHtml(r.name) + '">' + escapeHtml(r.name) + "</span>" +
          '<span class="bar-track"><span class="bar-fill" style="width:' + ((r.index / top) * 100).toFixed(1) + '%"></span></span>' +
          '<span class="bar-val">' + r.index.toFixed(2) + "</span></div>";
      }).join("");
    }

    /* Prediction vs actual */
    const pva = ModelService.predVsActual;
    if (pva && pva.labels.length) {
      Charts.draw("pvaChart", "line", pva.labels, [
        { label: "Actual speed", data: pva.actual, color: "#38e1ff", fill: false },
        { label: "Predicted speed", data: pva.pred, color: "#f97316", borderDash: [5, 4], fill: false }
      ], { ariaLabel: "Predicted versus actual speed on the chronological test split" });
    }

    /* Metric cards */
    const metricCards = byId("metricCards");
    const m = this.evaluate();
    if (metricCards) {
      if (!m) {
        metricCards.innerHTML = '<div class="chart-empty">Metrics unavailable — model training did not complete.</div>';
      } else {
        const items = [
          ["MAE (km/h)", fmtNum(m.mae, 2)],
          ["RMSE (km/h)", fmtNum(m.rmse, 2)],
          ["MAPE (%)", fmtNum(m.mape, 1)],
          ["R² (speed)", fmtNum(m.r2, 3)],
          ["Accuracy", fmtNum(m.accuracy * 100, 1) + "%"],
          ["Precision (macro)", fmtNum(m.precision * 100, 1) + "%"],
          ["Recall (macro)", fmtNum(m.recall * 100, 1) + "%"],
          ["F1 (macro)", fmtNum(m.f1 * 100, 1) + "%"]
        ];
        metricCards.innerHTML = items.map(function (it) {
          return '<div class="kpi"><div class="label">' + escapeHtml(it[0]) + '</div><div class="value" style="font-size:1.5rem">' + escapeHtml(it[1]) + "</div></div>";
        }).join("");
      }
    }
    App.metrics = m;
  }
};

/* =============================================================================
   16. ALERTS
   ============================================================================= */
const Alerts = {
  add(type, roadId, message, status) {
    const a = {
      id: "a_" + Math.random().toString(36).slice(2, 9),
      type: type,
      road_id: roadId,
      message: message,
      status: status || "open",
      raised: nowIso()
    };
    App.alerts.unshift(a);
    if (App.alerts.length > 200) App.alerts.length = 200;
    App.saveAlerts();
    return a;
  },

  dedupe(type, roadId, message) {
    const dup = App.alerts.filter(function (a) {
      return a.type === type && a.road_id === roadId && a.message === message && a.status === "open";
    })[0];
    return dup || this.add(type, roadId, message, "open");
  },

  seed() {
    App.alerts = App.alerts.filter(function (a) { return a.type === "test" || a.type === "prediction"; });
    const latest = Demo.latestAll();
    const self = this;
    latest.forEach(function (r) {
      if (r.congestion_index >= App.thresholds.severe) {
        self.dedupe("threshold", r.road_id, "Severe congestion: index " + r.congestion_index.toFixed(2) + " at " + r.road_name);
      } else if (r.congestion_index >= App.thresholds.high) {
        self.dedupe("threshold", r.road_id, "High congestion: index " + r.congestion_index.toFixed(2) + " at " + r.road_name);
      }
      if (r.incident_count > 0) {
        self.dedupe("incident", r.road_id, r.incident_count + " incident(s) reported near " + r.road_name);
      }
    });
    App.saveAlerts();
  },

  evaluatePrediction(p) {
    if (!p) return;
    if (p.predicted_congestion === "SEVERE" || p.predicted_congestion === "HIGH") {
      this.add("prediction", p.road_id,
        "Predicted " + p.predicted_congestion + " congestion at " + String(p.forecast_time).replace("T", " ") +
        " (" + Math.round(p.probability * 100) + "% probability ≥ moderate, model " + p.model + ")",
        "open");
      this.notify("Predicted " + p.predicted_congestion + " congestion", p.location + " at " + String(p.forecast_time).replace("T", " "));
      App.saveAlerts();
      if (App.route === "alerts") this.render();
    }
  },

  /* UI-only notification. Desktop notifications are used only if the user has
     explicitly enabled them and the browser granted permission. */
  notify(title, body) {
    try {
      if (Store.get(CONFIG.keys.notifications) !== "on") return;
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      new Notification(title, { body: body });
    } catch (e) { /* notifications are best-effort */ }
  },

  async enableNotifications() {
    if (typeof Notification === "undefined") {
      toast("Not supported", "This browser does not support desktop notifications.", "warn");
      return false;
    }
    try {
      const perm = await Notification.requestPermission();
      if (perm === "granted") {
        Store.set(CONFIG.keys.notifications, "on");
        toast("Notifications enabled", "Predicted severe congestion will raise a desktop notification.", "ok");
        return true;
      }
      toast("Permission declined", "Alerts will stay inside the app.", "warn");
      return false;
    } catch (e) {
      toast("Could not enable notifications", "The browser blocked the request.", "warn");
      return false;
    }
  },

  roadName(id) {
    const r = ROADS.filter(function (x) { return x.road_id === id; })[0];
    return r ? r.name : id;
  },

  counts() {
    return {
      open: App.alerts.filter(function (a) { return a.status === "open"; }).length,
      severe: App.alerts.filter(function (a) { return a.type === "prediction"; }).length,
      incident: App.alerts.filter(function (a) { return a.type === "incident"; }).length,
      threshold: App.alerts.filter(function (a) { return a.type === "threshold"; }).length,
      resolved: App.alerts.filter(function (a) { return a.status === "resolved"; }).length
    };
  },

  init() {
    const self = this;
    on(byId("testAlert"), "click", function () {
      self.add("test", ROADS[0].road_id, "Test notification from FlowCast (UI-only in Demo Mode).", "open");
      self.render();
      self.notify("FlowCast test alert", "This is a demo notification.");
      toast("Test alert sent", "UI-only demo notification.", "ok");
    });

    on(byId("clearAlerts"), "click", function () {
      App.alerts = App.alerts.filter(function (a) { return a.status !== "resolved"; });
      App.saveAlerts();
      self.render();
      toast("Resolved alerts cleared", "", "ok");
    });

    on(byId("saveThresholds"), "click", function () {
      const h = parseFloat(byId("thHigh").value);
      const s = parseFloat(byId("thSevere").value);
      if (!Validator.number(h, 0.01, 1) || !Validator.number(s, 0.01, 1) || s <= h) {
        toast("Invalid thresholds", "Severe must be greater than high, and both between 0.01 and 1.", "err");
        return;
      }
      App.thresholds = { high: round(h, 3), severe: round(s, 3) };
      App.saveThresholds();
      self.seed();
      self.render();
      toast("Thresholds saved", "High " + App.thresholds.high + " · Severe " + App.thresholds.severe, "ok");
    });

    on(byId("enableNotifications"), "click", function () { self.enableNotifications(); });
  },

  render() {
    const body = byId("alertBody");
    if (body) {
      if (!App.alerts.length) {
        body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted2)">No alerts. All clear.</td></tr>';
      } else {
        body.innerHTML = App.alerts.map(function (a) {
          return "<tr><td>" + escapeHtml(fmtStamp(a.raised)) + "</td>" +
            '<td><span class="badge-code">' + escapeHtml(a.type) + "</span></td>" +
            "<td>" + escapeHtml(Alerts.roadName(a.road_id)) + "</td>" +
            "<td>" + escapeHtml(a.message) + "</td>" +
            '<td><span class="pill ' + (a.status === "open" ? "HIGH" : "LOW") + '">' + escapeHtml(a.status) + "</span></td>" +
            '<td><button class="btn sm" type="button" data-resolve="' + escapeHtml(a.id) + '">Resolve</button></td></tr>';
        }).join("");
        $$("[data-resolve]", body).forEach(function (b) {
          on(b, "click", function () {
            const a = App.alerts.filter(function (x) { return x.id === b.dataset.resolve; })[0];
            if (a) { a.status = "resolved"; App.saveAlerts(); Alerts.render(); toast("Alert resolved", "", "ok"); }
          });
        });
      }
    }
    const c = this.counts();
    setText(byId("alertOpen"), c.open);
    setText(byId("alertSevere"), c.severe);
    setText(byId("alertIncident"), c.incident);
    setText(byId("alertResolved"), c.resolved);
    if (exists("thHigh")) byId("thHigh").value = App.thresholds.high;
    if (exists("thSevere")) byId("thSevere").value = App.thresholds.severe;
  }
};

/* =============================================================================
   17. DATA MANAGEMENT
   -----------------------------------------------------------------------------
   CSV parsing, validation, missing-value and duplicate detection, feature
   engineering, raw/processed/train/validation/test separation and CSV export.
   ============================================================================= */
const DataView = {
  parsed: null,
  lastValidation: null,
  REQUIRED: ["timestamp", "road_id", "speed_kmh"],
  EXPECTED: ["timestamp", "road_id", "latitude", "longitude", "speed_kmh", "traffic_volume", "occupancy", "rainfall_mm", "incident_count", "event_flag"],
  RAW_HEADERS: ["timestamp", "road_id", "latitude", "longitude", "speed_kmh", "traffic_volume", "occupancy", "rainfall_mm", "incident_count", "event_flag", "congestion_level"],
  PROCESSED_HEADERS: ["timestamp", "road_id", "hour", "day_of_week", "weekend", "peak_indicator", "speed_kmh", "congestion_index", "congestion_level", "weather", "rainfall_mm", "traffic_volume", "occupancy", "incident_count", "event_flag"],

  /* RFC-4180-ish CSV parser: handles quoted fields, escaped quotes and newlines */
  parseCSV(text) {
    const rows = [];
    let row = [], field = "", inQuotes = false, i = 0;
    text = String(text).replace(/^\uFEFF/, "");           // strip BOM
    while (i < text.length) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    while (rows.length && rows[rows.length - 1].every(function (v) { return String(v).trim() === ""; })) rows.pop();
    if (!rows.length) return { headers: [], rows: [] };

    const headers = rows[0].map(function (h) { return String(h).trim(); });
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      if (rows[r].every(function (v) { return String(v).trim() === ""; })) continue;
      const obj = {};
      headers.forEach(function (h, ci) { obj[h] = rows[r][ci] === undefined ? "" : String(rows[r][ci]).trim(); });
      out.push(obj);
    }
    return { headers: headers, rows: out };
  },

  validate(parsed) {
    const headers = parsed.headers || [];
    const missingCols = this.REQUIRED.filter(function (c) { return headers.indexOf(c) === -1; });
    const extraCols = headers.filter(function (h) { return this.EXPECTED.indexOf(h) === -1; }, this);
    let missingVals = 0, duplicates = 0, badSpeed = 0, badTimestamp = 0, unknownRoads = 0;
    const seen = {}, roadIds = ROADS.map(function (r) { return r.road_id; });

    parsed.rows.forEach(function (r) {
      this.REQUIRED.forEach(function (c) { if (!r[c]) missingVals++; }, this);
      const key = (r.timestamp || "") + "|" + (r.road_id || "");
      if (seen[key]) duplicates++; else seen[key] = 1;
      if (r.speed_kmh !== undefined && r.speed_kmh !== "") {
        const s = Number(r.speed_kmh);
        if (!isFinite(s) || s < 0 || s > 200) badSpeed++;
      }
      if (r.timestamp && isNaN(new Date(r.timestamp).getTime())) badTimestamp++;
      if (r.road_id && roadIds.indexOf(r.road_id) === -1) unknownRoads++;
    }, this);

    return {
      total: parsed.rows.length,
      columns: headers.length,
      missingCols: missingCols,
      extraCols: extraCols,
      missingVals: missingVals,
      duplicates: duplicates,
      badSpeed: badSpeed,
      badTimestamp: badTimestamp,
      unknownRoads: unknownRoads,
      ok: missingCols.length === 0 && parsed.rows.length > 0
    };
  },

  renderValidation(v, parsed) {
    const host = byId("uploadStatus");
    if (!host) return;
    const warn = !v.ok || v.missingVals || v.duplicates || v.badSpeed || v.badTimestamp;
    host.innerHTML =
      '<div class="notice' + (warn ? " warn" : "") + '">' +
        (v.missingCols.length
          ? "<b>Missing required columns:</b> " + escapeHtml(v.missingCols.join(", ")) + "<br>"
          : "<b>All required columns present.</b><br>") +
        "Rows: " + fmtInt(v.total) + " · Columns: " + v.columns +
        " · Missing values in required fields: " + v.missingVals +
        " · Duplicate (timestamp, road) pairs: " + v.duplicates +
        (v.badSpeed ? " · Out-of-range speeds: " + v.badSpeed : "") +
        (v.badTimestamp ? " · Unparseable timestamps: " + v.badTimestamp : "") +
        (v.unknownRoads ? " · Unknown road IDs: " + v.unknownRoads : "") +
        (v.extraCols.length ? "<br>Unrecognised columns will be ignored: " + escapeHtml(v.extraCols.join(", ")) : "") +
      "</div>";
    if (parsed) this.renderPreview(parsed, 20);
  },

  renderPreview(parsed, limit) {
    const table = byId("previewTable");
    if (!table || !parsed.headers.length) return;
    const thead = table.querySelector("thead"), tbody = table.querySelector("tbody");
    const headers = parsed.headers.slice(0, 12);
    thead.innerHTML = "<tr>" + headers.map(function (h) { return "<th>" + escapeHtml(h) + "</th>"; }).join("") + "</tr>";
    tbody.innerHTML = parsed.rows.slice(0, limit || 40).map(function (r) {
      return "<tr>" + headers.map(function (h) { return "<td>" + escapeHtml(r[h] || "—") + "</td>"; }).join("") + "</tr>";
    }).join("");
    setText(byId("previewSub"), "Showing " + Math.min(limit || 40, parsed.rows.length) + " of " + fmtInt(parsed.rows.length) + " uploaded rows.");
  },

  /* Feature engineering applied to each accepted row */
  engineer(row, road) {
    const speed = Number(row.speed_kmh);
    const ts = new Date(row.timestamp);
    const valid = !isNaN(ts.getTime());
    const rainfall = Number(row.rainfall_mm) || 0;
    const weather = rainfall > 5 ? "heavy_rain" : rainfall > 0 ? "rain" : "clear";
    const hour = valid ? ts.getHours() : new Date().getHours();
    const dow = valid ? ts.getDay() : new Date().getDay();
    return {
      timestamp: valid ? ts.toISOString() : nowIso(),
      road_id: road.road_id,
      road_name: road.name,
      latitude: Number(row.latitude) || road.lat,
      longitude: Number(row.longitude) || road.lng,
      speed_kmh: speed,
      free_flow_kmh: road.free_flow_kmh,
      traffic_volume: parseInt(row.traffic_volume, 10) || 0,
      occupancy: Number(row.occupancy) || 0,
      density: round((parseInt(row.traffic_volume, 10) || 0) / Math.max(road.lanes * 2, 1) / Math.max(speed, 1) * 10, 2),
      rainfall_mm: rainfall,
      weather: weather,
      incident_count: parseInt(row.incident_count, 10) || 0,
      event_flag: parseInt(row.event_flag, 10) || 0,
      day_of_week: dow,
      hour: hour,
      minute: valid ? ts.getMinutes() : 0,
      weekend: isWeekend(dow) ? 1 : 0,
      peak_indicator: Demo.peakIntensity(hour, isWeekend(dow)) > 0.4 ? 1 : 0,
      congestion_level: Demo.labelFor(speed, road.free_flow_kmh),
      congestion_index: round(Demo.indexFor(speed, road.free_flow_kmh), 3)
    };
  },

  ingestLocally(csv, filename) {
    const parsed = this.parseCSV(csv);
    const v = this.validate(parsed);
    if (!v.ok) return { ok: false, validation: v, added: 0, skipped: parsed.rows.length };
    let added = 0, skipped = 0;
    const seen = {};
    Demo.records.forEach(function (r) { seen[r.timestamp + "|" + r.road_id] = 1; });
    parsed.rows.forEach(function (row) {
      const road = ROADS.filter(function (x) { return x.road_id === row.road_id; })[0];
      const key = (row.timestamp || "") + "|" + (row.road_id || "");
      if (!road || seen[key] || !isFinite(Number(row.speed_kmh))) { skipped++; return; }
      seen[key] = 1;
      Demo.records.push(this.engineer(row, road));
      added++;
    }, this);
    Demo.reindex();
    ModelService.fit(Demo.records, true);
    Alerts.seed();
    Log.info("CSV ingested", { file: sanitizeFilename(filename), added: added, skipped: skipped });
    return { ok: true, validation: v, added: added, skipped: skipped, filename: sanitizeFilename(filename) };
  },

  renderSplits() {
    const host = byId("splitList");
    if (!host) return;
    const s = ModelService.split;
    const n = ModelService.matrix ? ModelService.matrix.X.length : Demo.records.length;
    const parts = s
      ? [
          { name: "Raw records", count: Demo.records.length, pct: 100 },
          { name: "Training (70%)", count: s.train.length, pct: 70 },
          { name: "Validation (15%)", count: s.val.length, pct: 15 },
          { name: "Test (15%)", count: s.test.length, pct: 15 }
        ]
      : [
          { name: "Raw records", count: n, pct: 100 },
          { name: "Training (70%)", count: Math.floor(n * 0.70), pct: 70 },
          { name: "Validation (15%)", count: Math.floor(n * 0.85) - Math.floor(n * 0.70), pct: 15 },
          { name: "Test (15%)", count: n - Math.floor(n * 0.85), pct: 15 }
        ];
    host.innerHTML = parts.map(function (p) {
      return '<div class="bar-row"><span>' + escapeHtml(p.name) + "</span>" +
        '<span class="bar-track"><span class="bar-fill" style="width:' + p.pct + '%"></span></span>' +
        '<span class="bar-val">' + fmtInt(p.count) + "</span></div>";
    }).join("") +
    '<p style="margin:12px 0 0;font-size:.74rem;color:var(--muted2)">Splits are chronological — the model never trains on rows that come after the rows it is tested on.</p>';
  },

  render() {
    const table = byId("previewTable");
    if (table && !this.parsed) {
      const sample = Demo.records.slice(-25);
      const headers = this.PROCESSED_HEADERS.slice(0, 12);
      table.querySelector("thead").innerHTML = "<tr>" + headers.map(function (h) { return "<th>" + escapeHtml(h) + "</th>"; }).join("") + "</tr>";
      table.querySelector("tbody").innerHTML = sample.map(function (r) {
        return "<tr>" + headers.map(function (h) {
          const v = r[h];
          return "<td>" + escapeHtml(typeof v === "number" ? fmtNum(v, 2) : v) + "</td>";
        }).join("") + "</tr>";
      }).join("");
      setText(byId("previewSub"), "Most recent 25 rows of the active demo dataset (" + fmtInt(Demo.records.length) + " records). Upload a CSV to preview your own data.");
    }
    this.renderSplits();
  },

  init() {
    const fileInput = byId("csvFile");
    const validateBtn = byId("btnValidate");
    const ingestBtn = byId("btnIngest");
    const self = this;

    on(fileInput, "change", function () {
      self.parsed = null;
      if (validateBtn) validateBtn.disabled = !fileInput.files.length;
      if (ingestBtn) ingestBtn.disabled = true;
      setHTML(byId("uploadStatus"), "");
    });

    on(validateBtn, "click", function () {
      const file = fileInput.files[0];
      if (!file) return;
      if (file.size > 25 * 1024 * 1024) { toast("File too large", "Please upload a CSV under 25 MB.", "err"); return; }
      const reader = new FileReader();
      reader.onload = function (e) {
        self.parsed = self.parseCSV(e.target.result);
        self.lastValidation = self.validate(self.parsed);
        self.renderValidation(self.lastValidation, self.parsed);
        if (ingestBtn) ingestBtn.disabled = !self.lastValidation.ok;
        if (!self.lastValidation.ok) toast("Validation failed", "Required columns are missing.", "err");
        else toast("File validated", self.lastValidation.total + " rows ready to ingest.", "ok");
      };
      reader.onerror = function () { toast("Could not read file", "The browser blocked the file read.", "err"); };
      reader.readAsText(file);
    });

    on(ingestBtn, "click", function () {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async function (e) {
        const btn = ingestBtn;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Ingesting…';
        try {
          const res = await DataSource.upload(e.target.result, sanitizeFilename(file.name));
          if (!res || res.ok === false) {
            toast("Ingestion rejected", "The file failed validation.", "err");
          } else {
            toast("Ingestion complete", fmtInt(res.added) + " rows added and features engineered" + (res.skipped ? " · " + fmtInt(res.skipped) + " skipped" : "") + ".", "ok");
            self.parsed = null;
            self.renderSplits();
            self.render();
            if (App.route === "analytics") Analytics.render();
            if (App.route === "dashboard") Dashboard.render();
          }
        } catch (err) {
          Log.error("Ingestion failed", err);
          toast("Ingestion failed", err && err.message ? err.message : "Unexpected error.", "err");
        } finally {
          btn.disabled = false;
          btn.textContent = "Ingest into demo store";
        }
      };
      reader.readAsText(file);
    });

    on(byId("exportRaw"), "click", function () {
      download("flowcast-raw-" + fmtDate(new Date()) + ".csv", toCSV(Demo.records, self.RAW_HEADERS));
      toast("Export ready", "Raw dataset downloaded.", "ok");
    });

    on(byId("exportProcessed"), "click", function () {
      download("flowcast-processed-" + fmtDate(new Date()) + ".csv", toCSV(Demo.records, self.PROCESSED_HEADERS));
      toast("Export ready", "Processed dataset with engineered features downloaded.", "ok");
    });

    on(byId("exportMetrics"), "click", function () {
      const m = App.metrics || (ModelService.trained ? ModelService.metrics : null);
      if (!m) { toast("No metrics yet", "Open Analytics once so the model is evaluated.", "warn"); return; }
      const rows = Object.keys(m).filter(function (k) { return typeof m[k] !== "object"; })
        .map(function (k) { return { metric: k, value: m[k] }; });
      download("flowcast-metrics-" + fmtDate(new Date()) + ".csv", toCSV(rows, ["metric", "value"]));
      toast("Export ready", "Evaluation metrics downloaded.", "ok");
    });

    on(byId("exportTemplate"), "click", function () {
      const rows = Demo.records.slice(-5).map(function (r) {
        const o = {};
        self.RAW_HEADERS.forEach(function (h) { o[h] = r[h]; });
        return o;
      });
      download("flowcast-upload-template.csv", toCSV(rows, self.RAW_HEADERS));
      toast("Template downloaded", "Five example rows with the expected column names.", "ok");
    });
  }
};

/* =============================================================================
   18. DOCS
   ============================================================================= */
const Docs = {
  rendered: false,

  ENDPOINTS: [
    { verb: "GET",  path: "/api/health",             desc: "Service health check" },
    { verb: "GET",  path: "/api/dashboard/summary",  desc: "KPI cards" },
    { verb: "GET",  path: "/api/traffic/current",    desc: "Current snapshot" },
    { verb: "GET",  path: "/api/traffic/history",    desc: "Historical records" },
    { verb: "POST", path: "/api/predict",            desc: "Single forecast" },
    { verb: "POST", path: "/api/predict/batch",      desc: "Batch forecasts" },
    { verb: "POST", path: "/api/data/upload",        desc: "CSV ingestion" },
    { verb: "GET",  path: "/api/analytics/trends",   desc: "Trend aggregates" },
    { verb: "GET",  path: "/api/analytics/hotspots", desc: "Hotspot ranking" },
    { verb: "GET",  path: "/api/models",             desc: "Model registry" },
    { verb: "GET",  path: "/api/alerts",             desc: "Alert feed" },
    { verb: "POST", path: "/api/alerts/test",        desc: "Test notification" }
  ],

  render() {
    /* populate the endpoint list if the markup provides a container */
    const list = byId("apiEndpointList");
    if (list && !list.dataset.filled) {
      list.innerHTML = this.ENDPOINTS.map(function (e) {
        return '<div class="endpoint"><span class="verb ' + e.verb + '">' + e.verb + "</span>" +
          "<code>" + escapeHtml(e.path) + "</code><span>" + escapeHtml(e.desc) + "</span></div>";
      }).join("");
      list.dataset.filled = "1";
    }
    const modeEl = byId("docsMode");
    if (modeEl) modeEl.textContent = DataSource.mode === "api" ? "API (" + CONFIG.apiBase + ")" : "Demo Mode (seeded synthetic data)";
    const regEl = byId("docsModelRegistry");
    if (regEl) regEl.textContent = ModelService.chosen ? ModelService.chosen.name : "not trained yet";

    this.rendered = true;
  }
};

/* =============================================================================
   19. LANDING  (ticker, hero metrics, scroll reveal, footer year)
   ============================================================================= */
const Landing = {
  rendered: false,

  render() {
    if (!this.rendered) {
      this.rendered = true;
      this.renderTicker();
      this.renderHeroMetrics();
      this.renderFooterYear();
      this.initReveal();
    }
  },

  renderTicker() {
    $$(".ticker-track").forEach(function (track) {
      if (track.dataset.filled) return;
      const latest = Demo.latestAll();
      const items = latest.map(function (r) {
        return '<span class="ticker-item"><b>' + escapeHtml(r.road_name) + "</b> " +
          escapeHtml(r.congestion_level) + " · " + fmtNum(r.speed_kmh, 1) + " km/h</span>";
      }).join("");
      /* duplicated once for a seamless loop */
      track.innerHTML = items + items;
      track.dataset.filled = "1";
    });
  },

  renderHeroMetrics() {
    const host = $(".hero-metrics");
    if (!host || host.dataset.filled) return;
    const s = Demo.summary();
    host.innerHTML = [
      { v: fmtInt(s.roads), l: "Monitored roads" },
      { v: fmtInt(s.records), l: "Historical records" },
      { v: fmtNum(s.congestion_index, 2), l: "Current index" },
      { v: fmtInt(s.incidents_24h), l: "Incidents (24 h)" }
    ].map(function (m) {
      return '<div class="hero-metric"><b>' + escapeHtml(m.v) + "</b><span>" + escapeHtml(m.l) + "</span></div>";
    }).join("");
    host.dataset.filled = "1";
  },

  renderFooterYear() {
    $$("[data-year]").forEach(function (n) { n.textContent = new Date().getFullYear(); });
  },

  initReveal() {
    const nodes = $$(".reveal");
    if (!nodes.length) return;
    if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") {
      nodes.forEach(function (n) { n.style.opacity = "1"; });
      return;
    }
    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.style.opacity = "1"; io.unobserve(entry.target); }
      });
    }, { rootMargin: "0px 0px -40px 0px", threshold: 0.05 });
    nodes.forEach(function (n) { io.observe(n); });
  }
};

/* =============================================================================
   20. AUTH UI
   ============================================================================= */
function showAuth(gated) {
  const screen = byId("authScreen");
  const shell = byId("appShell");
  if (screen) screen.classList.remove("hidden");
  if (shell) shell.classList.add("hidden");
  const note = byId("authGateNote");
  if (note) note.hidden = !gated;
  switchAuthPanel("signin");
  const first = byId("si_email");
  if (first) setTimeout(function () { try { first.focus(); } catch (e) {} }, 60);
}

function hideAuth() {
  const screen = byId("authScreen");
  const shell = byId("appShell");
  if (screen) screen.classList.add("hidden");
  if (shell) shell.classList.remove("hidden");
  syncAccountChrome();
}

function switchAuthPanel(which) {
  const panels = { signin: byId("panelSignin"), signup: byId("panelSignup"), forgot: byId("panelForgot") };
  Object.keys(panels).forEach(function (k) { if (panels[k]) panels[k].classList.remove("active"); });
  if (panels[which]) panels[which].classList.add("active");

  const tabSignin = byId("tabSignin"), tabSignup = byId("tabSignup");
  if (tabSignin) { tabSignin.classList.toggle("active", which === "signin"); tabSignin.setAttribute("aria-selected", String(which === "signin")); }
  if (tabSignup) { tabSignup.classList.toggle("active", which === "signup"); tabSignup.setAttribute("aria-selected", String(which === "signup")); }

  const tabs = $(".auth-tabs");
  if (tabs) tabs.style.display = which === "forgot" ? "none" : "flex";

  const copy = {
    signin: ["Welcome back", "Sign in to the congestion detection & prediction dashboard."],
    signup: ["Create your account", "Your account is stored locally in this browser."],
    forgot: ["Reset your password", "Demo Mode simulates the reset flow."]
  }[which] || ["Welcome back", ""];
  setText(byId("authTitle"), copy[0]);
  setText(byId("authLead"), copy[1]);

  $$(".field.invalid").forEach(function (f) { f.classList.remove("invalid"); });
}

function applySession() {
  const s = Auth.session;
  if (!s) return;
  setText(byId("userName"), s.name);
  setText(byId("avatar"), String(s.name).trim().charAt(0).toUpperCase() || "?");
  const chip = byId("userChip");
  if (chip) chip.title = s.email + " · " + s.role + " · session expires " + fmtStamp(new Date(s.expires).toISOString());
}

function syncAccountChrome() {
  const signedIn = Auth.isAuthed();
  const signIn = byId("signInBtn");
  const createAccount = byId("createAccountBtn");
  const userChip = byId("userChip");
  const logout = byId("logoutBtn");
  const sidebar = byId("sidebar");
  const menuButton = byId("menuBtn");
  const shell = byId("appShell");
  if (shell) shell.classList.toggle("guest-mode", !signedIn);
  if (signIn) { signIn.hidden = signedIn; toggleClass(signIn, "hidden", signedIn); }
  if (createAccount) { createAccount.hidden = signedIn; toggleClass(createAccount, "hidden", signedIn); }
  if (userChip) { userChip.hidden = !signedIn; toggleClass(userChip, "hidden", !signedIn); }
  if (logout) { logout.hidden = !signedIn; toggleClass(logout, "hidden", !signedIn); }
  if (sidebar) { sidebar.hidden = !signedIn; toggleClass(sidebar, "hidden", !signedIn); }
  if (menuButton) {
    menuButton.hidden = !signedIn;
    toggleClass(menuButton, "hidden", !signedIn);
    menuButton.setAttribute("aria-expanded", "false");
  }
  const overview = $('#nav [data-route="home"]');
  if (overview) { overview.hidden = signedIn; toggleClass(overview, "hidden", signedIn); }
  $$(".guest-only").forEach(function (button) {
    button.hidden = signedIn;
    toggleClass(button, "hidden", signedIn);
  });
}

const AuthUI = {
  init() {
    const users = Auth.users();
    const savedUsers = users.filter(function (user) { return user.id !== "u_demo"; });
    if (savedUsers.length !== users.length) Auth.saveUsers(savedUsers);
    const savedSession = Store.getJSON(CONFIG.keys.session, null);
    if (savedSession && savedSession.id === "u_demo") Store.remove(CONFIG.keys.session);

    on(byId("tabSignin"), "click", function () { switchAuthPanel("signin"); });
    on(byId("tabSignup"), "click", function () { switchAuthPanel("signup"); });
    on(byId("linkForgot"), "click", function () { switchAuthPanel("forgot"); });
    on(byId("linkBackSignin"), "click", function () { switchAuthPanel("signin"); });
    on(byId("authBackBtn"), "click", function () {
      App.intended = null;
      hideAuth();
      App.go("home");
    });
    on(byId("signInBtn"), "click", function () {
      showAuth(false);
      switchAuthPanel("signin");
    });
    on(byId("createAccountBtn"), "click", function () {
      showAuth(false);
      switchAuthPanel("signup");
    });
    $$("[data-auth]").forEach(function (button) {
      on(button, "click", function () {
        showAuth(false);
        switchAuthPanel(button.dataset.auth);
      });
    });

    /* password visibility toggles */
    $$(".pw-wrap .toggle").forEach(function (btn) {
      on(btn, "click", function () {
        const input = byId(btn.dataset.toggle);
        if (!input) return;
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.textContent = show ? "Hide" : "Show";
        btn.setAttribute("aria-label", (show ? "Hide" : "Show") + " password");
      });
    });

    /* password strength meter */
    on(byId("su_password"), "input", function (e) {
      const score = Auth.strength(e.target.value);
      const meter = byId("pwMeter");
      if (!meter) return;
      const widths = ["0%", "25%", "50%", "75%", "100%"];
      const colors = ["transparent", "#ef4444", "#eab308", "#22c55e", "#22c55e"];
      meter.style.width = widths[score];
      meter.style.background = colors[score];
      const f = byId("f_su_password");
      if (f && score >= 1) f.classList.remove("invalid");
    });

    /* clear field errors as the user types */
    ["si_email", "si_password", "su_name", "su_email", "su_password", "su_confirm", "fp_email"].forEach(function (id) {
      on(byId(id), "input", function () {
        const f = byId(id) ? byId(id).closest(".field") : null;
        if (f) f.classList.remove("invalid");
      });
    });

    /* ---------------- SIGN IN ---------------- */
    on(byId("panelSignin"), "submit", function (e) {
      e.preventDefault();
      const email = byId("si_email").value;
      const pw = byId("si_password").value;
      const remember = !!(byId("si_remember") && byId("si_remember").checked);

      let ok = Validator.field("f_si_email", Validator.email(email));
      ok = Validator.field("f_si_password", Validator.required(pw)) && ok;
      if (!ok) { toast("Check your details", "Please correct the highlighted fields.", "err"); return; }

      const btn = byId("si_submit");
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Signing in…';
      setTimeout(function () {
        const res = Auth.signin(email, pw, remember);
        btn.disabled = false;
        btn.textContent = "Sign in";
        if (!res.ok) {
          Validator.field("f_si_password", false);
          toast("Sign-in failed", res.message, "err");
          Log.warn("Sign-in rejected", { code: res.code });
          return;
        }
        hideAuth();
        applySession();
        const target = App.intended || "dashboard";
        App.intended = null;
        App.go(target);
        toast("Signed in", "Welcome back, " + res.user.name + ".", "ok");
      }, 450);
    });

    /* ---------------- SIGN UP ---------------- */
    on(byId("panelSignup"), "submit", function (e) {
      e.preventDefault();
      const name = byId("su_name").value;
      const email = byId("su_email").value;
      const pw = byId("su_password").value;
      const cf = byId("su_confirm").value;
      const terms = !!(byId("su_terms") && byId("su_terms").checked);

      let ok = Validator.field("f_su_name", Validator.name(name));
      ok = Validator.field("f_su_email", Validator.email(email)) && ok;
      ok = Validator.field("f_su_password", Validator.password(pw)) && ok;
      ok = Validator.field("f_su_confirm", Validator.match(pw, cf)) && ok;
      ok = Validator.field("f_su_terms", terms) && ok;
      if (!ok) { toast("Check the form", "Please correct the highlighted fields.", "err"); return; }

      const btn = byId("su_submit");
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Creating account…';
      setTimeout(function () {
        const res = Auth.signup(name, email, pw);
        btn.disabled = false;
        btn.textContent = "Create account";
        if (!res.ok) {
          if (res.code === "duplicate_email") Validator.field("f_su_email", false);
          toast("Could not create account", res.message, "err");
          return;
        }
        Auth.startSession(res.user, true);
        hideAuth();
        applySession();
        const target = App.intended || "dashboard";
        App.intended = null;
        App.go(target);
        toast("Account created", "You are now signed in as " + res.user.name + ".", "ok");
      }, 550);
    });

    /* ---------------- FORGOT PASSWORD ---------------- */
    on(byId("panelForgot"), "submit", function (e) {
      e.preventDefault();
      const email = byId("fp_email").value;
      if (!Validator.field("f_fp_email", Validator.email(email))) {
        toast("Invalid email", "Enter a valid email address.", "err");
        return;
      }
      const res = Auth.requestReset(email);
      openModal("Reset link sent (simulated)",
        res.exists
          ? "<p>A reset link was sent to <b>" + escapeHtml(email) + "</b>. In Demo Mode nothing leaves your browser.</p>" +
            "<p>Continue by signing in with your existing password.</p>"
          : "<p>No account exists for <b>" + escapeHtml(email) + "</b>. Create an account to continue.</p>",
        [{ label: "Got it", kind: "primary" }]);
      switchAuthPanel("signin");
    });

    /* ---------------- LOGOUT ---------------- */
    on(byId("logoutBtn"), "click", function () {
      confirmDialog("Sign out?",
        "<p>You will need to sign in again to reach the dashboard.</p>",
        "Sign out",
        function () {
          Auth.logout();
          Charts.destroyAll();
          App.intended = null;
          hideAuth();
          App.go("home");
          toast("Signed out", "See you soon.", "ok");
        }, true);
    });

    /* ---------------- SESSION RESTORE ---------------- */
    const s = Auth.restore();
    if (s) {
      applySession();
      hideAuth();
      App.go("dashboard");
    } else {
      hideAuth();
      App.go("home");
    }

    /* keep the chip in sync if a session changes elsewhere */
    Auth.onChange(function (session) { if (session) applySession(); });
  }
};

/* =============================================================================
   21. CHROME  (theme, sidebar, keyboard, responsive behaviour)
   ============================================================================= */
const Chrome = {
  init() {
    /* ---- theme ---- */
    const saved = Store.get(CONFIG.keys.theme) || "dark";
    document.documentElement.setAttribute("data-theme", saved);
    on(byId("themeBtn"), "click", function () {
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      Store.set(CONFIG.keys.theme, next);
      Charts.destroyAll();
      App.remount();
      if (App.route === "dashboard") Maps.invalidate();
      toast(next === "dark" ? "Dark theme" : "Light theme", "", "ok");
    });

    /* ---- mobile sidebar ---- */
    on(byId("menuBtn"), "click", function () {
      const sb = byId("sidebar");
      const open = !sb.classList.contains("open");
      sb.classList.toggle("open", open);
      byId("menuBtn").setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", function (e) {
      const sb = byId("sidebar");
      if (!sb || !sb.classList.contains("open")) return;
      if (sb.contains(e.target)) return;
      if (e.target.closest("#menuBtn")) return;
      sb.classList.remove("open");
      if (byId("menuBtn")) byId("menuBtn").setAttribute("aria-expanded", "false");
    });

    /* ---- navigation ---- */
    $$("#nav button").forEach(function (b) {
      on(b, "click", function () { App.go(b.dataset.route); });
    });
    $$("[data-route]").forEach(function (b) {
      if (b.closest("#nav")) return;
      on(b, "click", function () { App.go(b.dataset.route); });
    });

    /* ---- keyboard: Alt+1..7 routes, Esc closes, ? shows shortcuts ---- */
    document.addEventListener("keydown", function (e) {
      const tag = (e.target && e.target.tagName) || "";
      const typing = /INPUT|SELECT|TEXTAREA/.test(tag) || (e.target && e.target.isContentEditable);

      if (e.key === "Escape") {
        const modal = $(".modal-back");
        if (modal) return;                       // modal handles its own Escape
        if (byId("sidebar").classList.contains("open")) {
          byId("sidebar").classList.remove("open");
          byId("menuBtn").setAttribute("aria-expanded", "false");
        }
        return;
      }
      if (typing) return;
      if (e.altKey && /^[1-7]$/.test(e.key)) {
        const order = ["home", "dashboard", "prediction", "analytics", "alerts", "data", "docs"];
        const route = order[parseInt(e.key, 10) - 1];
        if (route) { e.preventDefault(); App.go(route); }
        return;
      }
      if (e.key === "?") { e.preventDefault(); Chrome.showShortcuts(); }
    });

    /* ---- responsive: charts + map on resize, viewport height fix ---- */
    const onResize = debounce(function () {
      Charts.resizeAll();
      Maps.invalidate();
      const narrow = window.innerWidth <= 900;
      if (narrow) {
        const cw = document.documentElement.clientWidth;
        document.documentElement.style.setProperty("--vh", window.innerHeight * 0.01 + "px");
        void cw;
      }
    }, 160);
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    onResize();

    /* mobile viewport height without the browser-chrome jump */
    try {
      const style = document.createElement("style");
      style.textContent = "@media (max-width:900px){#sidebar{height:calc(var(--vh, 1vh) * 100)}}";
      document.head.appendChild(style);
    } catch (e) {}

    /* ---- desktop-only breakpoint change: re-render charts at the new size ---- */
    if (window.matchMedia) {
      const mq = window.matchMedia("(max-width: 900px)");
      const handler = function () { setTimeout(function () { Charts.resizeAll(); Maps.invalidate(); }, 120); };
      if (mq.addEventListener) mq.addEventListener("change", handler);
      else if (mq.addListener) mq.addListener(handler);
    }

    /* ---- re-render charts when the tab becomes visible again ---- */
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) { Charts.resizeAll(); Maps.invalidate(); }
    });

    /* ---- global error safety net ---- */
    window.addEventListener("error", function (e) {
      Log.error("Unhandled error", e && e.message ? e.message : e);
    });
    window.addEventListener("unhandledrejection", function (e) {
      Log.error("Unhandled promise rejection", e && e.reason ? e.reason : e);
    });
  },

  showShortcuts() {
    openModal("Keyboard shortcuts",
      '<div class="endpoint"><span class="verb GET">Alt+1</span><code>Overview</code><span></span></div>' +
      '<div class="endpoint"><span class="verb GET">Alt+2</span><code>Dashboard</code><span></span></div>' +
      '<div class="endpoint"><span class="verb GET">Alt+3</span><code>Prediction</code><span></span></div>' +
      '<div class="endpoint"><span class="verb GET">Alt+4</span><code>Analytics</code><span></span></div>' +
      '<div class="endpoint"><span class="verb GET">Alt+5</span><code>Alerts</code><span></span></div>' +
      '<div class="endpoint"><span class="verb GET">Alt+6</span><code>Data</code><span></span></div>' +
      '<div class="endpoint"><span class="verb GET">Alt+7</span><code>Documentation</code><span></span></div>' +
      '<div class="endpoint"><span class="verb POST">Esc</span><code>Close dialog / sidebar</code><span></span></div>' +
      '<div class="endpoint"><span class="verb POST">?</span><code>This dialog</code><span></span></div>',
      [{ label: "Close", kind: "primary" }]);
  }
};

/* =============================================================================
   22. SELF TEST
   -----------------------------------------------------------------------------
   Validates authentication, validators, the data engine, the chronological
   split, the model, prediction bounds, CSV parsing and the alert lifecycle.
   Runs entirely against an in-memory store so it never touches real accounts.
   ============================================================================= */
const SelfTest = {
  results: [],

  assert(name, condition, detail) {
    this.results.push({ name: name, pass: !!condition, detail: detail === undefined ? "" : String(detail) });
    return !!condition;
  },

  run() {
    this.results = [];
    Log.info("Self-test started");

    /* ---------- password hashing ---------- */
    const h1 = Auth.hash("demo1234");
    const h2 = Auth.hash("demo1234");
    this.assert("hash is deterministic", h1 === h2, h1);
    this.assert("hash is 16 hex characters", /^[0-9a-f]{16}$/.test(h1), h1);
    this.assert("hash is case-sensitive", Auth.hash("Demo1234") !== h1);
    this.assert("different passwords differ", Auth.hash("demo12345") !== h1);

    /* ---------- strength scoring ---------- */
    this.assert("strength: short numeric password scores low", Auth.strength("1234567") <= 1, Auth.strength("1234567"));
    this.assert("strength: long mixed password scores high", Auth.strength("Flowcast#2026") === 4, Auth.strength("Flowcast#2026"));

    /* ---------- validators ---------- */
    this.assert("validator accepts a normal email", Validator.email("student@university.edu"));
    this.assert("validator rejects a malformed email", !Validator.email("student@university"));
    this.assert("validator rejects an empty email", !Validator.email(""));
    this.assert("validator rejects a 7-character password", !Validator.password("abc1234"));
    this.assert("validator accepts an 8-character password", Validator.password("abcd1234"));
    this.assert("validator rejects a 1-character name", !Validator.name("A"));
    this.assert("validator accepts a time value", Validator.time("08:30"));
    this.assert("validator rejects an out-of-range time", !Validator.time("25:99"));
    this.assert("validator accepts an ISO date", Validator.isoDate("2026-10-05"));
    this.assert("validator rejects a bad date", !Validator.isoDate("05/10/2026"));

    /* ---------- auth flows against an in-memory store ---------- */
    const previousSession = Auth.session;
    const previousMemory = Store.memory;
    const previousStoreMode = Store.forced;
    Store.memory = {};
    Store.useMemory();
    try {
      Auth.session = null;
      Store.remove(CONFIG.keys.users);
      Store.remove(CONFIG.keys.attempts);
      Store.remove(CONFIG.keys.session);
      const weak = Auth.signup("Ada Lovelace", "ada@uni.edu", "short");
      this.assert("weak password is rejected", weak.ok === false && weak.code === "weak_password", weak.code);

      const badEmail = Auth.signup("Ada Lovelace", "ada@uni", "Flowcast#2026");
      this.assert("invalid email is rejected", badEmail.ok === false && badEmail.code === "invalid_email", badEmail.code);

      const okSignup = Auth.signup("Ada Lovelace", "Ada@Uni.edu", "Flowcast#2026");
      this.assert("valid signup succeeds", okSignup.ok === true, okSignup.code || "ok");
      this.assert("email is normalised to lowercase", okSignup.ok && okSignup.user.email === "ada@uni.edu", okSignup.user && okSignup.user.email);
      this.assert("stored password is hashed, never plain", okSignup.ok && okSignup.user.password !== "Flowcast#2026" && okSignup.user.password.length === 16);

      const dup = Auth.signup("Someone Else", "ADA@UNI.EDU", "Flowcast#2026");
      this.assert("duplicate email is rejected", dup.ok === false && dup.code === "duplicate_email", dup.code);

      const wrongPw = Auth.signin("ada@uni.edu", "WrongPassword1", true);
      this.assert("wrong password is rejected", wrongPw.ok === false && wrongPw.code === "bad_password", wrongPw.code);

      const noAccount = Auth.signin("nobody@uni.edu", "Flowcast#2026", true);
      this.assert("unknown account is rejected", noAccount.ok === false && noAccount.code === "no_account", noAccount.code);

      const badFormat = Auth.signin("ada@uni", "Flowcast#2026", true);
      this.assert("malformed email blocks sign-in", badFormat.ok === false && badFormat.code === "invalid_email", badFormat.code);

      const good = Auth.signin("ada@uni.edu", "Flowcast#2026", true);
      this.assert("correct credentials sign in", good.ok === true, good.code || "ok");
      this.assert("session is created on sign-in", Auth.isAuthed() && !!Auth.session.token);
      this.assert("session carries an expiry", Auth.session.expires > Date.now());
      this.assert("successful sign-in clears failed attempts", Auth.attemptsFor("ada@uni.edu").count === 0);

      this.assert("session restores from storage", !!Auth.restore() && Auth.restore().email === "ada@uni.edu");

      /* lockout after repeated failures */
      for (let i = 0; i < CONFIG.maxLoginAttempts; i++) Auth.signin("ada@uni.edu", "nope", true);
      const locked = Auth.signin("ada@uni.edu", "Flowcast#2026", true);
      this.assert("lockout engages after repeated failures", locked.ok === false && locked.code === "locked", locked.code);
      Auth.clearFailures("ada@uni.edu");
      this.assert("clearing failures unlocks the account", Auth.lockedFor("ada@uni.edu") === 0);
      this.assert("correct password works again after unlock", Auth.signin("ada@uni.edu", "Flowcast#2026", true).ok === true);

      /* session persistence target + logout */
      Auth.startSession(Auth.find("ada@uni.edu"), false);
      this.assert("remember-me off uses session storage", !!Store.getSession(CONFIG.keys.session));
      Auth.startSession(Auth.find("ada@uni.edu"), true);
      this.assert("remember-me on uses local storage", !!Store.getLocal(CONFIG.keys.session));

      Auth.logout();
      this.assert("logout clears the session object", Auth.session === null);
      this.assert("logout clears persisted session", Store.get(CONFIG.keys.session) === null);
      this.assert("restore returns null after logout", Auth.restore() === null);

      /* expired session is refused */
      const fake = { id: "u_x", name: "X", email: "x@uni.edu", token: "demo.x", expires: Date.now() - 1000 };
      Store.setJSON(CONFIG.keys.session, fake, true);
      this.assert("expired session is refused", Auth.restore() === null);

      /* password reset flow */
      const resetKnown = Auth.requestReset("ada@uni.edu");
      const resetUnknown = Auth.requestReset("ghost@uni.edu");
      this.assert("reset reports an existing account", resetKnown.ok === true);
      this.assert("reset reports an unknown account", resetUnknown.ok === false);
      this.assert("reset rejects a malformed email", Auth.requestReset("nope").ok === false);
    } finally {
      Store.clearAll();
      Store.memory = previousMemory;
      Store.forced = previousStoreMode;
      Auth.session = previousSession;
      Auth.emit();
    }
    this.assert("self-test restores the active session", Auth.session === previousSession);
    this.assert("self-test restores the storage mode", Store.forced === previousStoreMode);

    /* ---------- demo data engine ---------- */
    const expected = ROADS.length * (CONFIG.days * 24 + 1);
    this.assert("demo dataset row count is exact", Demo.records.length === expected, Demo.records.length + " vs " + expected);
    this.assert("every record has a congestion label", Demo.records.every(function (r) { return CONFIG.levels.indexOf(r.congestion_level) !== -1; }));
    this.assert("labels follow the ratio thresholds",
      Demo.records.every(function (r) {
        return r.congestion_level === Demo.labelFor(r.speed_kmh, r.free_flow_kmh);
      }));
    this.assert("no speed exceeds free-flow speed", Demo.records.every(function (r) { return r.speed_kmh <= r.free_flow_kmh + 1e-9; }));
    this.assert("no speed is negative", Demo.records.every(function (r) { return r.speed_kmh > 0; }));
    this.assert("timestamps are chronological per road",
      Object.keys(Demo.byRoad).every(function (id) {
        const arr = Demo.byRoad[id];
        for (let i = 1; i < arr.length; i++) if (arr[i].timestamp < arr[i - 1].timestamp) return false;
        return true;
      }));
    this.assert("regeneration is reproducible",
      (function () {
        const before = Demo.records[100].speed_kmh;
        Demo.reseed(Demo.seed);
        const again = Demo.generate(Demo.seed)[100].speed_kmh;
        return before === again;
      })(), "seeded engine");

    /* ---------- chronological split ---------- */
    const built = ModelService.buildMatrix(Demo.records);
    const split = ModelService.chronologicalSplit(built.X.length);
    this.assert("split covers every row", split.train.length + split.val.length + split.test.length === built.X.length);
    this.assert("split is ordered train < val < test", split.trainEnd <= split.valEnd);
    this.assert("test rows come after training rows", split.test[0] > split.train[split.train.length - 1]);
    this.assert("feature rows are complete",
      built.X.every(function (row) { return row.length === ModelService.FEATURES.length && row.every(function (v) { return isFinite(v); }); }));
    this.assert("target length matches feature rows", built.y.length === built.X.length);

    /* ---------- model ---------- */
    const metrics = ModelService.fit(Demo.records, true);
    this.assert("model trains successfully", !!metrics, ModelService.error || "ok");
    this.assert("a model is selected", !!ModelService.chosen && !!ModelService.chosen.name, ModelService.chosen && ModelService.chosen.name);
    this.assert("selection follows validation RMSE",
      (function () {
        const b = ModelService.comparison.filter(function (c) { return !c.selected; })[0];
        const s = ModelService.comparison.filter(function (c) { return c.selected; })[0];
        if (!b || !s || b.valRmse == null || s.valRmse == null) return true;
        return s.valRmse <= b.valRmse + 1e-9;
      })());
    if (metrics) {
      this.assert("R² is within [-1, 1]", metrics.r2 >= -1 && metrics.r2 <= 1, metrics.r2);
      this.assert("MAE and RMSE are non-negative", metrics.mae >= 0 && metrics.rmse >= 0);
      this.assert("RMSE is at least MAE", metrics.rmse >= metrics.mae - 1e-9);
      this.assert("classification scores are within [0, 1]",
        metrics.accuracy >= 0 && metrics.accuracy <= 1 && metrics.precision <= 1 && metrics.recall <= 1 && metrics.f1 <= 1);
      this.assert("per-class metrics are reported", Array.isArray(metrics.per_class) && metrics.per_class.length === 4);
    }
    this.assert("feature importance sums to about 1",
      (function () { const s = sum(ModelService.importance.map(function (f) { return f.value; })); return Math.abs(s - 1) < 0.02; })(),
      sum(ModelService.importance.map(function (f) { return f.value; })).toFixed(3));

    /* ---------- prediction bounds and horizon behaviour ---------- */
    const base = { road_id: "R-02", date: fmtDate(new Date()), time: "08:30", weather: "clear", dow: 1, event_flag: false, horizon_min: 60 };
    const p60 = ModelService.predictForm(base);
    this.assert("prediction returns a valid level", CONFIG.levels.indexOf(p60.predicted_congestion) !== -1, p60.predicted_congestion);
    this.assert("level matches the threshold function", p60.predicted_congestion === Demo.labelFor(p60.expected_speed_kmh, p60.free_flow_kmh));
    this.assert("probability is within [0, 1]", p60.probability >= 0 && p60.probability <= 1, p60.probability);
    this.assert("confidence is within [0, 1]", p60.confidence >= 0 && p60.confidence <= 1, p60.confidence);
    this.assert("expected speed is positive and within free-flow", p60.expected_speed_kmh > 0 && p60.expected_speed_kmh <= p60.free_flow_kmh);
    this.assert("model version is reported", !!p60.model, p60.model);
    this.assert("an explanation is produced", Array.isArray(p60.explanation) && p60.explanation.length >= 3, p60.explanation.length + " lines");
    this.assert("data timestamp is reported", !!p60.data_timestamp);

    const pHorizons = HORIZONS.map(function (h) { return ModelService.predictForm(Object.assign({}, base, { horizon_min: h.value })); });
    this.assert("all six horizons return a forecast", pHorizons.length === 6 && pHorizons.every(function (p) { return !!p.predicted_congestion; }));
    this.assert("confidence does not increase with horizon",
      pHorizons[pHorizons.length - 1].confidence <= pHorizons[0].confidence + 1e-9,
      fmtNum(pHorizons[0].confidence, 2) + " → " + fmtNum(pHorizons[pHorizons.length - 1].confidence, 2));
    this.assert("uncertainty grows with horizon",
      pHorizons[pHorizons.length - 1].uncertainty_kmh >= pHorizons[0].uncertainty_kmh,
      fmtNum(pHorizons[0].uncertainty_kmh, 1) + " → " + fmtNum(pHorizons[pHorizons.length - 1].uncertainty_kmh, 1));

    const severe = ModelService.predictForm(Object.assign({}, base, { time: "08:00", weather: "heavy_rain", event_flag: true, dow: 1 }));
    const clear = ModelService.predictForm(Object.assign({}, base, { time: "03:00", weather: "clear", event_flag: false, dow: 0 }));
    this.assert("weather and event context raise predicted congestion",
      severe.congestion_index >= clear.congestion_index,
      fmtNum(clear.congestion_index, 2) + " → " + fmtNum(severe.congestion_index, 2));

    /* ---------- analytics ---------- */
    const trends = Analytics.computeTrends();
    this.assert("daily trend has one point per day", trends.daily.labels.length === CONFIG.days + 1, trends.daily.labels.length);
    this.assert("hourly profile has 24 buckets", trends.hourly.values.length === 24);
    this.assert("weekly profile has 7 buckets", trends.weekly.values.length === 7);
    this.assert("hotspot ranking covers every road", trends.hotspots.length === ROADS.length);
    this.assert("hotspot ranking is sorted descending",
      trends.hotspots.every(function (h, i) { return i === 0 || trends.hotspots[i - 1].index >= h.index; }));
    this.assert("correlations are within [-1, 1]", ModelService.correlations.every(function (c) { return Math.abs(c.r) <= 1.0000001; }));

    /* ---------- CSV parsing and validation ---------- */
    const csv = "timestamp,road_id,speed_kmh,traffic_volume,occupancy\n" +
                "2026-10-04T08:00:00,R-01,42.5,1500,62\n" +
                "2026-10-04T08:00:00,R-01,42.5,1500,62\n" +
                '"2026-10-04T09:00:00","R-02","31.0","1800","71"\n' +
                "2026-10-04T10:00:00,R-03,,900,40\n";
    const parsed = DataView.parseCSV(csv);
    this.assert("CSV parser reads all rows", parsed.rows.length === 4, parsed.rows.length);
    this.assert("CSV parser reads headers", parsed.headers.length === 5 && parsed.headers[0] === "timestamp");
    this.assert("CSV parser handles quoted fields", parsed.rows[2].speed_kmh === "31.0", parsed.rows[2].speed_kmh);
    const csvVal = DataView.validate(parsed);
    this.assert("CSV validation detects the duplicate row", csvVal.duplicates === 1, csvVal.duplicates);
    this.assert("CSV validation detects the missing value", csvVal.missingVals === 1, csvVal.missingVals);
    const missingCol = DataView.validate(DataView.parseCSV("timestamp,road_id\n2026-10-04T08:00:00,R-01\n"));
    this.assert("CSV validation flags missing required columns", missingCol.missingCols.indexOf("speed_kmh") !== -1 && missingCol.ok === false);
    this.assert("filename sanitisation strips paths and unsafe characters",
      sanitizeFilename("../../etc/pa ss wd.csv") === "pa_ss_wd.csv", sanitizeFilename("../../etc/pa ss wd.csv"));
    this.assert("HTML escaping neutralises script tags",
      escapeHtml("<img src=x onerror=alert(1)>").indexOf("<") === -1, escapeHtml("<img src=x>"));
    this.assert("CSV export round-trips a comma-containing value",
      toCSV([{ a: 'x,y' }], ["a"]) === 'a\n"x,y"', toCSV([{ a: "x,y" }], ["a"]));

    /* ---------- alerts ---------- */
    const before = App.alerts.length;
    const a = Alerts.add("test", "R-01", "Self-test alert", "open");
    this.assert("alert is added", App.alerts.length === before + 1);
    this.assert("alert counts include the new alert", Alerts.counts().open >= 1);
    a.status = "resolved";
    this.assert("alert can be resolved", Alerts.counts().resolved >= 1);
    App.alerts = App.alerts.filter(function (x) { return x.id !== a.id; });

    /* ---------- config sanity ---------- */
    this.assert("API base is configurable", typeof CONFIG.apiBase === "string" && CONFIG.apiBase.length > 0, CONFIG.apiBase);
    this.assert("thresholds are ordered", CONFIG.thresholds.low > CONFIG.thresholds.moderate && CONFIG.thresholds.moderate > CONFIG.thresholds.high);
    this.assert("every route has a title", ["home", "dashboard", "prediction", "analytics", "alerts", "data", "docs"]
      .every(function (r) { return !!App.titles[r]; }));
    this.assert("monitored streets are in Calabar", ROADS.some(function (r) { return r.name.indexOf("Marian Road") === 0; }) &&
      ROADS.some(function (r) { return r.name.indexOf("Ekpo Abasi Street") === 0; }) &&
      ROADS.every(function (r) { return r.lat > 4.9 && r.lat < 5.1 && r.lng > 8.2 && r.lng < 8.5; }));
    this.assert("demo sign-in button has been removed", !exists("btnDemo"));
    this.assert("map is centred on Calabar", CALABAR_CENTER[0] > 4.9 && CALABAR_CENTER[0] < 5.1 &&
      CALABAR_CENTER[1] > 8.2 && CALABAR_CENTER[1] < 8.5, CALABAR_CENTER.join(", "));

    const passed = this.results.filter(function (r) { return r.pass; }).length;
    const failed = this.results.length - passed;
    Log.info("Self-test complete", { passed: passed, failed: failed, total: this.results.length });
    this.report(passed, failed);
    return { passed: passed, failed: failed, total: this.results.length, results: this.results };
  },

  report(passed, failed) {
    const host = byId("selftestPanel");
    if (host) {
      host.innerHTML =
        '<div class="notice' + (failed ? " warn" : "") + '"><b>' + passed + " passed · " + failed + " failed</b> of " +
        this.results.length + " checks.</div>" +
        '<div class="table-wrap"><table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>' +
        this.results.map(function (r) {
          return "<tr><td>" + escapeHtml(r.name) + '</td><td><span class="pill ' + (r.pass ? "LOW" : "SEVERE") + '">' +
            (r.pass ? "pass" : "fail") + "</span></td><td>" + escapeHtml(r.detail) + "</td></tr>";
        }).join("") +
        "</tbody></table></div>";
    }
    if (console.table) {
      try { console.table(this.results.map(function (r) { return { check: r.name, result: r.pass ? "pass" : "FAIL", detail: r.detail }; })); } catch (e) {}
    }
    if (failed) Log.warn(failed + " self-test check(s) failed");
    else Log.info("All " + passed + " self-test checks passed");
  }
};

/* =============================================================================
   23. BOOT
   ============================================================================= */
function renderHomeStats() {
  setText(byId("homeRoads"), fmtInt(ROADS.length));
  setText(byId("homeRecords"), fmtInt(Demo.records.length));
  setText(byId("homeDays"), String(CONFIG.days));
}

async function boot() {
  try {
    App.init();
    Demo.generate();

    /* train the model before the first view mounts so metrics are ready */
    ModelService.fit(Demo.records);

    Chrome.init();
    Dashboard.init();
    Prediction.init();
    Alerts.init();
    DataView.init();

    Alerts.seed();
    renderHomeStats();

    await DataSource.init();
    const modeEl = byId("modeBadge");
    if (modeEl && DataSource.mode === "api") {
      modeEl.textContent = "● LIVE API";
      modeEl.style.background = "rgba(34,197,94,.14)";
      modeEl.style.borderColor = "rgba(34,197,94,.42)";
      modeEl.style.color = "#86efac";
    }

    AuthUI.init();
    Landing.render();

    /* optional self-test: ?selftest=1 */
    const params = new URLSearchParams(window.location.search);
    if (params.get("selftest") === "1") {
      const res = SelfTest.run();
      if (!byId("selftestPanel")) {
        toast("Self-test: " + res.passed + " passed", res.failed ? res.failed + " failed — see the console." : "All checks passed.", res.failed ? "err" : "ok", 7000);
      }
    }

    /* periodic refresh of relative timestamps while the alerts view is open */
    setInterval(function () {
      if (App.route === "alerts") Alerts.render();
    }, 30000);

    App.ready = true;
    Log.info("FlowCast ready", {
      version: CONFIG.version,
      mode: DataSource.mode,
      records: Demo.records.length,
      model: ModelService.chosen ? ModelService.chosen.name : "none"
    });
  } catch (err) {
    Log.error("Boot failed", err);
    toast("Startup problem", "Some features may be unavailable. See the console for details.", "err", 8000);
  }
}

/* Public surface for the console and for tests */
window.FlowCast = {
  version: CONFIG.version,
  config: CONFIG,
  roads: ROADS,
  app: App,
  auth: Auth,
  demo: Demo,
  ml: ModelService,
  data: DataView,
  analytics: Analytics,
  alerts: Alerts,
  charts: Charts,
  maps: Maps,
  api: Api,
  source: DataSource,
  log: Log,
  validator: Validator,
  test: function () { return SelfTest.run(); },
  shortcuts: function () { Chrome.showShortcuts(); },
  exportAll: function () {
    download("flowcast-raw.csv", toCSV(Demo.records, DataView.RAW_HEADERS));
    download("flowcast-processed.csv", toCSV(Demo.records, DataView.PROCESSED_HEADERS));
    if (App.metrics) {
      download("flowcast-metrics.csv", toCSV(
        Object.keys(App.metrics).filter(function (k) { return typeof App.metrics[k] !== "object"; })
          .map(function (k) { return { metric: k, value: App.metrics[k] }; }), ["metric", "value"]));
    }
    if (App.alerts.length) {
      download("flowcast-alerts.csv", toCSV(App.alerts, ["raised", "type", "road_id", "message", "status"]));
    }
    toast("Export complete", "Datasets, metrics and alerts downloaded.", "ok");
  }
};

/* Deferred scripts run before DOMContentLoaded, so either path is safe */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

})();