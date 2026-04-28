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
      .replace(/\[[^\]\n]+\]/g, '')
      .replace(/`[^`\n]+`/g, '')
      .replace(/\*{1,3}[^*\n]+\*{1,3}/g, '')
      .replace(/\([^)\n]+\)/g, '');
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

// Each case: { input, mustNotContain[], mustEqual? }
const cases = [
  // ── Production failures ────────────────────────────────────────────────────
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

  // ── Single-format cases ────────────────────────────────────────────────────
  { name: 'asterisk single',
    input: 'Hello there! *waves paw warmly*',
    mustNotContain: ['waves paw', '*'] },
  { name: 'asterisk double',
    input: 'Hello! **lifts honeycomb proudly**',
    mustNotContain: ['lifts honeycomb', '*'] },
  { name: 'asterisk triple',
    input: 'Watch! ***roars dramatically***',
    mustNotContain: ['roars', '*'] },
  { name: 'SCENE_ACTION official',
    input: 'Catch! [SCENE_ACTION: spawn_object("ball")]',
    mustNotContain: ['SCENE_ACTION', 'spawn_object', '[', ']'] },
  { name: 'plain bracket annotation',
    input: 'Mmm, that was good [licks lips].',
    mustNotContain: ['licks lips', '[', ']'] },

  // ── Nested / mixed formats ─────────────────────────────────────────────────
  { name: 'asterisks around brackets',
    input: 'Watch this *[juggles three balls]*',
    mustNotContain: ['juggles', '[', ']', '*'] },
  { name: 'parens around backticks',
    input: 'Here you go (`offers stone gently`)',
    mustNotContain: ['offers stone', '(', ')', '`'] },
  { name: 'backticks around angle tag',
    input: 'Watch — `<stone_appears>` look!',
    mustNotContain: ['stone_appears', '`', '<', '>'] },
  { name: 'triple nested: backtick > paren > asterisk',
    input: 'Here! `(*waves slowly*)`',
    mustNotContain: ['waves', '`', '(', ')', '*'] },
  { name: 'asterisks around SCENE_ACTION',
    input: 'Ta-da! *[SCENE_ACTION: animate("roar")]*',
    mustNotContain: ['SCENE_ACTION', 'animate', '*', '[', ']'] },

  // ── Long descriptions (exceed earlier 80-char bracket limit) ──────────────
  { name: 'long bracket (> 80 chars)',
    input: 'Look here! [holds up a large, beautifully crafted golden honeycomb dripping with rich amber honey from the hive]',
    mustNotContain: ['holds up', 'honeycomb', 'amber', '[', ']'] },
  { name: 'long paren (> 80 chars)',
    input: 'Come on! (reaches into the hollow log and carefully pulls out an enormous dripping honeycomb and holds it up to the light)',
    mustNotContain: ['reaches', 'honeycomb', '(', ')'] },
  { name: 'long asterisk (> 120 chars)',
    input: 'Watch! *slowly and deliberately reaches into the hollow of the old oak tree and pulls out a magnificent golden honeycomb that drips with amber honey*',
    mustNotContain: ['reaches', 'honeycomb', '*'] },

  // ── Action at the start of a sentence ─────────────────────────────────────
  { name: 'action at start',
    input: '*waves paw* Hello there, little friend!',
    mustNotContain: ['waves', '*'] },
  { name: 'tag at start',
    input: '<bear_smiles> Welcome to my forest!',
    mustNotContain: ['bear_smiles', '<', '>'] },

  // ── Multiple actions in one string ────────────────────────────────────────
  { name: 'multiple bracket actions',
    input: 'First [sniffs the air] then [picks up stone] — see?',
    mustNotContain: ['sniffs', 'picks', '[', ']'] },
  { name: 'multiple asterisk actions',
    input: '*sniffs* Mmm! *holds out paw* Try it!',
    mustNotContain: ['sniffs', 'holds out', '*'] },
  { name: 'action mid-sentence',
    input: 'Here, *leans forward gently* take a look at this.',
    mustNotContain: ['leans', '*'] },

  // ── Loose spacing inside markers ──────────────────────────────────────────
  { name: 'bracket with inner spaces',
    input: 'Yes! [ sighs deeply ]',
    mustNotContain: ['sighs', '[', ']'] },
  { name: 'asterisk with inner spaces',
    input: 'Okay! * nods slowly *',
    mustNotContain: ['nods', '*'] },

  // ── UPPERCASE format variations ────────────────────────────────────────────
  { name: 'uppercase angle tag',
    input: 'See this? <STONE_APPEARS>',
    mustNotContain: ['STONE_APPEARS', '<', '>'] },
  { name: 'uppercase bracket',
    input: 'Ready! [HOLDS UP HONEYCOMB]',
    mustNotContain: ['HOLDS', 'HONEYCOMB', '[', ']'] },

  // ── Controls — normal speech must not be damaged ───────────────────────────
  { name: 'control: plain speech',
    input: 'I love the forest and the smell of pine in the morning.',
    mustNotContain: [],
    mustEqual: 'I love the forest and the smell of pine in the morning.' },
  { name: 'control: speech with numbers',
    input: 'I have found 3 honeycombs today, maybe 4.',
    mustNotContain: [],
    mustEqual: 'I have found 3 honeycombs today, maybe 4.' },
  { name: 'control: speech with question',
    input: 'Isn\'t it nice to sit here by the river?',
    mustNotContain: [],
    mustEqual: 'Isn\'t it nice to sit here by the river?' },
  { name: 'control: speech with em-dash',
    input: 'Slow down — the forest will wait for you.',
    mustNotContain: [],
    mustEqual: 'Slow down — the forest will wait for you.' },
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
