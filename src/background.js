// background.js — Firefox MV3
// Optional host permissions (requested in sidebar UI), secure messaging,
// programmatic ids.js injection, per-origin opt-in, baseline on focus,
// and permission revocation on "Off".

const { action, runtime, tabs, webNavigation, storage, scripting, permissions } = browser;

/* --------------------------- State & persistence --------------------------- */

const CORE_PROTOCOLS = new Set(["http:", "https:", "file:"]);

const tabState = new Map();                // per-tab counters + ids
let allowlist = Object.create(null);       // { [origin]: true } persisted
const injectedTabs = new Set();            // tabs we've injected ids.js into
const probeTimers = new Map();             // per-tab debounce timers

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
function isTrackingEnabledForOrigin(origin) { return !!(origin && allowlist[origin]); }
function extURLPrefix() { return runtime.getURL(""); }

/* --------------------------- Storage (persist) --------------------------- */

async function loadAllowlist() {
  try {
    const { trackingAllowlist } = await storage.local.get("trackingAllowlist") ?? {};
    allowlist = (trackingAllowlist && typeof trackingAllowlist === "object")
      ? trackingAllowlist : Object.create(null);
  } catch { allowlist = Object.create(null); }
}
async function saveAllowlist() {
  try { await storage.local.set({ trackingAllowlist: allowlist }); } catch {}
}

/* ---------------------- Probing & programmatic injection ---------------------- */

function debounced(key, fn, delay = 150) {
  const prev = probeTimers.get(key);
  if (prev) clearTimeout(prev);
  const id = setTimeout(fn, delay);
  probeTimers.set(key, id);
}

// Inject ids.js into a tab if host permission exists. Safe to call repeatedly.
async function maybeInjectProbe(tabId) {
  try {
    const tab = await tabs.get(tabId);
    if (!tab?.url) return;
    const u = new URL(tab.url);
    const pattern = `${u.protocol}//${u.host}/*`;

    // Only inject if user has granted host permission (requested from the sidebar)
    const has = await permissions.contains({ origins: [pattern] });
    if (!has) return;

    await scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["ids.js"],
    }).catch(() => {});

    injectedTabs.add(tabId);
  } catch { /* ignore */ }
}

// Ask content script to probe canonical/og/jsonld, ensuring injection first
async function refreshPageIds(tabId) {
  await maybeInjectProbe(tabId);
  try { await tabs.sendMessage(tabId, { type: "probe-ids" }); } catch { /* ignore */ }
}

/* --------------------------- Snapshots & badge --------------------------- */

async function snapshotForWithLiveUrl(tabId) {
  const s = getState(tabId);
  let url = s.lastUrl || "";
  let origin = s.origin || "";

  if (!url) {
    try {
      const tab = await tabs.get(tabId);
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
  try { await runtime.sendMessage({ type: "url-change-state", ...snap }); } catch {}
}

async function updateBadge(tabId) {
  const snap = await snapshotForWithLiveUrl(tabId);
  const txt = (snap.trackingEnabled && snap.counts.totals.all) ? String(snap.counts.totals.all) : "";
  try {
    await action.setBadgeText({ tabId, text: txt });
    await action.setBadgeBackgroundColor?.({ tabId, color: "#444" });
  } catch {}
}

/* -------------------------- Metadata integration -------------------------- */

function integratePageIds(tabId, incoming) {
  const s = getState(tabId);
  const suppress = s.suppressNextIdIncrements;
  const { canonical = "", ogUrl = "", jsonLdId = "" } = incoming || {};
  const trackingEnabled = isTrackingEnabledForOrigin(s.origin);

  let idsChanged = false;

  const consider = (key, val) => {
    if (!val) return;
    const prev = s.ids[key] || "";
    const changed = prev !== val;
    if (changed) idsChanged = true;
    s.ids[key] = val;
    if (changed && trackingEnabled && s.hasBaseline && !suppress) {
      s.counts.ids[key] += 1;
    }
  };

  consider("canonical", canonical);
  consider("ogUrl", ogUrl);
  consider("jsonLdId", jsonLdId);

  if (s.suppressNextIdIncrements) s.suppressNextIdIncrements = false;

  tabState.set(tabId, s);
  return { idsChanged };
}

/* --------------------------- Baseline / reset flow --------------------------- */

async function baselineTab(tabId) {
  const s = getState(tabId);

  // Use live URL as baseline
  let liveUrl = "";
  try { const tab = await tabs.get(tabId); liveUrl = tab?.url || ""; } catch {}
  if (!liveUrl || !isCoreProtocol(liveUrl)) {
    s.lastUrl = null; s.origin = null; s.hasBaseline = false;
    s.counts = newCounts(); s.ids = { canonical: "", ogUrl: "", jsonLdId: "" };
    tabState.set(tabId, s);
    await broadcast(tabId); await updateBadge(tabId);
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

  await broadcast(tabId); await updateBadge(tabId);

  // If permission exists, inject & probe; otherwise this will no-op
  debounced(tabId, () => refreshPageIds(tabId), 0);
}

/* --------------------------- URL change handling --------------------------- */

async function handleUrlChange(tabId, url, source /* 'full' | 'spa' */) {
  if (!isCoreProtocol(url)) return;

  const s = getState(tabId);
  const next = toURL(url);
  if (!next) return;

  const origin = originOf(next);
  const trackingEnabled = isTrackingEnabledForOrigin(origin);

  // If not tracking this origin, keep minimal baseline for UI; no counts/probes.
  if (!trackingEnabled) {
    s.lastUrl = url;
    s.origin = origin;
    s.hasBaseline = true;
    tabState.set(tabId, s);
    await broadcast(tabId); await updateBadge(tabId);
    return;
  }

  const prevUrl = s.lastUrl;
  const prevHasBaseline = s.hasBaseline;

  // Establish baseline if none (e.g., after reload or newly focused)
  if (!prevHasBaseline) { await baselineTab(tabId); return; }

  if (prevUrl === url) return; // de-dupe

  const prev = toURL(prevUrl);
  const diffs = diffComponents(prev, next);

  if (prev && diffs.origin) {
    await baselineTab(tabId); // origin changed → reset + baseline
    return;
  }

  // Within-origin change: count + advance baseline
  s.counts.totals.all += 1;
  if (source === "spa") s.counts.totals.spa += 1; else s.counts.totals.full += 1;
  if (diffs.path)     s.counts.dims.path     += 1;
  if (diffs.query)    s.counts.dims.query    += 1;
  if (diffs.fragment) s.counts.dims.fragment += 1;

  s.lastUrl = url;
  s.origin  = origin;
  tabState.set(tabId, s);

  await broadcast(tabId); await updateBadge(tabId);
  debounced(tabId, () => refreshPageIds(tabId));
}

/* -------------------------------- Listeners -------------------------------- */

// Note: Firefox only delivers webNavigation events for hosts we have permission for.

tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) handleUrlChange(tabId, changeInfo.url, "full");
  if (changeInfo.status === "complete") {
    debounced(tabId, () => refreshPageIds(tabId));
  }
});
webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (isMainFrame(d)) handleUrlChange(d.tabId, d.url, "spa");
});
webNavigation.onCommitted.addListener((d) => {
  if (isMainFrame(d)) handleUrlChange(d.tabId, d.url, "full");
});

tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  injectedTabs.delete(tabId);
  const t = probeTimers.get(tabId);
  if (t) clearTimeout(t);
  probeTimers.delete(tabId);
});

// Auto-reset (baseline) on focus; if tracking enabled, ensure probe injection
tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await tabs.get(tabId);
    const url = tab?.url || "";
    const origin = (url && isCoreProtocol(url)) ? `${new URL(url).protocol}//${new URL(url).host}` : null;

    if (origin && isTrackingEnabledForOrigin(origin)) {
      await baselineTab(tabId);
      debounced(tabId, () => refreshPageIds(tabId), 0);
    } else {
      const s = getState(tabId);
      s.lastUrl = url || null;
      s.origin = origin || null;
      s.hasBaseline = !!url;
      tabState.set(tabId, s);
      await broadcast(tabId); await updateBadge(tabId);
    }
  } catch { await updateBadge(tabId); }
});

/* ----------------------------- Secure messaging ----------------------------- */

function isFromExtensionUI(sender) {
  const src = sender?.url || "";
  return src.startsWith(extURLPrefix()); // moz-extension://<uuid>/...
}

async function isFromInjectedContent(sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isFinite(tabId)) return false;
  if (!injectedTabs.has(tabId)) return false;
  try {
    const tab = await tabs.get(tabId);
    if (!tab?.url) return false;
    const u = new URL(tab.url);
    const pattern = `${u.protocol}//${u.host}/*`;
    if (!(await permissions.contains({ origins: [pattern] }))) return false;
    return true;
  } catch { return false; }
}

runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;

  // UI → background (must originate from our extension pages)
  if (["get-state", "manual-reset", "set-tracking"].includes(msg.type)) {
    if (!isFromExtensionUI(sender)) return;

    if (msg.type === "get-state") {
      (async () => {
        let tabId = Number.isFinite(msg.tabId) ? msg.tabId : sender?.tab?.id;
        if (!Number.isFinite(tabId)) {
          const [active] = await tabs.query({ active: true, currentWindow: true });
          tabId = active?.id;
        }
        if (Number.isFinite(tabId)) {
          const s = getState(tabId);
          if (!s.ids.canonical && !s.ids.ogUrl && !s.ids.jsonLdId) {
            debounced(tabId, () => refreshPageIds(tabId));
          }
          const snap = await snapshotForWithLiveUrl(tabId);
          await runtime.sendMessage({ type: "url-change-state", ...snap }).catch(() => {});
        }
      })();
      return;
    }

    if (msg.type === "manual-reset") {
      (async () => {
        let tabId = Number.isFinite(msg.tabId) ? msg.tabId : sender?.tab?.id;
        if (!Number.isFinite(tabId)) {
          const [active] = await tabs.query({ active: true, currentWindow: true });
          tabId = active?.id;
        }
        if (!Number.isFinite(tabId)) return;
        await baselineTab(tabId);
      })();
      return;
    }

    if (msg.type === "set-tracking") {
      (async () => {
        const { origin, enabled } = msg;
        if (!/^https?:\/\/[^/]+$/.test(origin || "")) {
          try { await runtime.sendMessage({ type: "set-tracking-result", origin, enabled: false, reason: "unsupported_origin" }); } catch {}
          return;
        }

        if (enabled) {
          allowlist[origin] = true;
          await saveAllowlist();

          // If sender's tab matches, baseline & probe now
          const tabId = sender?.tab?.id;
          if (Number.isFinite(tabId)) {
            await baselineTab(tabId);
            debounced(tabId, () => refreshPageIds(tabId), 0);
          }
          try { await runtime.sendMessage({ type: "set-tracking-result", origin, enabled: true }); } catch {}
        } else {
          // Best-effort revoke host permission for this origin
          try {
            const u = new URL(origin);
            const pattern = `${u.protocol}//${u.host}/*`;
            await permissions.remove({ origins: [pattern] }).catch(() => {});
          } catch { /* ignore */ }

          delete allowlist[origin];
          await saveAllowlist();

          const tabId = sender?.tab?.id;
          if (Number.isFinite(tabId)) {
            const s = getState(tabId);
            if (s.origin === origin) {
              s.counts = newCounts();
              s.ids = { canonical: "", ogUrl: "", jsonLdId: "" };
              tabState.set(tabId, s);
              await broadcast(tabId); await updateBadge(tabId);
            }
          }
          try { await runtime.sendMessage({ type: "set-tracking-result", origin, enabled: false }); } catch {}
        }
      })();
      return;
    }
  }

  // Content script → background (page-ids). Must be from injected tab with permission.
  if (msg.type === "page-ids") {
    (async () => {
      if (!(await isFromInjectedContent(sender))) return;

      const tabId = sender?.tab?.id;
      if (!Number.isFinite(tabId)) return;

      const { idsChanged } = integratePageIds(tabId, msg);
      if (idsChanged) {
        await broadcast(tabId);
        await updateBadge(tabId);
      }
    })();
    return;
  }
});

/* -------------------------------- Boot -------------------------------- */

(async function init() {
  await loadAllowlist();
})();

