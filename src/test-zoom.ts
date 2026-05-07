/**
 * Odyssey Zoom Isolation Test — test-zoom.ts
 *
 * Generates calibration images with visible markers, simulates the SDK's
 * center-crop/resize pipeline, then streams to Odyssey for side-by-side
 * comparison. Determines whether zoom comes from SDK or server.
 */

import { Odyssey, credentialsFromDict } from '@odysseyml/odyssey';

// ── SDK constants (mirrored from node_modules/@odysseyml/odyssey/dist/index.js:523-526) ──
const I2V_BASE_WIDTH = 1280;
const I2V_BASE_HEIGHT = 704;

// ── Test image presets ──
const PRESETS = {
  a: { width: 1280, height: 704, label: 'A: 1280×704 (exact match)' },
  b: { width: 512, height: 288, label: 'B: 512×288 (16:9)' },
  c: { width: 1024, height: 1024, label: 'C: 1024×1024 (square)' },
} as const;

type PresetKey = keyof typeof PRESETS;

// ── DOM refs ──
const btnA = document.getElementById('btn-a') as HTMLButtonElement;
const btnB = document.getElementById('btn-b') as HTMLButtonElement;
const btnC = document.getElementById('btn-c') as HTMLButtonElement;
const btnRun = document.getElementById('btn-run') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLElement;
const logEl = document.getElementById('log') as HTMLElement;
const canvasOriginal = document.getElementById('canvas-original') as HTMLCanvasElement;
const canvasSDK = document.getElementById('canvas-sdk') as HTMLCanvasElement;
const videoOutput = document.getElementById('video-output') as HTMLVideoElement;
const dimOriginal = document.getElementById('dim-original') as HTMLElement;
const dimSDK = document.getElementById('dim-sdk') as HTMLElement;
const dimOdyssey = document.getElementById('dim-odyssey') as HTMLElement;

let activePreset: PresetKey = 'a';
let client: Odyssey | null = null;
let leaseId: string | null = null;

// ── Logging ──
type LogLevel = 'info' | 'ok' | 'warn' | 'err';

function log(level: LogLevel, msg: string) {
  const now = new Date().toISOString().slice(11, 23);
  const line = document.createElement('div');
  line.innerHTML = `<span class="ts">${now}</span> <span class="${level}">${esc(msg)}</span>`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  console.log(`[zoom-test] [${level}] ${msg}`);
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setStatus(text: string, cls = '') {
  statusEl.textContent = text;
  statusEl.className = `status-badge ${cls}`;
}

// ── Calibration image generator ──
function generateCalibrationImage(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // Background: dark gray with subtle grid
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, width, height);

  // Checkerboard pattern for visibility
  const gridSize = Math.max(20, Math.floor(Math.min(width, height) / 20));
  ctx.fillStyle = '#16213e';
  for (let y = 0; y < height; y += gridSize * 2) {
    for (let x = 0; x < width; x += gridSize * 2) {
      ctx.fillRect(x, y, gridSize, gridSize);
      ctx.fillRect(x + gridSize, y + gridSize, gridSize, gridSize);
    }
  }

  // Percentage grid lines from edges (10%, 20%, 30%)
  const percentages = [10, 20, 30];
  ctx.lineWidth = 1;

  for (const pct of percentages) {
    const frac = pct / 100;
    const alpha = pct === 10 ? 0.8 : pct === 20 ? 0.6 : 0.4;
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.setLineDash([4, 4]);

    // Vertical lines from left and right
    const xLeft = Math.floor(width * frac);
    const xRight = Math.floor(width * (1 - frac));
    ctx.beginPath();
    ctx.moveTo(xLeft, 0); ctx.lineTo(xLeft, height);
    ctx.moveTo(xRight, 0); ctx.lineTo(xRight, height);
    ctx.stroke();

    // Horizontal lines from top and bottom
    const yTop = Math.floor(height * frac);
    const yBottom = Math.floor(height * (1 - frac));
    ctx.beginPath();
    ctx.moveTo(0, yTop); ctx.lineTo(width, yTop);
    ctx.moveTo(0, yBottom); ctx.lineTo(width, yBottom);
    ctx.stroke();

    // Labels
    ctx.setLineDash([]);
    const fontSize = Math.max(10, Math.floor(Math.min(width, height) / 30));
    ctx.font = `${fontSize}px monospace`;
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.fillText(`${pct}%`, xLeft + 3, fontSize + 2);
    ctx.fillText(`${pct}%`, 3, yTop + fontSize + 2);
  }
  ctx.setLineDash([]);

  // Corner markers
  const markerSize = Math.max(30, Math.floor(Math.min(width, height) / 10));
  const corners: Array<{ x: number; y: number; color: string; label: string }> = [
    { x: 0, y: 0, color: '#ef4444', label: 'TL' },
    { x: width - markerSize, y: 0, color: '#22c55e', label: 'TR' },
    { x: 0, y: height - markerSize, color: '#3b82f6', label: 'BL' },
    { x: width - markerSize, y: height - markerSize, color: '#eab308', label: 'BR' },
  ];
  for (const c of corners) {
    ctx.fillStyle = c.color;
    ctx.fillRect(c.x, c.y, markerSize, markerSize);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.floor(markerSize / 3)}px monospace`;
    ctx.fillText(c.label, c.x + 4, c.y + markerSize / 2 + 4);
  }

  // Center crosshair
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  const crossSize = Math.max(20, Math.floor(Math.min(width, height) / 8));
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - crossSize, cy); ctx.lineTo(cx + crossSize, cy);
  ctx.moveTo(cx, cy - crossSize); ctx.lineTo(cx, cy + crossSize);
  ctx.stroke();

  // Center circle
  ctx.beginPath();
  ctx.arc(cx, cy, crossSize / 2, 0, Math.PI * 2);
  ctx.stroke();

  // Dimension label at center
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.max(14, Math.floor(Math.min(width, height) / 15))}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(`${width}×${height}`, cx, cy - crossSize - 8);
  ctx.textAlign = 'start';

  // Border
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, width - 3, height - 3);

  return canvas;
}

// ── SDK crop simulation (exact replica of getCenterCropRect from SDK) ──
function getCenterCropRect(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number) {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return { sx: 0, sy: 0, sWidth: sourceWidth, sHeight: sourceHeight };
  }
  const targetRatio = targetWidth / targetHeight;
  const sourceRatio = sourceWidth / sourceHeight;

  if (Math.abs(sourceRatio - targetRatio) < 1e-4) {
    return { sx: 0, sy: 0, sWidth: sourceWidth, sHeight: sourceHeight };
  }

  if (sourceRatio > targetRatio) {
    const sWidth = Math.max(1, Math.floor(sourceHeight * targetRatio));
    const sx = Math.max(0, Math.floor((sourceWidth - sWidth) / 2));
    return { sx, sy: 0, sWidth, sHeight: sourceHeight };
  }

  const sHeight = Math.max(1, Math.floor(sourceWidth / targetRatio));
  const sy = Math.max(0, Math.floor((sourceHeight - sHeight) / 2));
  return { sx: 0, sy, sWidth: sourceWidth, sHeight: sHeight };
}

function simulateSDKCrop(sourceCanvas: HTMLCanvasElement, portrait: boolean): HTMLCanvasElement {
  const targetW = portrait ? I2V_BASE_HEIGHT : I2V_BASE_WIDTH;
  const targetH = portrait ? I2V_BASE_WIDTH : I2V_BASE_HEIGHT;

  const crop = getCenterCropRect(sourceCanvas.width, sourceCanvas.height, targetW, targetH);

  log('info', `SDK crop rect: sx=${crop.sx}, sy=${crop.sy}, sWidth=${crop.sWidth}, sHeight=${crop.sHeight}`);
  log('info', `SDK target: ${targetW}×${targetH} (${portrait ? 'portrait' : 'landscape'})`);

  const pxCroppedX = sourceCanvas.width - crop.sWidth;
  const pxCroppedY = sourceCanvas.height - crop.sHeight;
  const pctCroppedX = ((pxCroppedX / sourceCanvas.width) * 100).toFixed(1);
  const pctCroppedY = ((pxCroppedY / sourceCanvas.height) * 100).toFixed(1);
  log('info', `Pixels cropped: ${pxCroppedX}px horizontal, ${pxCroppedY}px vertical (${pctCroppedX}% × ${pctCroppedY}%)`);

  const result = document.createElement('canvas');
  result.width = targetW;
  result.height = targetH;
  const ctx = result.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, crop.sx, crop.sy, crop.sWidth, crop.sHeight, 0, 0, targetW, targetH);

  return result;
}

// ── Canvas to File ──
async function canvasToFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve(new File([blob!], name, { type: 'image/png' }));
    }, 'image/png');
  });
}

// ── Update display for selected preset ──
function updateDisplay() {
  const preset = PRESETS[activePreset];
  log('info', `Selected: ${preset.label}`);

  // Generate calibration image
  const calibration = generateCalibrationImage(preset.width, preset.height);
  dimOriginal.textContent = `${preset.width}×${preset.height} (ratio: ${(preset.width / preset.height).toFixed(3)})`;

  // Draw to original canvas
  canvasOriginal.width = preset.width;
  canvasOriginal.height = preset.height;
  canvasOriginal.getContext('2d')!.drawImage(calibration, 0, 0);

  // Simulate SDK crop
  const sdkResult = simulateSDKCrop(calibration, false);
  canvasSDK.width = sdkResult.width;
  canvasSDK.height = sdkResult.height;
  canvasSDK.getContext('2d')!.drawImage(sdkResult, 0, 0);
  dimSDK.textContent = `SDK output: ${sdkResult.width}×${sdkResult.height} (target: ${I2V_BASE_WIDTH}×${I2V_BASE_HEIGHT})`;

  // Highlight active button
  btnA.className = activePreset === 'a' ? 'active' : '';
  btnB.className = activePreset === 'b' ? 'active' : '';
  btnC.className = activePreset === 'c' ? 'active' : '';
}

// ── Stream test ──
async function runStream() {
  btnRun.disabled = true;
  btnStop.disabled = false;
  logEl.innerHTML = '';

  const preset = PRESETS[activePreset];
  log('info', `Starting stream test with ${preset.label}`);

  setStatus('fetching token…', '');

  try {
    // Generate the image file
    const calibration = generateCalibrationImage(preset.width, preset.height);
    const imageFile = await canvasToFile(calibration, `calibration-${activePreset}.png`);
    log('ok', `Image file: ${(imageFile.size / 1024).toFixed(1)} KB, type: ${imageFile.type}`);

    // Fetch credentials
    log('info', 'GET /api/odyssey/token…');
    const tokenRes = await fetch('/api/odyssey/token');
    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      throw new Error(`Token fetch failed ${tokenRes.status}: ${err}`);
    }
    const { credentials: credDict, leaseId: lid } = await tokenRes.json();
    leaseId = lid;
    log('ok', `Got credentials (leaseId: ${lid})`);

    const credentials = credentialsFromDict(credDict);

    // Connect
    client = new Odyssey({});
    (client as unknown as { capabilities: { image_to_video: boolean } }).capabilities.image_to_video = true;
    log('info', 'Connecting…');
    setStatus('connecting…', '');

    const stream = await new Promise<MediaStream>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout (15s)')), 15_000);

      client!.connectWithCredentials(credentials, {
        onConnected(s) {
          clearTimeout(timeout);
          log('ok', `Connected — stream tracks: ${s?.getTracks().length ?? 'null'}`);
          if (s) resolve(s);
          else reject(new Error('No media stream'));
        },
        onDisconnected() { log('warn', 'Disconnected'); },
        onStreamStarted() { log('ok', '🟢 onStreamStarted — character animating'); },
        onStreamEnded() { log('warn', 'onStreamEnded'); },
        onStatusChange(status) { log('info', `Status: ${status}`); },
        onError(err) { log('err', `Error: ${err?.message ?? String(err)}`); },
      });
    });

    videoOutput.srcObject = stream;
    setStatus('connected', 'connected');

    // Start stream with image
    log('info', `Calling startStream({ prompt: "Hold still, do not move", image: ${preset.label} })…`);
    setStatus('starting stream…', '');

    await Promise.race([
      client.startStream({ prompt: 'Hold still, do not move', image: imageFile, portrait: false }).then(() => {
        log('ok', 'startStream() resolved');
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('startStream timeout (15s)')), 15_000)
      ),
    ]);

    setStatus('streaming', 'streaming');
    dimOdyssey.textContent = `Stream active — compare with SDK simulation above`;
    log('ok', 'Stream running. Compare the three panels visually.');
    log('info', 'Key question: Does Odyssey output match SDK simulation, or show MORE zoom?');

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('err', msg);
    setStatus('error', 'error');
    btnRun.disabled = false;
    btnStop.disabled = true;
  }
}

async function stopStream() {
  if (client) {
    try { client.disconnect(); } catch { /* ignore */ }
    client = null;
  }
  if (leaseId) {
    await fetch('/api/odyssey/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaseId }),
    }).catch(() => undefined);
    leaseId = null;
  }
  videoOutput.srcObject = null;
  setStatus('stopped', '');
  dimOdyssey.textContent = '—';
  btnRun.disabled = false;
  btnStop.disabled = true;
  log('info', 'Stream stopped');
}

// ── Event listeners ──
btnA.addEventListener('click', () => { activePreset = 'a'; updateDisplay(); });
btnB.addEventListener('click', () => { activePreset = 'b'; updateDisplay(); });
btnC.addEventListener('click', () => { activePreset = 'c'; updateDisplay(); });
btnRun.addEventListener('click', runStream);
btnStop.addEventListener('click', stopStream);

// ── Init ──
updateDisplay();
