// background.js — MV3 compatible (Firefox: background.scripts; Chromium: service_worker)

// Polyfill for both Firefox and Chromium
const browserAPI = (typeof browser !== "undefined")
  ? browser
  : {
      ...chrome,
      action: chrome.action || chrome.browserAction,
      runtime: chrome.runtime,
      tabs: chrome.tabs,
      webNavigation: chrome.webNavigation,
    };

/* --------------------------- State & helpers --------------------------- */

const CORE_PROTOCOLS = new Set(["http:", "https:", "file:"]);

/**
 * tabState: Map<tabId, {
 *   lastUrl: string|null,
 *   origin: string|null,
 *   hasBaseline: boolean,
 *   suppressNextIdIncrements: boolean, // one-shot: baseline metadata shouldn't increment
 *   counts: {
 *     totals: { all, full, spa },
 *     dims:   { path, query, fragment },
 *     ids:    { canonical, ogUrl, jsonLdId }
 *   },
 *   ids: { canonical, ogUrl, jsonLdId }
 * }>
 */
const tabState = new Map();

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
  return { tabId, url, origin, counts: s.counts, ids: s.ids };
}

async function broadcast(tabId) {
  const snap = await snapshotForWithLiveUrl(tabId);
  try { await browserAPI.runtime.sendMessage({ type: "url-change-state", ...snap }); } catch {}
}

async function updateBadge(tabId) {
  const snap = await snapshotForWithLiveUrl(tabId);
  const txt = snap.counts.totals.all ? String(snap.counts.totals.all) : "";
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
 * - Always update stored values.
 * - Increment counters only if we have a baseline and not in suppression mode.
 * - Return { idsChanged, countsIncremented } so callers can decide to rebroadcast.
 */
function integratePageIds(tabId, incoming) {
  const s = getState(tabId);
  const suppress = s.suppressNextIdIncrements;
  const { canonical = "", ogUrl = "", jsonLdId = "" } = incoming || {};

  let idsChanged = false;
  let countsIncremented = false;

  const consider = (key, val) => {
    if (!val) return;
    const prev = s.ids[key] || "";
    const changed = prev !== val;
    if (changed) idsChanged = true;
    s.ids[key] = val;
    if (changed && s.hasBaseline && !suppress) {
      s.counts.ids[key] += 1;
      countsIncremented = true;
    }
  };

  consider("canonical", canonical);
  consider("ogUrl", ogUrl);
  consider("jsonLdId", jsonLdId);

  // Clear one-shot suppression after integrating baseline values
  if (suppress) s.suppressNextIdIncrements = false;

  tabState.set(tabId, s);
  return { idsChanged, countsIncremented };
}

/* --------------------------- Core URL change flow --------------------------- */

async function handleUrlChange(tabId, url, source /* 'full' | 'spa' */) {
  if (!isCoreProtocol(url)) return;

  const s = getState(tabId);
  const prevUrl = s.lastUrl;
  const prevHasBaseline = s.hasBaseline;

  const next = toURL(url);
  if (!next) return;

  // De-dupe if we already have a baseline and the URL hasn't changed
  if (prevHasBaseline && prevUrl === url) return;

  // If no baseline yet, set it now and DO NOT increment any counters.
  if (!prevHasBaseline) {
    s.lastUrl = url;
    s.origin = originOf(next);
    s.hasBaseline = true;
    s.suppressNextIdIncrements = true; // baseline metadata shouldn't increment
    tabState.set(tabId, s);

    await broadcast(tabId);
    await updateBadge(tabId);
    // Baseline metadata (no increments due to suppression)
    debouncedRefreshPageIds(tabId, 0);
    return;
  }

  // We have a baseline; compute diffs against it
  const prev = toURL(prevUrl);
  const diffs = diffComponents(prev, next);

  // If origin changed, reset and set NEW baseline to the new URL, no increments
  if (prev && diffs.origin) {
    s.counts = newCounts();
    s.ids = { canonical: "", ogUrl: "", jsonLdId: "" };
    s.lastUrl = url;
    s.origin = originOf(next);
    s.hasBaseline = true;
    s.suppressNextIdIncrements = true; // suppress metadata bump for this new baseline
    tabState.set(tabId, s);

    await broadcast(tabId);
    await updateBadge(tabId);
    debouncedRefreshPageIds(tabId, 0); // baseline metadata for new origin
    return;
  }

  // Normal, within-origin change: increment totals and per-dimension buckets
  s.counts.totals.all += 1;
  if (source === "spa") s.counts.totals.spa += 1;
  else                  s.counts.totals.full += 1;

  if (diffs.path)     s.counts.dims.path     += 1;
  if (diffs.query)    s.counts.dims.query    += 1;
  if (diffs.fragment) s.counts.dims.fragment += 1;

  // Advance baseline
  s.lastUrl = url;
  tabState.set(tabId, s);

  await broadcast(tabId);
  await updateBadge(tabId);

  // Re-probe metadata; if values change now, id counters will increment (no suppression)
  debouncedRefreshPageIds(tabId);
}

/* ------------------------------ Event wiring ------------------------------ */

// URL updates (new docs / redirects)
browserAPI.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    handleUrlChange(tabId, changeInfo.url, "full");
  }
  // Also probe metadata when a page finishes loading, even if URL didn't change
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

// Keep badge in step and ensure metadata populates when a tab is focused
browserAPI.tabs.onActivated.addListener(async ({ tabId }) => {
  await updateBadge(tabId);
  debouncedRefreshPageIds(tabId); // ensure canonical/OG/JSON-LD are populated on focus
});

/* ---------------------- Messages (sidebar / popup / page) ---------------------- */

browserAPI.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;

  // Snapshot request — include live URL if we don't have one yet.
  // Also kick off a metadata probe if we haven't stored any IDs for this tab.
  if (msg.type === "get-state") {
    (async () => {
      let tabId = Number.isFinite(msg.tabId) ? msg.tabId : sender?.tab?.id;
      if (!Number.isFinite(tabId)) {
        const [active] = await browserAPI.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (Number.isFinite(tabId)) {
        const s = getState(tabId);
        if (!s.ids.canonical && !s.ids.ogUrl && !s.ids.jsonLdId) {
          debouncedRefreshPageIds(tabId);
        }
        const snap = await snapshotForWithLiveUrl(tabId);
        await browserAPI.runtime.sendMessage({ type: "url-change-state", ...snap }).catch(() => {});
      }
    })();
    return;
  }

  // Manual reset:
  // - zero counters/ids
  // - baseline immediately to the current live URL (if available)
  // - re-probe metadata as baseline (no increments)
  if (msg.type === "manual-reset") {
    (async () => {
      let tabId = Number.isFinite(msg.tabId) ? msg.tabId : sender?.tab?.id;
      if (!Number.isFinite(tabId)) {
        const [active] = await browserAPI.tabs.query({ active: true, currentWindow: true });
        tabId = active?.id;
      }
      if (!Number.isFinite(tabId)) return;

      const s = getState(tabId);
      s.counts = newCounts();
      s.ids = { canonical: "", ogUrl: "", jsonLdId: "" };
      s.hasBaseline = false;
      s.suppressNextIdIncrements = true; // baseline metadata suppression

      try {
        const tab = await browserAPI.tabs.get(tabId);
        if (tab?.url && isCoreProtocol(tab.url)) {
          const u = new URL(tab.url);
          s.lastUrl = tab.url;
          s.origin = `${u.protocol}//${u.host}`;
          s.hasBaseline = true;
        } else {
          s.lastUrl = null;
          s.origin = null;
          s.hasBaseline = false;
        }
      } catch {
        s.lastUrl = null; s.origin = null; s.hasBaseline = false;
      }

      tabState.set(tabId, s);

      await broadcast(tabId);
      await updateBadge(tabId);

      // Re-probe metadata to capture baseline values (will not increment due to suppression)
      debouncedRefreshPageIds(tabId, 0);
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
      (async () => {
        await broadcast(tabId);
        await updateBadge(tabId);
      })();
    }
    return;
  }
});

