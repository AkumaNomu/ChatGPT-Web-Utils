(() => {
  'use strict';

  // Guard against double-injection (Firefox may re-run content scripts on SPA nav).
  if (window.__chatgptMassDeleteInjected) return;
  window.__chatgptMassDeleteInjected = true;

  // ---------------------------------------------------------------------------
  // Config — keep in one place so future ChatGPT markup/API changes are easy.
  // ---------------------------------------------------------------------------
  const SIDEBAR_ITEM_SELECTOR = '[data-sidebar-item="true"]';
  const OPTIONS_TRIGGER_SELECTOR = '[data-conversation-options-trigger]';
  // Project rows carry data-sidebar-item too — keep-open="true" tells them
  // apart. Mass delete only ever handles real conversations.
  const PROJECT_ROW_SELECTOR =
    '[data-sidebar-item="true"][data-sidebar-keep-open="true"][role="button"]';
  const CONVERSATION_SELECTOR =
    '[data-sidebar-item="true"]:not([data-sidebar-keep-open="true"])';
  const CONVERSATION_ID_PATTERN = /\/c\/([0-9a-f-]{8,})/i;

  // Absolute URLs: relative paths do NOT resolve in this content-script
  // context ("not a valid URL"), so build from the page origin explicitly.
  const ORIGIN = window.location.origin; // https://chatgpt.com
  const SESSION_PATH = `${ORIGIN}/api/auth/session`;
  const DELETE_PATH = (id) => `${ORIGIN}/backend-api/conversation/id/${encodeURIComponent(id)}`;
  const CONCURRENCY = 4;
  const MAX_RETRIES = 3;

  const PREFIX = 'data-chatgpt-mass-delete';
  const SELECTED_ATTR = 'data-chatgpt-mass-delete-selected';
  const ID_ATTR = 'data-chatgpt-mass-delete-id';

  // Settings live in settings.js (runs first). Default to ON when the
  // registry is unavailable so features never silently die.
  function massDeleteEnabled() {
    try {
      if (window.__cmdSettings) return window.__cmdSettings.isEnabled('massDelete');
      return true;
    } catch {
      return true;
    }
  }

  // ---------------------------------------------------------------------------
  // State. Only conversation IDs are stored. Never tokens/cookies/sessions.
  // ---------------------------------------------------------------------------
  /** @type {Set<string>} */
  const selected = new Set();
  let isDeleting = false;
  // True after an explicit Select All: newly discovered conversations join
  // the selection as they appear. Cleared by any deselect, clear, or delete.
  let selectAllLatch = false;
  // Pending single-click action on the top control (cancelled by dblclick).
  let topClickTimer = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---------------------------------------------------------------------------
  // ID / title extraction (no class-name selectors — they are unstable).
  // ---------------------------------------------------------------------------
  function getConversationId(item) {
    const trigger = item.querySelector(OPTIONS_TRIGGER_SELECTOR);
    const fromTrigger = trigger?.dataset?.conversationOptionsTrigger;
    if (fromTrigger && fromTrigger.trim()) return fromTrigger.trim();

    const href = item.getAttribute('href') || '';
    const match = href.match(CONVERSATION_ID_PATTERN);
    if (match) return match[1];

    return null;
  }

  function getConversationTitle(item) {
    return item.getAttribute('aria-label') || '';
  }

  function findConversations() {
    return Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
  }

  function findItemForId(id) {
    return findConversations().filter((item) => getConversationId(item) === id);
  }

  // ---------------------------------------------------------------------------
  // Header control — lives at the top of the sidebar (first child of the
  // nav/aside), moving naturally with it. Single row: tri-state top
  // checkbox, count (selection mode only), Delete (selection mode only),
  // plus a status line for progress/results. The MutationObserver +
  // interval remount it if a rerender drops it.
  // ---------------------------------------------------------------------------
  function findToolbarAnchor() {
    const items = findConversations();
    if (items.length === 0) return null;
    const first = items[0];
    const sidebar = first.closest('nav') || first.closest('aside');
    if (sidebar) return { parent: sidebar, before: sidebar.firstChild };
    const list = first.parentElement;
    if (list && list.parentNode instanceof Element) {
      return { parent: list.parentNode, before: list };
    }
    return null;
  }

  function getToolbarElements() {
    const toolbar = document.querySelector(`[${PREFIX}="toolbar"]`);
    if (!toolbar) return null;
    return {
      toolbar,
      topbox: toolbar.querySelector(`[${PREFIX}="topbox"]`),
      count: toolbar.querySelector(`[${PREFIX}="count"]`),
      deleteBtn: toolbar.querySelector(`[${PREFIX}="delete"]`),
      status: toolbar.querySelector(`[${PREFIX}="status"]`),
    };
  }

  function makeButton(kind, label) {
    const btn = document.createElement('button');
    btn.setAttribute(PREFIX, kind);
    btn.type = 'button';
    btn.textContent = label;
    return btn;
  }

  function ensureToolbar() {
    if (!massDeleteEnabled()) return;
    if (document.querySelector(`[${PREFIX}="toolbar"]`)) {
      updateToolbar();
      return;
    }
    // Never insert during churn/hydration — the interval retries once calm.
    if (!sidebarQuiet) return;
    const anchor = findToolbarAnchor();
    if (!anchor) return; // Retried by scans + interval once chats render.

    const toolbar = document.createElement('div');
    toolbar.setAttribute(PREFIX, 'toolbar');

    const row = document.createElement('div');
    row.setAttribute(PREFIX, 'toolbar-row');

    // Tri-state global control: empty (none) / checked (all) / minus (some).
    const topbox = document.createElement('button');
    topbox.type = 'button';
    topbox.setAttribute(PREFIX, 'topbox');
    topbox.setAttribute('role', 'checkbox');
    topbox.setAttribute('aria-checked', 'false');
    topbox.setAttribute('aria-label', 'Select all conversations');
    topbox.title = 'Select all (double-click to clear)';
    topbox.tabIndex = 0;
    topbox.style.width = '18px';
    topbox.style.height = '18px';
    topbox.style.display = 'inline-flex';
    topbox.style.alignItems = 'center';
    topbox.style.justifyContent = 'center';
    topbox.style.margin = '0';
    topbox.style.padding = '0';
    topbox.style.flex = '0 0 auto';
    topbox.style.border = '1.5px solid #888';
    topbox.style.borderRadius = '5px';
    topbox.style.background = 'transparent';
    topbox.style.cursor = 'pointer';

    const svg = document.createElementNS(CHECKBOX_SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute(PREFIX, 'checkbox-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.style.width = '12px';
    svg.style.height = '12px';
    const checkPath = document.createElementNS(CHECKBOX_SVG_NS, 'path');
    checkPath.setAttribute('d', 'M3.2 8.6l3.3 3.3 6.3-7.8');
    checkPath.setAttribute('fill', 'none');
    checkPath.setAttribute('stroke', 'currentColor');
    checkPath.setAttribute('stroke-width', '2.4');
    checkPath.setAttribute('stroke-linecap', 'round');
    checkPath.setAttribute('stroke-linejoin', 'round');
    checkPath.setAttribute('class', 'glyph glyph-check');
    checkPath.style.display = 'none';
    const minusPath = document.createElementNS(CHECKBOX_SVG_NS, 'path');
    minusPath.setAttribute('d', 'M3.5 8h9');
    minusPath.setAttribute('fill', 'none');
    minusPath.setAttribute('stroke', 'currentColor');
    minusPath.setAttribute('stroke-width', '2.4');
    minusPath.setAttribute('stroke-linecap', 'round');
    minusPath.setAttribute('class', 'glyph glyph-minus');
    minusPath.style.display = 'none';
    svg.append(checkPath, minusPath);
    topbox.appendChild(svg);

    const count = document.createElement('span');
    count.setAttribute(PREFIX, 'count');
    count.setAttribute('aria-live', 'polite');
    count.hidden = true;

    const deleteBtn = makeButton('delete', 'Delete (0)');
    deleteBtn.hidden = true;

    const status = document.createElement('div');
    status.setAttribute(PREFIX, 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;

    // Single/double click routing lives in the document-level capture
    // handlers (onClickCapture / onTopboxDblclickCapture) so ChatGPT row
    // handlers can never interfere. Stop local propagation as backup.
    topbox.addEventListener('click', (e) => e.stopPropagation());
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void deleteSelected();
    });

    row.append(topbox, count, deleteBtn);
    toolbar.append(row, status);

    try {
      anchor.parent.insertBefore(toolbar, anchor.before);
    } catch {
      return; // Unexpected structure — retry on next scan.
    }
    updateToolbar();
    console.info(
      '[ChatGPT Mass Delete] toolbar mounted (%d conversations detected)',
      findConversations().length
    );
  }

  function setStatus(message, mode) {
    const els = getToolbarElements();
    if (!els) return;
    if (!message) {
      els.status.hidden = true;
      els.status.textContent = '';
      els.status.removeAttribute(`${PREFIX}-status-mode`);
      return;
    }
    els.status.hidden = false;
    els.status.textContent = message;
    els.status.setAttribute(`${PREFIX}-status-mode`, mode || 'info');
  }

  function allDetectedSelected() {
    if (selected.size === 0) return false;
    for (const item of findConversations()) {
      const id = getConversationId(item);
      if (!id || !selected.has(id)) return false;
    }
    return true;
  }

  function selectionSnapshot() {
    if (selected.size === 0) return 'none';
    return allDetectedSelected() ? 'all' : 'some';
  }

  function updateToolbar() {
    const els = getToolbarElements();
    if (!els || !els.topbox) return;
    const n = selected.size;
    const all = allDetectedSelected();
    const partial = n > 0 && !all;

    // Tri-state top control (+ inline paint so it works without CSS).
    els.topbox.setAttribute('aria-checked', all ? 'true' : (partial ? 'mixed' : 'false'));
    if (partial) {
      els.topbox.setAttribute(`${PREFIX}-partial`, 'true');
    } else {
      els.topbox.removeAttribute(`${PREFIX}-partial`);
    }
    els.topbox.style.background = n === 0 ? 'transparent' : '#ececec';
    els.topbox.style.borderColor = n === 0 ? '' : '#ececec';
    els.topbox.style.color = n === 0 ? '' : '#171717';
    els.topbox.setAttribute('aria-label', all ? 'Clear selection' : 'Select all conversations');
    const check = els.topbox.querySelector('.glyph-check');
    const minus = els.topbox.querySelector('.glyph-minus');
    if (check) check.style.display = all ? 'block' : 'none';
    if (minus) minus.style.display = partial ? 'block' : 'none';

    // Count + Delete exist only in selection mode.
    els.count.hidden = n === 0;
    els.deleteBtn.hidden = n === 0;
    els.deleteBtn.disabled = isDeleting;
    if (n > 0) {
      els.count.textContent = n === 1 ? '1 selected' : `${n} selected`;
      els.deleteBtn.textContent = `Delete (${n})`;
    }
  }

  // ---------------------------------------------------------------------------
  // Checkboxes — custom, fully extension-controlled (no native <input>).
  //
  // Why: a native checkbox inside ChatGPT's row depends on the click event
  // reaching it with default action intact. ChatGPT's own row-level handlers
  // and hover re-renders can swallow or orphan that click, leaving the box
  // unchecked. A custom button toggled from document-level capture handlers
  // runs before any row handler and paints state itself, so it can't break.
  // ---------------------------------------------------------------------------
  const CHECKBOX_SVG_NS = 'http://www.w3.org/2000/svg';

  function createCheckboxButton(id, title) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute(PREFIX, 'checkbox');
    btn.setAttribute(ID_ATTR, id);
    btn.setAttribute('role', 'checkbox');
    btn.setAttribute('aria-checked', selected.has(id) ? 'true' : 'false');
    btn.setAttribute('aria-label', `Select conversation ${title}`.trim());
    btn.tabIndex = 0;
    // Inline base styles so the box renders even without the stylesheet.
    // Checked = solid light fill with dark check (ChatGPT dark convention).
    btn.style.width = '16px';
    btn.style.height = '16px';
    btn.style.display = 'inline-flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.style.margin = '0';
    btn.style.padding = '0';
    btn.style.flex = '0 0 auto';
    btn.style.border = '1.5px solid #888';
    btn.style.borderRadius = '4px';
    btn.style.background = selected.has(id) ? '#ececec' : 'transparent';
    btn.style.borderColor = selected.has(id) ? '#ececec' : '';
    btn.style.color = selected.has(id) ? '#171717' : '';
    btn.style.cursor = 'pointer';

    const svg = document.createElementNS(CHECKBOX_SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute(PREFIX, 'checkbox-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.style.width = '11px';
    svg.style.height = '11px';
    svg.style.opacity = selected.has(id) ? '1' : '0';

    const path = document.createElementNS(CHECKBOX_SVG_NS, 'path');
    path.setAttribute('d', 'M3.2 8.6l3.3 3.3 6.3-7.8');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2.4');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    btn.appendChild(svg);
    return btn;
  }

  function paintRow(item, id, checked) {
    const btn = item.querySelector(`[${PREFIX}="checkbox"]`);
    if (btn) {
      btn.setAttribute('aria-checked', checked ? 'true' : 'false');
      btn.setAttribute(ID_ATTR, id);
      btn.setAttribute('aria-label', `Select conversation ${getConversationTitle(item)}`.trim());
      // Inline checked visuals (stylesheet enhances with transitions/themes).
      btn.style.background = checked ? '#ececec' : 'transparent';
      if (checked) {
        btn.style.borderColor = '#ececec';
        btn.style.color = '#171717';
      } else {
        btn.style.borderColor = '';
        btn.style.color = '';
      }
      const icon = btn.firstChild;
      if (icon instanceof Element) icon.style.opacity = checked ? '1' : '0';
    }
    const wrapper = item.querySelector(`[${PREFIX}="checkbox-wrapper"]`);
    if (wrapper) {
      wrapper.setAttribute(ID_ATTR, id);
      // Drives the full-opacity reveal for checked rows (stylesheet).
      if (checked) {
        wrapper.setAttribute(`${PREFIX}-checked`, 'true');
      } else {
        wrapper.removeAttribute(`${PREFIX}-checked`);
      }
    }
    if (checked) {
      item.setAttribute(SELECTED_ATTR, 'true');
    } else {
      item.removeAttribute(SELECTED_ATTR);
    }
  }

  function syncCheckboxForItem(item, id) {
    paintRow(item, id, selected.has(id));
  }

  // Dedupe: pointerdown (primary path) and click (assistive-tech fallback)
  // can both fire for one press — only honor the first per row per moment.
  let lastToggle = { id: null, t: 0 };

  function toggleSelection(id) {
    if (isDeleting) return;
    const now = Date.now();
    if (lastToggle.id === id && now - lastToggle.t < 600) return;
    lastToggle = { id, t: now };

    if (selected.has(id)) {
      selected.delete(id);
      selectAllLatch = false; // Customized: newcomers stay unselected.
    } else {
      selected.add(id);
    }
    refreshSelectionUI();
  }

  function injectWrapper(item, id) {
    const wrapper = document.createElement('span');
    wrapper.setAttribute(PREFIX, 'checkbox-wrapper');
    wrapper.setAttribute(ID_ATTR, id);
    wrapper.title = 'Select conversation';
    wrapper.style.display = 'inline-flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.justifyContent = 'center';
    wrapper.style.alignSelf = 'center';
    wrapper.style.flex = '0 0 auto';
    wrapper.style.flexShrink = '0';
    wrapper.style.position = 'relative';
    wrapper.style.zIndex = '1';
    wrapper.style.marginRight = '2px';
    wrapper.style.padding = '4px';
    wrapper.style.borderRadius = '6px';
    wrapper.style.cursor = 'pointer';
    // NOTE: opacity is intentionally NOT inlined — the stylesheet dims
    // idle checkboxes and reveals them on row hover/selection.
    // No per-node listeners: toggling is handled by document-level capture
    // handlers so ChatGPT row handlers can never swallow the event.
    wrapper.appendChild(createCheckboxButton(id, getConversationTitle(item)));
    item.insertBefore(wrapper, item.firstChild);
  }

  // Selection-mode rendering (spec option 1): row checkboxes exist only
  // while selected.size > 0, so the sidebar looks untouched otherwise.
  // With the Select-All latch on, newly discovered rows join immediately.
  function syncRowCheckboxes() {
    if (!massDeleteEnabled()) return;
    if (selectAllLatch) {
      for (const item of findConversations()) {
        const id = getConversationId(item);
        if (id) selected.add(id);
      }
    }
    const selecting = selected.size > 0;
    for (const item of findConversations()) {
      const id = getConversationId(item);
      const wrapper = item.querySelector(`[${PREFIX}="checkbox-wrapper"]`);
      if (!id || !selecting) {
        if (wrapper) wrapper.remove();
        item.removeAttribute(SELECTED_ATTR);
        continue;
      }
      if (!wrapper) {
        injectWrapper(item, id);
      } else {
        // Row may have been recycled for another conversation
        // (virtualized list) — repaint from the Set.
        syncCheckboxForItem(item, id);
        continue;
      }
      paintRow(item, id, selected.has(id));
    }
  }

  function refreshSelectionUI() {
    syncRowCheckboxes();
    updateToolbar();
  }

  function wrapperIdFromEventTarget(target) {
    if (!(target instanceof Element)) return null;
    const wrapper = target.closest(`[${PREFIX}="checkbox-wrapper"]`);
    if (!wrapper) return null;
    return wrapper.getAttribute(ID_ATTR) || null;
  }

  // Primary path: pointerdown fires before any hover re-render can replace
  // the node and before ChatGPT's own handlers run (document capture).
  // preventDefault() here suppresses the compatibility click, so no anchor
  // navigation and no double toggle.
  function onPointerDownCapture(e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.isPrimary === false) return;
    const id = wrapperIdFromEventTarget(e.target);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    toggleSelection(id);
  }

  // Fallback path: keyboard/screen-reader activation synthesizes click
  // without pointerdown. Suppressed after a pointerdown toggle by dedupe.
  // Also routes top-control mouse clicks (with double-click priority).
  function onClickCapture(e) {
    const t = e.target;
    if (t instanceof Element && t.closest(`[${PREFIX}="topbox"]`)) {
      e.preventDefault();
      e.stopPropagation();
      if (e.detail === 0) return; // Keyboard echo; keydown already acted.
      topboxSingleClick();
      return;
    }
    const id = wrapperIdFromEventTarget(e.target);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    toggleSelection(id);
  }

  // Double-click on the top control always clears — cancelling any pending
  // single-click action so there is no select-all flicker.
  function onTopboxDblclickCapture(e) {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (!t.closest(`[${PREFIX}="topbox"]`)) return;
    e.preventDefault();
    e.stopPropagation();
    if (topClickTimer) {
      clearTimeout(topClickTimer);
      topClickTimer = null;
    }
    clearSelection();
  }

  function onKeyCapture(e) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const kind = target.getAttribute(PREFIX);
    if (kind === 'topbox') {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === 'keydown') topboxKeyboardActivate();
      }
      return;
    }
    if (kind !== 'checkbox') return;
    if (e.key === ' ' || e.key === 'Enter') {
      // Keydown Enter activates buttons; Space activates on keyup — cancel
      // both so the anchor never receives an activating click.
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'keydown') {
        const wrapper = target.closest(`[${PREFIX}="checkbox-wrapper"]`);
        const id = wrapper?.getAttribute(ID_ATTR);
        if (id) toggleSelection(id);
      }
    }
  }

  function onMouseDownOrDragCapture(e) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    // Never let ChatGPT start a drag from the checkbox; keep focus/click
    // behavior intact (no preventDefault here).
    if (target.closest(`[${PREFIX}="checkbox-wrapper"]`)) {
      e.stopPropagation();
    }
  }

  // ---------------------------------------------------------------------------
  // Selection actions
  // ---------------------------------------------------------------------------
  function selectAllDetected() {
    if (isDeleting) return;
    selectAllLatch = true;
    for (const item of findConversations()) {
      const id = getConversationId(item);
      if (id) selected.add(id);
    }
    refreshSelectionUI();
  }

  function clearSelection() {
    if (isDeleting) return;
    selectAllLatch = false;
    selected.clear();
    setStatus('');
    refreshSelectionUI();
  }

  // Top-control click routing with double-click priority: a single click
  // waits 280ms; if the dblclick event arrives first the pending action
  // is cancelled and the selection is cleared — never select-all flicker.
  function topboxSingleClick() {
    if (isDeleting) return;
    if (topClickTimer) return; // 2nd click of a double-click: ignore.
    const snapshot = selectionSnapshot();
    topClickTimer = setTimeout(() => {
      topClickTimer = null;
      if (snapshot === 'all') {
        clearSelection();
      } else {
        selectAllDetected();
      }
    }, 280);
  }

  function topboxKeyboardActivate() {
    if (isDeleting) return;
    if (selectionSnapshot() === 'all') {
      clearSelection();
    } else {
      selectAllDetected();
    }
  }

  // ---------------------------------------------------------------------------
  // Confirmation dialog (extension-owned DOM, isolated by PREFIX).
  // ---------------------------------------------------------------------------
  function showConfirm(count) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.setAttribute(PREFIX, 'overlay');

      const dialog = document.createElement('div');
      dialog.setAttribute(PREFIX, 'dialog');
      dialog.setAttribute('role', 'alertdialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', 'Confirm deletion');

      const icon = document.createElement('div');
      icon.setAttribute(PREFIX, 'dialog-icon');
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '!';

      const title = document.createElement('h2');
      title.setAttribute(PREFIX, 'dialog-title');
      title.textContent = `Delete ${count} conversation${count === 1 ? '' : 's'}?`;

      const body = document.createElement('p');
      body.setAttribute(PREFIX, 'dialog-body');
      body.textContent = 'This cannot be undone.';

      const actions = document.createElement('div');
      actions.setAttribute(PREFIX, 'dialog-actions');

      const cancel = document.createElement('button');
      cancel.setAttribute(PREFIX, 'dialog-cancel');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';

      const confirm = document.createElement('button');
      confirm.setAttribute(PREFIX, 'dialog-confirm');
      confirm.type = 'button';
      confirm.textContent = 'Delete';

      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          done(false);
        }
      };

      cancel.addEventListener('click', (e) => {
        e.stopPropagation();
        done(false);
      });
      confirm.addEventListener('click', (e) => {
        e.stopPropagation();
        done(true);
      });
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) done(false);
      });
      document.addEventListener('keydown', onKey, true);

      actions.append(cancel, confirm);
      dialog.append(icon, title, body, actions);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      cancel.focus();
    });
  }

  // ---------------------------------------------------------------------------
  // Deletion API — same-origin, uses the existing ChatGPT session only.
  // Never touches auth headers, cookies, or tokens.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Auth — approved exception to the no-credentials rule (user-approved):
  // the backend-api rejects cookie-only requests, so the session's access
  // token is fetched from ChatGPT's own same-origin session endpoint and
  // held ONLY in these in-memory variables. It is never stored (no
  // storage/cookies/DOM), never logged, and only ever sent as the
  // Authorization header on same-origin backend-api DELETE calls.
  // (SESSION_PATH/DELETE_PATH are absolute — see config above.)
  // ---------------------------------------------------------------------------
  let cachedToken = null;
  let tokenPromise = null;
  let tokenWarned = false;

  // Safe one-line error summary. fetch TypeErrors never contain URLs or
  // credentials, and our own thrown Errors carry only HTTP codes — so this
  // can never leak the token.
  function describeError(e) {
    try {
      if (e instanceof Error) return `${e.name}: ${e.message}`;
      return String(e);
    } catch {
      return 'unknown error';
    }
  }

  async function fetchSessionToken() {
    const res = await fetch(SESSION_PATH, { method: 'GET', credentials: 'include' });
    if (!res.ok) throw new Error(`session HTTP ${res.status}`);
    const data = await res.json().catch(() => null);
    const token = data && data.accessToken;
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('no access token in session');
    }
    return token;
  }

  async function getAccessToken(forceRefresh = false) {
    if (!forceRefresh && cachedToken) return cachedToken;
    if (!forceRefresh && tokenPromise) return tokenPromise;
    tokenPromise = fetchSessionToken();
    try {
      cachedToken = await tokenPromise;
      return cachedToken;
    } finally {
      tokenPromise = null;
    }
  }

  // Returns { ok, status }. status is the HTTP code, or 0 when the
  // request never completed (network error / blocked). Only numeric
  // statuses and conversation IDs are ever logged — never headers,
  // bodies, tokens, or cookies.
  async function deleteOneConversation(id, attempt = 0, refreshed = false) {
    let headers = {};
    try {
      const token = refreshed
        ? await getAccessToken(true)
        : await getAccessToken();
      headers = { Authorization: `Bearer ${token}` };
    } catch (e) {
      if (!tokenWarned) {
        tokenWarned = true;
        console.warn(
          '[ChatGPT Mass Delete] session lookup failed (%s); trying without Authorization header',
          describeError(e)
        );
      }
      headers = {};
    }
    try {
      const response = await fetch(DELETE_PATH(id), {
        method: 'DELETE',
        credentials: 'include',
        headers,
      });
      if (response.ok) return { ok: true, status: response.status }; // HTTP 2xx → success

      // Token may have expired mid-batch: refresh once and retry.
      if (response.status === 401 && !refreshed) {
        cachedToken = null;
        return deleteOneConversation(id, attempt, true);
      }

      const retryable = response.status === 429 || (response.status >= 500 && response.status < 600);
      if (retryable && attempt < MAX_RETRIES) {
        let delay = Math.min(1000 * 2 ** attempt, 8000);
        const retryAfter = response.headers.get('Retry-After');
        if (retryAfter) {
          const seconds = parseInt(retryAfter, 10);
          if (!Number.isNaN(seconds)) delay = Math.min(Math.max(seconds, 0) * 1000, 15000);
        }
        await sleep(delay + Math.random() * 500);
        return deleteOneConversation(id, attempt + 1, refreshed);
      }
      return { ok: false, status: response.status };
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        await sleep(1000 * 2 ** attempt + Math.random() * 500);
        return deleteOneConversation(id, attempt + 1, refreshed);
      }
      return { ok: false, status: 0, error: describeError(e) };
    }
  }

  function removeConversationFromSidebar(id) {
    for (const item of findItemForId(id)) {
      item.remove();
    }
  }

  async function deleteSelected() {
    if (isDeleting) return;
    if (selected.size === 0) return;

    const ids = Array.from(selected);
    const confirmed = await showConfirm(ids.length);
    if (!confirmed) return;

    isDeleting = true;
    updateToolbar();

    const total = ids.length;
    let done = 0;
    let succeeded = 0;
    let failed = 0;
    let cursor = 0;
    /** @type {Map<number, number>} */
    const statusTally = new Map();

    console.info('[ChatGPT Mass Delete] attempting %d deletion(s)', total);

    setStatus(`Deleting… 0 / ${total}`, 'progress');

    async function worker() {
      while (cursor < ids.length) {
        const id = ids[cursor];
        cursor += 1;
        const res = await deleteOneConversation(id);
        if (res.ok) {
          succeeded += 1;
          selected.delete(id);
          removeConversationFromSidebar(id);
        } else {
          failed += 1;
          statusTally.set(res.status, (statusTally.get(res.status) || 0) + 1);
          console.warn(
            '[ChatGPT Mass Delete] delete failed: id=%s http=%s%s',
            id,
            res.status === 0 ? 'network-error' : res.status,
            res.error ? ` (${res.error})` : ''
          );
          // Failed rows stay in the sidebar and stay selected for retry.
        }
        done += 1;
        setStatus(`Deleting… ${done} / ${total}`, 'progress');
        updateToolbar();
      }
    }

    const workers = [];
    const poolSize = Math.min(CONCURRENCY, ids.length);
    for (let i = 0; i < poolSize; i += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);

    isDeleting = false;
    selectAllLatch = false;
    refreshSelectionUI();

    let message;
    let mode;
    const tallyText = Array.from(statusTally.entries())
      .map(([status, n]) => (status === 0 ? `network-error×${n}` : `HTTP ${status}×${n}`))
      .join(', ');
    if (failed === 0) {
      message = total === 1 ? 'Deleted 1 conversation.' : `Deleted ${succeeded} conversations.`;
      mode = 'success';
    } else if (succeeded === 0) {
      message = failed === 1
        ? 'Could not delete 1 conversation.'
        : `Deleted 0 of ${total} conversations. ${failed} could not be deleted.`;
      mode = 'error';
    } else {
      message = `Deleted ${succeeded} of ${total} conversations. ` +
        `${failed} could not be deleted.`;
      mode = 'error';
    }
    setStatus(message, mode);
    console.info('[ChatGPT Mass Delete] %s%s', message, tallyText ? ` [${tallyText}]` : '');
  }

  // ---------------------------------------------------------------------------
  // Hydration-safe mounting. ChatGPT server-renders the sidebar and React
  // hydrates it after load — and a quiet sidebar is NOT proof hydration
  // ran (it can hydrate lazily after seconds of calm). Any foreign node
  // inserted beforehand causes a hydration mismatch (React error #418)
  // and React discards our nodes. So structural insertion requires ALL of:
  //   1. the sidebar subtree calm for QUIET_MS (churn/hydration detector),
  //   2. document fully loaded plus a tail delay (hydration virtually
  //      always done by then),
  //   3. a minimum page age (kills the quiet-but-not-yet-hydrated race).
  // The same gate protects every re-insertion, not just boot. Later
  // client-side rerenders merely drop our nodes (no crash) and the
  // observer + interval re-add them once calm returns. Absolute cap
  // forces progress so the UI can never stay invisible forever.
  // ---------------------------------------------------------------------------
  const QUIET_MS = 1500;
  const TAIL_AFTER_LOAD_MS = 2500;
  const MIN_PAGE_AGE_MS = 4000;
  const MOUNT_CAP_MS = 25000;

  const bootTime = Date.now();
  let quietWatchedRoot = null;
  let sidebarQuiet = false;
  let quietTimer = null;
  let quietForced = false;

  function findSidebarRoot() {
    const items = findConversations();
    if (items.length > 0) {
      return items[0].closest('nav') || items[0].closest('aside') || null;
    }
    return document.querySelector('nav') || document.querySelector('aside');
  }

  function markSidebarBusy() {
    sidebarQuiet = false;
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      sidebarQuiet = true;
    }, QUIET_MS);
  }

  const quietObserver = new MutationObserver(() => {
    markSidebarBusy();
  });

  // Re-anchor the churn watcher when React swaps the sidebar subtree
  // (otherwise we'd watch a detached node and stall forever).
  function ensureQuietWatcher() {
    try {
      const root = findSidebarRoot();
      if (!root) return false;
      if (root !== quietWatchedRoot) {
        quietObserver.disconnect();
        quietWatchedRoot = root;
        quietObserver.observe(root, { childList: true, subtree: true });
        markSidebarBusy();
      }
      if (!quietForced && Date.now() - bootTime > MOUNT_CAP_MS) {
        quietForced = true;
        sidebarQuiet = true;
      }
      return true;
    } catch {
      return false;
    }
  }

  function mountWindowOpen() {
    if (quietForced) return true;
    if (!sidebarQuiet) return false;
    if (document.readyState !== 'complete') return false;
    if (Date.now() - bootTime < MIN_PAGE_AGE_MS) return false;
    if (!loadPlusTailElapsed()) return false;
    return true;
  }

  let loadTime = 0;
  if (document.readyState === 'complete') {
    loadTime = Date.now();
  } else {
    window.addEventListener(
      'load',
      () => {
        loadTime = Date.now();
      },
      { once: true }
    );
  }

  function loadPlusTailElapsed() {
    return loadTime !== 0 && Date.now() - loadTime > TAIL_AFTER_LOAD_MS;
  }

  function waitForMountWindow() {
    return new Promise((resolve) => {
      const tick = setInterval(() => {
        ensureQuietWatcher();
        if (mountWindowOpen() || Date.now() - bootTime > MOUNT_CAP_MS) {
          clearInterval(tick);
          sidebarQuiet = true;
          resolve();
        }
      }, 300);
    });
  }

  // ---------------------------------------------------------------------------
  // Dynamic sidebar — tolerate React rerenders without rebuilding the sidebar.
  // ---------------------------------------------------------------------------
  let scanScheduled = false;

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    const run = () => {
      scanScheduled = false;
      try {
        if (massDeleteEnabled()) {
          ensureToolbar();
          syncRowCheckboxes();
          updateToolbar();
        }
        // Coordinated hook: cleanup.js (Upgrade/projects) rides the same
        // debounced scan instead of running a second observer.
        try {
          if (typeof window.__cmdCleanupScan === 'function') {
            window.__cmdCleanupScan();
          }
        } catch {
          // Never break the host page.
        }
      } catch {
        // Never break the host page.
      }
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(run, 0));
    } else {
      setTimeout(run, 50);
    }
  }

  const observer = new MutationObserver((mutations) => {
    // Ignore mutations caused by our own toolbar/modal/checkboxes.
    let relevant = false;
    for (const m of mutations) {
      if (m.type === 'attributes') {
        if (m.target instanceof Element && !m.target.closest(`[${PREFIX}]`)) {
          relevant = true;
          break;
        }
        continue;
      }
      if (m.target instanceof Element && m.target.closest(`[${PREFIX}]`)) {
        // The checkbox wrapper lives inside a sidebar item, so check whether
        // the sidebar item itself was added/removed as well.
        for (const n of m.addedNodes) {
          if (n instanceof Element && (n.matches?.(SIDEBAR_ITEM_SELECTOR) || n.querySelector?.(SIDEBAR_ITEM_SELECTOR))) {
            relevant = true;
            break;
          }
        }
        if (relevant) break;
        for (const n of m.removedNodes) {
          if (n instanceof Element && (n.matches?.(SIDEBAR_ITEM_SELECTOR) || n.querySelector?.(SIDEBAR_ITEM_SELECTOR))) {
            relevant = true;
            break;
          }
        }
        if (relevant) break;
        continue;
      }
      relevant = true;
      break;
    }
    if (relevant) scheduleScan();
  });

  function diagnoseStyles() {
    try {
      const toolbar = document.querySelector(`[${PREFIX}="toolbar"]`);
      if (!toolbar) {
        console.info('[ChatGPT Mass Delete] toolbar check: toolbar node missing');
        return;
      }
      const cs = getComputedStyle(toolbar);
      console.info(
        '[ChatGPT Mass Delete] toolbar check: position=%s top=%s left=%s display=%s z=%s bg=%s',
        cs.position, cs.top, cs.left, cs.display, cs.zIndex, cs.backgroundColor
      );
    } catch {
      console.info('[ChatGPT Mass Delete] toolbar check: unavailable');
    }
  }

  // Event handlers touch no DOM on registration: safe to attach at once —
  // they only act on our own elements when events fire.
  document.addEventListener('pointerdown', onPointerDownCapture, true);
  document.addEventListener('click', onClickCapture, true);
  document.addEventListener('dblclick', onTopboxDblclickCapture, true);
  document.addEventListener('keydown', onKeyCapture, true);
  document.addEventListener('keyup', onKeyCapture, true);
  document.addEventListener('mousedown', onMouseDownOrDragCapture, true);
  document.addEventListener('dragstart', onMouseDownOrDragCapture, true);

  async function boot() {
    // Wait for a proven mount window (quiet + loaded + tail + min age)
    // before inserting anything into React's tree.
    await waitForMountWindow();

    ensureToolbar();
    syncRowCheckboxes();
    updateToolbar();

    // href/aria-label cover in-place row recycling (virtualized lists);
    // childList covers added/removed conversations.
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href', 'aria-label'],
    });

    console.info(
      '[ChatGPT Mass Delete] active — %d conversations detected',
      findConversations().length
    );
    setTimeout(diagnoseStyles, 2000);

    // Catch late sidebar renders (cold load, SPA nav).
    for (const delay of [500, 1500, 3000, 6000]) {
      setTimeout(scheduleScan, delay);
    }

    // Self-heal: if a ChatGPT rerender drops the header control, remount
    // it — but only when calm, so re-insertion can never race hydration
    // or churn and trigger error #418 again. Re-anchors the churn
    // watcher first in case React swapped the sidebar subtree.
    // Cheap (one querySelector + list scan) and inert when all is well.
    setInterval(() => {
      try {
        ensureQuietWatcher();
        ensureToolbar();
        syncRowCheckboxes();
      } catch {
        // Never break the host page.
      }
    }, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
  } else {
    void boot();
  }
})();
