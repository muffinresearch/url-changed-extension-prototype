// background.js — Firefox MV3
// - Optional host permissions (requested/revoked by the sidebar UI)
// - No storage: tracking state == host permission for the origin
// - Secure messaging with per-tab nonce
// - Programmatic ids.js injection
// - Baseline on tab focus; count URL changes only when permission exists

const { action, runtime, tabs, webNavigation, scripting, permissions } = browser;

/* --------------------------- State (memory only) --------------------------- */

const CORE_PROTOCOLS = new Set(["http:", "https:", "file:"]);

// Per-tab state for counts + identifiers
const tabState = new Map(); // Map<tabId, { lastUrl, origin, hasBaseline, suppressNextIdIncrements, counts, ids }>

// Tabs we injected ids.js into (used for message authentication)
const injectedTabs = new Set(); // Set<tabId>

// Per-tab nonce shared with ids.js to authenticate messages
const tabNonce = new Map(); // Map<tabId, string>

// Per-tab debounce timers for metadata probes
const probeTimers = new Map(); // Map<tabId, number>

/* --------------------------- Helpers & utilities --------------------------- */

function newCounts() {
  return {
    totals: { all: 0, full: 0, spa: 0 },
    dims:   { path: 0, query: 0, fragment: 0 },
    ids:    { canonical: 0, ogUrl: 0, jsonLdId: 0 }
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
      ids: { canonical: "", ogUrl: "", jsonLdId: "" }
    });
  }
  return tabState.get(tabId);
}

function toURL(u) {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

function isCoreProtocol(url) {
  try {
    return CORE_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function originOf(u) {
  return `${u.protocol}//${u.host}`;
}

function isMainFrame(d) {
  return d?.frameId === 0;
}

function diffComponents(prev, next) {
  if (!prev) {
    return { origin: false, path: false, query: false, fragment: false };
  }
  return {
    origin: prev.protocol !== next.protocol || prev.host !== next.host,
    path: prev.pathname !== next.pathname,
    query: prev.search !== next.search,
    fragment: prev.hash !== next.hash
  };
}

function patternForOrigin(origin) {
  if (!origin) {
    return null;
  }
  try {
    const u = new URL(origin);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

async function hasHostPerm(origin) {
  const pattern = patternForOrigin(origin);
  if (!pattern) {
    return false;
  }
  try {
    return await permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

function extURLPrefix() {
  return runtime.getURL(""); // moz-extension://<uuid>/
}

function debounced(key, fn, delay = 150) {
  const prev = probeTimers.get(key);
  if (prev) {
    clearTimeout(prev);
  }
  const id = setTimeout(fn, delay);
  probeTimers.set(key, id);
}

/* --------------------------- Programmatic injection --------------------------- */

function makeNonce() {
  // 128-bit random hex
  const a = crypto.getRandomValues(new Uint32Array(4));
  return Array.from(a, x => x.toString(16).padStart(8, "0")).join("");
}

// Inject ids.js and send the init token; safe to call repeatedly.
async function ensureInjectedWithNonce(tabId) {
  try {
    const tab = await tabs.get(tabId);
    if (!tab?.url) {
      return;
    }
    const u = new URL(tab.url);
    const origin = `${u.protocol}//${u.host}`;

    // Only inject if host permission exists
    if (!(await hasHostPerm(origin))) {
      return;
    }

    // Execute ids.js (no-op if already loaded; that's fine)
    await scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["ids.js"]
    }).catch(() => {});

    // Generate or reuse a per-tab nonce
    if (!tabNonce.has(tabId)) {
      tabNonce.set(tabId, makeNonce());
    }
    const nonce = tabNonce.get(tabId);

    // Send init message to content with the nonce
    await tabs.sendMessage(tabId, { type: "init-probe", nonce }).catch(() => {});

    injectedTabs.add(tabId);
  } catch {
    // ignore
  }
}

async function refreshPageIds(tabId) {
  await ensureInjectedWithNonce(tabId);
  try {
    await tabs.sendMessage(tabId, { type: "probe-ids" });
  } catch {
    // ignore (no script/page)
  }
}

/* --------------------------- Badge + snapshot --------------------------- */

async function snapshotForWithLiveUrl(tabId) {
  const s = getState(tabId);
  let url = s.lastUrl || "";
  let origin = s.origin || "";

  if (!url) {
    try {
      const tab = await tabs.get(tabId);
      if (tab?.url) {
        url = tab.url;
        try {
          const u = new URL(url);
          origin = `${u.protocol}//${u.host}`;
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  const trackingEnabled = await hasHostPerm(origin);
  return { tabId, url, origin, counts: s.counts, ids: s.ids, trackingEnabled };
}

async function broadcast(tabId) {
  const snap = await snapshotForWithLiveUrl(tabId);
  try {
    await runtime.sendMessage({ type: "url-change-state", ...snap });
  } catch {
    // ignore
  }
}

async function updateBadge(tabId) {
  const snap = await snapshotForWithLiveUrl(tabId);
  const txt = (snap.trackingEnabled && snap.counts.totals.all) ? String(snap.counts.totals.all) : "";
  try {
    await action.setBadgeText({ tabId, text: txt });
    await action.setBadgeBackgroundColor?.({ tabId, color: "#444" });
  } catch {
    // ignore
  }
}

/* --------------------------- Metadata integration --------------------------- */

function integratePageIds(tabId, incoming) {
  const s = getState(tabId);
  const suppress = s.suppressNextIdIncrements;
  const { canonical = "", ogUrl = "", jsonLdId = "" } = incoming || {};

  let idsChanged = false;

  const consider = (key, val) => {
    if (!val) {
      return;
    }
    const prev = s.ids[key] || "";
    const changed = prev !== val;
    if (changed) {
      idsChanged = true;
    }
    s.ids[key] = val;
    if (changed && s.hasBaseline && !suppress) {
      s.counts.ids[key] += 1;
    }
  };

  consider("canonical", canonical);
  consider("ogUrl", ogUrl);
  consider("jsonLdId", jsonLdId);

  if (suppress) {
    s.suppressNextIdIncrements = false;
  }

  tabState.set(tabId, s);
  return { idsChanged };
}

/* --------------------------- Baseline / reset flow --------------------------- */

async function baselineTab(tabId) {
  const s = getState(tabId);

  // Grab live URL
  let liveUrl = "";
  try {
    const tab = await tabs.get(tabId);
    liveUrl = tab?.url || "";
  } catch {
    // ignore
  }

  if (!liveUrl || !isCoreProtocol(liveUrl)) {
    s.lastUrl = null;
    s.origin = null;
    s.hasBaseline = false;
    s.counts = newCounts();
    s.ids = { canonical: "", ogUrl: "", jsonLdId: "" };
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
  s.suppressNextIdIncrements = true; // first metadata snapshot is baseline
  tabState.set(tabId, s);

  await broadcast(tabId);
  await updateBadge(tabId);

  // If permission exists, probe identifiers immediately
  debounced(tabId, () => refreshPageIds(tabId), 0);
}

/* --------------------------- URL change handling --------------------------- */

async function handleUrlChange(tabId, url, source /* 'full' | 'spa' */) {
  if (!isCoreProtocol(url)) {
    return;
  }

  const s = getState(tabId);
  const next = toURL(url);
  if (!next) {
    return;
  }

  const origin = originOf(next);
  const trackingEnabled = await hasHostPerm(origin);

  // If tracking is off (no permission), keep minimal baseline; do not count or probe.
  if (!trackingEnabled) {
    s.lastUrl = url;
    s.origin = origin;
    s.hasBaseline = true;
    tabState.set(tabId, s);
    await broadcast(tabId);
    await updateBadge(tabId);
    return;
  }

  const prevUrl = s.lastUrl;
  const prevHasBaseline = s.hasBaseline;

  if (!prevHasBaseline) {
    await baselineTab(tabId);
    return;
  }

  if (prevUrl === url) {
    return;
  }

  const prev = toURL(prevUrl);
  const diffs = diffComponents(prev, next);

  if (prev && diffs.origin) {
    await baselineTab(tabId);
    return;
  }

  // Within-origin change: count + advance baseline
  s.counts.totals.all += 1;
  if (source === "spa") {
    s.counts.totals.spa += 1;
  } else {
    s.counts.totals.full += 1;
  }
  if (diffs.path) {
    s.counts.dims.path += 1;
  }
  if (diffs.query) {
    s.counts.dims.query += 1;
  }
  if (diffs.fragment) {
    s.counts.dims.fragment += 1;
  }

  s.lastUrl = url;
  s.origin = origin;
  tabState.set(tabId, s);

  await broadcast(tabId);
  await updateBadge(tabId);
  debounced(tabId, () => refreshPageIds(tabId));
}

/* -------------------------------- Listeners -------------------------------- */

// Firefox will only deliver webNavigation events for hosts we have permission for.

tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    handleUrlChange(tabId, changeInfo.url, "full");
  }
  if (changeInfo.status === "complete") {
    debounced(tabId, () => refreshPageIds(tabId));
  }
});

webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (isMainFrame(d)) {
    handleUrlChange(d.tabId, d.url, "spa");
  }
});

webNavigation.onCommitted.addListener((d) => {
  if (isMainFrame(d)) {
    handleUrlChange(d.tabId, d.url, "full");
  }
});

tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  injectedTabs.delete(tabId);
  tabNonce.delete(tabId);
  const t = probeTimers.get(tabId);
  if (t) {
    clearTimeout(t);
  }
  probeTimers.delete(tabId);
});

// Baseline on tab focus; if permission exists, probe immediately
tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await tabs.get(tabId);
    const url = tab?.url || "";
    const origin = (url && isCoreProtocol(url)) ? `${new URL(url).protocol}//${new URL(url).host}` : null;

    if (origin && await hasHostPerm(origin)) {
      await baselineTab(tabId);
      debounced(tabId, () => refreshPageIds(tabId), 0);
    } else {
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
});

/* ----------------------------- Secure messaging ----------------------------- */

function isFromExtensionUI(sender) {
  const src = sender?.url || "";
  return src.startsWith(extURLPrefix());
}

async function isFromInjectedContent(sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isFinite(tabId)) {
    return false;
  }
  if (!injectedTabs.has(tabId)) {
    return false;
  }
  try {
    const tab = await tabs.get(tabId);
    if (!tab?.url) {
      return false;
    }
    const u = new URL(tab.url);
    const pattern = `${u.protocol}//${u.host}/*`;
    if (!(await permissions.contains({ origins: [pattern] }))) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) {
    return;
  }

  // UI → background
  if (["get-state", "manual-reset", "set-tracking"].includes(msg.type)) {
    if (!isFromExtensionUI(sender)) {
      return;
    }

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
        if (!Number.isFinite(tabId)) {
          return;
        }
        await baselineTab(tabId);
      })();
      return;
    }

    if (msg.type === "set-tracking") {
      (async () => {
        const { origin, enabled } = msg;

        // Only http/https origins are supported
        if (!/^https?:\/\/[^/]+$/.test(origin || "")) {
          try {
            await runtime.sendMessage({ type: "set-tracking-result", origin, enabled: false, reason: "unsupported_origin" });
          } catch {
            // ignore
          }
          return;
        }

        if (enabled) {
          // Baseline & probe if sender tab matches
          const tabId = sender?.tab?.id;
          if (Number.isFinite(tabId)) {
            await baselineTab(tabId);
            debounced(tabId, () => refreshPageIds(tabId), 0);
          }
          try {
            await runtime.sendMessage({ type: "set-tracking-result", origin, enabled: true });
          } catch {
            // ignore
          }
        } else {
          // Defensive: also attempt to remove permission here (UI already tries)
          try {
            const u = new URL(origin);
            const pattern = `${u.protocol}//${u.host}/*`;
            await permissions.remove({ origins: [pattern] }).catch(() => {});
          } catch {
            // ignore
          }

          // Clear visible state for matching tab
          const tabId = sender?.tab?.id;
          if (Number.isFinite(tabId)) {
            const s = getState(tabId);
            if (s.origin === origin) {
              s.counts = newCounts();
              s.ids = { canonical: "", ogUrl: "", jsonLdId: "" };
              tabState.set(tabId, s);
              await broadcast(tabId);
              await updateBadge(tabId);
            }
          }
          try {
            await runtime.sendMessage({ type: "set-tracking-result", origin, enabled: false });
          } catch {
            // ignore
          }
        }
      })();
      return;
    }
  }

  // Content → background (page-ids) with nonce & permission checks
  if (msg.type === "page-ids") {
    (async () => {
      if (!(await isFromInjectedContent(sender))) {
        return;
      }
      const tabId = sender?.tab?.id;
      if (!Number.isFinite(tabId)) {
        return;
      }

      // Nonce/token validation
      const expected = tabNonce.get(tabId);
      if (!expected || msg.nonce !== expected) {
        return;
      }

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

(function init() {
  // Nothing to load — permission state is the source of truth.
})();
