import { useRef, useState } from 'react';
import { Tldraw, type Editor } from 'tldraw';
import 'tldraw/tldraw.css';

type Props = {
  onCancel: () => void;
  onDone: (file: File, dataUrl: string) => void;
};

export default function DrawCanvasModal({ onCancel, onDone }: Props) {
  const editorRef = useRef<Editor | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDone = async () => {
    const editor = editorRef.current;
    if (!editor) return;

    const shapeIds = [...editor.getCurrentPageShapeIds()];
    if (shapeIds.length === 0) {
      setError('Draw something first.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await editor.toImage(shapeIds, {
        format: 'png',
        background: true,
        padding: 32,
        scale: 2,
      });
      const file = new File([result.blob], 'drawing.png', { type: 'image/png' });
      const dataUrl = URL.createObjectURL(result.blob);
      onDone(file, dataUrl);
    } catch {
      setError('Could not export the drawing. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="dtl-canvas-modal" role="dialog" aria-modal="true" aria-label="Draw">
      <header className="dtl-canvas-toolbar">
        <button type="button" className="dtl-canvas-btn" onClick={onCancel}>
          Back
        </button>
        <span className="dtl-canvas-title">Draw something</span>
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
        <Tldraw
          onMount={(editor) => {
            editorRef.current = editor;
          }}
        />
      </div>
    </div>
  );
}
