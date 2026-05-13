/**
 * A/B test script for Item Grab character prompts.
 *
 * Tests three prompt variants across a set of objects and prints
 * side-by-side responses so you can judge which works best.
 *
 * Usage:
 *   node scripts/test-item-grab.js
 *   node scripts/test-item-grab.js --object "a stapler"
 *   node scripts/test-item-grab.js --variant B
 */

import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────

const API_KEY = process.env.GOOGLE_GENAI_API_KEY || process.env.VITE_GEMINI_API_KEY;
if (!API_KEY) {
  console.error('Missing GOOGLE_GENAI_API_KEY. Run: GOOGLE_GENAI_API_KEY=your_key node scripts/test-item-grab.js');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: API_KEY });

// Bear system prompt — loaded from file if available, otherwise fallback
const bearPromptPath = path.join(__dirname, '../server/character-prompts/bear.txt');
const BEAR_SYSTEM_PROMPT = fs.existsSync(bearPromptPath)
  ? fs.readFileSync(bearPromptPath, 'utf8').trim()
  : [
      'You are Steve the Bear — a wise, warm, gentle bear with a rich forest life.',
      'You speak in short, vivid sentences. You love berries, honey, fish, and pine cones.',
      'You are curious about human objects but often baffled by technology.',
      'You always stay in character. Keep replies under 20 words.',
    ].join('\n');

// ─── Test objects ─────────────────────────────────────────────────────────────

const TEST_OBJECTS = [
  'a phone',
  'an apple',
  'a book',
  'a pair of scissors',
  'a flower',
  'a chocolate bar',
  'a water bottle',
  'a fish',
  'a baseball cap',
  'a toy ball',
];

// ─── Prompt variants ──────────────────────────────────────────────────────────

const VARIANTS = {
  A: {
    label: 'A — Generic curiosity (current)',
    build: (obj) =>
      `[Item Grab: I'm holding something up to your camera. Here's what you see: ${obj}. React with curiosity and comment on the object in ONE sentence — under 20 words — in character.]`,
  },
  B: {
    label: 'B — Physical receive',
    build: (obj) =>
      `The user just handed you ${obj}. As Steve the Bear, physically receive it and describe in ONE sentence under 20 words what you do with it.`,
  },
  C: {
    label: 'C — Category-aware (bear instincts)',
    build: (obj) => buildCategoryPrompt(obj),
  },
};

// ─── Category-aware prompt builder (mirrors src/lib/objectCategories.ts) ─────

const CATEGORY_KEYWORDS = {
  food:     ['apple', 'banana', 'orange', 'fruit', 'vegetable', 'sandwich', 'bread', 'burger', 'snack', 'berry', 'berries', 'mushroom', 'carrot'],
  sweet:    ['candy', 'chocolate', 'cake', 'cookie', 'donut', 'honey', 'ice cream', 'dessert', 'biscuit', 'muffin'],
  drink:    ['cup', 'mug', 'bottle', 'glass', 'can', 'coffee', 'tea', 'juice', 'water', 'soda'],
  fish:     ['fish', 'salmon', 'tuna', 'shrimp', 'crab', 'lobster', 'seafood'],
  tech:     ['phone', 'laptop', 'tablet', 'computer', 'keyboard', 'remote', 'camera', 'headphones', 'device', 'screen', 'controller'],
  book:     ['book', 'magazine', 'newspaper', 'notebook', 'journal', 'paper', 'comic'],
  toy:      ['ball', 'toy', 'game', 'dice', 'puzzle', 'doll', 'figurine', 'card'],
  nature:   ['flower', 'plant', 'leaf', 'rock', 'stone', 'stick', 'branch', 'pine', 'cone', 'shell', 'feather', 'log'],
  tool:     ['scissors', 'knife', 'hammer', 'screwdriver', 'pen', 'pencil', 'ruler', 'key', 'brush', 'spoon', 'fork'],
  clothing: ['hat', 'cap', 'glasses', 'sunglasses', 'gloves', 'scarf', 'shoe', 'sock', 'bag', 'wallet', 'watch'],
};

const BEAR_TEMPLATES = {
  food:     'The user just handed you {obj}. As Steve the Bear, react with your natural foraging instincts — sniff it, consider eating it — in ONE sentence under 20 words.',
  sweet:    'The user just handed you {obj}. As Steve the Bear who is obsessed with honey and sweet things, react with excitement in ONE sentence under 20 words.',
  drink:    'The user just handed you {obj}. As Steve the Bear, sniff it curiously and react to what it smells like in ONE sentence under 20 words.',
  fish:     'The user just handed you {obj}. As Steve the Bear whose favourite food is fish, react with pure delight in ONE sentence under 20 words.',
  tech:     'The user just handed you {obj}. As Steve the Bear who has never seen technology, react with bewildered curiosity — paw at it — in ONE sentence under 20 words.',
  book:     'The user just handed you {obj}. As Steve the Bear, hold it carefully in your paws and react thoughtfully in ONE sentence under 20 words.',
  toy:      'The user just handed you {obj}. As Steve the Bear, react with playful excitement in ONE sentence under 20 words.',
  nature:   'The user just handed you {obj}. As Steve the Bear, recognise it from the forest and react with warmth in ONE sentence under 20 words.',
  tool:     'The user just handed you {obj}. As Steve the Bear, hold it awkwardly in your big paws and react with gentle confusion in ONE sentence under 20 words.',
  clothing: 'The user just handed you {obj}. As Steve the Bear, try to figure out what it is and react with curious amusement in ONE sentence under 20 words.',
  other:    'The user just handed you {obj}. As Steve the Bear, physically receive it and react with warm curiosity in ONE sentence under 20 words.',
};

function categorize(description) {
  const lower = description.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((k) => lower.includes(k))) return category;
  }
  return 'other';
}

function buildCategoryPrompt(obj) {
  const category = categorize(obj);
  return BEAR_TEMPLATES[category].replace('{obj}', obj);
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function askBear(prompt) {
  const result = await ai.models.generateContent({
    model: 'gemini-2.0-flash',
    generationConfig: { maxOutputTokens: 80, temperature: 0.9 },
    contents: [{ role: 'user', parts: [{ text: `${BEAR_SYSTEM_PROMPT}\n\n${prompt}` }] }],
  });
  return (result.text || '').trim();
}

async function runTests(objects, variantFilter) {
  const variantKeys = variantFilter
    ? [variantFilter.toUpperCase()]
    : Object.keys(VARIANTS);

  for (const obj of objects) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  OBJECT: ${obj.toUpperCase()}  [category: ${categorize(obj)}]`);
    console.log('═'.repeat(70));

    for (const key of variantKeys) {
      const variant = VARIANTS[key];
      if (!variant) { console.error(`Unknown variant: ${key}`); continue; }
      const prompt = variant.build(obj);
      process.stdout.write(`\n  ${variant.label}\n  Prompt: ${prompt}\n  → `);
      try {
        const response = await askBear(prompt);
        console.log(response);
      } catch (err) {
        console.log(`ERROR: ${err.message}`);
      }
    }
  }
  console.log(`\n${'═'.repeat(70)}\nDone.\n`);
}

// Parse CLI args
const args = process.argv.slice(2);
const objIdx = args.indexOf('--object');
const varIdx = args.indexOf('--variant');
const customObj = objIdx !== -1 ? args[objIdx + 1] : null;
const customVar = varIdx !== -1 ? args[varIdx + 1] : null;

const objects = customObj ? [customObj] : TEST_OBJECTS;

console.log(`\nItem Grab A/B Test — ${objects.length} object(s), variant: ${customVar || 'ALL'}`);
console.log(`Bear system prompt: ${fs.existsSync(bearPromptPath) ? 'bear.txt' : 'fallback'}\n`);

runTests(objects, customVar).catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
