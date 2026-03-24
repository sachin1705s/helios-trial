import fs from 'fs';

const SMALLEST_API_KEY = 'sk_fcd03ed94d449aa460aeaf8eabda1c65';

// Test a selection of known lightning-v3.1 voice IDs
const voices = ['magnus', 'emily', 'jasper', 'aria', 'alex', 'luna', 'ryan', 'sophia', 'liam', 'zara'];

async function testVoice(voiceId) {
  const endpoint = 'https://api.smallest.ai/waves/v1/lightning-v3.1/get_speech';
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SMALLEST_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: "Hello, I am a character. Testing my voice.",
        voice_id: voiceId,
        sample_rate: 24000,
        output_format: 'wav',
      }),
    });
    if (!response.ok) {
      const err = await response.text();
      console.log(`  ${voiceId}: FAIL — ${err.slice(0, 80)}`);
      return false;
    }
    const buf = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(`test-voice-${voiceId}.wav`, buf);
    console.log(`  ${voiceId}: OK (${buf.length} bytes) → test-voice-${voiceId}.wav`);
    return true;
  } catch (err) {
    console.log(`  ${voiceId}: ERROR — ${err.message}`);
    return false;
  }
}

console.log('Testing lightning-v3.1 voices...\n');
for (const v of voices) {
  await testVoice(v);
}
console.log('\nDone. Open the .wav files to hear each voice.');
