/**
 * Vision Matrix Test
 *
 * Runs every plausible (model, config, prompt) combination against test images
 * for both drip-check and item-grab modes. Logs raw response, finishReason,
 * token usage (prompt / output / thinking), latency, and a verdict so we can
 * pick the winning config by data rather than deploy-and-pray.
 *
 * Usage:
 *   1. Drop test images into scripts/test-images/ named like:
 *        - person-*.jpg / person-*.png  → tested in drip-check mode
 *        - object-*.jpg / object-*.png  → tested in item-grab mode
 *        - empty-*.jpg                  → tested in both modes (should return NO_RESULT)
 *      (You can also pass --image <path> --mode <drip-check|item-grab> to test one image.)
 *
 *   2. Run from project root:
 *        node scripts/test-vision-matrix.js
 *
 * Results print as a per-image table and end with a recommendation block.
 */

import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

// ─── Load .env manually (no dotenv dep) ──────────────────────────────────────
const envPath = path.join(PROJECT_ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY;
if (!API_KEY) {
  console.error('Missing GEMINI_API_KEY in .env');
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey: API_KEY });

// ─── Modes (same prompts as server/index.js) ─────────────────────────────────
const VISION_MODES = {
  'drip-check': {
    promptCurrent: [
      'Look at the person in this image and describe ONLY:',
      '- their hairstyle (color, length, shape)',
      '- their clothing (visible items, color, style)',
      '- any standout style details (accessories, vibe)',
      '',
      'Return 1–2 short factual sentences. No opinions, no greetings, no preamble.',
      'If no person is visible, return exactly: NO_RESULT',
    ].join('\n'),
    // A reworded prompt designed to be more direct for 2.5-flash
    promptReworded: [
      'Task: describe the visible person in this image.',
      'Output format: 1-2 plain factual sentences covering hair, clothing, and any standout style details.',
      'Constraints: no greetings, no preamble, no opinions, no questions.',
      'If no person is visible, output exactly this token and nothing else: NO_RESULT',
    ].join('\n'),
    baselineMaxTokens: 120,
  },
  'item-grab': {
    promptCurrent: [
      'Look at this image. The user is showing or holding an object toward the camera.',
      'Name the most prominent object (or 1–2 objects) using simple, generic terms (e.g. "a phone", "a book", "a cup").',
      'No brand names, no model numbers, no colors, no descriptions — just what the object is.',
      'Return a single short sentence. No greetings, no opinions, no preamble.',
      'If no clear object is being shown, return exactly: NO_RESULT',
    ].join('\n'),
    promptReworded: [
      'Task: name the most prominent object being shown to the camera.',
      'Output format: one short sentence naming the object in simple generic terms (e.g. "a phone", "a book").',
      'Constraints: no brands, no models, no colors, no descriptions, no greetings, no preamble.',
      'If no clear object is visible, output exactly this token and nothing else: NO_RESULT',
    ].join('\n'),
    baselineMaxTokens: 60,
  },
};

// ─── Configs to test ─────────────────────────────────────────────────────────
// Each config produces a generateContent call. `tokensFactor` scales the
// mode's baselineMaxTokens. Other flags toggle the hypotheses we want to test.
const RELAXED_SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
];

const JSON_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    noResult:    { type: 'boolean' },
  },
  required: ['description', 'noResult'],
};

const CONFIGS = [
  // ── Baseline: what's deployed today
  {
    label: '2.5-flash | DEFAULT (thinking on, current tokens)',
    model: 'gemini-2.5-flash',
    promptVariant: 'current',
    tokensFactor: 1,
    thinkingBudget: null, // null = use SDK default (thinking enabled)
  },
  // ── Hypothesis A: thinking eats the output budget
  {
    label: 'A) 2.5-flash | thinking=0, current tokens',
    model: 'gemini-2.5-flash',
    promptVariant: 'current',
    tokensFactor: 1,
    thinkingBudget: 0,
  },
  // ── Hypothesis B: thinking + tokens too low together
  {
    label: 'B) 2.5-flash | thinking=0, 3x tokens',
    model: 'gemini-2.5-flash',
    promptVariant: 'current',
    tokensFactor: 3,
    thinkingBudget: 0,
  },
  // ── Hypothesis C: prompt wording doesn't match 2.5-flash's style
  {
    label: 'C) 2.5-flash | thinking=0, reworded prompt, 3x tokens',
    model: 'gemini-2.5-flash',
    promptVariant: 'reworded',
    tokensFactor: 3,
    thinkingBudget: 0,
  },
  // ── Hypothesis D: prompt belongs in systemInstruction, not user content
  {
    label: 'D) 2.5-flash | thinking=0, systemInstruction, 3x tokens',
    model: 'gemini-2.5-flash',
    promptVariant: 'current',
    tokensFactor: 3,
    thinkingBudget: 0,
    asSystemInstruction: true,
  },
  // ── Hypothesis E: sampling randomness producing unstable outputs
  {
    label: 'E) 2.5-flash | thinking=0, temperature=0, 3x tokens',
    model: 'gemini-2.5-flash',
    promptVariant: 'current',
    tokensFactor: 3,
    thinkingBudget: 0,
    temperature: 0,
  },
  // ── Hypothesis F: free-form text breaks the pipeline; force JSON schema
  {
    label: 'F) 2.5-flash | thinking=0, JSON schema, 3x tokens',
    model: 'gemini-2.5-flash',
    promptVariant: 'current',
    tokensFactor: 3,
    thinkingBudget: 0,
    responseJson: true,
  },
  // ── Hypothesis G: safety filter is silently refusing on people/objects
  {
    label: 'G) 2.5-flash | thinking=0, relaxed safety, 3x tokens',
    model: 'gemini-2.5-flash',
    promptVariant: 'current',
    tokensFactor: 3,
    thinkingBudget: 0,
    relaxedSafety: true,
  },
  // ── Hypothesis H: it's a small-model limitation; pro should fix it
  {
    label: 'H) 2.5-pro | thinking=0, 3x tokens',
    model: 'gemini-2.5-pro',
    promptVariant: 'current',
    tokensFactor: 3,
    thinkingBudget: 0,
  },
  // ── Alt model: lite (cheaper, no thinking by default)
  {
    label: 'I) 2.5-flash-lite | current tokens',
    model: 'gemini-2.5-flash-lite',
    promptVariant: 'current',
    tokensFactor: 1,
    thinkingBudget: null,
  },
  // ── Reference: 2.0-flash (will 429 if quota still dead)
  {
    label: 'Z) 2.0-flash | current (reference; may 429)',
    model: 'gemini-2.0-flash',
    promptVariant: 'current',
    tokensFactor: 1,
    thinkingBudget: null,
  },
];

// ─── Verdict heuristic ───────────────────────────────────────────────────────
function verdict(modeKey, raw) {
  const text = (raw || '').trim();
  if (!text) return 'EMPTY';
  if (text === 'NO_RESULT') return 'NO_RESULT';
  // Penalize obvious failure modes
  if (/^I (cannot|can't|am unable)/i.test(text)) return 'REFUSED';
  if (/sorry|cannot|unable to/i.test(text) && text.length < 100) return 'REFUSED';
  if (text.length > 400) return 'TOO_LONG';
  // Item-grab: should be a short noun phrase
  if (modeKey === 'item-grab') {
    if (text.length > 120) return 'TOO_LONG';
    if (!/^(a |an |the |\d)/i.test(text)) return 'WEIRD_FORMAT';
  }
  return 'OK';
}

// ─── One test call ───────────────────────────────────────────────────────────
async function runOne(image, modeKey, config) {
  const mode = VISION_MODES[modeKey];
  const prompt = config.promptVariant === 'current' ? mode.promptCurrent : mode.promptReworded;
  const maxOutputTokens = mode.baselineMaxTokens * config.tokensFactor;
  const mimeType = image.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const base64 = fs.readFileSync(image).toString('base64');

  const genConfig = {
    maxOutputTokens,
    abortSignal: AbortSignal.timeout(30000),
  };
  if (config.thinkingBudget !== null) {
    genConfig.thinkingConfig = { thinkingBudget: config.thinkingBudget };
  }
  if (typeof config.temperature === 'number') {
    genConfig.temperature = config.temperature;
  }
  if (config.responseJson) {
    genConfig.responseMimeType = 'application/json';
    genConfig.responseSchema = JSON_SCHEMA;
  }
  if (config.relaxedSafety) {
    genConfig.safetySettings = RELAXED_SAFETY;
  }
  if (config.asSystemInstruction) {
    genConfig.systemInstruction = prompt;
  }

  // When prompt is in systemInstruction, the user message only carries the image
  // (plus a tiny anchor so 2.5-flash treats it as a real turn).
  const userParts = config.asSystemInstruction
    ? [{ inlineData: { mimeType, data: base64 } }, { text: 'image attached' }]
    : [{ inlineData: { mimeType, data: base64 } }, { text: prompt }];

  const start = Date.now();
  let result;
  try {
    result = await ai.models.generateContent({
      model: config.model,
      config: genConfig,
      contents: [{ role: 'user', parts: userParts }],
    });
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: err?.message || String(err),
      status: err?.status ?? err?.response?.status,
    };
  }
  const latencyMs = Date.now() - start;

  let rawText = '';
  let textErr = null;
  try { rawText = (result.text || '').trim(); } catch (e) { textErr = e?.message; }

  // For JSON config, parse and extract description for downstream verdict.
  // Track parse failure separately so we don't mistake "valid JSON but bad
  // content" for "non-JSON output when JSON was requested".
  let text = rawText;
  let jsonParseFailed = false;
  if (config.responseJson && rawText) {
    try {
      const parsed = JSON.parse(rawText);
      if (parsed?.noResult) text = 'NO_RESULT';
      else text = String(parsed?.description ?? '').trim();
    } catch {
      jsonParseFailed = true;
    }
  }

  const cand = result.candidates?.[0];
  const finishReason = cand?.finishReason;
  const usage = result.usageMetadata || {};
  const safety = cand?.safetyRatings?.filter(r => r.probability && r.probability !== 'NEGLIGIBLE') || [];

  let v = verdict(modeKey, text);
  if (jsonParseFailed) v = 'JSON_INVALID';
  if (finishReason === 'SAFETY') v = 'SAFETY_BLOCK';
  if (finishReason === 'MAX_TOKENS' && !text) v = 'EMPTY_TRUNCATED';

  return {
    ok: true,
    latencyMs,
    text,
    rawText,
    textErr,
    finishReason,
    promptTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    thinkingTokens: usage.thoughtsTokenCount,
    totalTokens: usage.totalTokenCount,
    safetyHits: safety.length,
    verdict: v,
    maxOutputTokens,
  };
}

// ─── Image discovery ─────────────────────────────────────────────────────────
function discoverImages() {
  const args = process.argv.slice(2);
  const imageIdx = args.indexOf('--image');
  const modeIdx = args.indexOf('--mode');
  if (imageIdx !== -1) {
    const img = args[imageIdx + 1];
    const mode = modeIdx !== -1 ? args[modeIdx + 1] : 'item-grab';
    return [{ path: img, modes: [mode] }];
  }
  const dir = path.join(__dirname, 'test-images');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png)$/i.test(f));
  return files.map(f => {
    const base = f.toLowerCase();
    let modes;
    if (base.startsWith('person')) modes = ['drip-check'];
    else if (base.startsWith('object')) modes = ['item-grab'];
    else if (base.startsWith('empty')) modes = ['drip-check', 'item-grab'];
    else modes = ['drip-check', 'item-grab']; // fall back: test both
    return { path: path.join(dir, f), modes };
  });
}

// ─── Pretty print ────────────────────────────────────────────────────────────
function fmt(s, w) {
  s = String(s ?? '');
  return s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w);
}

function truncate(s, w) {
  s = String(s ?? '').replace(/\n+/g, ' ');
  return s.length > w ? s.slice(0, w - 1) + '…' : s;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const images = discoverImages();
  if (!images.length) {
    console.error('\nNo images found.');
    console.error('Drop test images into scripts/test-images/ named:');
    console.error('  person-*.jpg   (tested in drip-check mode)');
    console.error('  object-*.jpg   (tested in item-grab mode)');
    console.error('  empty-*.jpg    (tested in both, should produce NO_RESULT)');
    console.error('Or pass: --image <path> --mode <drip-check|item-grab>\n');
    process.exit(1);
  }

  console.log(`\nGemini key: ${API_KEY.slice(0, 8)}...${API_KEY.slice(-4)}`);
  console.log(`Images: ${images.length}, configs per mode: ${CONFIGS.length}\n`);

  const allResults = [];

  for (const img of images) {
    for (const modeKey of img.modes) {
      console.log('═'.repeat(110));
      console.log(`IMAGE: ${path.basename(img.path)}    MODE: ${modeKey}`);
      console.log('═'.repeat(110));
      console.log(
        fmt('CONFIG', 56) + ' ' +
        fmt('VERDICT', 12) + ' ' +
        fmt('LAT', 6) + ' ' +
        fmt('IN/OUT/THINK', 14) + ' ' +
        'RESPONSE'
      );
      console.log('─'.repeat(110));

      for (const config of CONFIGS) {
        const r = await runOne(img.path, modeKey, config);
        allResults.push({ image: path.basename(img.path), mode: modeKey, config: config.label, ...r });
        if (!r.ok) {
          console.log(
            fmt(config.label, 56) + ' ' +
            fmt(`ERR ${r.status || ''}`, 12) + ' ' +
            fmt(r.latencyMs + 'ms', 6) + ' ' +
            fmt('-', 14) + ' ' +
            truncate(r.error, 40)
          );
        } else {
          const tokens = `${r.promptTokens ?? '?'}/${r.outputTokens ?? '?'}/${r.thinkingTokens ?? 0}`;
          console.log(
            fmt(config.label, 56) + ' ' +
            fmt(r.verdict + (r.finishReason && r.finishReason !== 'STOP' ? `(${r.finishReason})` : ''), 12) + ' ' +
            fmt(r.latencyMs + 'ms', 6) + ' ' +
            fmt(tokens, 14) + ' ' +
            truncate(r.text || (r.textErr ? `<<text() threw: ${r.textErr}>>` : '<empty>'), 40)
          );
        }
        // Spacing requests so we don't trip per-minute caps during the matrix
        await new Promise(r => setTimeout(r, 800));
      }
      console.log();
    }
  }

  // ─── Summary / recommendation ──────────────────────────────────────────────
  console.log('═'.repeat(110));
  console.log('SUMMARY BY CONFIG (across all images + modes)');
  console.log('═'.repeat(110));
  const byConfig = new Map();
  for (const r of allResults) {
    if (!byConfig.has(r.config)) byConfig.set(r.config, { ok: 0, refused: 0, empty: 0, error: 0, other: 0, totalLat: 0, n: 0 });
    const b = byConfig.get(r.config);
    b.n++;
    b.totalLat += r.latencyMs || 0;
    if (!r.ok) b.error++;
    else if (r.verdict === 'OK' || r.verdict === 'NO_RESULT') b.ok++;
    else if (r.verdict === 'EMPTY') b.empty++;
    else if (r.verdict === 'REFUSED') b.refused++;
    else b.other++;
  }
  console.log(fmt('CONFIG', 56) + ' ' + fmt('OK', 5) + ' ' + fmt('EMPTY', 7) + ' ' + fmt('REFUSED', 9) + ' ' + fmt('OTHER', 7) + ' ' + fmt('ERROR', 7) + ' AVG_LAT');
  console.log('─'.repeat(110));
  const sorted = [...byConfig.entries()].sort((a, b) => b[1].ok - a[1].ok);
  for (const [label, b] of sorted) {
    console.log(
      fmt(label, 56) + ' ' +
      fmt(`${b.ok}/${b.n}`, 5) + ' ' +
      fmt(b.empty, 7) + ' ' +
      fmt(b.refused, 9) + ' ' +
      fmt(b.other, 7) + ' ' +
      fmt(b.error, 7) + ' ' +
      Math.round(b.totalLat / b.n) + 'ms'
    );
  }
  console.log();

  if (sorted.length > 0) {
    const winner = sorted[0];
    console.log(`RECOMMENDED CONFIG: ${winner[0]}`);
    console.log(`  → ${winner[1].ok}/${winner[1].n} correct, avg ${Math.round(winner[1].totalLat / winner[1].n)}ms\n`);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
