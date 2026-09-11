/* ============================================================================
 *  tools/harvest-myinfo.js — PASTE INTO THE DEVTOOLS CONSOLE ON THE
 *  "MY INFORMATION" PAGE OF A WORKDAY APPLICATION.
 *
 *  Unlike tools/harvest.js (which only lists data-automation-ids), this one
 *  also OPENS each dropdown and records what is inside it, including one level
 *  of nesting — because "FINRA Career Site" lives under "Job Sites" and the
 *  selector alone tells us nothing about how to reach it.
 *
 *  SAFETY: it only opens and closes dropdowns. It never selects an option,
 *  never types into a field, and never clicks Save/Continue/Next. Your
 *  application is left exactly as it was.
 *
 *  ── USAGE ─────────────────────────────────────────────────────────────────
 *    1. Get to My Information (sign in → any job → Apply).
 *    2. DevTools → Console → paste this whole file → Enter.
 *    3. Wait for it to finish (it pauses while each dropdown animates).
 *    4. Run  __afReport()  — the result is copied to your clipboard.
 *    5. Paste that to me.
 *
 *  ── EXTRAS ────────────────────────────────────────────────────────────────
 *    __afDeepScan('[data-automation-id="xyz"]')   drill a single dropdown,
 *                                                 including into categories
 *    __afReport()                                 re-copy the JSON
 * ========================================================================= */

(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (el) => el && el.getClientRects().length > 0;

  const OPTION_SELECTORS = [
    '[data-automation-id="promptOption"]',
    '[role="option"]',
    '[data-automation-id="menuItem"]',
    'li[data-automation-id]',
  ];

  function labelFor(el) {
    const aria = el.getAttribute?.('aria-label');
    if (aria) return aria.trim();

    const by = el.getAttribute?.('aria-labelledby');
    if (by) {
      const t = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean)
        .join(' ');
      if (t) return t;
    }
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return l.textContent.trim();
    }
    const wrap = el.closest?.('label');
    if (wrap) return wrap.textContent.trim().slice(0, 70);
    if (el.placeholder) return `(placeholder) ${el.placeholder}`;
    const own = el.textContent?.trim();
    return own && own.length <= 70 ? own : '';
  }

  function currentOptions() {
    const seen = new Set();
    const out = [];
    for (const sel of OPTION_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (!vis(el)) continue;
        const text = (el.textContent || '').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push({
          text: text.slice(0, 60),
          automationId: el.getAttribute('data-automation-id') || null,
          role: el.getAttribute('role') || null,
          // A chevron/expand affordance usually means it drills into a submenu.
          looksLikeCategory:
            el.getAttribute('aria-haspopup') === 'true' ||
            el.getAttribute('aria-expanded') !== null ||
            !!el.querySelector('[data-automation-id*="chevron" i], [class*="chevron" i]'),
        });
      }
    }
    return out;
  }

  async function closePopups() {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.activeElement?.dispatchEvent?.(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    await sleep(250);
  }

  /* ---- fields ---- */

  function scanFields() {
    const rows = [];
    for (const el of document.querySelectorAll('[data-automation-id]')) {
      if (!vis(el)) continue;
      const field = el.matches('input,select,textarea,button')
        ? el
        : el.querySelector('input,select,textarea,button');
      if (!field) continue;

      const isPrompt =
        field.getAttribute('aria-haspopup') === 'listbox' ||
        field.getAttribute('aria-haspopup') === 'true' ||
        field.getAttribute('role') === 'combobox' ||
        field.tagName === 'SELECT' ||
        (field.tagName === 'BUTTON' && /select|prompt|search/i.test(el.getAttribute('data-automation-id') || ''));

      rows.push({
        automationId: el.getAttribute('data-automation-id'),
        tag: field.tagName.toLowerCase(),
        type: field.type || '',
        kind: field.tagName === 'SELECT' ? 'select' : isPrompt ? 'prompt' : 'text',
        required: field.required || field.getAttribute('aria-required') === 'true',
        value: field.type === 'password' ? '<hidden>' : (field.value || '').slice(0, 40),
        label: labelFor(field) || labelFor(el),
      });
    }
    return rows;
  }

  /* ---- dropdowns ---- */

  async function openAndRecord(automationId) {
    const el = document.querySelector(`[data-automation-id="${CSS.escape(automationId)}"]`);
    if (!el) return { automationId, error: 'not found' };

    const trigger = el.matches('button,input,select') ? el : el.querySelector('button,input,select');
    if (!trigger) return { automationId, error: 'no trigger' };

    if (trigger.tagName === 'SELECT') {
      return {
        automationId,
        kind: 'native-select',
        options: [...trigger.options].map((o) => ({ text: o.textContent.trim(), value: o.value })),
      };
    }

    const before = currentOptions().length;
    try {
      trigger.click();
    } catch {
      return { automationId, error: 'click threw' };
    }
    await sleep(700);

    const options = currentOptions();
    const searchBox = [...document.querySelectorAll('input[type="text"], input[type="search"]')]
      .filter(vis)
      .map((i) => i.getAttribute('data-automation-id') || i.getAttribute('aria-label') || i.placeholder)
      .filter(Boolean);

    await closePopups();

    return {
      automationId,
      kind: 'prompt',
      openedNewOptions: options.length > before,
      searchInputs: searchBox.slice(0, 4),
      options,
    };
  }

  /** Drill into every category-looking entry, one level deep. */
  window.__afDeepScan = async (selector) => {
    const el = document.querySelector(selector);
    if (!el) return console.warn('no element for', selector);
    const trigger = el.matches('button,input') ? el : el.querySelector('button,input');
    if (!trigger) return console.warn('no trigger inside', selector);

    trigger.click();
    await sleep(700);

    const top = currentOptions();
    console.log('%cTop level:', 'color:#7c5cff;font-weight:bold');
    console.table(top);

    const result = { selector, topLevel: top, categories: {} };

    for (const opt of top) {
      const node = [...document.querySelectorAll(OPTION_SELECTORS.join(','))].find(
        (n) => vis(n) && n.textContent.trim().startsWith(opt.text.slice(0, 30))
      );
      if (!node) continue;

      node.click();
      await sleep(600);

      const inner = currentOptions().filter((o) => !top.some((t) => t.text === o.text));
      if (inner.length) {
        result.categories[opt.text] = inner;
        console.log(`%c  ${opt.text} →`, 'color:#46c17f', inner.map((i) => i.text).join(', '));
      }

      // Step back out: a Back control if there is one, else reopen from scratch.
      const back = [...document.querySelectorAll('button,[role="button"]')].find(
        (b) => vis(b) && /^\s*(back|‹|←)/i.test(b.textContent || '')
      );
      if (back) {
        back.click();
        await sleep(500);
      } else {
        await closePopups();
        trigger.click();
        await sleep(700);
      }
    }

    await closePopups();
    window.__afDeep = result;
    console.log('%cStored in __afDeep', 'color:#8a8a9c');
    return result;
  };

  /* ---- run ---- */

  (async () => {
    console.clear();
    console.log('%cHarvesting My Information…', 'color:#7c5cff;font-weight:bold;font-size:13px');

    const fields = scanFields();
    console.log(`${fields.length} fields found`);
    console.table(fields);

    const prompts = fields.filter((f) => f.kind === 'prompt' || f.kind === 'select');
    console.log(`%cOpening ${prompts.length} dropdowns…`, 'color:#8a8a9c');

    const dropdowns = [];
    for (const p of prompts) {
      const r = await openAndRecord(p.automationId);
      dropdowns.push(r);
      console.log(`  ${p.automationId}: ${r.options?.length ?? 0} options`);
    }

    window.__afResult = {
      url: location.href,
      hostname: location.hostname,
      title: document.title,
      fields,
      dropdowns,
    };

    console.log(
      '%c\nDone. Run __afReport() to copy the JSON, then paste it to Claude.',
      'color:#46c17f;font-weight:bold'
    );
    console.log(
      '%cIf the "how did you hear about us" dropdown came back empty or shallow, run:\n' +
        '  __afDeepScan(\'[data-automation-id="THE_ID"]\')',
      'color:#8a8a9c'
    );
  })();

  window.__afReport = () => {
    const json = JSON.stringify({ ...window.__afResult, deep: window.__afDeep }, null, 1);
    console.log(json);
    try {
      copy(json);
      console.log('%cCopied to clipboard.', 'color:#46c17f');
    } catch {
      console.log('%cSelect the JSON above and copy it manually.', 'color:#f0a83c');
    }
    return json;
  };
})();
