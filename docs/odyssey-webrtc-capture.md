# Capturing a WebRTC report for the Odyssey team

When the broadcast looks broken — frozen video, high packet loss, audio
glitches — the Odyssey team has asked us to send a `chrome://webrtc-internals`
dump so they can investigate. This is a one-page procedure for capturing one.

> They told us: _"if you are able to capture any logs using
> chrome://webrtc-internals, that would be a huge help for our team in
> debugging this. Unfortunately we are not able to consistently reproduce this
> right now."_

## What you'll send them

1. **`webrtc_internals_dump.txt`** — the gold-standard artifact. Contains every
   `RTCPeerConnection`'s SDP exchange, ICE candidates, selected pair, and the
   full per-stat-type time series (packet loss, jitter, RTT, FPS, bitrate)
   sampled every second.
2. **`context.txt`** — a short text summary copied from our in-app debug
   overlay. Has the Odyssey session id, browser/OS/network details, and an
   anomaly summary so the team can correlate to their server logs.
3. _(Optional but very useful)_ **A screen recording** of the issue. Loom or
   QuickTime are both fine.

## Step-by-step

1. **Open `chrome://webrtc-internals` in a new tab first.** Chrome only records
   PCs created _after_ this page is open. If you open it after the issue
   starts, you'll lose the early lifecycle events (offer/answer/candidates).

2. **Open the broadcast page** (`/lab/broadcast`) in a separate tab.
   Enable the in-app overlay if it isn't already:

   ```js
   // run this in DevTools console, then reload
   localStorage.setItem('webrtc_debug', 'true')
   ```

   Or just append `?webrtc_debug` to the URL.

3. **Reproduce the issue.** Note the wall-clock time when it starts, and what
   you did to trigger it (or note "spontaneous" if it just happened).

4. **While the issue is still happening**, click **Copy summary** in the
   bottom-right overlay. Paste into a text file named `context.txt`. The
   summary includes the Odyssey session id, ICE pair, browser/network info,
   and anomaly counts.

5. **Switch to the `chrome://webrtc-internals` tab** and click **"Create Dump"**
   near the top. Chrome will download `webrtc_internals_dump.txt`.

6. **Send the Odyssey team** (Slack/email) all three artifacts together:
   - `webrtc_internals_dump.txt`
   - `context.txt`
   - screen recording (if you have one)

   Include a one-line note: when it happened (local time + timezone), what you
   were doing, and whether the issue resolved on its own or required reload.

## If you didn't open webrtc-internals first

Capture it anyway — the dump will still have the stats history from the moment
you opened the page until the issue ended. Note in `context.txt` that
webrtc-internals was opened mid-session so they know the lifecycle events are
incomplete.

## Sanity check before sending

- `context.txt` should mention an Odyssey session id (32+ char string).
- `webrtc_internals_dump.txt` should be > 100 KB (otherwise it didn't capture
  much). Open it — search for `inbound-rtp` to confirm video stats are there.
- ICE pair in `context.txt` should not say `(not yet nominated)` — if it does,
  the issue happened before ICE finished, which is itself useful info; flag it
  in your note.

## File locations in this repo (for maintainers)

- Overlay: [src/components/WebRTCDebugOverlay.tsx](../src/components/WebRTCDebugOverlay.tsx)
- Collector + `buildSummary()`: [src/lib/webrtc-stats-collector.ts](../src/lib/webrtc-stats-collector.ts)
- Where session id is wired in: [src/hooks/useOdysseyStream.ts](../src/hooks/useOdysseyStream.ts)
