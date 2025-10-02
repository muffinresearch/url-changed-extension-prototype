// sidebar.js — class-based banner/toast, hardened messaging, permission request/revoke,
// about: support with robust clearing, yellow flash, and dynamic tab title tooltip.

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
  canonUrl: document.getElementById("canonUrl"),
  canonCount: document.getElementById("canonCount"),
  ogUrl: document.getElementById("ogUrl"),
  ogCount: document.getElementById("ogCount"),
  jsonId: document.getElementById("jsonId"),
  jsonCount: document.getElementById("jsonCount"),

  trackToggle: document.getElementById("trackToggle"),
  trackStatus: document.getElementById("trackStatus"),

  unavailableBanner: document.getElementById("unavailableBanner"),
  toast: document.getElementById("toast")
};

let selectedTabId = null;
let currentTrackingEnabled = null; // null = unknown
const MIN_LIVE_MS = 500;
let liveShownAt = 0;
let flipTimer = null;
let lastFocusedWindowId = null;
let lastKnownProtocol = null;

/* ---------------- Utilities ---------------- */

function setText(el, text) {
  const next = text == null ? "" : String(text);
  if ((el?.textContent ?? "") === next) {
    return false;
  }
  if (el) {
    el.textContent = next;
  }
  return true;
}

function setTextWithFlash(el, text, { flash = true } = {}) {
  const changed = setText(el, text);
  if (!changed || !flash || !el) {
    return;
  }
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

function multiSet(pairs, { flash = true } = {}) {
  for (const [el, val] of pairs) {
    setTextWithFlash(el, val, { flash });
  }
}

function isHttpOriginText(s) {
  return typeof s === "string" && /^https?:\/\/[^/]+$/.test(s);
}

function protocolOf(url) {
  try {
    return new URL(url).protocol;
  } catch {
    return "";
  }
}

function isSupportedProtocol(proto) {
  return proto === "http:" || proto === "https:";
}

function patternForOriginText(originText) {
  try {
    const u = new URL(originText);
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}

/* ---------------- Badge (class-based) ---------------- */

function showLiveBadge() {
  const b = fields.liveBadge;
  if (!b) {
    return;
  }
  b.textContent = "Live";
  b.classList.remove("badge--synced");
  b.classList.add("badge--live");
  b.classList.remove("is-hidden");
  liveShownAt = Date.now();
  if (flipTimer) {
    clearTimeout(flipTimer);
    flipTimer = null;
  }
}

function showSyncedBadge() {
  const b = fields.liveBadge;
  if (!b) {
    return;
  }
  b.textContent = "Synced";
  b.classList.remove("badge--live");
  b.classList.add("badge--synced");
  b.classList.remove("is-hidden");
  if (flipTimer) {
    clearTimeout(flipTimer);
    flipTimer = null;
  }
}

function hideBadge() {
  const b = fields.liveBadge;
  if (!b) {
    return;
  }
  b.classList.add("is-hidden");
  if (flipTimer) {
    clearTimeout(flipTimer);
    flipTimer = null;
  }
}

/* ---------------- Unavailable mode (about:, file:, etc.) ---------------- */

function showUnavailableBanner(show) {
  const el = fields.unavailableBanner;
  if (!el) {
    return;
  }
  if (show) {
    el.classList.remove("is-hidden");
  } else {
    el.classList.add("is-hidden");
  }
}

function applyUnavailableUI(originText, note = "(unavailable here)") {
  if (fields.trackToggle) {
    fields.trackToggle.disabled = true;
    fields.trackToggle.checked = false;
  }
  if (fields.trackStatus) {
    setText(fields.trackStatus, "Off");
  }
  if (fields.resetBtn) {
    fields.resetBtn.disabled = true;
  }

  setTextWithFlash(fields.coreOrigin, originText || "(none)", { flash: false });

  const dash = "—";
  multiSet([
    [fields.all, dash], [fields.full, dash], [fields.spa, dash],
    [fields.path, dash], [fields.query, dash], [fields.frag, dash]
  ], { flash: false });

  multiSet([
    [fields.coreUrl, note],
    [fields.canonUrl, note],
    [fields.ogUrl, note],
    [fields.jsonId, note]
  ], { flash: false });

  showUnavailableBanner(true);
  hideBadge();
}

function clearUnavailableUI() {
  if (fields.resetBtn) {
    fields.resetBtn.disabled = false;
  }
  showUnavailableBanner(false);
}

/* ---------------- Rendering (supported pages) ---------------- */

function renderCounters(counts) {
  const { totals = {}, dims = {} } = counts || {};
  if (currentTrackingEnabled === false) {
    multiSet([
      [fields.all, "—"], [fields.full, "—"], [fields.spa, "—"],
      [fields.path, "—"], [fields.query, "—"], [fields.frag, "—"]
    ], { flash: false });
    return;
  }
  multiSet([
    [fields.all, totals.all ?? 0],
    [fields.full, totals.full ?? 0],
    [fields.spa, totals.spa ?? 0],
    [fields.path, dims.path ?? 0],
    [fields.query, dims.query ?? 0],
    [fields.frag, dims.fragment ?? 0]
  ]);
}

function renderMetadataTrackingOn({ url, origin, counts, ids }) {
  setTextWithFlash(fields.coreOrigin, origin || "(none)");
  setTextWithFlash(fields.coreUrl, url || "(none)");

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
  multiSet([[fields.coreUrl, off], [fields.canonUrl, off], [fields.ogUrl, off], [fields.jsonId, off]], { flash: false });
}

function renderSnapshot(snap) {
  currentTrackingEnabled = !!snap.trackingEnabled;

  const originTxt = snap.origin || "";
  const isHttp = isHttpOriginText(originTxt);
  if (fields.trackToggle) {
    fields.trackToggle.disabled = !isHttp;
    fields.trackToggle.checked = currentTrackingEnabled;
  }
  if (fields.trackStatus) {
    setText(fields.trackStatus, currentTrackingEnabled ? "On" : "Off");
  }

  renderCounters(snap.counts);
  if (currentTrackingEnabled) {
    renderMetadataTrackingOn(snap);
  } else {
    renderMetadataTrackingOff(snap.origin);
  }
}

/* ---------------- Title + live fetch ---------------- */

function formatTitle(tab) {
  const t = (tab.title || "").trim();
  if (t) {
    return t;
  }
  const u = tab.url || "";
  try {
    const p = new URL(u);
    if (["about:", "moz-extension:", "chrome:"].includes(p.protocol)) {
      return `${p.protocol}${p.pathname || ""}`;
    }
    return p.host || u;
  } catch {
    return u || "(current tab)";
  }
}

function setTabTitleEl(tab) {
  const full = (tab.title && tab.title.trim()) || tab.url || "Current Tab";
  if (fields.tabTitle) {
    fields.tabTitle.title = full;
    setTextWithFlash(fields.tabTitle, formatTitle(tab), { flash: false });
  }
}

async function showLiveForActiveTab({ optimistic = false } = {}) {
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!active) {
    return;
  }
  selectedTabId = active.id;

  setTabTitleEl(active);

  let origin = "(none)";
  let proto = "";
  try {
    proto = protocolOf(active.url);
    origin = (active.url && isSupportedProtocol(proto)) ? new URL(active.url).origin : "(none)";
  } catch {
    // ignore
  }

  lastKnownProtocol = proto;
  setTextWithFlash(fields.coreOrigin, origin, { flash: false });

  if (!isSupportedProtocol(proto)) {
    applyUnavailableUI(origin, "(unavailable here)");
    return;
  }

  clearUnavailableUI();

  if (currentTrackingEnabled === null || optimistic === false) {
    multiSet([[fields.coreUrl, "(loading…)"], [fields.canonUrl, "(loading…)"], [fields.ogUrl, "(loading…)"], [fields.jsonId, "(loading…)"]], { flash: false });
  }

  showLiveBadge();
  browser.runtime.sendMessage({ type: "get-state", tabId: selectedTabId }).catch(() => {});
}

/* ---------------- Toast ---------------- */

function showToast(message, ms = 1800) {
  const el = fields.toast;
  if (!el) {
    return;
  }
  setText(el, message);
  el.classList.add("toast--show");
  setTimeout(() => {
    el.classList.remove("toast--show");
  }, ms);
}

/* ---------------- Events ---------------- */

if (fields.resetBtn) {
  fields.resetBtn.addEventListener("click", async () => {
    if (fields.resetBtn.disabled) {
      return;
    }
    const tabId = selectedTabId;
    if (!Number.isFinite(tabId)) {
      return;
    }

    multiSet([[fields.all, 0], [fields.full, 0], [fields.spa, 0], [fields.path, 0], [fields.query, 0], [fields.frag, 0]], { flash: false });
    multiSet([[fields.canonUrl, "(loading…)"], [fields.ogUrl, "(loading…)"], [fields.jsonId, "(loading…)"], [fields.canonCount, 0], [fields.ogCount, 0], [fields.jsonCount, 0]], { flash: false });

    try {
      await browser.runtime.sendMessage({ type: "manual-reset", tabId });
    } catch {
      // ignore
    }
    browser.runtime.sendMessage({ type: "get-state", tabId }).catch(() => {});
  });
}

// Secure message handling: only accept messages from our own extension id.
browser.runtime.onMessage.addListener((msg, sender) => {
  if (sender?.id !== browser.runtime.id) {
    return;
  }
  if (!msg || !msg.type) {
    return;
  }

  if (msg.type === "set-tracking-result") {
    const originText = fields.coreOrigin?.textContent || "";
    if (msg.origin === originText) {
      const ok = !!msg.enabled;
      if (fields.trackToggle) {
        fields.trackToggle.checked = ok;
      }
      if (fields.trackStatus) {
        setText(fields.trackStatus, ok ? "On" : "Off");
      }
      if (!ok) {
        showToast("Permission revoked");
      }
      browser.runtime.sendMessage({ type: "get-state" }).catch(() => {});
    }
    return;
  }

  if (msg.type !== "url-change-state" || msg.tabId !== selectedTabId) {
    return;
  }

  if (!(lastKnownProtocol && isSupportedProtocol(lastKnownProtocol))) {
    applyUnavailableUI(fields.coreOrigin?.textContent || "(none)");
    return;
  }

  const elapsed = Date.now() - liveShownAt;
  const doRender = () => {
    renderSnapshot(msg);
    showSyncedBadge();
  };

  if (elapsed >= MIN_LIVE_MS) {
    doRender();
  } else {
    if (flipTimer) {
      clearTimeout(flipTimer);
    }
    flipTimer = setTimeout(doRender, MIN_LIVE_MS - elapsed);
  }
});

// Follow active tab and window focus
browser.tabs.onActivated.addListener(async () => {
  currentTrackingEnabled = null;
  await showLiveForActiveTab({ optimistic: false });
});

browser.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) {
    return;
  }
  if (lastFocusedWindowId === windowId && currentTrackingEnabled !== null) {
    return;
  }
  lastFocusedWindowId = windowId;

  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!active) {
    return;
  }
  if (selectedTabId === active.id && currentTrackingEnabled !== null) {
    return;
  }

  currentTrackingEnabled = null;
  await showLiveForActiveTab({ optimistic: false });
});

// Keep title + origin fresh and re-sync on URL change for the active tab
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== selectedTabId) {
    return;
  }

  if (changeInfo.title) {
    setTabTitleEl(tab);
  }

  if (changeInfo.url) {
    const proto = protocolOf(changeInfo.url);
    lastKnownProtocol = proto;
    const isSupported = isSupportedProtocol(proto);

    if (isSupported) {
      clearUnavailableUI(); // <-- ensure banner is removed and controls re-enabled
      try {
        const o = new URL(changeInfo.url).origin;
        setTextWithFlash(fields.coreOrigin, o, { flash: false });
      } catch {
        setTextWithFlash(fields.coreOrigin, "(none)", { flash: false });
      }

      if (currentTrackingEnabled === true) {
        setTextWithFlash(fields.coreUrl, changeInfo.url);
      } else {
        setTextWithFlash(fields.coreUrl, "(loading…)", { flash: false });
      }

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

if (fields.trackToggle) {
  fields.trackToggle.addEventListener("change", async () => {
    const origin = fields.coreOrigin?.textContent || "";
    if (!isHttpOriginText(origin)) {
      fields.trackToggle.checked = false;
      if (fields.trackStatus) {
        setText(fields.trackStatus, "Off");
      }
      return;
    }

    const enabling = !!fields.trackToggle.checked;

    if (enabling) {
      const pattern = patternForOriginText(origin);
      if (!pattern) {
        return;
      }
      try {
        const granted = await browser.permissions.request({ origins: [pattern] });
        if (!granted) {
          fields.trackToggle.checked = false;
          if (fields.trackStatus) {
            setText(fields.trackStatus, "Off");
          }
          browser.runtime.sendMessage({ type: "set-tracking", origin, enabled: false }).catch(() => {});
          return;
        }
      } catch {
        fields.trackToggle.checked = false;
        if (fields.trackStatus) {
          setText(fields.trackStatus, "Off");
        }
        return;
      }

      if (fields.trackStatus) {
        setText(fields.trackStatus, "On");
      }
      currentTrackingEnabled = null;
      browser.runtime.sendMessage({ type: "set-tracking", origin, enabled: true }).catch(() => {});
      browser.runtime.sendMessage({ type: "get-state" }).catch(() => {});
      return;
    }

    try {
      const pattern = patternForOriginText(origin);
      if (pattern) {
        await browser.permissions.remove({ origins: [pattern] }).catch(() => {});
      }
    } catch {
      // ignore
    }

    if (fields.trackStatus) {
      setText(fields.trackStatus, "Off");
    }
    showToast("Permission revoked");
    currentTrackingEnabled = null;
    browser.runtime.sendMessage({ type: "set-tracking", origin, enabled: false }).catch(() => {});
    browser.runtime.sendMessage({ type: "get-state" }).catch(() => {});
  });
}

/* -------------------------------- Boot -------------------------------- */

(async function init() {
  await showLiveForActiveTab({ optimistic: false });
})();

