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
  const CONVERSATION_ID_PATTERN = /\/c\/([0-9a-f-]{8,})/i;

  const DELETE_PATH = (id) => `/backend-api/conversation/id/${encodeURIComponent(id)}`;
  const CONCURRENCY = 4;
  const MAX_RETRIES = 3;

  const PREFIX = 'data-chatgpt-mass-delete';
  const SELECTED_ATTR = 'data-chatgpt-mass-delete-selected';
  const ID_ATTR = 'data-chatgpt-mass-delete-id';

  // ---------------------------------------------------------------------------
  // State. Only conversation IDs are stored. Never tokens/cookies/sessions.
  // ---------------------------------------------------------------------------
  /** @type {Set<string>} */
  const selected = new Set();
  let isDeleting = false;

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
    return Array.from(document.querySelectorAll(SIDEBAR_ITEM_SELECTOR));
  }

  function findItemForId(id) {
    return findConversations().filter((item) => getConversationId(item) === id);
  }

  // ---------------------------------------------------------------------------
  // Toolbar — fixed panel docked at the sidebar's bottom-left, appended to
  // <body> OUTSIDE ChatGPT's React tree so rerenders can never remove,
  // relocate, or hide it.
  // ---------------------------------------------------------------------------
  function getToolbarElements() {
    const toolbar = document.querySelector(`[${PREFIX}="toolbar"]`);
    if (!toolbar) return null;
    return {
      toolbar,
      selectAll: toolbar.querySelector(`[${PREFIX}="select-all"]`),
      clear: toolbar.querySelector(`[${PREFIX}="clear"]`),
      count: toolbar.querySelector(`[${PREFIX}="count"]`),
      deleteBtn: toolbar.querySelector(`[${PREFIX}="delete"]`),
      status: toolbar.querySelector(`[${PREFIX}="status"]`),
    };
  }

  function isDarkTheme() {
    return (
      document.documentElement.classList.contains('dark') ||
      document.body?.classList.contains('dark') === true
    );
  }

  // Inline critical styles: the manifest stylesheet is the primary path,
  // but these guarantee the panel is visible even if it fails to apply.
  function styleToolbarInline(toolbar) {
    const dark = isDarkTheme();
    toolbar.style.position = 'fixed';
    toolbar.style.top = '12px';
    toolbar.style.left = '50%';
    toolbar.style.transform = 'translateX(-50%)';
    toolbar.style.zIndex = '2147483646';
    toolbar.style.width = '360px';
    toolbar.style.maxWidth = 'calc(100vw - 24px)';
    toolbar.style.background = dark ? '#212121' : '#ffffff';
    toolbar.style.color = dark ? '#ececec' : '#0d0d0d';
    toolbar.style.border = '1px solid rgba(128, 128, 128, 0.4)';
    toolbar.style.borderRadius = '14px';
    toolbar.style.boxShadow = '0 10px 30px rgba(0, 0, 0, 0.25)';
    toolbar.style.padding = '12px';
    toolbar.style.fontSize = '13px';
    toolbar.style.lineHeight = '1.4';
  }

  function makeButton(kind, label) {
    const btn = document.createElement('button');
    btn.setAttribute(PREFIX, kind);
    btn.type = 'button';
    btn.textContent = label;
    return btn;
  }

  function ensureToolbar() {
    if (document.querySelector(`[${PREFIX}="toolbar"]`)) {
      updateToolbar();
      return;
    }
    if (!document.body) {
      setTimeout(scheduleScan, 300);
      return;
    }

    const toolbar = document.createElement('div');
    toolbar.setAttribute(PREFIX, 'toolbar');

    const head = document.createElement('div');
    head.setAttribute(PREFIX, 'toolbar-head');

    const title = document.createElement('span');
    title.setAttribute(PREFIX, 'toolbar-title');
    title.textContent = 'Mass delete';

    const count = document.createElement('span');
    count.setAttribute(PREFIX, 'count');
    count.setAttribute('aria-live', 'polite');

    const row = document.createElement('div');
    row.setAttribute(PREFIX, 'toolbar-row');

    const selectAll = makeButton('select-all', 'Select all');
    const clear = makeButton('clear', 'Clear');

    const deleteBtn = makeButton('delete', 'Delete selected');

    const status = document.createElement('div');
    status.setAttribute(PREFIX, 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;

    selectAll.addEventListener('click', (e) => {
      e.stopPropagation();
      selectAllConversations();
    });
    clear.addEventListener('click', (e) => {
      e.stopPropagation();
      clearSelection();
    });
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void deleteSelected();
    });

    head.append(title, count);
    row.append(selectAll, clear, deleteBtn);
    toolbar.append(head, row, status);
    styleToolbarInline(toolbar);

    // Top-center panel outside React's tree: always visible, never
    // reconciled away.
    document.body.appendChild(toolbar);
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

  function updateToolbar() {
    const els = getToolbarElements();
    if (!els) return;
    const n = selected.size;
    els.count.textContent = n === 1 ? '1 selected' : `${n} selected`;
    els.count.toggleAttribute(`${PREFIX}-active`, n > 0);
    els.deleteBtn.disabled = n === 0 || isDeleting;
    els.selectAll.disabled = isDeleting;
    els.clear.disabled = n === 0 || isDeleting;
    els.deleteBtn.textContent = n === 0 ? 'Delete selected' : `Delete ${n} selected`;
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
    btn.style.width = '20px';
    btn.style.height = '20px';
    btn.style.display = 'inline-flex';
    btn.style.alignItems = 'center';
    btn.style.justifyContent = 'center';
    btn.style.margin = '0';
    btn.style.padding = '0';
    btn.style.flex = '0 0 auto';
    btn.style.border = '2px solid #888';
    btn.style.borderRadius = '6px';
    btn.style.background = selected.has(id) ? '#10a37f' : 'transparent';
    btn.style.borderColor = selected.has(id) ? '#10a37f' : '';
    btn.style.color = selected.has(id) ? '#ffffff' : '';
    btn.style.cursor = 'pointer';

    const svg = document.createElementNS(CHECKBOX_SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute(PREFIX, 'checkbox-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.style.width = '13px';
    svg.style.height = '13px';
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
      btn.style.background = checked ? '#10a37f' : 'transparent';
      if (checked) {
        btn.style.borderColor = '#10a37f';
        btn.style.color = '#ffffff';
      } else {
        btn.style.borderColor = '';
        btn.style.color = '';
      }
      const icon = btn.firstChild;
      if (icon instanceof Element) icon.style.opacity = checked ? '1' : '0';
    }
    const wrapper = item.querySelector(`[${PREFIX}="checkbox-wrapper"]`);
    if (wrapper) wrapper.setAttribute(ID_ATTR, id);
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
    } else {
      selected.add(id);
    }
    for (const item of findItemForId(id)) {
      paintRow(item, id, selected.has(id));
    }
    updateToolbar();
  }

  function injectCheckbox(item) {
    const id = getConversationId(item);
    if (!id) return;

    let wrapper = item.querySelector(`[${PREFIX}="checkbox-wrapper"]`);
    if (wrapper) {
      // Row may have been recycled for another conversation (virtualized
      // list) — refresh the id and repaint from the Set.
      syncCheckboxForItem(item, id);
      return;
    }

    wrapper = document.createElement('span');
    wrapper.setAttribute(PREFIX, 'checkbox-wrapper');
    wrapper.setAttribute(ID_ATTR, id);
    wrapper.title = 'Select conversation';
    wrapper.style.display = 'inline-flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.justifyContent = 'center';
    wrapper.style.alignSelf = 'center';
    wrapper.style.flex = '0 0 auto';
    wrapper.style.position = 'relative';
    wrapper.style.zIndex = '1';
    wrapper.style.marginRight = '6px';
    wrapper.style.padding = '5px';
    wrapper.style.borderRadius = '8px';
    wrapper.style.cursor = 'pointer';
    // No per-node listeners: toggling is handled by document-level capture
    // handlers so ChatGPT row handlers can never swallow the event.
    wrapper.appendChild(createCheckboxButton(id, getConversationTitle(item)));
    item.insertBefore(wrapper, item.firstChild);
    if (selected.has(id)) {
      item.setAttribute(SELECTED_ATTR, 'true');
    }
  }

  function ensureAllCheckboxes() {
    for (const item of findConversations()) {
      injectCheckbox(item);
    }
  }

  function syncAllCheckboxes() {
    for (const item of findConversations()) {
      const id = getConversationId(item);
      if (id) syncCheckboxForItem(item, id);
    }
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
  function onClickCapture(e) {
    const id = wrapperIdFromEventTarget(e.target);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    toggleSelection(id);
  }

  function onKeyCapture(e) {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.getAttribute(PREFIX) !== 'checkbox') return;
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
  function selectAllConversations() {
    if (isDeleting) return;
    for (const item of findConversations()) {
      const id = getConversationId(item);
      if (id) selected.add(id);
    }
    syncAllCheckboxes();
    updateToolbar();
  }

  function clearSelection() {
    if (isDeleting) return;
    selected.clear();
    syncAllCheckboxes();
    setStatus('');
    updateToolbar();
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
      body.textContent = 'This cannot be undone. Deleted conversations cannot be recovered.';

      const actions = document.createElement('div');
      actions.setAttribute(PREFIX, 'dialog-actions');

      const cancel = document.createElement('button');
      cancel.setAttribute(PREFIX, 'dialog-cancel');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';

      const confirm = document.createElement('button');
      confirm.setAttribute(PREFIX, 'dialog-confirm');
      confirm.type = 'button';
      confirm.textContent = count === 1 ? 'Delete' : `Delete ${count}`;

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
  // Returns { ok, status }. status is the HTTP code, or 0 when the
  // request never completed (network error / blocked). Only numeric
  // statuses and conversation IDs are ever logged — never headers,
  // bodies, tokens, or cookies.
  async function deleteOneConversation(id, attempt = 0) {
    try {
      const response = await fetch(DELETE_PATH(id), {
        method: 'DELETE',
        credentials: 'include',
      });
      if (response.ok) return { ok: true, status: response.status }; // HTTP 2xx → success

      const retryable = response.status === 429 || (response.status >= 500 && response.status < 600);
      if (retryable && attempt < MAX_RETRIES) {
        let delay = Math.min(1000 * 2 ** attempt, 8000);
        const retryAfter = response.headers.get('Retry-After');
        if (retryAfter) {
          const seconds = parseInt(retryAfter, 10);
          if (!Number.isNaN(seconds)) delay = Math.min(Math.max(seconds, 0) * 1000, 15000);
        }
        await sleep(delay + Math.random() * 500);
        return deleteOneConversation(id, attempt + 1);
      }
      return { ok: false, status: response.status };
    } catch {
      if (attempt < MAX_RETRIES) {
        await sleep(1000 * 2 ** attempt + Math.random() * 500);
        return deleteOneConversation(id, attempt + 1);
      }
      return { ok: false, status: 0 };
    }
  }

  function reasonForStatus(status) {
    if (status === 0) return 'network error — the request was blocked or never sent';
    if (status === 401 || status === 403) {
      return `HTTP ${status} — ChatGPT rejected the request (authorization)`;
    }
    if (status === 404) return 'HTTP 404 — endpoint not found (ChatGPT may have changed its API)';
    if (status === 429) return 'HTTP 429 — rate-limited by ChatGPT';
    if (status >= 500 && status < 600) return `HTTP ${status} — ChatGPT server error`;
    return `HTTP ${status}`;
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

    setStatus(`Deleting conversations… 0 / ${total}`, 'progress');

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
            '[ChatGPT Mass Delete] delete failed: id=%s http=%s',
            id,
            res.status === 0 ? 'network-error' : res.status
          );
          // Failed rows stay in the sidebar and stay selected for retry.
        }
        done += 1;
        setStatus(`Deleting conversations… ${done} / ${total}`, 'progress');
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
    syncAllCheckboxes();
    updateToolbar();

    let message;
    let mode;
    const tallyText = Array.from(statusTally.entries())
      .map(([status, n]) => (status === 0 ? `network-error×${n}` : `HTTP ${status}×${n}`))
      .join(', ');
    // Most common failure status drives the human-readable reason.
    const topStatus = Array.from(statusTally.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
    const reason = topStatus === undefined ? '' : ` (${reasonForStatus(topStatus)})`;
    if (failed === 0) {
      message = total === 1 ? 'Deleted 1 conversation.' : `Deleted ${succeeded} conversations.`;
      mode = 'success';
    } else if (succeeded === 0) {
      message = failed === 1
        ? `Could not delete 1 conversation${reason}.`
        : `Deleted 0 of ${total} conversations. ${failed} could not be deleted${reason}.`;
      mode = 'error';
    } else {
      message = `Deleted ${succeeded} of ${total} conversations. ` +
        `${failed} conversation${failed === 1 ? '' : 's'} could not be deleted${reason}.`;
      mode = 'error';
    }
    setStatus(message, mode);
    console.info('[ChatGPT Mass Delete] %s%s', message, tallyText ? ` [${tallyText}]` : '');
    updateToolbar();
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
        ensureToolbar();
        ensureAllCheckboxes();
        updateToolbar();
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

  function boot() {
    // Document-level capture first: our handlers run before any ChatGPT
    // row-level handler, so selection can never be swallowed.
    document.addEventListener('pointerdown', onPointerDownCapture, true);
    document.addEventListener('click', onClickCapture, true);
    document.addEventListener('keydown', onKeyCapture, true);
    document.addEventListener('keyup', onKeyCapture, true);
    document.addEventListener('mousedown', onMouseDownOrDragCapture, true);
    document.addEventListener('dragstart', onMouseDownOrDragCapture, true);

    ensureToolbar();
    ensureAllCheckboxes();
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
