#!/usr/bin/env node
/**
 * Stress test the voice-clone and character-clone provider endpoints.
 *
 * Hits /api/health (config probe), /api/health/upstream (reachability), then
 * exercises /api/voice-clone and /api/character-clone with synthetic payloads
 * of varying sizes. Prints a table of {endpoint, payload bytes, status, ms,
 * error?} so you can see exactly which combination is failing.
 *
 * Usage:
 *   node scripts/stress-test-providers.js                 # hits local http://localhost:5173 (Vite proxy)
 *   BASE_URL=https://www.interactstudio.space node scripts/stress-test-providers.js
 *   ONLY=voice node scripts/stress-test-providers.js      # only run voice tests
 *   ONLY=image node scripts/stress-test-providers.js      # only run image tests
 *
 * Requires the dev server to be running (npm run dev) OR a deployed URL via BASE_URL.
 */

const BASE_URL = (process.env.BASE_URL || 'http://localhost:5173').replace(/\/$/, '');
const ONLY = process.env.ONLY || 'all';

// ── helpers ────────────────────────────────────────────────────────────────
function buildSilenceWav(seconds) {
  // 16-bit PCM mono @ 16kHz — 32 KB/s. Smallest accepts WAV cleanly.
  const sampleRate = 16000;
  const samples = seconds * sampleRate;
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);          // PCM chunk size
  buf.writeUInt16LE(1, 20);            // PCM format
  buf.writeUInt16LE(1, 22);            // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);            // block align
  buf.writeUInt16LE(16, 34);           // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  // Sprinkle low-amplitude noise so it's not literally silent (some providers reject pure silence).
  for (let i = 44; i < buf.length; i += 2) {
    const v = Math.floor((Math.random() - 0.5) * 800);
    buf.writeInt16LE(v, i);
  }
  return buf;
}

function buildTinyPng(side = 256) {
  // Generate a JPEG via Sharp if it's installed, otherwise emit a 1x1 PNG that
  // upscales server-side — Gemini Vision is fine with tiny inputs.
  try {
    // Optional dep — avoid hard requirement.
    const sharp = require('sharp');
    return sharp({ create: { width: side, height: side, channels: 3, background: { r: 200, g: 160, b: 120 } } })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch {
    // 1x1 PNG, ~70 bytes — Gemini will still attempt the call, which is what we want
    // for an endpoint-reachability stress test even if the model rejects the image.
    return Promise.resolve(Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8ffff3f0005fe02fea7355' +
      '0810000000049454e44ae426082',
      'hex',
    ));
  }
}

async function postMultipart(url, fields) {
  const boundary = `----StressBoundary${Date.now().toString(16)}`;
  const CRLF = '\r\n';
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (Buffer.isBuffer(value)) {
      parts.push(Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="${name}"; filename="${name}.bin"${CRLF}` +
        `Content-Type: application/octet-stream${CRLF}${CRLF}`,
      ));
      parts.push(value);
      parts.push(Buffer.from(CRLF));
    } else if (value && typeof value === 'object' && value.buffer) {
      parts.push(Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="${name}"; filename="${value.filename || name}"${CRLF}` +
        `Content-Type: ${value.contentType || 'application/octet-stream'}${CRLF}${CRLF}`,
      ));
      parts.push(value.buffer);
      parts.push(Buffer.from(CRLF));
    } else {
      parts.push(Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}` +
        `${String(value)}${CRLF}`,
      ));
    }
  }
  parts.push(Buffer.from(`--${boundary}--${CRLF}`));
  const body = Buffer.concat(parts);
  const t0 = Date.now();
  let res, errorMsg;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) },
      body,
    });
  } catch (err) {
    errorMsg = `${err.name}: ${err.message}`;
  }
  const ms = Date.now() - t0;
  if (!res) return { ms, error: errorMsg, bytes: body.length };
  const text = await res.text().catch(() => '');
  let parsed; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { ms, status: res.status, bytes: body.length, body: text.slice(0, 500), parsed };
}

function row(label, payloadBytes, result) {
  const status = result.status ?? (result.error ? 'NET' : '?');
  const note = result.error
    ? result.error.slice(0, 60)
    : (result.parsed?.error ?? result.parsed?.voiceId ?? result.parsed?.imageBase64?.length ?? result.body?.slice(0, 60) ?? '');
  const noteStr = String(note).slice(0, 60);
  console.log(
    `  ${label.padEnd(28)} ` +
    `${String(Math.round(payloadBytes / 1024) + 'KB').padStart(8)} ` +
    `${String(status).padStart(4)}  ` +
    `${String(result.ms + 'ms').padStart(8)}  ` +
    `${noteStr}`,
  );
}

// ── runs ───────────────────────────────────────────────────────────────────
async function runHealth() {
  console.log('\n▸ Health checks');
  for (const path of ['/api/health', '/api/health/upstream']) {
    const t0 = Date.now();
    try {
      const r = await fetch(BASE_URL + path);
      const text = await r.text();
      console.log(`  GET ${path.padEnd(28)} ${String(r.status).padStart(4)}  ${String(Date.now() - t0 + 'ms').padStart(8)}`);
      try {
        const parsed = JSON.parse(text);
        console.log('    ', JSON.stringify(parsed, null, 2).split('\n').join('\n    '));
      } catch {
        console.log(`    body: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      console.log(`  GET ${path.padEnd(28)} NET   ${String(Date.now() - t0 + 'ms').padStart(8)}  ${err.message}`);
    }
  }
}

async function runVoice() {
  console.log('\n▸ /api/voice-clone — synthetic noise WAV at varying durations');
  console.log('  test                          payload status   elapsed  note');
  console.log('  ' + '─'.repeat(78));
  for (const seconds of [5, 15, 30, 60]) {
    const wav = buildSilenceWav(seconds);
    const result = await postMultipart(BASE_URL + '/api/voice-clone', {
      audio: { buffer: wav, filename: `noise-${seconds}s.wav`, contentType: 'audio/wav' },
      display_name: `stress-${seconds}s`,
      provider: 'smallest',
    });
    row(`smallest noise ${seconds}s`, wav.length, result);
  }
}

async function runImage() {
  console.log('\n▸ /api/character-clone — synthetic image at varying sizes');
  console.log('  test                          payload status   elapsed  note');
  console.log('  ' + '─'.repeat(78));
  for (const side of [256, 512, 1024]) {
    const img = await buildTinyPng(side);
    for (const framing of ['headshot', 'full']) {
      const result = await postMultipart(BASE_URL + '/api/character-clone', {
        image: { buffer: img, filename: `flat-${side}.jpg`, contentType: 'image/jpeg' },
        framing,
      });
      row(`gemini ${side}px ${framing}`, img.length, result);
    }
  }
}

(async () => {
  console.log(`\nStress test → ${BASE_URL}  (only=${ONLY})`);
  await runHealth();
  if (ONLY === 'all' || ONLY === 'voice') await runVoice();
  if (ONLY === 'all' || ONLY === 'image') await runImage();
  console.log('\nDone.\n');
})().catch((err) => { console.error(err); process.exit(1); });
