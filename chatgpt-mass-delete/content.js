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

  // ---------------------------------------------------------------------------
  // Toolbar
  // ---------------------------------------------------------------------------
  function findSidebarContainer() {
    const items = findConversations();
    if (items.length === 0) return null;
    const first = items[0];
    return (
      first.closest('nav') ||
      first.closest('aside') ||
      first.parentElement
    );
  }

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

  function ensureToolbar() {
    if (document.querySelector(`[${PREFIX}="toolbar"]`)) {
      updateToolbar();
      return;
    }
    const container = findSidebarContainer();
    if (!container) return;

    const toolbar = document.createElement('div');
    toolbar.setAttribute(PREFIX, 'toolbar');

    const row = document.createElement('div');
    row.setAttribute(PREFIX, 'toolbar-row');

    const selectAll = document.createElement('button');
    selectAll.setAttribute(PREFIX, 'select-all');
    selectAll.type = 'button';
    selectAll.textContent = 'Select all';

    const clear = document.createElement('button');
    clear.setAttribute(PREFIX, 'clear');
    clear.type = 'button';
    clear.textContent = 'Clear selection';

    const count = document.createElement('span');
    count.setAttribute(PREFIX, 'count');
    count.setAttribute('aria-live', 'polite');

    const deleteBtn = document.createElement('button');
    deleteBtn.setAttribute(PREFIX, 'delete');
    deleteBtn.type = 'button';
    deleteBtn.textContent = 'Delete selected';

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

    row.append(selectAll, clear, count, deleteBtn);
    toolbar.append(row, status);

    // Prepend so it stays visible at the top of the sidebar.
    container.insertBefore(toolbar, container.firstChild);
    updateToolbar();
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
    els.count.textContent = `${n} selected`;
    els.deleteBtn.disabled = n === 0 || isDeleting;
    els.selectAll.disabled = isDeleting;
    els.clear.disabled = n === 0 || isDeleting;
    els.deleteBtn.textContent = n === 0 ? 'Delete selected' : `Delete selected (${n})`;
  }

  // ---------------------------------------------------------------------------
  // Checkboxes
  // ---------------------------------------------------------------------------
  function syncCheckboxForItem(item, id) {
    const input = item.querySelector(`[${PREFIX}="checkbox"]`);
    if (!input) return;
    const shouldCheck = selected.has(id);
    if (input.checked !== shouldCheck) input.checked = shouldCheck;
    input.setAttribute('aria-label', `Select conversation ${getConversationTitle(item)}`.trim());
    if (shouldCheck) {
      item.setAttribute(SELECTED_ATTR, 'true');
    } else {
      item.removeAttribute(SELECTED_ATTR);
    }
  }

  function toggleSelection(id, checked) {
    if (checked) {
      selected.add(id);
    } else {
      selected.delete(id);
    }
    // Sync highlight on every row with this id (normally one).
    for (const item of findConversations()) {
      if (getConversationId(item) === id) syncCheckboxForItem(item, id);
    }
    updateToolbar();
  }

  function injectCheckbox(item) {
    const id = getConversationId(item);
    if (!id) return;

    const existing = item.querySelector(`[${PREFIX}="checkbox-wrapper"]`);
    if (existing) {
      // Keep the wrapper's id in sync in case the row was recycled.
      existing.setAttribute(`${PREFIX}-id`, id);
      const input = existing.querySelector(`[${PREFIX}="checkbox"]`);
      if (input) input.setAttribute(`${PREFIX}-id`, id);
      syncCheckboxForItem(item, id);
      return;
    }

    const wrapper = document.createElement('span');
    wrapper.setAttribute(PREFIX, 'checkbox-wrapper');
    wrapper.setAttribute(`${PREFIX}-id`, id);
    wrapper.title = 'Select conversation';
    wrapper.draggable = false;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute(PREFIX, 'checkbox');
    input.setAttribute(`${PREFIX}-id`, id);
    input.checked = selected.has(id);
    input.tabIndex = 0;
    input.setAttribute('aria-label', `Select conversation ${getConversationTitle(item)}`.trim());

    // Clicking the checkbox must only toggle selection — never navigate,
    // drag, pin, or open the three-dot menu.
    const toggleFromEvent = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isDeleting) return;
      input.checked = !input.checked;
      toggleSelection(id, input.checked);
    };

    wrapper.addEventListener('click', toggleFromEvent, true);
    wrapper.addEventListener('mousedown', (e) => e.stopPropagation(), true);
    wrapper.addEventListener('pointerdown', (e) => e.stopPropagation(), true);
    wrapper.addEventListener('dragstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, true);
    input.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (isDeleting) return;
        input.checked = !input.checked;
        toggleSelection(id, input.checked);
      } else {
        e.stopPropagation();
      }
    });
    // Change events (e.g. keyboard AT) funnel through the same path.
    input.addEventListener('click', (e) => e.stopPropagation());

    wrapper.appendChild(input);
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
      dialog.append(title, body, actions);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      cancel.focus();
    });
  }

  // ---------------------------------------------------------------------------
  // Deletion API — same-origin, uses the existing ChatGPT session only.
  // Never touches auth headers, cookies, or tokens.
  // ---------------------------------------------------------------------------
  async function deleteOneConversation(id, attempt = 0) {
    try {
      const response = await fetch(DELETE_PATH(id), {
        method: 'DELETE',
        credentials: 'include',
      });
      if (response.ok) return true; // HTTP 2xx → success

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
      return false;
    } catch {
      if (attempt < MAX_RETRIES) {
        await sleep(1000 * 2 ** attempt + Math.random() * 500);
        return deleteOneConversation(id, attempt + 1);
      }
      return false;
    }
  }

  function removeConversationFromSidebar(id) {
    for (const item of findConversations()) {
      if (getConversationId(item) === id) {
        item.remove();
      }
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

    setStatus(`Deleting conversations… 0 / ${total}`, 'progress');

    async function worker() {
      while (cursor < ids.length) {
        const id = ids[cursor];
        cursor += 1;
        const ok = await deleteOneConversation(id);
        if (ok) {
          succeeded += 1;
          selected.delete(id);
          removeConversationFromSidebar(id);
        } else {
          failed += 1;
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

    if (failed === 0) {
      setStatus(
        total === 1 ? 'Deleted 1 conversation.' : `Deleted ${succeeded} conversations.`,
        'success'
      );
    } else if (succeeded === 0) {
      setStatus(
        failed === 1
          ? 'Could not delete 1 conversation.'
          : `Deleted 0 of ${total} conversations. ${failed} conversations could not be deleted.`,
        'error'
      );
    } else {
      setStatus(
        `Deleted ${succeeded} of ${total} conversations. ` +
          `${failed} conversation${failed === 1 ? '' : 's'} could not be deleted.`,
        'error'
      );
    }
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

  function isExtensionNode(node) {
    return (
      node instanceof Element &&
      (node.hasAttribute(PREFIX) || node.closest(`[${PREFIX}]`) !== null)
    );
  }

  const observer = new MutationObserver((mutations) => {
    // Ignore mutations caused by our own toolbar/modal/checkboxes.
    let relevant = false;
    for (const m of mutations) {
      if (m.target instanceof Element && m.target.closest(`[${PREFIX}]`)) {
        // The checkbox wrapper lives inside a sidebar item, so check whether
        // the sidebar item itself was added/removed as well.
        const addedItems = [];
        const removedItems = [];
        for (const n of m.addedNodes) {
          if (n instanceof Element) {
            if (n.matches?.(SIDEBAR_ITEM_SELECTOR)) addedItems.push(n);
            else if (n.querySelector?.(SIDEBAR_ITEM_SELECTOR)) relevant = true;
          }
        }
        for (const n of m.removedNodes) {
          if (n instanceof Element) {
            if (n.matches?.(SIDEBAR_ITEM_SELECTOR)) removedItems.push(n);
            else if (n.querySelector?.(SIDEBAR_ITEM_SELECTOR)) relevant = true;
          }
        }
        if (addedItems.length > 0 || removedItems.length > 0) relevant = true;
        continue;
      }
      relevant = true;
      // Quick check: does this mutation touch sidebar items?
      for (const n of m.addedNodes) {
        if (n instanceof Element) {
          if (isExtensionNode(n)) continue;
          relevant = true;
          break;
        }
      }
      if (relevant) break;
    }
    if (relevant) scheduleScan();
  });

  function boot() {
    ensureToolbar();
    ensureAllCheckboxes();
    updateToolbar();

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

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
