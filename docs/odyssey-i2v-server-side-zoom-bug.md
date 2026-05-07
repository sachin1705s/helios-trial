# Bug Report: Image-to-Video Streams Apply Heavy Server-Side Zoom to Input Images

**Reported by:** Interact Studio  
**Date:** 2026-05-06  
**Severity:** High — significantly degrades the quality of image-to-video output; subject is cropped out of frame  
**Affected SDK:** `@odysseyml/odyssey@^1.3.0`  
**Affected method:** `startStream({ image })`

---

## Summary

When an image is passed to `startStream({ image })`, the resulting video stream is heavily zoomed into the center of the image — roughly 60–70% of the image area is cropped away. This occurs **even when the input image is pre-sized to exactly the SDK's internal target dimensions (1280×704)**, ruling out any client-side resizing as the cause.

We isolated this with a controlled test. The zoom is applied server-side by Odyssey's model, and there is currently no API parameter to control or disable it.

---

## Observed Behavior

The streamed video output zooms heavily into the center of whatever image is sent, cropping the edges significantly. Corner markers placed at the edges of a calibration image are cut off in the stream. This happens regardless of:

- Input image dimensions
- Input image aspect ratio
- Whether the `portrait` flag is set or not

---

## Investigation: Ruling Out Client-Side Causes

### Step 1 — Understanding the SDK's client-side pipeline

We inspected the SDK's compiled source (`node_modules/@odysseyml/odyssey/dist/index.js`). Before sending an image, the SDK runs `resizeImageForI2V()`, which:

1. Detects the source image's MIME type and dimensions
2. Calls `getCenterCropRect()` to compute a center-crop region that matches the target aspect ratio (1280×704 ≈ 1.818:1 for landscape)
3. Draws the cropped region onto a canvas resized to exactly 1280×704
4. Encodes the result as base64 and sends it over the WebSocket

Relevant constants from the SDK source:

```js
// node_modules/@odysseyml/odyssey/dist/index.js, lines 523–526
var I2V_BASE_WIDTH = 1280;
var I2V_BASE_HEIGHT = 704;
var I2V_JPEG_QUALITY = 0.92;
var I2V_RESIZABLE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
```

The `getCenterCropRect()` function:

```js
// lines 1176–1193
getCenterCropRect(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const targetRatio = targetWidth / targetHeight;
  const sourceRatio = sourceWidth / sourceHeight;
  if (Math.abs(sourceRatio - targetRatio) < 1e-4) {
    return { sx: 0, sy: 0, sWidth: sourceWidth, sHeight: sourceHeight }; // no crop if ratios match
  }
  if (sourceRatio > targetRatio) {
    const sWidth = Math.floor(sourceHeight * targetRatio);
    const sx = Math.floor((sourceWidth - sWidth) / 2);
    return { sx, sy: 0, sWidth, sHeight: sourceHeight };
  }
  const sHeight = Math.floor(sourceWidth / targetRatio);
  const sy = Math.floor((sourceHeight - sHeight) / 2);
  return { sx: 0, sy, sWidth: sourceWidth, sHeight: sHeight };
}
```

### Step 2 — Controlled test with exact-dimension input

We built an isolated test page that:

1. Generates a calibration image with colored corner markers (red TL, green TR, blue BL, yellow BR), a center crosshair, and percentage grid lines at 10%, 20%, and 30% from each edge
2. Simulates the SDK's `getCenterCropRect` + resize pipeline locally and renders the result
3. Sends the image to `startStream()` and displays the stream output with `object-fit: contain` (no browser-side cropping)

**Test image A: 1280×704 PNG** — this is exactly the SDK's target dimensions. The SDK's `getCenterCropRect` returns `{ sx: 0, sy: 0, sWidth: 1280, sHeight: 704 }` (no crop, no resize), and the `resizeImageForI2V` function returns the original image unchanged. What Odyssey receives is the exact original image.

### Step 3 — Result

Despite sending an unmodified 1280×704 image, the Odyssey stream output is zoomed in:

| Panel | What it shows |
|-------|--------------|
| Original image | Full 1280×704 calibration image, all four corner markers visible, all grid lines visible |
| SDK simulation | Identical to original — correct, no processing for exact-dimension input |
| Odyssey stream output | Heavily zoomed in. Bottom corner markers (BL, BR) cut off. Grid lines near edges not visible. |

**Screenshot evidence:**

The image below shows all three panels side by side. The Odyssey output (rightmost panel) visibly crops the bottom corner markers that are fully visible in both the original and the SDK simulation:

> *(Screenshot attached — `test-zoom-image-a-result.png`)*

This rules out:
- CSS display cropping (we used `object-fit: contain`)
- SDK client-side resizing (the input was exactly 1280×704, no processing applied)
- Input image aspect ratio mismatch

The zoom is applied by the Odyssey model on the server.

---

## Impact

For `startStream({ image })` use cases, the effective visible area of the source image is reduced to approximately the center 60–70% of what was sent. For a 1280×704 image, subjects placed toward the edges are systematically cut out of the output. This makes image-to-video effectively unusable for any image where the subject is not already tightly centered.

---

## Current Workaround

We are pre-padding images before sending — placing the source image centered on a larger canvas (adding ~30–40% padding around it) so that when Odyssey zooms in, the original image fills the visible area. This is a fragile workaround: the exact zoom factor is not documented, so the padding amount is approximate.

---

## Requested

1. **Confirmation** that this server-side zoom is intentional behavior (e.g. for aesthetic framing) or a known issue
2. **A `startStream` parameter to disable or reduce the zoom** — e.g. `framing: 'fit'` vs `framing: 'fill'`, or a `zoom` factor
3. If a parameter is not planned: **documentation of the exact zoom factor / crop percentage** applied, so we can pre-pad images precisely rather than guessing

---

## Reproduction

```typescript
import { Odyssey, credentialsFromDict } from '@odysseyml/odyssey';

// Generate a 1280×704 calibration PNG with corner markers
// (see attached test-zoom.html / test-zoom.ts)

const credentials = credentialsFromDict(await fetchCredentials());
const client = new Odyssey({});
client.connectWithCredentials(credentials, {
  onConnected(stream) {
    videoEl.srcObject = stream;
  }
});

// Image is exactly 1280×704 — SDK applies zero processing
await client.startStream({ prompt: 'Hold still', image: calibration1280x704 });

// Result: video output is zoomed in, edges of calibration image cropped
```

Test harness: `test-zoom.html` + `src/test-zoom.ts` in our repo — generates calibration images, simulates SDK processing, and displays stream output side-by-side for direct comparison.

---

## Environment

- SDK: `@odysseyml/odyssey@^1.3.0`
- Connection method: `connectWithCredentials()` (secure credentials flow)
- Server: Node.js / Express
- Browser: Chrome 135 (Chromium-based)
- `portrait` flag: `false` (landscape, 1280×704 target)
