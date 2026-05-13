const captured: WeakRef<RTCPeerConnection>[] = [];
let installed = false;

export function installPeerConnectionInterceptor() {
  if (installed) return;
  installed = true;

  const Original = window.RTCPeerConnection;

  const Patched = function (
    this: RTCPeerConnection,
    config?: RTCConfiguration,
  ) {
    const pc = new Original(config);
    captured.push(new WeakRef(pc));
    console.log('[WebRTC-Diag] RTCPeerConnection created', { config });
    return pc;
  } as unknown as typeof RTCPeerConnection;

  Patched.prototype = Original.prototype;
  Object.defineProperty(Patched, 'name', { value: 'RTCPeerConnection' });
  // Copy static properties (generateCertificate, etc.)
  for (const key of Object.getOwnPropertyNames(Original)) {
    if (key !== 'prototype' && key !== 'length' && key !== 'name') {
      try {
        Object.defineProperty(
          Patched,
          key,
          Object.getOwnPropertyDescriptor(Original, key)!,
        );
      } catch {
        // some properties may not be configurable
      }
    }
  }

  window.RTCPeerConnection = Patched;
}

export function getActivePeerConnections(): RTCPeerConnection[] {
  const live: RTCPeerConnection[] = [];
  for (let i = captured.length - 1; i >= 0; i--) {
    const pc = captured[i].deref();
    if (!pc || pc.connectionState === 'closed') {
      captured.splice(i, 1);
    } else {
      live.push(pc);
    }
  }
  return live;
}

export function getFirstPeerConnection(): RTCPeerConnection | null {
  return getActivePeerConnections()[0] ?? null;
}
