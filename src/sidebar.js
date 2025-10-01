// sidebar.js — no flicker when tracking is off; restrained flashing; focus-change guarded

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
  coreCount: document.getElementById("coreCount"), // if present
  canonUrl: document.getElementById("canonUrl"),
  canonCount: document.getElementById("canonCount"),
  ogUrl: document.getElementById("ogUrl"),
  ogCount: document.getElementById("ogCount"),
  jsonId: document.getElementById("jsonId"),
  jsonCount: document.getElementById("jsonCount"),

  // opt-in tracking
  trackToggle: document.getElementById("trackToggle"),
  trackStatus: document.getElementById("trackStatus"),
};

let selectedTabId = null;
let currentTrackingEnabled = null; // null=unknown, true/false=known
const MIN_LIVE_MS = 500;
let liveShownAt = 0;
let flipTimer = null;
let lastFocusedWindowId = null;

/* ---------------- Utility: stable sets with optional flash ---------------- */

function setText(el, text) {
  const next = text == null ? "" : String(text);
  if ((el.textContent ?? "") === next) return false;
  el.textContent = next;
  return true;
}

function setTextWithFlash(el, text, { flash = true } = {}) {
  const changed = setText(el, text);
  if (!changed || !flash) return;
  el.classList.remove("flash");
  void el.offsetWidth; // restart animation
  el.classList.add("flash");
}

function multiSet(pairs, { flash = true } = {}) {
  for (const [el, val] of pairs) setTextWithFlash(el, val, { flash });
}

/* ---------------- Badge helpers ---------------- */

function showLiveBadge() {
  fields.liveBadge.textContent = "Live";
  fields.liveBadge.classList.remove("synced");
  fields.liveBadge.hidden = false;
  liveShownAt = Date.now();
  if (flipTimer) { clearTimeout(flipTimer); flipTimer = null; }
}
function showSyncedBadge() {
  fields.liveBadge.textContent = "Synced";
  fields.liveBadge.classList.add("synced");
  fields.liveBadge.hidden = false;
  if (flipTimer) { clearTimeout(flipTimer); flipTimer = null; }
}

/* ---------------- Renderers ---------------- */

function renderCounters(counts) {
  const { totals = {}, dims = {} } = counts || {};
  // If tracking is off, show dashes but don't flash
  if (currentTrackingEnabled === false) {
    multiSet([
      [fields.all, "—"], [fields.full, "—"], [fields.spa, "—"],
      [fields.path, "—"], [fields.query, "—"], [fields.frag, "—"],
    ], { flash: false });
    return;
  }
  multiSet([
    [fields.all, totals.all ?? 0],
    [fields.full, totals.full ?? 0],
    [fields.spa, totals.spa ?? 0],
    [fields.path, dims.path ?? 0],
    [fields.query, dims.query ?? 0],
    [fields.frag, dims.fragment ?? 0],
  ]);
}

function renderMetadataTrackingOn({ url, origin, counts, ids }) {
  // origin + core URL + core count
  setTextWithFlash(fields.coreOrigin, origin || "(none)");
  setTextWithFlash(fields.coreUrl, url || "(none)");
  if (fields.coreCount) setTextWithFlash(fields.coreCount, counts?.totals?.all ?? 0);

  // derived IDs
  const canonical = ids?.canonical || "(none)";
  const ogUrl     = ids?.ogUrl     || "(none)";
  const jsonId    = ids?.jsonLdId  || "(none)";
  const idCounts  = counts?.ids || {};

  multiSet([
    [fields.canonUrl, canonical],
    [fields.ogUrl, ogUrl],
    [fields.jsonId, jsonId],
    [fields.canonCount, idCounts.canonical ?? 0],
    [fields.ogCount,    idCounts.ogUrl ?? 0],
    [fields.jsonCount,  idCounts.jsonLdId ?? 0],
  ]);
}

function renderMetadataTrackingOff(origin) {
  // Always show origin, no flash
  setTextWithFlash(fields.coreOrigin, origin || "(none)", { flash: false });

  // Everything else is suppressed; write placeholders with no flash
  const off = "(tracking off)";
  const dash = "—";
  multiSet([
    [fields.coreUrl, off],
    [fields.canonUrl, off],
    [fields.ogUrl, off],
    [fields.jsonId, off],
  ], { flash: false });

  if (fields.coreCount) setTextWithFlash(fields.coreCount, dash, { flash: false });
  multiSet([
    [fields.canonCount, dash],
    [fields.ogCount, dash],
    [fields.jsonCount, dash],
  ], { flash: false });
}

function renderSnapshot(snap) {
  // Tracking toggle state
  currentTrackingEnabled = !!snap.trackingEnabled;
  fields.trackToggle && (fields.trackToggle.checked = currentTrackingEnabled);
  fields.trackStatus && setText(fields.trackStatus, currentTrackingEnabled ? "On" : "Off");

  // Counters first (they know how to handle tracking off)
  renderCounters(snap.counts);

  // Metadata based on tracking
  if (currentTrackingEnabled) {
    renderMetadataTrackingOn(snap);
  } else {
    renderMetadataTrackingOff(snap.origin);
  }
}

/* ---------------- Live fetch for active tab ---------------- */

function formatTitle(tab) {
  const t = (tab.title || "").trim();
  if (t) return t;
  const u = tab.url || "";
  try {
    const p = new URL(u);
    if (["about:", "moz-extension:", "chrome:"].includes(p.protocol)) {
      return `${p.protocol}${p.pathname || ""}`;
    }
    return p.host || u;
  } catch { return u || "(current tab)"; }
}

async function showLiveForActiveTab({ optimistic = true } = {}) {
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!active) return;
  selectedTabId = active.id;

  // Title always safe to set
  setTextWithFlash(fields.tabTitle, formatTitle(active), { flash: false });

  // Always set Origin immediately so user knows context
  let origin = "(none)";
  try {
    origin = (active.url && active.url.startsWith("http")) ? new URL(active.url).origin : "(none)";
  } catch {}
  setTextWithFlash(fields.coreOrigin, origin, { flash: false });

  // If we don't yet know trackingEnabled for this tab, DO NOT write URLs.
  // Show stable placeholders to avoid flicker.
  if (currentTrackingEnabled === null || optimistic === false) {
    multiSet([
      [fields.coreUrl, "(loading…)"],
      [fields.canonUrl, "(loading…)"],
      [fields.ogUrl, "(loading…)"],
      [fields.jsonId, "(loading…)"],
    ], { flash: false });

    const dash = "—";
    if (fields.coreCount) setTextWithFlash(fields.coreCount, dash, { flash: false });
    multiSet([[fields.canonCount, dash], [fields.ogCount, dash], [fields.jsonCount, dash]], { flash: false });
  }

  // Ask background for the canonical snapshot; badge lives as before
  showLiveBadge();
  browser.runtime.sendMessage({ type: "get-state", tabId: selectedTabId }).catch(() => {});
}

/* ---------------- Events ---------------- */

fields.resetBtn?.addEventListener("click", async () => {
  const tabId = selectedTabId;
  if (!Number.isFinite(tabId)) return;

  // Optimistic clear — but do not flash
  multiSet([
    [fields.all, 0], [fields.full, 0], [fields.spa, 0],
    [fields.path, 0], [fields.query, 0], [fields.frag, 0],
  ], { flash: false });

  // Clear derived IDs immediately; core URLs will be re-written by snapshot
  const dash = "—";
  multiSet([
    [fields.canonUrl, "(loading…)"],
    [fields.ogUrl, "(loading…)"],
    [fields.jsonId, "(loading…)"],
    [fields.canonCount, 0],
    [fields.ogCount, 0],
    [fields.jsonCount, 0],
  ], { flash: false });
  if (fields.coreCount) setTextWithFlash(fields.coreCount, 0, { flash: false });

  try { await browser.runtime.sendMessage({ type: "manual-reset", tabId }); } catch {}
  browser.runtime.sendMessage({ type: "get-state", tabId }).catch(() => {});
});

// Background broadcasts: render and flip to Synced after a minimum Live duration
browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "url-change-state" || msg.tabId !== selectedTabId) return;

  const elapsed = Date.now() - liveShownAt;
  const doRender = () => { renderSnapshot(msg); showSyncedBadge(); };

  if (elapsed >= MIN_LIVE_MS) doRender();
  else {
    if (flipTimer) clearTimeout(flipTimer);
    flipTimer = setTimeout(doRender, MIN_LIVE_MS - elapsed);
  }
});

// Follow active tab within the current window
browser.tabs.onActivated.addListener(async () => {
  // Unknown tracking state until snapshot arrives for the newly activated tab
  currentTrackingEnabled = null;
  await showLiveForActiveTab({ optimistic: false });
});

// Guarded window focus change: only react if active tab changed or tracking unknown
browser.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return; // sidebar focus, etc.
  if (lastFocusedWindowId === windowId && currentTrackingEnabled !== null) return;
  lastFocusedWindowId = windowId;

  // Snap to the active tab in the focused window
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!active) return;
  if (selectedTabId === active.id && currentTrackingEnabled !== null) return;

  currentTrackingEnabled = null;
  await showLiveForActiveTab({ optimistic: false });
});

// Keep title fresh and re-sync on URL change for the active tab
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== selectedTabId) return;

  if (changeInfo.title) setText(fields.tabTitle, formatTitle(tab));

  if (changeInfo.url) {
    // Always update origin non-flashing
    try {
      const o = changeInfo.url.startsWith("http") ? new URL(changeInfo.url).origin : "(none)";
      setTextWithFlash(fields.coreOrigin, o, { flash: false });
    } catch { setTextWithFlash(fields.coreOrigin, "(none)", { flash: false }); }

    // Only write the Core URL immediately if we already know tracking is ON.
    if (currentTrackingEnabled === true) {
      setTextWithFlash(fields.coreUrl, changeInfo.url);
    } else {
      setTextWithFlash(fields.coreUrl, "(loading…)", { flash: false });
    }

    showLiveBadge();
    browser.runtime.sendMessage({ type: "get-state", tabId }).catch(() => {});
  }
});

/* Tracking toggle */
fields.trackToggle?.addEventListener("change", () => {
  const originText = fields.coreOrigin.textContent || "";
  const origin = originText.startsWith("http") ? originText : "";
  if (!origin) return;
  const enabled = !!fields.trackToggle.checked;
  // Immediately reflect status text without flash; values will follow via snapshot
  fields.trackStatus && setText(fields.trackStatus, enabled ? "On" : "Off");
  currentTrackingEnabled = null; // force placeholders until snapshot reflects new state
  browser.runtime.sendMessage({ type: "set-tracking", origin, enabled }).catch(() => {});
  browser.runtime.sendMessage({ type: "get-state" }).catch(() => {});
});

// Initial boot
(async function init() {
  await showLiveForActiveTab({ optimistic: false });
})();

