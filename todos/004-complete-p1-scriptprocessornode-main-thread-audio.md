---
name: ScriptProcessorNode on main thread blocks event loop during Gemini Live mic capture
description: Mic PCM capture uses deprecated ScriptProcessorNode — runs base64+JSON+send on main thread every 128ms, causes audio glitches
type: p1
status: pending
issue_id: "004"
tags: [performance, gemini-live, code-review]
---

## Problem Statement

The Gemini Live mic capture falls back to `ScriptProcessorNode` (or uses it as the primary path), which runs its callback on the **main thread** every ~128ms at 16kHz. The callback does:
1. Float32 → Int16 conversion loop (2048 iterations)
2. `arrayBufferToBase64` — string concatenation loop (4096 string allocations per call)
3. `JSON.stringify` + `ws.send`

All of this runs synchronously on the event loop. Combined, this blocks React renders, incoming Gemini audio playback, and UI interactions for measurable time every ~128ms.

The `AudioWorkletProcessor` in `public/audio-processor.worklet.js` already does the correct thing — zero-copy Int16 transfer off the main thread. It just isn't wired up.

## Findings

- `src/App.tsx` — mic capture using ScriptProcessorNode
- `public/audio-processor.worklet.js` — correct AudioWorklet already exists but unused
- `arrayBufferToBase64` creates ~4096 throwaway string objects per frame (PERF-01)

## Proposed Solutions

### Option A: Wire up the existing AudioWorklet (recommended)
```tsx
// Load the worklet
await geminiLiveCaptureCtxRef.current.audioWorklet.addModule('/audio-processor.worklet.js');
const workletNode = new AudioWorkletNode(geminiLiveCaptureCtxRef.current, 'pcm-processor');
workletNode.port.onmessage = (e) => {
  const int16Buffer: ArrayBuffer = e.data; // already Int16, zero-copy transferred
  if (ws.readyState !== WebSocket.OPEN) return;
  // Convert to base64 efficiently
  const bytes = new Uint8Array(int16Buffer);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  }
  const b64 = btoa(chunks.join(''));
  ws.send(JSON.stringify({ realtimeInput: { mediaChunks: [{ mimeType: 'audio/pcm', data: b64 }] } }));
};
sourceNode.connect(workletNode);
```

### Option B: Fix arrayBufferToBase64 to use chunked String.fromCharCode.apply
As an interim fix while keeping ScriptProcessorNode:
```tsx
const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  }
  return btoa(chunks.join(''));
};
```
Eliminates the O(n) string concat GC pressure at minimum.

## Recommended Action

Option A — wire up the existing AudioWorklet. The file is already written and correct. This is the fix that eliminates both the main-thread blocking and the GC pressure.

## Acceptance Criteria

- [ ] Mic audio capture uses `AudioWorkletNode` (`pcm-processor`) not `ScriptProcessorNode`
- [ ] `ScriptProcessorNode` / `createScriptProcessor` call removed
- [ ] Audio playback from Gemini is gap-free on a mid-range mobile device
- [ ] `arrayBufferToBase64` uses chunked `String.fromCharCode` not single-char concatenation
