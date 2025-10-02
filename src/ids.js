// ids.js — injected programmatically; only responds after receiving a valid nonce.
// Never trusts messages without the expected nonce; never uses innerHTML.

let EXPECTED_NONCE = null;

function getCanonical() {
  const link = document.querySelector('link[rel="canonical"]');
  return link && link.href ? String(link.href) : "";
}
function getOgUrl() {
  const meta = document.querySelector('meta[property="og:url"], meta[name="og:url"]');
  return meta && meta.content ? String(meta.content) : "";
}
function getJsonLdId() {
  try {
    const nodes = document.querySelectorAll('script[type="application/ld+json"]');
    for (const n of nodes) {
      try {
        const obj = JSON.parse(n.textContent || "null");
        if (obj && typeof obj === "object") {
          const id = Array.isArray(obj) ? (obj.find(x => x && typeof x === "object" && x["@id"]) || {})["@id"] : obj["@id"];
          if (id && typeof id === "string") {
            return id;
          }
        }
      } catch {
        // ignore malformed JSON-LD
      }
    }
    return "";
  } catch {
    return "";
  }
}

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) {
    return;
  }

  if (msg.type === "init-probe") {
    // Set the expected nonce from background
    if (typeof msg.nonce === "string" && msg.nonce.length >= 8) {
      EXPECTED_NONCE = msg.nonce;
    }
    return;
  }

  if (msg.type === "probe-ids") {
    if (!EXPECTED_NONCE) {
      return; // refuse to operate without nonce
    }
    const payload = {
      type: "page-ids",
      canonical: getCanonical(),
      ogUrl: getOgUrl(),
      jsonLdId: getJsonLdId(),
      nonce: EXPECTED_NONCE
    };
    try {
      browser.runtime.sendMessage(payload).catch(() => {});
    } catch {
      // ignore
    }
    return;
  }
});
