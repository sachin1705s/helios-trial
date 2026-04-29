import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOdysseyStream } from '../../hooks/useOdysseyStream';

type Tool = 'pen' | 'eraser';

const CANVAS_W = 512;
const CANVAS_H = 512;

export default function DrawingExperiment() {
  const navigate = useNavigate();
  const { status, error, videoRef, startStream, interact, disconnect } = useOdysseyStream();

  const canvasRef    = useRef<HTMLCanvasElement | null>(null);
  const drawingRef   = useRef(false);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState('#ffffff');
  const [strokeWidth, setStrokeWidth] = useState(6);
  const [isStreaming, setIsStreaming] = useState(false);
  const [phase, setPhase] = useState<'draw' | 'live'>('draw');

  // Canvas setup
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }, []);

  const getPos = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = CANVAS_W / rect.width;
    const scaleY = CANVAS_H / rect.height;
    if ('touches' in e) {
      const t = e.touches[0];
      return { x: (t.clientX - rect.left) * scaleX, y: (t.clientY - rect.top) * scaleY };
    }
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  };

  const startDraw = useCallback((e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    drawingRef.current = true;
    const { x, y } = getPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  }, []);

  const draw = useCallback((e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    const { x, y } = getPos(e);
    ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = tool === 'eraser' ? 'rgba(0,0,0,1)' : color;
    ctx.lineWidth   = tool === 'eraser' ? strokeWidth * 3 : strokeWidth;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.lineTo(x, y);
    ctx.stroke();
  }, [tool, color, strokeWidth]);

  const endDraw = useCallback(() => { drawingRef.current = false; }, []);

  const clearCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  }, []);

  const bringToLife = useCallback(async () => {
    if (status !== 'ready' || isStreaming) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    setIsStreaming(true);
    setPhase('live');

    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const imageFile = new File([blob], 'drawing.png', { type: 'image/png' });
      await startStream({
        image:   imageFile,
        prompt:  'You are a living character that just came to life from a drawing. React to being alive, look around curiously, and animate naturally.',
        portrait: false,
      });
    }, 'image/png');
  }, [status, isStreaming, startStream]);

  const sendPrompt = useCallback(async (prompt: string) => {
    if (!prompt.trim()) return;
    await interact(prompt);
  }, [interact]);

  const handleBack = useCallback(async () => {
    await disconnect();
    navigate('/home');
  }, [disconnect, navigate]);

  const [promptText, setPromptText] = useState('');

  return (
    <div className="experiment-shell">
      <header className="experiment-topbar">
        <button className="btn ghost" onClick={handleBack}>← Back</button>
        <h1>Drawing to Live</h1>
        <span className="exp-badge">Experiment 1</span>
      </header>

      <div className="experiment-body">
        {/* Left: canvas or live video */}
        <div className="experiment-video-panel">
          {phase === 'draw' && (
            <canvas
              ref={canvasRef}
              width={CANVAS_W}
              height={CANVAS_H}
              style={{ cursor: tool === 'eraser' ? 'cell' : 'crosshair', touchAction: 'none' }}
              onMouseDown={startDraw}
              onMouseMove={draw}
              onMouseUp={endDraw}
              onMouseLeave={endDraw}
              onTouchStart={startDraw}
              onTouchMove={draw}
              onTouchEnd={endDraw}
            />
          )}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{ display: phase === 'live' ? 'block' : 'none', width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </div>

        {/* Right: controls */}
        <aside className="experiment-side-panel">
          <div className="experiment-status">
            {status === 'idle' || status === 'connecting' ? 'Connecting to Odyssey…' :
             status === 'ready'     ? 'Draw something, then bring it to life.' :
             status === 'streaming' ? 'Your drawing is alive!' :
             status === 'error'     ? `Error: ${error}` : status}
          </div>

          {phase === 'draw' && (
            <>
              <div className="drawing-tools">
                <div className="tool-row">
                  <button className={`exp-btn ghost ${tool === 'pen' ? 'active' : ''}`} onClick={() => setTool('pen')} style={{ flex: 1 }}>Pen</button>
                  <button className={`exp-btn ghost ${tool === 'eraser' ? 'active' : ''}`} onClick={() => setTool('eraser')} style={{ flex: 1 }}>Eraser</button>
                </div>
                <label className="tool-label">Colour
                  <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ marginLeft: 8, verticalAlign: 'middle' }} />
                </label>
                <label className="tool-label">Size: {strokeWidth}px
                  <input type="range" min={1} max={30} value={strokeWidth} onChange={(e) => setStrokeWidth(Number(e.target.value))} style={{ width: '100%' }} />
                </label>
              </div>
              <button className="exp-btn ghost" onClick={clearCanvas}>Clear</button>
              <button
                className="exp-btn primary"
                disabled={status !== 'ready'}
                onClick={bringToLife}
              >
                Bring to Life ✨
              </button>
            </>
          )}

          {phase === 'live' && (
            <>
              <div className="exp-prompt-row">
                <input
                  type="text"
                  className="exp-text-input"
                  placeholder="Talk to your drawing…"
                  value={promptText}
                  onChange={(e) => setPromptText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { void sendPrompt(promptText); setPromptText(''); }
                  }}
                />
                <button
                  className="exp-btn primary"
                  onClick={() => { void sendPrompt(promptText); setPromptText(''); }}
                >
                  Send
                </button>
              </div>
              <button className="exp-btn ghost" onClick={() => { clearCanvas(); setPhase('draw'); setIsStreaming(false); }}>
                Draw again
              </button>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
