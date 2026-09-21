/**
 * free-text.js — finding the prose questions on a page.
 *
 * The sibling of radio-groups.js, and structural for the same reason: an
 * application's questions are written per company, so their data-automation-ids
 * are unpredictable and there is no stable list to enumerate. What is stable is
 * the shape — a question, and a box big enough to answer it in.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────
 * The visa question does not appear on My Information. It turns up later in the
 * application, on a page AF.currentPage() returns null for — so there is no
 * adapter entry, no field map, and nothing for filler.js to resolve. This file
 * is the page-agnostic path: it works from what is on screen rather than from
 * what the registry knows.
 *
 * Nothing here submits anything. See the guards note in main.js.
 */

AF.freeText = {};

/* Below this, a box is a short-answer field rather than somewhere to write a
 * paragraph. Workday renders plenty of both. */
const LONG_ENOUGH = 120;

/**
 * Can this field hold a paragraph?
 *
 * Pure, and deliberately reads nothing but the element's own properties — no
 * layout, no ancestors — which is what keeps it testable outside a browser.
 * See test/free-text.test.mjs.
 *
 * The maxlength check is the one that matters in practice: writing 60 words
 * into a maxlength=40 input truncates silently, and the application goes out
 * with half a sentence in it.
 */
AF.freeText.acceptsLongText = function (el) {
  if (!el) return false;
  if (el.disabled || el.readOnly) return false;

  const tag = String(el.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;

  const type = String(el.type ?? 'text').toLowerCase();
  if (type !== 'text' && type !== 'search') return false;

  const max = Number(el.maxLength);
  if (Number.isFinite(max) && max >= 0 && max < LONG_ENOUGH) return false;

  return true;
};

/** Visible in the layout sense — Workday keeps hidden duplicates in the DOM. */
function onScreen(el) {
  if (!el?.isConnected || !el.getClientRects().length) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

/**
 * The question a free-text field is asking.
 *
 * Its own label first, then the enclosing formField-* wrapper's text, which is
 * where Workday usually puts a long prompt that does not fit in a <label>.
 * Reuses describeField's label-hunting order rather than inventing a second one.
 */
AF.freeText.questionFor = function (el) {
  const direct =
    el.getAttribute('aria-label') ||
    (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) ||
    el.closest('label')?.textContent;

  if (direct?.trim()) return AF.questions.cleanQuestion(direct);

  const wrap = el.closest('[data-automation-id^="formField-"], fieldset, [role="group"]');
  if (wrap) {
    const text = (wrap.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text.length >= 8) return AF.questions.cleanQuestion(text.slice(0, 300));
  }

  /* Last resort: the nearest preceding text block, same walk radio-groups.js
   * uses when a group has no legend. */
  let node = el.closest('[data-automation-id], div') ?? el;
  for (let i = 0; i < 4 && node; i++) {
    const prev = node.previousElementSibling;
    const text = prev?.textContent?.trim();
    if (text && text.length >= 8) return AF.questions.cleanQuestion(text.slice(0, 300));
    node = node.parentElement;
  }
  return '';
};

/**
 * Every prose field currently on screen, with the question it is asking.
 *
 * @returns [{ el, question, wantsVisa, filled }]
 */
AF.freeText.findQuestions = function (root = document) {
  const out = [];

  for (const el of root.querySelectorAll('textarea, input[type="text"], input[type="search"]')) {
    if (!AF.freeText.acceptsLongText(el) || !onScreen(el)) continue;

    // The honeypot, and anything else the adapter has told us to leave alone.
    if (el.name === 'website') continue;

    const question = AF.freeText.questionFor(el);
    if (!question) continue;

    out.push({
      el,
      question,
      wantsVisa: AF.questions.wantsVisaExplanation(question),
      filled: !!el.value.trim(),
    });
  }

  return out;
};

/** Just the visa ones, which is all any caller currently wants. */
AF.freeText.findVisaQuestions = (root = document) =>
  AF.freeText.findQuestions(root).filter((q) => q.wantsVisa);

/**
 * Write the explanation into one field.
 *
 * Goes through setNativeValue because these pages are React-controlled: a plain
 * .value assignment looks right on screen and leaves React's state empty, which
 * is the bug the whole extension exists to avoid. See content/react-set.js.
 *
 * Never overwrites. If you have already typed something, that is your answer.
 */
AF.freeText.fill = function (el, text) {
  if (!text) return { ok: false, reason: 'nothing saved to fill' };
  if (!AF.freeText.acceptsLongText(el)) return { ok: false, reason: 'field cannot hold it' };
  if (el.value.trim() === text.trim()) return { ok: true, already: true };
  if (el.value.trim()) return { ok: false, reason: 'already has an answer — left alone' };

  try {
    if (!AF.setNativeValue(el, text)) return { ok: false, reason: 'the page rejected the write' };
  } catch (err) {
    AF.log('freeText.fill threw', err);
    return { ok: false, reason: 'the page threw while filling' };
  }

  return el.value.trim() === text.trim()
    ? { ok: true }
    : { ok: false, reason: 'written but it did not stick' };
};
