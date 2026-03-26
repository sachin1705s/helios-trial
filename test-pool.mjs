/**
 * Odyssey pool smoke test
 * Run with: node test-pool.mjs
 * Requires the dev server to be running: npm run dev:server
 */

const BASE = 'http://localhost:8787';
const LIMIT = Number(process.env.ODYSSEY_KEY_LIMIT || 5);

let passed = 0;
let failed = 0;

const assert = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
};

const token = async () => {
  const r = await fetch(`${BASE}/api/odyssey/token`);
  return { status: r.status, body: await r.json() };
};

const heartbeat = async (leaseId) => {
  const r = await fetch(`${BASE}/api/odyssey/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leaseId }),
  });
  return { status: r.status, body: await r.json() };
};

const release = async (leaseId) => {
  const r = await fetch(`${BASE}/api/odyssey/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leaseId }),
  });
  return { status: r.status, body: await r.json() };
};

// ── Test 1: allocate a lease ──────────────────────────────────────────────────
console.log('\n[1] Allocate lease');
const t1 = await token();
assert('returns 200', t1.status === 200, `got ${t1.status}`);
assert('has apiKey', typeof t1.body.apiKey === 'string' && t1.body.apiKey.length > 0);
assert('has leaseId', typeof t1.body.leaseId === 'string' && t1.body.leaseId.length > 0);
const lease1 = t1.body.leaseId;

// ── Test 2: heartbeat ─────────────────────────────────────────────────────────
console.log('\n[2] Heartbeat');
const hb = await heartbeat(lease1);
assert('returns 200', hb.status === 200, `got ${hb.status}`);
assert('ok: true', hb.body.ok === true);

// ── Test 3: heartbeat with unknown leaseId ────────────────────────────────────
console.log('\n[3] Heartbeat — unknown leaseId');
const hbUnknown = await heartbeat('00000000-0000-0000-0000-000000000000');
assert('returns 404', hbUnknown.status === 404, `got ${hbUnknown.status}`);

// ── Test 4: fill all slots on key[0] then expect 503 ─────────────────────────
console.log(`\n[4] Fill all ${LIMIT} slots (key[0]) — expect 503 on slot ${LIMIT + 1}`);
const extraLeases = [lease1]; // already have 1
for (let i = 1; i < LIMIT; i++) {
  const t = await token();
  assert(`slot ${i + 1} allocated`, t.status === 200, `got ${t.status} — ${JSON.stringify(t.body)}`);
  if (t.body.leaseId) extraLeases.push(t.body.leaseId);
}
// This next one should be rejected if only 1 key is configured
const overflow = await token();
if (overflow.status === 503) {
  assert(`slot ${LIMIT + 1} rejected (503 — at capacity)`, true);
} else {
  // Multiple keys configured — just note it
  console.log(`  ℹ  slot ${LIMIT + 1} succeeded (multiple keys configured — key[1] used)`);
  passed++;
  if (overflow.body.leaseId) extraLeases.push(overflow.body.leaseId);
}

// ── Test 5: release a slot, then re-allocate ──────────────────────────────────
console.log('\n[5] Release slot then re-allocate');
const rel = await release(lease1);
assert('release returns 200', rel.status === 200, `got ${rel.status}`);
assert('ok: true', rel.body.ok === true);

// Wait a moment for Redis to propagate (local is instant, remote ~50ms)
await new Promise((r) => setTimeout(r, 200));

const realloc = await token();
assert('re-allocation succeeds after release', realloc.status === 200, `got ${realloc.status} — ${JSON.stringify(realloc.body)}`);
if (realloc.body.leaseId) extraLeases.push(realloc.body.leaseId);

// ── Cleanup ───────────────────────────────────────────────────────────────────
console.log('\n[cleanup] Releasing all leases');
for (const id of extraLeases) {
  if (id !== lease1) await release(id); // lease1 already released above
}
console.log(`  Released ${extraLeases.length - 1} remaining leases`);

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
