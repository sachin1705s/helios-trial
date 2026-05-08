import { useCallback, useEffect, useRef, useState } from 'react';

type Props = {
  onCancel: () => void;
  onDone: (file: File, dataUrl: string) => void;
};

const COLORS = [
  '#142826', '#2F5E48', '#E8745A', '#F0B546',
  '#3B82F6', '#8B5CF6', '#EC4899', '#F5F1E8',
];
const SIZES = [3, 6, 12, 20];

type Stroke = { points: [number, number][]; color: string; size: number };

export default function DrawCanvasModal({ onCancel, onDone }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const strokesRef = useRef<Stroke[]>([]);
  const activeStroke = useRef<Stroke | null>(null);
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(SIZES[1]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drawing = useRef(false);

  strokesRef.current = strokes;

  const redraw = useCallback((allStrokes: Stroke[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#F5F1E8';
    ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    for (const s of allStrokes) {
      if (s.points.length < 2) continue;
      ctx.beginPath();
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.moveTo(s.points[0][0], s.points[0][1]);
      for (let i = 1; i < s.points.length; i++) {
        ctx.lineTo(s.points[i][0], s.points[i][1]);
      }
      ctx.stroke();
    }
    ctx.restore();
  }, []);

  // Resize canvas to match container — only runs on mount and container resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = parent.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      redraw(strokesRef.current);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [redraw]);

  // Redraw when strokes change (no canvas reset)
  useEffect(() => {
    redraw(strokes);
  }, [strokes, redraw]);

  const getPos = (e: React.PointerEvent): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  const onPointerDown = (e: React.PointerEvent) => {
    drawing.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    activeStroke.current = { points: [getPos(e)], color, size };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawing.current || !activeStroke.current) return;
    activeStroke.current.points.push(getPos(e));
    redraw([...strokesRef.current, activeStroke.current]);
  };

  const onPointerUp = () => {
    if (!drawing.current || !activeStroke.current) return;
    drawing.current = false;
    if (activeStroke.current.points.length >= 2) {
      setStrokes((prev) => [...prev, activeStroke.current!]);
    }
    activeStroke.current = null;
  };

  const handleUndo = () => setStrokes((prev) => prev.slice(0, -1));
  const handleClear = () => setStrokes([]);

  const handleDone = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (strokes.length === 0) {
      setError('Draw something first.');
      return;
    }
    setSubmitting(true);
    setError(null);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setError('Could not export the drawing. Please try again.');
          setSubmitting(false);
          return;
        }
        const file = new File([blob], 'drawing.png', { type: 'image/png' });
        const dataUrl = URL.createObjectURL(blob);
        onDone(file, dataUrl);
      },
      'image/png',
    );
  };

  return (
    <div className="dtl-canvas-modal" role="dialog" aria-modal="true" aria-label="Draw">
      <header className="dtl-canvas-toolbar">
        <button type="button" className="dtl-canvas-btn" onClick={onCancel}>
          Back
        </button>
        <div className="dtl-canvas-controls">
          <div className="dtl-canvas-colors">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`dtl-color-swatch${c === color ? ' active' : ''}`}
                style={{ background: c, border: c === '#F5F1E8' ? '1px solid rgba(20,40,38,0.2)' : 'none' }}
                onClick={() => setColor(c)}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
          <div className="dtl-canvas-sizes">
            {SIZES.map((s) => (
              <button
                key={s}
                type="button"
                className={`dtl-size-btn${s === size ? ' active' : ''}`}
                onClick={() => setSize(s)}
                aria-label={`Brush size ${s}`}
              >
                <span className="dtl-size-dot" style={{ width: s, height: s }} />
              </button>
            ))}
          </div>
          <button type="button" className="dtl-canvas-btn" onClick={handleUndo} disabled={strokes.length === 0}>
            Undo
          </button>
          <button type="button" className="dtl-canvas-btn" onClick={handleClear} disabled={strokes.length === 0}>
            Clear
          </button>
        </div>
        <button
          type="button"
          className="dtl-canvas-btn dtl-canvas-btn--primary"
          onClick={handleDone}
          disabled={submitting}
        >
          {submitting ? 'Saving…' : 'Use drawing'}
        </button>
      </header>

      {error && <p className="dtl-canvas-error">{error}</p>}

      <div className="dtl-canvas-stage">
        <canvas
          ref={canvasRef}
          className="dtl-freehand-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
          style={{ touchAction: 'none', cursor: 'crosshair' }}
        />
      </div>
    </div>
  );
}
