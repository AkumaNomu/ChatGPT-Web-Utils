/* ChatGPT Mass Delete + Cleanup — shared settings.
 *
 * Runs first (see manifest content_scripts order) and exposes a tiny
 * toggle registry on window. All four features default to ON.
 *
 * Future settings UI: hydrate `overrides` from
 * browser.storage.local / chrome.storage.local here and subscribe to
 * storage changes — call sites already read through isEnabled(), so no
 * other file needs to change.
 */
(() => {
  'use strict';

  const DEFAULTS = {
    massDelete: true,
    removeUpgrade: true,
    removeDisclaimer: true,
    keepProjectsCollapsed: true,
  };

  const overrides = {};

  function isEnabled(name) {
    if (Object.prototype.hasOwnProperty.call(overrides, name)) {
      return overrides[name] === true;
    }
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, name)) {
      return DEFAULTS[name] === true;
    }
    return false;
  }

  function setOverride(name, value) {
    overrides[name] = value === true;
  }

  window.__cmdSettings = { DEFAULTS, isEnabled, setOverride };
})();
