async function getActiveTabId() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function render({ url, origin, counts }) {
  document.getElementById("url").textContent = url || "(no URL yet)";
  document.getElementById("meta").textContent = origin ? `Origin: ${origin}` : "";
  const { totals, dims } = counts || { totals: {}, dims: {} };
  document.getElementById("all").textContent = totals.all ?? 0;
  document.getElementById("full").textContent = totals.full ?? 0;
  document.getElementById("spa").textContent = totals.spa ?? 0;
  document.getElementById("path").textContent = dims.path ?? 0;
  document.getElementById("query").textContent = dims.query ?? 0;
  document.getElementById("frag").textContent = dims.fragment ?? 0;
}

(async function init() {
  const tabId = await getActiveTabId();
  if (!tabId) return;

  // Ask background for the latest snapshot for this tab
  await browser.runtime.sendMessage({ type: "get-state", tabId });

  // Listen for broadcasts and update if they match our tabId
  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "url-change-state" && msg.tabId === tabId) {
      render(msg);
    }
  });

  // Reset button
  document.getElementById("reset").addEventListener("click", () => {
    browser.tabs.sendMessage(tabId, { type: "manual-reset" }).catch(() => {
      // If no content script, fall back to background handler by tab context
      browser.runtime.sendMessage({ type: "manual-reset" }).catch(() => {});
    });
  });
})();

