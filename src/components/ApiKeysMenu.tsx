import { useEffect, useRef, useState } from 'react';

type KeyEntry = { index: number; masked: string };

type Mode = { type: 'idle' } | { type: 'add' } | { type: 'replace'; index: number };

export function ApiKeysMenu({ adminSecret }: { adminSecret?: string }) {
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState<KeyEntry[]>([]);
  const [limit, setLimit] = useState(5);
  const [mode, setMode] = useState<Mode>({ type: 'idle' });
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminSecret) h['Authorization'] = `Bearer ${adminSecret}`;
    return h;
  };

  const load = async () => {
    setError(null);
    try {
      const res = await fetch('/api/reactor/keys', { headers: headers() });
      if (res.status === 401) { setError('Unauthorized — check ADMIN_SECRET.'); return; }
      if (!res.ok) { setError('Failed to load keys.'); return; }
      const data = await res.json() as { keys: KeyEntry[]; limit: number };
      setKeys(data.keys);
      setLimit(data.limit);
    } catch {
      setError('Could not reach server.');
    }
  };

  useEffect(() => {
    if (open) { void load(); setMode({ type: 'idle' }); setInput(''); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (open && panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const handleAdd = async () => {
    if (!input.trim()) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch('/api/reactor/keys', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ key: input.trim() }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; setError(d.error ?? 'Failed.'); return; }
      setInput(''); setMode({ type: 'idle' }); await load();
    } catch { setError('Request failed.'); }
    finally { setBusy(false); }
  };

  const handleReplace = async (idx: number) => {
    if (!input.trim()) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/reactor/keys/${idx}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ key: input.trim() }),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; setError(d.error ?? 'Failed.'); return; }
      setInput(''); setMode({ type: 'idle' }); await load();
    } catch { setError('Request failed.'); }
    finally { setBusy(false); }
  };

  const handleDelete = async (idx: number) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/reactor/keys/${idx}`, {
        method: 'DELETE',
        headers: headers(),
      });
      if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; setError(d.error ?? 'Failed.'); return; }
      setMode({ type: 'idle' }); await load();
    } catch { setError('Request failed.'); }
    finally { setBusy(false); }
  };

  const cancelMode = () => { setMode({ type: 'idle' }); setInput(''); setError(null); };

  const isAdding = mode.type === 'add';
  const isReplacing = mode.type === 'replace';
  const activeIndex = isReplacing ? mode.index : -1;

  return (
    <div className="api-keys-menu" ref={panelRef}>
      <button
        type="button"
        className={`btn ghost api-keys-toggle${open ? ' active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Manage Reactor API keys"
        aria-expanded={open}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="8" cy="15" r="3" />
          <path d="M10.85 12.15L20 3" />
          <path d="M18 5l1 1" />
          <path d="M15 8l1 1" />
        </svg>
        Keys
      </button>

      {open && (
        <div className="api-keys-panel" role="dialog" aria-label="Reactor API keys">
          <div className="api-keys-panel__header">
            <span>Reactor API Keys</span>
            <span className="api-keys-meta">{limit} streams/key</span>
          </div>

          {error && <div className="api-keys-error">{error}</div>}

          <ul className="api-keys-list">
            {keys.length === 0 && !error && (
              <li className="api-keys-empty">No keys configured</li>
            )}
            {keys.map((k) => (
              <li key={k.index} className="api-keys-item">
                {isReplacing && activeIndex === k.index ? (
                  <div className="api-keys-inline-form">
                    <input
                      className="api-keys-input"
                      type="text"
                      placeholder="New key…"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void handleReplace(k.index); if (e.key === 'Escape') cancelMode(); }}
                      autoFocus
                    />
                    <button type="button" className="api-keys-action save" onClick={() => void handleReplace(k.index)} disabled={busy || !input.trim()}>Save</button>
                    <button type="button" className="api-keys-action cancel" onClick={cancelMode}>✕</button>
                  </div>
                ) : (
                  <>
                    <span className="api-keys-masked">{k.masked}</span>
                    <div className="api-keys-item-actions">
                      <button
                        type="button"
                        className="api-keys-action replace"
                        onClick={() => { setMode({ type: 'replace', index: k.index }); setInput(''); setError(null); }}
                        title="Replace"
                        disabled={busy}
                      >
                        Replace
                      </button>
                      <button
                        type="button"
                        className="api-keys-action delete"
                        onClick={() => void handleDelete(k.index)}
                        title="Delete"
                        disabled={busy}
                      >
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>

          {isAdding ? (
            <div className="api-keys-add-form">
              <input
                className="api-keys-input"
                type="text"
                placeholder="rk_…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd(); if (e.key === 'Escape') cancelMode(); }}
                autoFocus
              />
              <div className="api-keys-add-actions">
                <button type="button" className="api-keys-action save" onClick={() => void handleAdd()} disabled={busy || !input.trim()}>Add</button>
                <button type="button" className="api-keys-action cancel" onClick={cancelMode}>Cancel</button>
              </div>
            </div>
          ) : (
            !isReplacing && (
              <button
                type="button"
                className="api-keys-add-btn"
                onClick={() => { setMode({ type: 'add' }); setInput(''); setError(null); }}
                disabled={busy}
              >
                + Add key
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
