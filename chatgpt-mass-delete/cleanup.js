/* ChatGPT cleanup + project-sidebar behavior.
 *
 * Runs after settings.js and content.js (see manifest order). Owns no
 * MutationObserver of its own: content.js calls window.__cmdCleanupScan()
 * from its already-debounced scan, so all features share one coordinated
 * observer. Event interception below only touches the DOM by tagging;
 * actual hiding is done by cleanup.css.
 *
 * Selectors use only stable semantic/data attributes — never ChatGPT's
 * generated class names.
 */
(() => {
  'use strict';

  if (window.__chatgptCleanupInjected) return;
  window.__chatgptCleanupInjected = true;

  const SIDEBAR_ITEM_SELECTOR = '[data-sidebar-item="true"]';
  const OPTIONS_TRIGGER_SELECTOR = '[data-conversation-options-trigger]';
  // Definitive project-row selector (stable semantic attributes only).
  const PROJECT_ROW_SELECTOR =
    '[data-sidebar-item="true"][data-sidebar-keep-open="true"][role="button"]';
  const TRAILING_BUTTON_SELECTOR = 'button[data-trailing-button]';
  const PROJECT_HOME_LABEL = 'Open project home';

  const HIDDEN_ATTR = 'data-chatgpt-cleanup-hidden';
  const ENTRY_ATTR = 'data-chatgpt-mass-delete-project';
  const ENTRY_VALUE = 'true';

  const CONVERSATION_ID_PATTERN = /\/c\/([0-9a-f-]{8,})/i;
  const PROJECT_HREF_PATTERN = /project/i;
  const STRUCTURAL_TAGS = /^(NAV|ASIDE|MAIN|BODY|HTML)$/;

  // Single/double-click model for project rows: EVERY click on the row is
  // suppressed before ChatGPT's native handler can expand it. A lone click
  // does nothing (stays collapsed). Two clicks on the same row within this
  // window count as a double-click: collapse is ensured and the existing
  // "Open project home" button is triggered programmatically.
  const DOUBLE_CLICK_MS = 450;

  function enabled(name) {
    try {
      if (window.__cmdSettings) return window.__cmdSettings.isEnabled(name);
      return true;
    } catch {
      return true;
    }
  }

  function sidebarRoot() {
    const items = document.querySelectorAll(SIDEBAR_ITEM_SELECTOR);
    if (items.length > 0) {
      return items[0].closest('nav') || items[0].closest('aside') || document.body;
    }
    return document.querySelector('nav') || document.querySelector('aside') || document.body;
  }

  function isProjectRow(el) {
    return el instanceof Element && el.matches(PROJECT_ROW_SELECTOR);
  }

  function isConversationItem(el) {
    // Project rows also carry data-sidebar-item — the keep-open marker
    // is what distinguishes real conversations from projects.
    return (
      el instanceof Element &&
      el.matches(SIDEBAR_ITEM_SELECTOR) &&
      !el.matches('[data-sidebar-keep-open="true"]')
    );
  }

  function countItems(el) {
    try {
      return el.querySelectorAll(
        '[data-sidebar-item="true"]:not([data-sidebar-keep-open="true"])'
      ).length;
    } catch {
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Remove Upgrade UI.
  // Identification: aria-label="Upgrade" or exact button text "Upgrade".
  // Hiding: climb while the ancestor's whole text is exactly "Upgrade"
  // (pure upgrade container → no empty spacing left), capped and never
  // past structural tags. Tag once; skip anything already hidden.
  // ---------------------------------------------------------------------------
  const seenUpgradeButtons = new WeakSet();

  // Text comparison ignoring SVG internals (<title> etc.), which would
  // otherwise poison exact "Upgrade" matches.
  function upgradeText(el) {
    try {
      const clone = el.cloneNode(true);
      for (const svg of clone.querySelectorAll('svg')) svg.remove();
      return (clone.textContent || '').trim();
    } catch {
      return (el.textContent || '').trim();
    }
  }

  function buttonSaysUpgrade(btn) {
    if (btn.getAttribute('aria-label') === 'Upgrade') return true;
    if (upgradeText(btn) === 'Upgrade') return true;
    // Icon + label compositions: no direct text of its own, and every
    // text-bearing child says exactly "Upgrade".
    let direct = '';
    try {
      for (const node of btn.childNodes) {
        if (node.nodeType === 3) direct += node.nodeValue || '';
      }
    } catch {
      return false;
    }
    if (direct.trim() !== '') return false;
    let hits = 0;
    for (const child of btn.children) {
      const t = upgradeText(child);
      if (t === '') continue;
      if (t === 'Upgrade') {
        hits += 1;
        continue;
      }
      return false; // Unrelated textual content — not ours to hide.
    }
    return hits >= 1;
  }

  function hideUpgradeUI() {
    const buttons = document.getElementsByTagName('button');
    for (const btn of buttons) {
      if (seenUpgradeButtons.has(btn)) continue;
      if (btn.closest(`[${HIDDEN_ATTR}]`)) {
        seenUpgradeButtons.add(btn);
        continue;
      }
      if (!buttonSaysUpgrade(btn)) continue;

      let container = btn;
      let guard = 0;
      while (guard++ < 5) {
        const parent = container.parentElement;
        if (!parent || STRUCTURAL_TAGS.test(parent.tagName)) break;
        if (upgradeText(parent) !== 'Upgrade') break;
        container = parent;
      }
      container.setAttribute(HIDDEN_ATTR, 'upgrade');
      seenUpgradeButtons.add(btn);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Thread disclaimer: pure CSS ([data-testid="thread-disclaimer"]).
  // No JS needed — the stylesheet hides recreated nodes automatically.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // 3-5. Projects: detect, keep collapsed, dblclick opens Project home.
  //
  // Detection (no class names), strongest signal first:
  //   0. Definitive rows: [data-sidebar-item][data-sidebar-keep-open][role].
  //   a. Disclosure markers: [aria-expanded] whose region holds chats.
  //   b. Links to /project*/... that are not conversation items.
  //   c. Structural fallback: a header-like element adjacent to a nested
  //      chats container (proper subset of the sidebar's items).
  // Collapse: the nested chats container is tagged and hidden by CSS
  // (covers CSS-:hover reveals too). EVERY click on a project row is
  // suppressed at document capture before ChatGPT can expand it: a lone
  // click does nothing, while two clicks within DOUBLE_CLICK_MS trigger
  // the existing "Open project home" button programmatically (never a
  // hand-built URL) and the native dblclick is swallowed. Clicks from
  // the row's own trailing/options buttons always pass through, as do
  // plain conversation rows and our own UI. Pointer events are never
  // disabled, so hover styling and action buttons keep working.
  // ---------------------------------------------------------------------------
  // Panel searches are deliberately narrow: only siblings of the entry
  // or the entry's own children (excluding the header link's subtree).
  // Ancestor-walk heuristics are avoided — they misfire on single-row
  // wrappers and could hide legitimate conversations.
  function siblingPanel(entry, totalItems) {
    const parent = entry.parentElement;
    if (!(parent instanceof Element)) return null;
    for (const sib of parent.children) {
      if (sib === entry || sib.contains(entry)) continue;
      if (sib.hasAttribute(HIDDEN_ATTR)) continue;
      const n = countItems(sib);
      if (n > 0 && n < totalItems) return sib;
    }
    return null;
  }

  function childPanel(entry, headerLink, totalItems) {
    if (!(entry instanceof Element)) return null;
    for (const child of entry.children) {
      if (headerLink && child.contains(headerLink)) continue;
      if (child.hasAttribute(HIDDEN_ATTR)) continue;
      const n = countItems(child);
      if (n > 0 && n < totalItems) return child;
    }
    return null;
  }

  function tagPair(entry, chats) {
    if (!(entry instanceof Element) || !(chats instanceof Element)) return false;
    if (isConversationItem(entry)) return false;
    if (entry.closest('[data-chatgpt-mass-delete]')) return false;
    // Never hide an ancestor of the entry: that would remove the project
    // header itself and kill double-click navigation.
    if (chats.contains(entry)) return false;
    entry.setAttribute(ENTRY_ATTR, ENTRY_VALUE);
    chats.setAttribute(HIDDEN_ATTR, 'project-chats');
    return true;
  }

  function tagProjectChats() {
    const root = sidebarRoot();
    const totalItems = countItems(root);
    if (totalItems === 0) return;
    let tagged = 0;

    // (0) Definitive project rows (stable semantic selector).
    // Safety: if NO plain conversation exists, keep-open does not
    // discriminate on this DOM — tagging everything would suppress all
    // sidebar navigation, so skip project handling entirely.
    const plainConvos = root.querySelectorAll(
      '[data-sidebar-item="true"]:not([data-sidebar-keep-open="true"])'
    ).length;
    if (plainConvos > 0) {
      for (const row of root.querySelectorAll(PROJECT_ROW_SELECTOR)) {
        if (row.closest('[data-chatgpt-mass-delete]')) continue;
        const region = siblingPanel(row, totalItems) || childPanel(row, null, totalItems);
        if (region instanceof Element) {
          if (tagPair(row, region)) tagged += 1;
        } else {
          // Row with no discoverable chats yet: mark it so clicks/hover
          // are still managed once its conversations render.
          row.setAttribute(ENTRY_ATTR, ENTRY_VALUE);
        }
      }
    }

    // (a) Disclosure markers.
    for (const dis of root.querySelectorAll('[aria-expanded]')) {
      if (dis.closest('[data-chatgpt-mass-delete]')) continue;
      let region = null;
      const controlled = dis.getAttribute('aria-controls');
      if (controlled) {
        try {
          region = document.getElementById(controlled);
        } catch {
          region = null;
        }
      }
      if (!(region instanceof Element) || countItems(region) === 0) {
        region = siblingPanel(dis, totalItems) || childPanel(dis, null, totalItems);
      }
      if (region instanceof Element && countItems(region) > 0) {
        if (tagPair(dis, region)) tagged += 1;
      }
    }

    // (b) Project links that are not conversations.
    for (const link of root.querySelectorAll('a[href]')) {
      if (isConversationItem(link)) continue;
      const href = link.getAttribute('href') || '';
      if (!PROJECT_HREF_PATTERN.test(href)) continue;
      if (CONVERSATION_ID_PATTERN.test(href)) continue;
      const region = siblingPanel(link, totalItems) || childPanel(link, link, totalItems);
      if (region instanceof Element) {
        if (tagPair(link, region)) tagged += 1;
      } else {
        // Link with no discoverable chats yet: still mark the entry so
        // single-click expansion is suppressed once chats render.
        link.setAttribute(ENTRY_ATTR, ENTRY_VALUE);
      }
    }

    // (c) Structural fallback: header link + adjacent chats list.
    // The header link must be a real navigating anchor (not a section
    // toggle button, not a conversation) so collapsible sidebar sections
    // are never mistaken for projects. Cheap property checks run before
    // any subtree queries.
    for (const list of root.querySelectorAll('*')) {
      if (list.hasAttribute(HIDDEN_ATTR)) continue;
      const header = list.previousElementSibling;
      if (!(header instanceof Element)) continue;
      if (isConversationItem(list) || isConversationItem(header)) continue;
      const headerLink = header.matches('a[href]') ? header : header.querySelector('a[href]');
      if (!headerLink) continue;
      const href = headerLink.getAttribute('href') || '';
      if (href === '' || href === '#') continue;
      if (CONVERSATION_ID_PATTERN.test(href)) continue;
      if (header.querySelector(SIDEBAR_ITEM_SELECTOR)) continue;
      const n = countItems(list);
      if (n === 0 || n >= totalItems) continue;
      if (tagPair(header, list)) tagged += 1;
    }

    if (tagged > 0) {
      console.info('[ChatGPT Cleanup] projects collapsed: %d', tagged);
    }
  }

  function eventInProjectEntry(e) {
    const t = e.target;
    if (!(t instanceof Element)) return null;
    // Our own UI keeps working everywhere.
    if (t.closest('[data-chatgpt-mass-delete]')) return null;
    // Project action buttons are never intercepted: "Open project home"
    // and "Open project options" must keep working on direct clicks.
    if (t.closest(TRAILING_BUTTON_SELECTOR)) return null;
    if (t.closest(OPTIONS_TRIGGER_SELECTOR)) return null;
    // A plain conversation row (including chats nested in a project)
    // keeps its normal behavior — only project chrome is managed.
    const row = t.closest(SIDEBAR_ITEM_SELECTOR);
    if (row && !row.matches('[data-sidebar-keep-open="true"]')) return null;
    return t.closest(`[${ENTRY_ATTR}="${ENTRY_VALUE}"]`);
  }

  let lastProjectClick = { entry: null, time: 0 };

  function findProjectHomeButton(entry) {
    const inEntry = entry.querySelector(`button[aria-label="${PROJECT_HOME_LABEL}"]`);
    if (inEntry) return inEntry;
    // Same row container, attributed to THIS entry only.
    const parent = entry.parentElement;
    if (parent instanceof Element) {
      const cands = parent.querySelectorAll(`button[aria-label="${PROJECT_HOME_LABEL}"]`);
      for (const b of cands) {
        if (b.closest(PROJECT_ROW_SELECTOR) === entry) return b;
      }
    }
    return null;
  }

  function ensureEntryCollapsed(entry) {
    try {
      const total = countItems(sidebarRoot());
      const region = siblingPanel(entry, total) || childPanel(entry, null, total);
      if (region instanceof Element) {
        region.setAttribute(HIDDEN_ATTR, 'project-chats');
      }
    } catch {
      // Never break the host page.
    }
  }

  function onProjectClickCapture(e) {
    if (!enabled('keepProjectsCollapsed')) return;
    if (e.button !== undefined && e.button !== 0) return;
    const entry = eventInProjectEntry(e);
    if (!entry) return;
    // Always suppress native handling first — the decision between
    // single and double click happens below, never after expansion.
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (lastProjectClick.entry === entry && now - lastProjectClick.time < DOUBLE_CLICK_MS) {
      // Double click: collapse, then open Project home through the
      // existing button (never a hand-built URL).
      lastProjectClick = { entry: null, time: 0 };
      ensureEntryCollapsed(entry);
      const home = findProjectHomeButton(entry);
      if (home) home.click();
      return;
    }
    lastProjectClick = { entry, time: now };
    // Lone single click: intentionally nothing — stays collapsed.
  }

  function onProjectDblclickCapture(e) {
    if (!enabled('keepProjectsCollapsed')) return;
    const entry = eventInProjectEntry(e);
    if (!entry) return;
    // The click pair above already opened Project home; swallow the
    // native dblclick so nothing expands (or navigates twice) on top.
    e.preventDefault();
    e.stopPropagation();
  }

  function onProjectHoverCapture(e) {
    if (!enabled('keepProjectsCollapsed')) return;
    const entry = eventInProjectEntry(e);
    if (!entry) return;
    // Starve JS-driven hover reveals; CSS reveals are already neutralized
    // by hiding the tagged chats containers.
    e.stopPropagation();
  }

  document.addEventListener('click', onProjectClickCapture, true);
  document.addEventListener('dblclick', onProjectDblclickCapture, true);
  document.addEventListener('mouseover', onProjectHoverCapture, true);
  document.addEventListener('pointerover', onProjectHoverCapture, true);

  // ---------------------------------------------------------------------------
  // Coordinated scan, called from content.js's debounced observer pipeline.
  // ---------------------------------------------------------------------------
  function runCleanupScan() {
    try {
      if (enabled('removeUpgrade')) hideUpgradeUI();
      // Disclaimer is CSS-only.
      if (enabled('keepProjectsCollapsed')) tagProjectChats();
    } catch {
      // Never break the host page.
    }
  }

  window.__cmdCleanupScan = runCleanupScan;
})();
