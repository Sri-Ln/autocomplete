/**
 * resume.js — attach the saved résumé to a page's own upload field.
 *
 * The popup keeps a copy of the file (a browser extension cannot read one from
 * disk by path). Here it is rebuilt as a File and handed to the page's
 * <input type="file"> the way a drop does: through a DataTransfer, then the
 * input and change events the page listens for. Nothing is sent anywhere but
 * that input.
 *
 * Only an upload field for a résumé or CV qualifies — never a cover letter,
 * transcript or other attachment — and the caller attaches only when the field
 * is empty, so a file the user chose is never replaced.
 */
(() => {
  'use strict';

  const RESUME = /\bresum[eé]s?\b|r[eé]sum[eé]|\bcv\b|curriculum vitae/i;
  const NOT_RESUME = /cover|transcript|portfolio|writing sample|reference|certificat|other/i;

  /** Whether a field's label or id names a résumé upload. */
  const isResumeField = (text) => RESUME.test(text ?? '') && !NOT_RESUME.test(text ?? '');

  /** The saved résumé as a File, or null when none is saved. */
  async function load() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'getResume' });
      const r = res?.ok ? res.resume : null;
      if (!r?.data) return null;
      const bytes = Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0));
      return new File([bytes], r.name, { type: r.type, lastModified: r.updated ?? Date.now() });
    } catch {
      return null;
    }
  }

  /**
   * Put `file` on `input` → true once `took()` says the page shows it.
   * Uploads can take a few seconds, so the wait is generous.
   */
  async function attach(input, file, took, timeoutMs = 15000) {
    if (!input || !file) return false;
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return !!(await AF.waitFor(took, timeoutMs, 100));
  }

  AF.resume = { isResumeField, load, attach };
})();
