// Pre-render character greeting audio to static WAV files.
// Run: npm run render:greetings
//
// Reads greetings from src/data/characters.json, calls Gemini TTS with the
// per-character voice, and writes public/greetings/{id}.wav. Static assets are
// served from /greetings/{id}.wav at runtime so the greeting plays in <150ms
// instead of the 1–3s round-trip Gemini TTS takes per visit.

import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Must stay in sync with GEMINI_VOICE_BY_SLIDE_ID in src/App.tsx.
const VOICE_BY_ID = {
  'alexander':      'Orus',
  'bear':           'Charon',
  'circus-lion':    'Fenrir',
  'cleopatra':      'Kore',
  'da-vinci':       'Puck',
  'einstein':       'Zephyr',
  'grandpa-turtle': 'Leda',
  'steve-jobs':     'Aoede',
};

function pcmToWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function renderOne(text, voiceName, apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini TTS HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const part = json.candidates?.[0]?.content?.parts?.[0];
  if (!part?.inlineData?.data) {
    throw new Error(`No audio part in response: ${JSON.stringify(json).slice(0, 300)}`);
  }
  const audio = Buffer.from(part.inlineData.data, 'base64');
  const mimeType = part.inlineData.mimeType || '';
  const isRiff = audio.slice(0, 4).toString('ascii') === 'RIFF';
  if (isRiff) return audio;
  const sampleRateMatch = mimeType.match(/rate=(\d+)/);
  const sampleRate = sampleRateMatch ? parseInt(sampleRateMatch[1], 10) : 24000;
  return pcmToWav(audio, sampleRate);
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY is missing. Set it in .env before running.');
    process.exit(1);
  }

  const charsPath = join(projectRoot, 'src/data/characters.json');
  const outDir = join(projectRoot, 'public/greetings');
  await mkdir(outDir, { recursive: true });

  const data = JSON.parse(await readFile(charsPath, 'utf8'));
  const characters = data.characters ?? [];

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const c of characters) {
    if (!c.greeting) { skipped++; continue; }
    const voice = VOICE_BY_ID[c.id];
    if (!voice) {
      console.warn(`[skip] ${c.id}: no voice mapping`);
      skipped++;
      continue;
    }
    const outPath = join(outDir, `${c.id}.wav`);
    process.stdout.write(`[${c.id}] voice=${voice} ... `);
    const t0 = Date.now();
    try {
      const wav = await renderOne(c.greeting, voice, apiKey);
      await writeFile(outPath, wav);
      console.log(`${wav.length} bytes in ${Date.now() - t0}ms → ${outPath}`);
      ok++;
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      failed++;
    }
  }

  console.log(`\nDone. ok=${ok} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main();
