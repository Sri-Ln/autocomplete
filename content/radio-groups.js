/**
 * radio-groups.js — finding and setting the Yes/No questions on a page.
 *
 * These cannot be handled by a selector map. Application questions are written
 * per company, so their data-automation-ids are unpredictable and there is no
 * stable list to enumerate. What IS stable is their structure: a question, and
 * a set of radio inputs sharing a name.
 *
 * So discovery is structural — find radio groups, read the question text above
 * them — and the answer comes from content/questions.js.
 */

/**
 * Every radio group currently on screen.
 *
 * @returns [{ name, question, options: [{ label, input }], selected }]
 */
AF.findRadioGroups = function (root = document) {
  const byName = new Map();

  for (const input of root.querySelectorAll('input[type="radio"]')) {
    if (!input.name) continue;
    if (!input.getClientRects().length && !input.closest('label')) continue;
    if (!byName.has(input.name)) byName.set(input.name, []);
    byName.get(input.name).push(input);
  }

  const groups = [];
  for (const [name, inputs] of byName) {
    if (inputs.length < 2) continue; // a lone radio is not a question
    groups.push({
      name,
      question: AF.questionTextFor(inputs),
      options: inputs.map((input) => ({ label: AF.labelForInput(input), input })),
      selected: inputs.find((i) => i.checked) ?? null,
    });
  }
  return groups;
};

/** The visible label of a single radio input. */
AF.labelForInput = function (input) {
  const aria = input.getAttribute('aria-label');
  if (aria) return aria.trim();

  if (input.id) {
    const forLabel = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (forLabel) return forLabel.textContent.trim();
  }

  const wrapping = input.closest('label');
  if (wrapping) return wrapping.textContent.trim();

  // Workday often puts the text in a sibling span.
  const sibling = input.parentElement?.querySelector('span, div');
  return sibling ? sibling.textContent.trim() : '';
};

/**
 * The question a radio group is asking.
 *
 * Walks up to the enclosing group/fieldset and takes its text minus the option
 * labels, which is what remains of the prompt. Falls back to the nearest
 * preceding heading or label-ish element.
 */
AF.questionTextFor = function (inputs) {
  const first = inputs[0];

  const container =
    first.closest('fieldset, [role="group"], [role="radiogroup"], [data-automation-id^="formField-"]') ??
    first.parentElement?.parentElement;

  if (container) {
    const legend = container.querySelector('legend, [role="heading"], h2, h3, h4');
    if (legend?.textContent.trim()) return legend.textContent.trim();

    // Strip the option labels out of the container's text; the prompt is left.
    let text = container.textContent ?? '';
    for (const input of inputs) {
      const label = AF.labelForInput(input);
      if (label) text = text.split(label).join(' ');
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length >= 8) return text.slice(0, 300);
  }

  // Last resort: the nearest preceding text block.
  let node = first.closest('[data-automation-id], div');
  for (let i = 0; i < 4 && node; i++) {
    const prev = node.previousElementSibling;
    const text = prev?.textContent?.trim();
    if (text && text.length >= 8) return text.slice(0, 300);
    node = node.parentElement;
  }
  return '';
};

/**
 * Select the option whose label matches `answer`.
 *
 * Radios go through the same click-first path as checkboxes — React routes
 * both onto the click event rather than change, so a prototype-setter write
 * plus a dispatched change never reaches it. See content/react-set.js.
 */
AF.answerRadioGroup = function (group, answer) {
  if (!answer) return { ok: false, reason: 'no answer' };

  const labels = group.options.map((o) => o.label);
  const hit = AF.bestMatch(labels, [answer], { threshold: 0.8, floor: 0.8 });
  if (!hit) {
    return { ok: false, reason: `no option matching "${answer}"`, sample: labels };
  }

  const target = group.options[hit.index].input;
  if (target.checked) return { ok: true, already: true };

  AF.setNativeChecked(target, true);

  return target.checked
    ? { ok: true }
    : { ok: false, reason: `clicked "${hit.text}" but it did not take` };
};

/**
 * Resolve and answer every radio question on the page.
 *
 * Returns a report the widget can show verbatim. Questions it will not answer
 * are listed with the reason, because "I left three questions for you" is only
 * useful if you can see which and why.
 */
AF.answerQuestions = function ({ profile, answers }) {
  const result = { answered: [], left: [], failed: [] };

  for (const group of AF.findRadioGroups()) {
    if (!group.question) continue;

    const short = group.question.slice(0, 70);

    if (group.selected) {
      result.answered.push({ question: short, answer: AF.labelForInput(group.selected),
                             source: 'already' });
      continue;
    }

    const decision = AF.questions.resolve(group.question, { profile, learned: answers });

    if (!decision.answer) {
      result.left.push({ question: short, reason: decision.reason, source: decision.source });
      continue;
    }

    const set = AF.answerRadioGroup(group, decision.answer);
    if (set.ok) {
      result.answered.push({ question: short, answer: decision.answer,
                             source: decision.source, why: decision.reason });
    } else {
      result.failed.push({ question: short, reason: set.reason });
    }
  }

  return result;
};

/**
 * Capture answers the user filled in by hand, so they are known next time.
 *
 * remember() refuses anything employer-specific, so this cannot accidentally
 * learn "No" for one company and apply it to another.
 */
AF.captureAnswers = function (learned) {
  let next = learned;
  const stored = [];

  for (const group of AF.findRadioGroups()) {
    if (!group.question || !group.selected) continue;
    const answer = AF.labelForInput(group.selected);
    if (!answer) continue;

    const out = AF.questions.remember(next, group.question, answer);
    if (out.stored) {
      next = out.learned;
      stored.push({ question: group.question.slice(0, 70), answer });
    }
  }

  return { learned: next, stored };
};
