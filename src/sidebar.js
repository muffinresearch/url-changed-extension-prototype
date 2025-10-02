// sidebar.js — requests host permission on "On", revokes it on "Off".
// Also handles unsupported pages, yellow flash, and tracking-aware rendering.

const fields = {
  tabTitle: document.getElementById("tabTitle"),
  liveBadge: document.getElementById("liveBadge"),
  resetBtn: document.getElementById("reset"),

  all: document.getElementById("all"),
  full: document.getElementById("full"),
  spa: document.getElementById("spa"),
  path: document.getElementById("path"),
  query: document.getElementById("query"),
  frag: document.getElementById("frag"),

  coreOrigin: document.getElementById("coreOrigin"),
  coreUrl: document.getElementById("coreUrl"),
  coreCount: document.getElementById("coreCount"),
  canonUrl: document.getElementById("canonUrl"),
  canonCount: document.getElementById("canonCount"),
  ogUrl: document.getElementById("ogUrl"),
  ogCount: document.getElementById("ogCount"),
  jsonId: document.getElementById("jsonId"),
  jsonCount: document.getElementById("jsonCount"),

  trackToggle: document.getElementById("trackToggle"),
  trackStatus: document.getElementById("trackStatus"),
};

let selectedTabId = null;
let currentTrackingEnabled = null; // null=unknown
const MIN_LIVE_MS = 500;
let liveShownAt = 0;
let flipTimer = null;
let lastFocusedWindowId = null;
let lastKnownProtocol = null;

/* ---------------- Utilities ---------------- */

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
  void el.offsetWidth;
  el.classList.add("flash");
}
function multiSet(pairs, { flash = true } = {}) {
  for (const [el, val] of pairs) setTextWithFlash(el, val, { flash });
}
function isHttpOriginText(s) { return typeof s === "string" && /^https?:\/\/[^/]+$/.test(s); }
function protocolOf(url) { try { return new URL(url).protocol; } catch { return ""; } }
function isSupportedProtocol(proto) { return proto === "http:" || proto === "https:"; }
function patternForOriginText(originText) { try { const u = new URL(originText); return `${u.protocol}//${u.host}/*`; } catch { return null; } }

/* ---------------- Badge ---------------- */

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
function hideBadge() {
  fields.liveBadge.hidden = true;
  if (flipTimer) { clearTimeout(flipTimer); flipTimer = null; }
}

/* ---------------- Unsupported-page mode ---------------- */

function applyUnavailableUI(originText, reason = "(unavailable here)") {
  if (fields.trackToggle) { fields.trackToggle.disabled = true; fields.trackToggle.checked = false; }
  if (fields.trackStatus) setText(fields.trackStatus, "Off");
  if (fields.resetBtn) fields.resetBtn.disabled = true;

  setTextWithFlash(fields.coreOrigin, originText || "(none)", { flash: false });

  const dash = "—";
  multiSet([[fields.all, dash], [fields.full, dash], [fields.spa, dash], [fields.path, dash], [fields.query, dash], [fields.frag, dash]], { flash: false });

  const unavailable = reason;
  multiSet([[fields.coreUrl, unavailable], [fields.canonUrl, unavailable], [fields.ogUrl, unavailable], [fields.jsonId, unavailable]], { flash: false });

  if (fields.coreCount) setTextWithFlash(fields.coreCount, dash, { flash: false });
  multiSet([[fields.canonCount, dash], [fields.ogCount, dash], [fields.jsonCount, dash]], { flash: false });

  hideBadge();
}

function clearUnavailableUI() {
  if (fields.resetBtn) fields.resetBtn.disabled = false;
}

/* ---------------- Rendering (supported pages) ---------------- */

function renderCounters(counts) {
  const { totals = {}, dims = {} } = counts || {};
  if (currentTrackingEnabled === false) {
    multiSet([[fields.all, "—"], [fields.full, "—"], [fields.spa, "—"], [fields.path, "—"], [fields.query, "—"], [fields.frag, "—"]], { flash: false });
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
  setTextWithFlash(fields.coreOrigin, origin || "(none)");
  setTextWithFlash(fields.coreUrl, url || "(none)");
  if (fields.coreCount) setTextWithFlash(fields.coreCount, counts?.totals?.all ?? 0);

  const canonical = ids?.canonical || "(none)";
  const ogUrl     = ids?.ogUrl     || "(none)";
  const jsonId    = ids?.jsonLdId  || "(none)";
  const idCounts  = counts?.ids || {};

  multiSet([[fields.canonUrl, canonical], [fields.ogUrl, ogUrl], [fields.jsonId, jsonId]]);
  multiSet([[fields.canonCount, idCounts.canonical ?? 0], [fields.ogCount, idCounts.ogUrl ?? 0], [fields.jsonCount, idCounts.jsonLdId ?? 0]]);
}

function renderMetadataTrackingOff(origin) {
  setTextWithFlash(fields.coreOrigin, origin || "(none)", { flash: false });
  const off = "(tracking off)";
  const dash = "—";
  multiSet([[fields.coreUrl, off], [fields.canonUrl, off], [fields.ogUrl, off], [fields.jsonId, off]], { flash: false });
  if (fields.coreCount) setTextWithFlash(fields.coreCount, dash, { flash: false });
  multiSet([[fields.canonCount, dash], [fields.ogCount, dash], [fields.jsonCount, dash]], { flash: false });
}

function renderSnapshot(snap) {
  currentTrackingEnabled = !!snap.trackingEnabled;

  const originTxt = snap.origin || "";
  const isHttp = isHttpOriginText(originTxt);
  if (fields.trackToggle) fields.trackToggle.disabled = !isHttp;
  if (fields.trackToggle) fields.trackToggle.checked = currentTrackingEnabled;
  if (fields.trackStatus) setText(fields.trackStatus, currentTrackingEnabled ? "On" : "Off");

  renderCounters(snap.counts);
  if (currentTrackingEnabled) renderMetadataTrackingOn(snap);
  else renderMetadataTrackingOff(snap.origin);
}

/* ---------------- Title + live fetch ---------------- */

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

async function showLiveForActiveTab({ optimistic = false } = {}) {
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!active) return;
  selectedTabId = active.id;

  setTextWithFlash(fields.tabTitle, formatTitle(active), { flash: false });

  let origin = "(none)";
  let proto = "";
  try {
    proto = protocolOf(active.url);
    origin = (active.url && isSupportedProtocol(proto)) ? new URL(active.url).origin : "(none)";
  } catch {}

  lastKnownProtocol = proto;
  setTextWithFlash(fields.coreOrigin, origin, { flash: false });

  if (!isSupportedProtocol(proto)) {
    applyUnavailableUI(origin, "(unavailable here)");
    return; // do not ask background for state
  }

  clearUnavailableUI();

  if (currentTrackingEnabled === null || optimistic === false) {
    multiSet([[fields.coreUrl, "(loading…)"], [fields.canonUrl, "(loading…)"], [fields.ogUrl, "(loading…)"], [fields.jsonId, "(loading…)"]], { flash: false });
    const dash = "—";
    if (fields.coreCount) setTextWithFlash(fields.coreCount, dash, { flash: false });
    multiSet([[fields.canonCount, dash], [fields.ogCount, dash], [fields.jsonCount, dash]], { flash: false });
  }

  showLiveBadge();
  browser.runtime.sendMessage({ type: "get-state", tabId: selectedTabId }).catch(() => {});
}

/* ---------------- Events ---------------- */

fields.resetBtn?.addEventListener("click", async () => {
  if (fields.resetBtn.disabled) return;
  const tabId = selectedTabId;
  if (!Number.isFinite(tabId)) return;

  multiSet([[fields.all, 0], [fields.full, 0], [fields.spa, 0], [fields.path, 0], [fields.query, 0], [fields.frag, 0]], { flash: false });
  multiSet([[fields.canonUrl, "(loading…)"], [fields.ogUrl, "(loading…)"], [fields.jsonId, "(loading…)"], [fields.canonCount, 0], [fields.ogCount, 0], [fields.jsonCount, 0]], { flash: false });
  if (fields.coreCount) setTextWithFlash(fields.coreCount, 0, { flash: false });

  try { await browser.runtime.sendMessage({ type: "manual-reset", tabId }); } catch {}
  browser.runtime.sendMessage({ type: "get-state", tabId }).catch(() => {});
});

// Handle background → UI messages
browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "set-tracking-result") {
    const originText = fields.coreOrigin.textContent || "";
    if (msg.origin === originText) {
      const ok = !!msg.enabled;
      if (fields.trackToggle) fields.trackToggle.checked = ok;
      if (fields.trackStatus) setText(fields.trackStatus, ok ? "On" : "Off");
      browser.runtime.sendMessage({ type: "get-state" }).catch(() => {});
    }
    return;
  }

  if (msg?.type !== "url-change-state" || msg.tabId !== selectedTabId) return;

  // If we somehow receive a snapshot for an unsupported page, enforce unavailable UI
  if (!isSupportedProtocol(lastKnownProtocol)) {
    applyUnavailableUI(fields.coreOrigin.textContent || "(none)");
    return;
  }

  const elapsed = Date.now() - liveShownAt;
  const doRender = () => { renderSnapshot(msg); showSyncedBadge(); };

  if (elapsed >= MIN_LIVE_MS) doRender();
  else {
    if (flipTimer) clearTimeout(flipTimer);
    flipTimer = setTimeout(doRender, MIN_LIVE_MS - elapsed);
  }
});

// Follow active tab and window focus
browser.tabs.onActivated.addListener(async () => {
  currentTrackingEnabled = null;
  await showLiveForActiveTab({ optimistic: false });
});
browser.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return;
  if (lastFocusedWindowId === windowId && currentTrackingEnabled !== null) return;
  lastFocusedWindowId = windowId;

  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!active) return;
  if (selectedTabId === active.id && currentTrackingEnabled !== null) return;

  currentTrackingEnabled = null;
  await showLiveForActiveTab({ optimistic: false });
});

// Keep title + origin fresh and re-sync on URL change for the active tab
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== selectedTabId) return;

  if (changeInfo.title) setText(fields.tabTitle, formatTitle(tab));

  if (changeInfo.url) {
    const proto = protocolOf(changeInfo.url);
    lastKnownProtocol = proto;
    const isSupported = isSupportedProtocol(proto);

    if (isSupported) {
      try {
        const o = new URL(changeInfo.url).origin;
        setTextWithFlash(fields.coreOrigin, o, { flash: false });
      } catch { setTextWithFlash(fields.coreOrigin, "(none)", { flash: false }); }

      if (currentTrackingEnabled === true) setTextWithFlash(fields.coreUrl, changeInfo.url);
      else setTextWithFlash(fields.coreUrl, "(loading…)", { flash: false });

      showLiveBadge();
      browser.runtime.sendMessage({ type: "get-state", tabId }).catch(() => {});
    } else {
      const originText = "(none)";
      setTextWithFlash(fields.coreOrigin, originText, { flash: false });
      applyUnavailableUI(originText, "(unavailable here)");
    }
  }
});

/* ---- Tracking toggle: request host permission on "On", revoke on "Off" ---- */

fields.trackToggle?.addEventListener("change", async () => {
  const origin = fields.coreOrigin.textContent || "";
  if (!isHttpOriginText(origin)) {
    fields.trackToggle.checked = false;
    if (fields.trackStatus) setText(fields.trackStatus, "Off");
    return;
  }

  const enabling = !!fields.trackToggle.checked;

  if (enabling) {
    // Request host permission (door-hanger)
    const pattern = patternForOriginText(origin);
    if (!pattern) return;
    try {
      const granted = await browser.permissions.request({ origins: [pattern] });
      if (!granted) {
        fields.trackToggle.checked = false;
        if (fields.trackStatus) setText(fields.trackStatus, "Off");
        browser.runtime.sendMessage({ type: "set-tracking", origin, enabled: false }).catch(() => {});
        return;
      }
    } catch {
      fields.trackToggle.checked = false;
      if (fields.trackStatus) setText(fields.trackStatus, "Off");
      return;
    }
    if (fields.trackStatus) setText(fields.trackStatus, "On");
    currentTrackingEnabled = null;
    browser.runtime.sendMessage({ type: "set-tracking", origin, enabled: true }).catch(() => {});
    browser.runtime.sendMessage({ type: "get-state" }).catch(() => {});
    return;
  }

  // Disabling: revoke host permission and tell background to disable
  try {
    const pattern = patternForOriginText(origin);
    if (pattern) {
      await browser.permissions.remove({ origins: [pattern] }).catch(() => {});
    }
  } catch { /* ignore */ }

  if (fields.trackStatus) setText(fields.trackStatus, "Off");
  currentTrackingEnabled = null;
  browser.runtime.sendMessage({ type: "set-tracking", origin, enabled: false }).catch(() => {});
  browser.runtime.sendMessage({ type: "get-state" }).catch(() => {});
});

/* -------------------------------- Boot -------------------------------- */

(async function init() {
  await showLiveForActiveTab({ optimistic: false });
})();

