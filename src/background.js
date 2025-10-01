// background.js — MV3 compatible (Firefox: background.scripts; Chromium: service_worker)

// Cross-browser API
const browserAPI = (typeof browser !== "undefined")
  ? browser
  : {
      ...chrome,
      action: chrome.action || chrome.browserAction,
      runtime: chrome.runtime,
      tabs: chrome.tabs,
      webNavigation: chrome.webNavigation,
      storage: chrome.storage,
    };

/* --------------------------- State & helpers --------------------------- */

const CORE_PROTOCOLS = new Set(["http:", "https:", "file:"]);

/**
 * tabState: Map<tabId, {
 *   lastUrl: string|null,
 *   origin: string|null,
 *   hasBaseline: boolean,
 *   suppressNextIdIncrements: boolean,
 *   counts: {
 *     totals: { all, full, spa },
 *     dims:   { path, query, fragment },
 *     ids:    { canonical, ogUrl, jsonLdId }
 *   },
 *   ids: { canonical, ogUrl, jsonLdId }
 * }>
 */
const tabState = new Map();

/** Persisted allow-list: { [origin: string]: true } */
let allowlist = Object.create(null);

async function loadAllowlist() {
  try {
    const { trackingAllowlist } = await browserAPI.storage?.local?.get?.("trackingAllowlist") ?? {};
    allowlist = (trackingAllowlist && typeof trackingAllowlist === "object") ? trackingAllowlist : Object.create(null);
  } catch {
    allowlist = Object.create(null);
  }
}
async function saveAllowlist() {
  try { await browserAPI.storage?.local?.set?.({ trackingAllowlist: allowlist }); } catch {}
}

function newCounts() {
  return {
    totals: { all: 0, full: 0, spa: 0 },
    dims:   { path: 0, query: 0, fragment: 0 },
    ids:    { canonical: 0, ogUrl: 0, jsonLdId: 0 },
  };
}
function getState(tabId) {
  if (!tabState.has(tabId)) {
    tabState.set(tabId, {
      lastUrl: null,
      origin: null,
      hasBaseline: false,
      suppressNextIdIncrements: false,
      counts: newCounts(),
      ids: { canonical: "", ogUrl: "", jsonLdId: "" },
    });
  }
  return tabState.get(tabId);
}

function toURL(u) { try { return new URL(u); } catch { return null; } }
function isCoreProtocol(url) { try { return CORE_PROTOCOLS.has(new URL(url).protocol); } catch { return false; } }
function originOf(u) { return `${u.protocol}//${u.host}`; }
function isMainFrame(d) { return d?.frameId === 0; }

function diffComponents(prev, next) {
  if (!prev) return { origin: false, path: false, query: false, fragment: false };
  return {
    origin: prev.protocol !== next.protocol || prev.host !== next.host,
    path: prev.pathname !== next.pathname,
    query: prev.search !== next.search,
    fragment: prev.hash !== next.hash,
  };
}

function isTrackingEnabledForOrigin(origin) {
  return !!(origin && allowlist[origin]);
}

/* ---------------------- Snapshots, badge, broadcast ---------------------- */

async function snapshotForWithLiveUrl(tabId) {
  const s = getState(tabId);
  let url = s.lastUrl || "";
  let origin = s.origin || "";

  if (!url) {
    try {
      const tab = await browserAPI.tabs.get(tabId);
      if (tab?.url) {
        url = tab.url;
        try { const u = new URL(url); origin = `${u.protocol}//${u.host}`; } catch {}
      }
    } catch {}
  }

  const trackingEnabled = isTrackingEnabledForOrigin(origin);
  return { tabId, url, origin, counts: s.counts, ids: s.ids, trackingEnabled };
}

async function broadcast(tabId) {
  const snap = await snapshotForWithLiveUrl(tabId);
  try { await browserAPI.runtime.sendMessage({ type: "url-change-state", ...snap }); } catch {}
}

async function updateBadge(tabId) {
  const snap = await snapshotForWithLiveUrl(tabId);
  const txt = (snap.trackingEnabled && snap.counts.totals.all) ? String(snap.counts.totals.all) : "";
  try {
    await browserAPI.action.setBadgeText({ tabId, text: txt });
    await browserAPI.action.setBadgeBackgroundColor?.({ tabId, color: "#444" });
  } catch {}
}

/* -------------------------- Metadata probing -------------------------- */

// Ask the content script to probe canonical / og:url / JSON-LD
async function refreshPageIds(tabId) {
  try { await browserAPI.tabs.sendMessage(tabId, { type: "probe-ids" }); } catch { /* no content script here */ }
}

// Debounce probes per-tab to avoid spam
const probeTimers = new Map(); // tabId -> timeout id
function debouncedRefreshPageIds(tabId, delay = 150) {
  const prev = probeTimers.get(tabId);
  if (prev) clearTimeout(prev);
  const id = setTimeout(() => { refreshPageIds(tabId); }, delay);
  probeTimers.set(tabId, id);
}

/**
 * Fold in canonical / og:url / JSON-LD.
 * - Always store values.
 * - Increment counters only if: tracking enabled for origin, have baseline, and not in suppression mode.
 */
function integratePageIds(tabId, incoming) {
  const s = getState(tabId);
  const suppress = s.suppressNextIdIncrements;
  const { canonical = "", ogUrl = "", jsonLdId = "" } = incoming || {};

  const trackingEnabled = isTrackingEnabledForOrigin(s.origin);
  let idsChanged = false;
  let countsIncremented = false;

  const consider = (key, val) => {
    if (!val) return;
    const prev = s.ids[key] || "";
    const changed = prev !== val;
    if (changed) idsChanged = true;
    s.ids[key] = val;
    if (changed && trackingEnabled && s.hasBaseline && !suppress) {
      s.counts.ids[key] += 1;
      countsIncremented = true;
    }
  };

  consider("canonical", canonical);
  consider("ogUrl", ogUrl);
  consider("jsonLdId", jsonLdId);

  if (suppress) s.suppressNextIdIncrements = false;

  tabState.set(tabId, s);
  return { idsChanged, countsIncremented };
}

/* --------------------------- Baseline & reset --------------------------- */

/** Baseline a tab to its current live URL; zero counts; do not increment first metadata integration. */
async function baselineTab(tabId) {
  const s = getState(tabId);

  // Get live URL
  let liveUrl = "";
  try { const tab = await browserAPI.tabs.get(tabId); liveUrl = tab?.url || ""; } catch {}
  if (!liveUrl || !isCoreProtocol(liveUrl)) {
    // Clear state if we can't baseline
    s.lastUrl = null; s.origin = null; s.hasBaseline = false;
    s.counts = newCounts(); s.ids = { canonical: "", ogUrl: "", jsonLdId: "" };
    tabState.set(tabId, s);
    await broadcast(tabId);
    await updateBadge(tabId);
    return;
  }

  const u = new URL(liveUrl);
  s.lastUrl = liveUrl;
  s.origin = `${u.protocol}//${u.host}`;
  s.hasBaseline = true;
  s.counts = newCounts();
  s.ids = { canonical: "", ogUrl: "", jsonLdId: "" };
  s.suppressNextIdIncrements = true; // first metadata integration is baseline (no increments)
  tabState.set(tabId, s);

  await broadcast(tabId);
  await updateBadge(tabId);
  debouncedRefreshPageIds(tabId, 0);
}

/* --------------------------- Core URL change flow --------------------------- */

async function handleUrlChange(tabId, url, source /* 'full' | 'spa' */) {
  if (!isCoreProtocol(url)) return;

  const s = getState(tabId);
  const next = toURL(url);
  if (!next) return;

  const origin = originOf(next);
  const trackingEnabled = isTrackingEnabledForOrigin(origin);

  // If tracking is disabled for this origin, keep a minimal baseline (for UI), but do not count or probe.
  if (!trackingEnabled) {
    s.lastUrl = url;
    s.origin = origin;
    s.hasBaseline = true; // so snapshot shows URL; but counts stay at zero
    tabState.set(tabId, s);
    await broadcast(tabId);
    await updateBadge(tabId);
    return;
  }

  const prevUrl = s.lastUrl;
  const prevHasBaseline = s.hasBaseline;

  // If no baseline yet (e.g., fresh focus, restart), establish it and stop.
  if (!prevHasBaseline) {
    await baselineTab(tabId);
    return;
  }

  // De-dupe
  if (prevUrl === url) return;

  // Compute diffs and handle origin change
  const prev = toURL(prevUrl);
  const diffs = diffComponents(prev, next);

  if (prev && diffs.origin) {
    // Reset on origin change, then baseline to the new origin
    await baselineTab(tabId); // baselineTab reads live URL; here it's equal to `url`
    return;
  }

  // Normal within-origin change: count + advance baseline
  s.counts.totals.all += 1;
  if (source === "spa") s.counts.totals.spa += 1; else s.counts.totals.full += 1;
  if (diffs.path)     s.counts.dims.path     += 1;
  if (diffs.query)    s.counts.dims.query    += 1;
  if (diffs.fragment) s.counts.dims.fragment += 1;

  s.lastUrl = url;
  s.origin  = origin;
  tabState.set(tabId, s);

  await broadcast(tabId);
  await updateBadge(tabId);
  debouncedRefreshPageIds(tabId); // will increment ID counts if values change
}

/* ------------------------------ Event wiring ------------------------------ */

// URL updates (new docs / redirects)
browserAPI.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    handleUrlChange(tabId, changeInfo.url, "full");
  }
  // Probe metadata when a page finishes loading (even if URL didn't change)
  if (changeInfo.status === "complete") {
    debouncedRefreshPageIds(tabId);
  }
});

// SPA same-document navigations (history API)
browserAPI.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (isMainFrame(d)) handleUrlChange(d.tabId, d.url, "spa");
});

// New document commits (main frame only)
browserAPI.webNavigation.onCommitted.addListener((d) => {
  if (isMainFrame(d)) handleUrlChange(d.tabId, d.url, "full");
});

// Cleanup
browserAPI.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  const t = probeTimers.get(tabId);
  if (t) clearTimeout(t);
  probeTimers.delete(tabId);
});

// Auto-reset (baseline) when a tab becomes active
browserAPI.tabs.onActivated.addListener(async ({ tabId }) => {
  // Baseline only if tracking is enabled for this tab's origin; otherwise just broadcast "disabled"
  try {
    const tab = await browserAPI.tabs.get(tabId);
    const url = tab?.url || "";
    const origin = url && isCoreProtocol(url) ? `${new URL(url).protocol}//${new URL(url).host}` : null;

    if (origin && isTrackingEnabledForOrigin(origin)) {
      await baselineTab(tabId);
    } else {
      // Ensure UI knows tracking is disabled; set minimal state
      const s = getState(tabId);
      s.lastUrl = url || null;
      s.origin = origin || null;
      s.hasBaseline = !!url;
      tabState.set(tabId, s);
      await broadcast(tabId);
      await updateBadge(tabId);
    }
  } catch {
    await updateBadge(tabId);
  }

  // Always ensure metadata is populated (will be ignored if tracking disabled)
  debouncedRefreshPageIds(tabId);
});

/* ---------------------- Messages (sidebar / popup / page) ---------------------- */

browserAPI.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;

  // Snapshot request — also kick a probe if no IDs yet.
  if (msg.type === "get-state") {
    (async () => {
      let tabId = Number.isFinite(msg.tabId) ? msg.tabId : sender?.tab?.id;
      if (!Number.isFinite(tabId)) {
        const [active] = await browserAPI.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (Number.isFinite(tabId)) {
        const s = getState(tabId);
        if (!s.ids.canonical && !s.ids.ogUrl && !s.ids.jsonLdId) debouncedRefreshPageIds(tabId);
        const snap = await snapshotForWithLiveUrl(tabId);
        await browserAPI.runtime.sendMessage({ type: "url-change-state", ...snap }).catch(() => {});
      }
    })();
    return;
  }

  // Manual reset: force baseline (even if tracking currently disabled, we'll still show the snapshot)
  if (msg.type === "manual-reset") {
    (async () => {
      let tabId = Number.isFinite(msg.tabId) ? msg.tabId : sender?.tab?.id;
      if (!Number.isFinite(tabId)) {
        const [active] = await browserAPI.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!Number.isFinite(tabId)) return;

      await baselineTab(tabId);
    })();
    return;
  }

  // Toggle tracking for an origin { origin, enabled }
  if (msg.type === "set-tracking") {
    (async () => {
      const { origin, enabled } = msg;
      if (!origin) return;
      if (enabled) allowlist[origin] = true;
      else delete allowlist[origin];
      await saveAllowlist();

      // If the sender tab matches this origin, re-baseline or broadcast disabled
      const tabId = sender?.tab?.id;
      if (Number.isFinite(tabId)) {
        const s = getState(tabId);
        const sameOrigin = s.origin === origin;
        if (sameOrigin) {
          if (enabled) {
            await baselineTab(tabId);
          } else {
            // Clear counts and ids for visual clarity
            s.counts = newCounts();
            s.ids = { canonical: "", ogUrl: "", jsonLdId: "" };
            tabState.set(tabId, s);
            await broadcast(tabId);
            await updateBadge(tabId);
          }
        }
      }
    })();
    return;
  }

  // Metadata probe result from content script
  if (msg.type === "page-ids") {
    const tabId = sender?.tab?.id;
    if (!Number.isFinite(tabId)) return;

    const { idsChanged } = integratePageIds(tabId, msg);
    // Rebroadcast if metadata values changed (even if counters didn’t increment)
    if (idsChanged) {
      (async () => { await broadcast(tabId); await updateBadge(tabId); })();
    }
    return;
  }
});

/* ---------------------------- Bootstrapping ---------------------------- */

(async function init() {
  await loadAllowlist();
  // No need to rebuild tabState: we baseline on focus and handle counts thereafter.
})();

