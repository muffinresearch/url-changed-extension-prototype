// ids.js — small, no-UI probe to extract canonical / og:url / JSON-LD @id

function extractIds() {
  try {
    const d = document;

    // <link rel="canonical" href="...">
    const canonical = d.querySelector('link[rel="canonical" i]')?.href?.trim() || "";

    // <meta property="og:url" content="...">
    const ogUrl = d.querySelector('meta[property="og:url" i]')?.content?.trim() || "";

    // JSON-LD: look for a top-level @id or mainEntityOfPage.@id/url
    let jsonLdId = "";
    const scripts = d.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      try {
        const data = JSON.parse(s.textContent || "null");
        const candidates = Array.isArray(data) ? data : [data];
        for (const node of candidates) {
          if (!node || typeof node !== "object") continue;
          if (typeof node["@id"] === "string" && node["@id"]) { jsonLdId = node["@id"]; break; }
          const main = node.mainEntityOfPage;
          if (main && typeof main === "object") {
            if (typeof main["@id"] === "string" && main["@id"]) { jsonLdId = main["@id"]; break; }
            if (typeof main.url === "string" && main.url) { jsonLdId = main.url; break; }
          }
          if (typeof node.url === "string" && node.url) { jsonLdId = node.url; break; }
        }
        if (jsonLdId) break;
      } catch { /* ignore bad JSON-LD */ }
    }

    return { canonical, ogUrl, jsonLdId };
  } catch {
    return { canonical: "", ogUrl: "", jsonLdId: "" };
  }
}

// Answer background queries
browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "probe-ids") {
    const ids = extractIds();
    // respond directly back to the sender tab’s background
    browser.runtime.sendMessage({ type: "page-ids", ...ids }).catch(() => {});
  }
});

// Send once on idle load so background has something even before first ping
try {
  const ids = extractIds();
  browser.runtime.sendMessage({ type: "page-ids", ...ids }).catch(() => {});
} catch {}
