// Quick test harness: import stripActionTags from server/index.js by
// duplicating the function here, then run it against every leak pattern
// we've seen in production. Run with: node server/strip-action-tags.test.js

const stripActionTags = (text) => {
  let prev;
  let current = text;
  let safety = 5;
  do {
    prev = current;
    current = current
      .replace(/<[^>]+>/g, '')
      .replace(/\[SCENE_ACTION:[^\]]*\]/gi, '')
      .replace(/\[[^\]]{1,80}\]/g, '')
      .replace(/`[^`\n]+`/g, '')
      .replace(/\*{1,3}[^*\n]{1,120}\*{1,3}/g, '')
      .replace(/\([^)\n]{1,120}\)/g, '');
  } while (current !== prev && --safety > 0);

  return current
    .replace(/`+/g, '')
    .replace(/\*+/g, '')
    .replace(/<\s*>/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
};

// Each case: { input, expectClean: substring that MUST NOT survive }
const cases = [
  // Production failures we've seen
  { name: 'angle-tag (stone_appears)',
    input: 'Look at this stone — isn\'t it nice to hold? <stone_appears>',
    mustNotContain: ['stone_appears', '<', '>'] },
  { name: 'backtick action',
    input: 'Try a taste! `hold up honeycomb`',
    mustNotContain: ['hold up honeycomb', '`'] },
  { name: 'paren stage direction',
    input: 'Want a taste? (Holds up a fat honeycomb thickly dripping honey)',
    mustNotContain: ['Holds up', '(', ')'] },
  { name: 'BACKTICK-WRAPPED BRACKETS — latest failure',
    input: 'Smells sweet, doesn\'t it? `[holds up a fat, dripping honeycomb]`',
    mustNotContain: ['holds up', '[', ']', '`'] },

  // Other plausible model outputs
  { name: 'asterisk action',
    input: 'Hello there! *waves paw warmly*',
    mustNotContain: ['waves paw', '*'] },
  { name: 'double asterisk',
    input: 'Hello! **lifts honeycomb proudly**',
    mustNotContain: ['lifts honeycomb', '*'] },
  { name: 'SCENE_ACTION official',
    input: 'Catch! [SCENE_ACTION: spawn_object("ball")]',
    mustNotContain: ['SCENE_ACTION', 'spawn_object', '[', ']'] },
  { name: 'plain bracket annotation',
    input: 'Mmm, that was good [licks lips].',
    mustNotContain: ['licks lips', '[', ']'] },
  { name: 'mixed: asterisks around brackets',
    input: 'Watch this *[juggles three balls]*',
    mustNotContain: ['juggles', '[', ']', '*'] },
  { name: 'mixed: parens around backticks',
    input: 'Here you go (`offers stone gently`)',
    mustNotContain: ['offers stone', '(', ')', '`'] },
  { name: 'mixed: backticks around angle tag',
    input: 'Watch — `<stone_appears>` look!',
    mustNotContain: ['stone_appears', '`', '<', '>'] },

  // Make sure normal speech isn't damaged
  { name: 'normal speech (control)',
    input: 'I love the forest and the smell of pine in the morning.',
    mustNotContain: [],
    mustEqual: 'I love the forest and the smell of pine in the morning.' },
];

let passed = 0;
let failed = 0;

for (const c of cases) {
  const out = stripActionTags(c.input);
  let ok = true;
  const reasons = [];
  for (const bad of c.mustNotContain) {
    if (out.includes(bad)) {
      ok = false;
      reasons.push(`still contains "${bad}"`);
    }
  }
  if (c.mustEqual !== undefined && out !== c.mustEqual) {
    ok = false;
    reasons.push(`expected exact match: "${c.mustEqual}"`);
  }
  if (ok) {
    passed++;
    console.log(`PASS  ${c.name}`);
    console.log(`        in:  ${JSON.stringify(c.input)}`);
    console.log(`        out: ${JSON.stringify(out)}`);
  } else {
    failed++;
    console.log(`FAIL  ${c.name}`);
    console.log(`        in:  ${JSON.stringify(c.input)}`);
    console.log(`        out: ${JSON.stringify(out)}`);
    for (const r of reasons) console.log(`        why: ${r}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
