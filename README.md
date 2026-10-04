# ChatGPT Web Utils — Mass Delete

A browser extension for `chatgpt.com` that adds checkboxes to sidebar
conversations so you can select and delete many chats at once, with a
confirmation step, concurrency-limited batch deletion, and per-chat
success/failure tracking.

Works on **Firefox** and **Chrome** (Manifest V3, no build step, no
dependencies).

## Features (selection-mode UI)

The sidebar looks untouched until you select something:

- A single tri-state checkbox at the top of the sidebar is the only
  permanent control: empty (none selected) → click selects all;
  checked (all selected) → click clears; minus (partial) → click
  selects all. Double-click always clears, with no select-all flicker.
- Selecting anything enters selection mode: per-conversation checkboxes
  appear, the `N selected` count shows, and `Delete (N)` appears. At
  zero selected, all three hide again and row checkboxes are removed
  from the DOM.
- Row checkboxes never interfere with opening, dragging, pinning, or
  the options menu; clicking a row still opens the chat normally.
- In-memory selection (`Set` of conversation IDs, no duplicates). An
  explicit Select-All latches: newly loaded conversations join the
  selection while it is active.
- Confirmation dialog showing the exact count before anything is deleted
- Live progress (`Deleting… d / N`) and final summary
  (`Deleted 7 conversations.` / `Deleted 5 of 7 conversations. 2 could
  not be deleted.`)
- Batch deletes with a concurrency limit of 4; retries HTTP 429/5xx with
  backoff; failures stay visible and selected for retry
- Successes are removed from the sidebar immediately
- Survives sidebar rerenders (MutationObserver + periodic self-heal);
  never touches ChatGPT's React internals or CSS class names
- Injection waits for React hydration to settle (avoids hydration
  mismatches); event listeners attach immediately since they touch no DOM

## UI cleanup and sidebar behavior (all on by default)

Toggles live in `settings.js` (`massDelete`, `removeUpgrade`,
`removeDisclaimer`, `keepProjectsCollapsed`). No settings UI yet; a
future one can hydrate overrides from extension storage without
touching call sites.

- **Remove Upgrade**: hides the main Upgrade button and the sidebar
  Upgrade entry. Identified by `aria-label="Upgrade"` or exact button
  text, hiding the whole Upgrade-only container so no spacing remains.
- **Remove disclaimer**: hides `ChatGPT can make mistakes…` via
  `[data-testid="thread-disclaimer"] { display: none !important; }`
  (pure CSS — recreated nodes stay hidden automatically).
- **Keep Projects collapsed**: project entries are detected via
  `aria-expanded` regions, `/project*/` links, or header+list
  structure (never class names). Their chat lists are hidden, single
  clicks and hover reveals are suppressed at document capture, and the
  second click of a double-click passes through so Project-home
  navigation keeps working. Conversations and extension UI are exempt.

Note: Select-all and the selection count were intentionally removed in
1.2.0 and stay out; the bar is Clear + `Delete (N)` only.

## Install

### Firefox (temporary)

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on** → select `chatgpt-mass-delete/manifest.json`
3. Open `https://chatgpt.com`

The temporary install is removed when Firefox closes; repeat after each
restart. For a permanent install the package must be signed via
[AMO](https://addons.mozilla.org) (upload, get it signed, install).

### Chrome (unpacked)

1. Open `chrome://extensions`, enable **Developer mode**
2. **Load unpacked** → select the `chatgpt-mass-delete/` folder
3. Open `https://chatgpt.com`

Note: Chrome shows a benign warning about the unrecognized
`browser_specific_settings` key (Firefox-only metadata). It does not
affect loading or behavior. For distribution, package for the
[Chrome Web Store](https://chromewebstore.google.com).

## Usage

1. Click the checkbox at the top of the sidebar to select all chats
   (double-click it to clear). Per-chat boxes appear; untick any you
   want to keep, or tick individual rows (hover a row to reveal its box;
   checked rows stay highlighted).
2. Click **Delete (N)** in the same header area.
3. Confirm the count in the dialog (Cancel aborts, Esc aborts).
4. Watch progress; retry any failures (they remain selected).

Tip: test on 1–2 throwaway chats first. Deletion is permanent.

## How deletion works

Each selected conversation is deleted with its conversation ID only:

```http
DELETE https://chatgpt.com/backend-api/conversation/id/{conversation_id}
```

The request is same-origin with `credentials: 'include'`. ChatGPT's
`backend-api` rejects cookie-only calls, so the extension fetches the
session's access token from ChatGPT's own same-origin `api/auth/session`
endpoint and sends it as the `Authorization` header (user-approved
exception to the no-credentials rule, see below). On HTTP 401 the token
is refreshed once and the request retried.

## Privacy and security

- Only conversation IDs are handled. The access token above is held in
  two in-memory variables: never written to storage/cookies/DOM, never
  logged (verified: no console line references it), and sent only to
  `chatgpt.com/backend-api` — nowhere else, to nobody else.
- No analytics, no remote code, no host permissions beyond the
  `chatgpt.com` content-script match. The extension is inert on all
  other sites.

## Troubleshooting

- **Bar not showing**: open DevTools console and look for
  `[ChatGPT Mass Delete] toolbar mounted (N conversations detected)`.
  No line → the script isn't running the latest build (temporary
  installs don't auto-update: remove and re-add it). Repeating mount
  lines → the sidebar renderer is dropping the bar; it self-heals every
  3 seconds.
- **Deletions fail**: the bar and console report the reason per
  conversation (`HTTP 401/403/404/429/5xx` or `network-error` with the
  underlying error text). `network-error` on every request points at a
  request blocker — try with content/ad blockers (e.g. uBlock Origin)
  disabled on `chatgpt.com`.
- **Checkbox won't toggle**: the toggle runs on document-level
  `pointerdown` capture, so page handlers can't swallow it. If a row
  still misbehaves, note whether it happens on hover, after scrolling,
  or in a specific theme.

## Project structure

```text
chatgpt-mass-delete/
├── manifest.json   # Manifest V3, matches https://chatgpt.com/*
├── settings.js     # Feature toggles (defaults ON, storage-ready)
├── content.js      # Mass delete: detect, select, confirm, delete, observe
├── cleanup.js      # Upgrade/disclaimer removal, project collapse; rides
│                   # content.js's observer via window.__cmdCleanupScan
├── styles.css      # Extension-scoped dark UI ([data-chatgpt-mass-delete])
├── cleanup.css     # Hiding rules ([data-testid], [data-chatgpt-cleanup-hidden])
└── icons/          # SVG source + 16/32/48/128 PNGs
```

No background script, no bundler. Edit, reload the temporary/unpacked
extension, refresh the page.

## Versions

See commit history. Notable: `1.0.6` fixed API calls (absolute URLs —
relative `fetch()` paths don't resolve in this content-script
context); `1.1.x` restyled to the neutral dark UI; `1.2.0` simplified
the bar to Clear + Delete (N); `1.3.0` migrated to MV3 for Chrome;
`1.4.0` added the cleanup/project addendum (settings, Upgrade and
disclaimer removal, keep-projects-collapsed);
`1.5.0` rebuilt mass-delete as native-feeling selection mode (tri-state
top checkbox, `Delete (N)`, Select-All latch, double-click to clear).
