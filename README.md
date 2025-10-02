# Web Extension: URL Changed Extension Prototype

## Important Note 💣

This quick prototype was built by ChatGPT, with all files authored by ChatGPT, and refined based on directions.

⚠️ As a result, it's worth noting that this code may well contain bugs or oversights so ***please use at your own risk***, and it should be considered **experimental**.


## Overview

A minimal WebExtension for Firefox that tracks how often pages change their URL while you use them. It distinguishes **full navigations** vs **History API** changes, and also counts changes to **path**, **query**, and **fragment id**. It optionally inspects common “document identity” metadata: **canonical URL**, **Opengraph URL**, and **JSON-LD `@id`**.

The UI lives in a **sidebar** with a responsive **Live → Synced** status so it feels instant but stays consistent with the background state.


## Features (at a glance)

* **Per-origin opt-in** via **optional host permissions** (door-hanger).
* **Counters**: Total, Full, History API, Path, Query, Fragment id.
* **Metadata cards**: Core URL, Origin, Canonical, Opengraph URL, JSON-LD `@id` (+ per-field change counts).
* **Automatic baseline** on tab focus; **Reset** button to re-baseline manually.
* **Live / Synced** badge for responsive UI with background confirmation.
* **“Not available on about: pages”** banner when the current page isn’t HTTP(S).
* **Per-origin permission revocation** when tracking is turned Off.

---

## How it works

### Components

* **background.js** (MV3)

  * Tracks per-tab state: last URL, counts, and latest metadata.
  * Listens to:
    * `tabs.onUpdated` (URL/status complete),
    * `webNavigation.onCommitted` (full navigation),
    * `webNavigation.onHistoryStateUpdated` (History API).
  * Only *counts* and *probes metadata* when the user has granted host permission for that origin.
  * Injects `ids.js` (content script) **programmatically** when needed.

* **ids.js** (content)

  * Runs in the page **only after** the background injects it and sends a **nonce**.
  * Extracts `rel=canonical`, `og:url`, and JSON-LD `@id`, then reports them back with the nonce.

* **sidebar.html / sidebar.js / sidebar.css**

  * Shows title + **counts grid**.
  * Renders each URL/metadata as a **card** with a small header (label + count) and the URL beneath.
  * **Tracking** toggle (On → request permission, Off → revoke).
  * **Reset** re-baselines current tab.
  * **Live** appears immediately on changes; flips to **Synced** once a confirmed snapshot arrives from background.
  * Shows **banner** on non-HTTP(S) pages; hides it automatically when you switch to HTTP(S).

### Counting rules

* The very first load after a baseline is **not** counted.
* On within-origin changes, counts increment as appropriate:

  * **Full** vs **History API** (committed navigation vs history state change),
  * **Path**, **Query**, **Fragment id** deltas.
* **Origin change** triggers an automatic **reset/baseline**.

---

## Permissions model (and runtime requests)

* `manifest.json`:

  * `"permissions": ["tabs", "webNavigation", "scripting"]`
  * `"optional_host_permissions": ["<all_urls>"]`
* **Tracking is off by default.**
  Enabling tracking for the current origin triggers `browser.permissions.request({ origins: ["https://example.com/*"] })`.
  Disabling tracking revokes it via `browser.permissions.remove({ origins: [...] })`.
* Note: In Firefox, `webNavigation` events are delivered **only** for hosts you have permission for—so the optional permission gates both metadata probing and navigation event flow.

---

## Security considerations

* **Runtime host permissions**: Permissions for hosts are requested at runtime.
* **Origin-gated injection**: `ids.js` is injected only when the current origin has host permission.
* **Per-tab nonce**: background generates a random nonce, sends it to `ids.js` (`init-probe`), and requires that same nonce on every `page-ids` message.
* **Sender checks**:
  * Sidebar → background messages are accepted only from our own extension pages.
  * Content → background messages are accepted only from injected tabs **with** current host permission and the **correct nonce**.
* **XSS-safe UI**: Sidebar uses `textContent` (never `innerHTML`); long strings are truncated visually and shown fully on hover via `title` attributes.

---

## Baseline, reset, and focus

* **Baseline** establishes the “starting” URL and clears counts + metadata. The first metadata snapshot after baseline does **not** increment counts.
* **Auto-baseline** runs on **tab focus** (if tracking is enabled for that origin).
* **Reset** in the sidebar triggers a baseline for the active tab.

---

## Live vs. Synced

* **Live** appears immediately after a navigation/URL change or when the UI asks the background for state—this is an optimistic render.
* **Synced** replaces Live once a confirmed snapshot arrives from the background (after a minimum display time), ensuring counters and metadata reflect the canonical state.

## Unsupported pages

* On `about:`, `file:`, or other non-HTTP(S) schemes, the sidebar:

  * Disables controls,
  * Shows a **“Not available on about: pages”** banner,
  * Clears when you move back to an HTTP(S) page.

## Development

1. **Clone** into a folder with:

   * `manifest.json` (MV3, service worker disabled; background uses `"scripts"` + `"type": "module"` as per current Firefox behaviour)
   * `background.js`, `ids.js`
   * `sidebar.html`, `sidebar.js`, `sidebar.css`
2. **Load temporary add-on** in Firefox:

   * `about:debugging` → “This Firefox” → “Load Temporary Add-on…” → select `manifest.json`.
3. Open the **Sidebar** (View → Sidebar → URL Change Counters), navigate a site, and toggle **Tracking** On to grant the per-origin permission.

## File overview

* `manifest.json` — MV3 manifest with optional host permissions.
* `background.js` — state, counting, permission checks, secure messaging, programmatic injection.
* `ids.js` — metadata probe running in the page with nonce validation.
* `sidebar.html` — sidebar layout (counts grid + cards).
* `sidebar.js` — UI wiring, badge state, permission request/revoke, secure message handling.
* `sidebar.css` — theming (light/dark), grids, cards, badges, banner, toast.

## Notes / limitations

* Navigation counting is **per-tab** and **per-origin** opt-in.
* Metadata is re-probed whenever the core URL changes or a page load completes. Changes to canonical/Opengraph/JSON-LD after that point will increment their counters automatically. Resetting simply clears counts and establishes a new baseline.

