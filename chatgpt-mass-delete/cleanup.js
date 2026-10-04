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

  const HIDDEN_ATTR = 'data-chatgpt-cleanup-hidden';
  const ENTRY_ATTR = 'data-chatgpt-projects';

  const CONVERSATION_ID_PATTERN = /\/c\/([0-9a-f-]{8,})/i;
  const PROJECT_HREF_PATTERN = /project/i;
  const STRUCTURAL_TAGS = /^(NAV|ASIDE|MAIN|BODY|HTML)$/;

  // Double-click pass-through window: the 2nd click within this long after
  // the 1st on the same project entry is allowed through untouched.
  const DOUBLE_CLICK_MS = 500;

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

  function isConversationItem(el) {
    return el instanceof Element && el.matches(SIDEBAR_ITEM_SELECTOR);
  }

  function countItems(el) {
    try {
      return el.querySelectorAll(SIDEBAR_ITEM_SELECTOR).length;
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

  function hideUpgradeUI() {
    const buttons = document.getElementsByTagName('button');
    for (const btn of buttons) {
      if (seenUpgradeButtons.has(btn)) continue;
      if (btn.closest(`[${HIDDEN_ATTR}]`)) {
        seenUpgradeButtons.add(btn);
        continue;
      }
      const label = btn.getAttribute('aria-label');
      const text = (btn.textContent || '').trim();
      if (label !== 'Upgrade' && text !== 'Upgrade') continue;

      let container = btn;
      let guard = 0;
      while (guard++ < 5) {
        const parent = container.parentElement;
        if (!parent || STRUCTURAL_TAGS.test(parent.tagName)) break;
        if ((parent.textContent || '').trim() !== 'Upgrade') break;
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
  // 3-5. Projects: detect, keep collapsed, dblclick still navigates.
  //
  // Detection (no class names), strongest signal first:
  //   a. Disclosure markers: [aria-expanded] whose region holds chats.
  //   b. Links to /project*/... that are not conversation items.
  //   c. Structural fallback: a header-like element adjacent to a nested
  //      chats container (proper subset of the sidebar's items).
  // Collapse: the nested chats container is tagged and hidden by CSS
  // (covers CSS-:hover reveals too). Single clicks on the entry are
  // suppressed at document capture; the 2nd click of a double-click is
  // let through so Project-home navigation keeps working. Hover
  // (mouseover/pointerover) inside entries is stopped so JS-driven
  // reveals never fire. Conversations and our own UI are exempt.
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
    entry.setAttribute(ENTRY_ATTR, 'entry');
    chats.setAttribute(HIDDEN_ATTR, 'project-chats');
    return true;
  }

  function tagProjectChats() {
    const root = sidebarRoot();
    const totalItems = countItems(root);
    if (totalItems === 0) return;
    let tagged = 0;

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
        link.setAttribute(ENTRY_ATTR, 'entry');
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
    // Exempt conversations (and their checkboxes) and our own UI: those
    // keep their normal behavior everywhere, including inside projects.
    if (t.closest(SIDEBAR_ITEM_SELECTOR)) return null;
    if (t.closest('[data-chatgpt-mass-delete]')) return null;
    if (t.closest(OPTIONS_TRIGGER_SELECTOR)) return null;
    return t.closest(`[${ENTRY_ATTR}="entry"]`);
  }

  let lastProjectClick = { entry: null, time: 0 };

  function onProjectClickCapture(e) {
    if (!enabled('keepProjectsCollapsed')) return;
    if (e.button !== undefined && e.button !== 0) return;
    const entry = eventInProjectEntry(e);
    if (!entry) return;
    const now = Date.now();
    if (lastProjectClick.entry === entry && now - lastProjectClick.time < DOUBLE_CLICK_MS) {
      // Second click of a double-click: let it through so Project-home
      // navigation works. (dblclick itself is never intercepted.)
      lastProjectClick = { entry: null, time: 0 };
      return;
    }
    lastProjectClick = { entry, time: now };
    // Single click: suppress expansion, keep the project collapsed.
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
