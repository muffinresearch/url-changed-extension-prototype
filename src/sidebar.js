// sidebar.js — active tab (current window), Live→Synced badge, yellow flash, Origin above Core URL

const fields = {
  tabTitle: document.getElementById("tabTitle"),
  liveBadge: document.getElementById("liveBadge"),
  resetBtn: document.getElementById("reset"),

  // counters
  all: document.getElementById("all"),
  full: document.getElementById("full"),
  spa: document.getElementById("spa"),
  path: document.getElementById("path"),
  query: document.getElementById("query"),
  frag: document.getElementById("frag"),

  // metadata (origin first)
  coreOrigin: document.getElementById("coreOrigin"),
  coreUrl: document.getElementById("coreUrl"),
  coreCount: document.getElementById("coreCount"),
  canonUrl: document.getElementById("canonUrl"),
  canonCount: document.getElementById("canonCount"),
  ogUrl: document.getElementById("ogUrl"),
  ogCount: document.getElementById("ogCount"),
  jsonId: document.getElementById("jsonId"),
  jsonCount: document.getElementById("jsonCount"),
};

let selectedTabId = null;
const MIN_LIVE_MS = 500;
let liveShownAt = 0;
let flipTimer = null;

function clearFlipTimer() { if (flipTimer) { clearTimeout(flipTimer); flipTimer = null; } }

/* ---------------- Flash helpers ---------------- */

/** Set textContent and add a subtle yellow fade if it changed */
function setTextWithFlash(el, nextText) {
  const prev = el.textContent ?? "";
  const text = nextText == null ? "" : String(nextText);
  if (prev === text) return;
  el.textContent = text;
  el.classList.remove("flash");
  void el.offsetWidth; // restart animation
  el.classList.add("flash");
}
function multiFlash(pairs) { for (const [el, val] of pairs) setTextWithFlash(el, val); }

/* ---------------- Badge helpers ---------------- */

function showLiveBadge() {
  fields.liveBadge.textContent = "Live";
  fields.liveBadge.classList.remove("synced");
  fields.liveBadge.hidden = false;
  liveShownAt = Date.now();
  clearFlipTimer();
}
function showSyncedBadge() {
  fields.liveBadge.textContent = "Synced";
  fields.liveBadge.classList.add("synced");
  fields.liveBadge.hidden = false;
  clearFlipTimer();
}

/* ---------------- Rendering ---------------- */

function renderCounters(counts) {
  const { totals = {}, dims = {} } = counts || {};
  multiFlash([
    [fields.all, totals.all ?? 0],
    [fields.full, totals.full ?? 0],
    [fields.spa, totals.spa ?? 0],
    [fields.path, dims.path ?? 0],
    [fields.query, dims.query ?? 0],
    [fields.frag, dims.fragment ?? 0],
  ]);
}

function renderMetadata({ url, origin, counts, ids }) {
  setTextWithFlash(fields.coreOrigin, origin || "(none)");
  setTextWithFlash(fields.coreUrl, url || "(none)");

  // Core count is equal to Total
  setTextWithFlash(fields.coreCount, counts?.totals?.all ?? 0);

  const canonical = ids?.canonical || "(none)";
  const ogUrl     = ids?.ogUrl     || "(none)";
  const jsonId    = ids?.jsonLdId  || "(none)";
  const idCounts  = counts?.ids || {};

  multiFlash([
    [fields.canonUrl, canonical],
    [fields.ogUrl, ogUrl],
    [fields.jsonId, jsonId],
    [fields.canonCount, idCounts.canonical ?? 0],
    [fields.ogCount, idCounts.ogUrl ?? 0],
    [fields.jsonCount, idCounts.jsonLdId ?? 0],
  ]);
}

function renderSnapshot(snap) {
  renderCounters(snap.counts);
  renderMetadata(snap);
}

function formatTitle(tab) {
  const t = (tab.title || "").trim();
  if (t) return t;
  const u = tab.url || "";
  try {
    const p = new URL(u);
    if (p.protocol === "about:" || p.protocol === "moz-extension:" || p.protocol === "chrome:") {
      return `${p.protocol}${p.pathname || ""}`;
    }
    return p.host || u;
  } catch { return u || "(current tab)"; }
}

async function showLiveForActiveTab() {
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!active) return;
  selectedTabId = active.id;

  setTextWithFlash(fields.tabTitle, formatTitle(active));
  setTextWithFlash(fields.coreUrl, active.url || "(none)");
  try {
    setTextWithFlash(
      fields.coreOrigin,
      active.url && active.url.startsWith("http") ? new URL(active.url).origin : "(none)"
    );
  } catch { setTextWithFlash(fields.coreOrigin, "(none)"); }

  showLiveBadge();
  browser.runtime.sendMessage({ type: "get-state", tabId: selectedTabId }).catch(() => {});
}

/* ---------------- Events ---------------- */

fields.resetBtn.addEventListener("click", async () => {
  const tabId = selectedTabId;
  if (!Number.isFinite(tabId)) return;

  // Optimistic zeroing (counters)
  multiFlash([
    [fields.all, 0], [fields.full, 0], [fields.spa, 0],
    [fields.path, 0], [fields.query, 0], [fields.frag, 0],
  ]);
  // Optimistic metadata reset (keep core URL/origin from live tab, clear derived IDs)
  multiFlash([
    [fields.canonUrl, "(none)"], [fields.ogUrl, "(none)"], [fields.jsonId, "(none)"],
    [fields.canonCount, 0], [fields.ogCount, 0], [fields.jsonCount, 0],
  ]);

  try { await browser.runtime.sendMessage({ type: "manual-reset", tabId }); } catch {}
  browser.runtime.sendMessage({ type: "get-state", tabId }).catch(() => {});
});

// Render and flip to Synced after a minimum Live duration
browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "url-change-state" || msg.tabId !== selectedTabId) return;

  const elapsed = Date.now() - liveShownAt;
  const doRender = () => { renderSnapshot(msg); showSyncedBadge(); };

  if (elapsed >= MIN_LIVE_MS) doRender();
  else { clearFlipTimer(); flipTimer = setTimeout(doRender, MIN_LIVE_MS - elapsed); }
});

// Follow active tab within the current window
browser.tabs.onActivated.addListener(async () => { await showLiveForActiveTab(); });

// Keep title/url fresh and re-sync on change
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== selectedTabId) return;

  if (changeInfo.title) setTextWithFlash(fields.tabTitle, formatTitle(tab));
  if (changeInfo.url) {
    setTextWithFlash(fields.coreUrl, changeInfo.url || "(none)");
    try {
      setTextWithFlash(fields.coreOrigin,
        changeInfo.url && changeInfo.url.startsWith("http") ? new URL(changeInfo.url).origin : "(none)"
      );
    } catch { setTextWithFlash(fields.coreOrigin, "(none)"); }
    showLiveBadge();
    browser.runtime.sendMessage({ type: "get-state", tabId }).catch(() => {});
  }
});

// Keep in step with window focus
browser.windows.onFocusChanged.addListener(async () => { await showLiveForActiveTab(); });

// Initial boot
(async function init() { await showLiveForActiveTab(); })();

