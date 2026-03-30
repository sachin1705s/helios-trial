// AudioWorklet processor: converts Float32 mic samples to Int16 PCM and
// transfers each 128-sample frame (zero-copy) to the main thread.
// Runs on the audio rendering thread (off main thread) — avoids UI jank
// that ScriptProcessorNode caused on mobile when streaming at 16kHz.
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    const int16 = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      // Float32 [-1, 1] → Int16 [-32768, 32767]
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    // Transfer the underlying ArrayBuffer (zero-copy) to the main thread
    this.port.postMessage(int16.buffer, [int16.buffer]);
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
