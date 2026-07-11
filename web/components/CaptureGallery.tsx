'use client';
import { useEffect, useRef, useState } from 'react';
import { authedFetch } from '@/lib/authedFetch';
import { ui, card } from '@/lib/ui';

export type DrawnBox = { class: 'human' | 'animal'; bbox: [number, number, number, number] };
export type Detection = {
  id: string;
  deviceId: string;
  imageUrl: string | null;
  capturedAt: number;
  analyzed?: boolean;  // false = still waiting for the AI; true = the AI has run
  detections: { label?: string; confidence?: number; box?: number[] }[];
  boxes?: DrawnBox[];  // human-annotated boxes from external cameras (trail cams etc.)
};

// A record belongs on the Detections page when the AI has RUN and it found at
// least one animal or person (either a model label or an annotated box). An
// unanalyzed photo, or one analyzed with nothing found, does not qualify.
export function hasAnimalOrPerson(det: Detection): boolean {
  if (!det.analyzed) return false;
  return (det.detections?.length ?? 0) > 0 || (det.boxes?.length ?? 0) > 0;
}

const CAPTURE_MAX_W = 320;   // column width the gallery image fits into

// Canvas-overlaid image for detections that carry pre-drawn boxes (external
// data sources). Colors match the source annotations sampled from the batch.
//
// A per-image "Rotate 90°" button turns the picture in the browser -- each click
// adds another 90° and wraps back to upright after four (0 -> 90 -> 180 -> 270 ->
// 0). Handy for cameras mounted sideways. The rotation is VIEW ONLY: it isn't
// saved, so a refresh shows the original orientation again. Any overlay boxes
// rotate WITH the image (they live in the same rotated group), so they stay
// aligned. The frame reserves space for the rotated footprint so a turned image
// never overlaps the caption/link beneath it.
function CaptureImage({ det, showBoxes }: { det: Detection; showBoxes: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [rot, setRot] = useState(0);             // 0 / 90 / 180 / 270 degrees
  const [box, setBox] = useState({ w: 0, h: 0 }); // rendered (unrotated) size, px
  const boxes = det.boxes ?? [];
  const draw = () => {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    canvas.width = img.clientWidth;
    canvas.height = img.clientHeight;
    if (img.clientWidth && (img.clientWidth !== box.w || img.clientHeight !== box.h)) {
      setBox({ w: img.clientWidth, h: img.clientHeight });
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!showBoxes || !boxes.length) return;
    const sx = img.clientWidth / img.naturalWidth;
    const sy = img.clientHeight / img.naturalHeight;
    ctx.lineWidth = 2;
    for (const b of boxes) {
      ctx.strokeStyle = b.class === 'human' ? 'rgb(208,22,24)' : 'rgb(240,240,70)';
      const [x, y, w, h] = b.bbox;
      ctx.strokeRect(x * sx, y * sy, w * sx, h * sy);
    }
  };
  useEffect(draw, [showBoxes, boxes]);

  const rotated = rot % 180 !== 0;
  const footW = rotated ? box.h : box.w;
  const footH = rotated ? box.w : box.h;
  const scale = footW > CAPTURE_MAX_W && footW > 0 ? CAPTURE_MAX_W / footW : 1;
  const rotateBtn: React.CSSProperties = { fontSize: 11, padding: '2px 6px', marginTop: 4, cursor: 'pointer' };

  return (
    <div style={{ marginTop: 8 }}>
      <div
        style={{
          position: 'relative',
          width: box.w ? footW * scale : '100%',
          height: box.w ? footH * scale : undefined,
          maxWidth: CAPTURE_MAX_W,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: box.w ? 'absolute' : 'relative',
            top: '50%',
            left: '50%',
            width: box.w || '100%',
            transform: box.w
              ? `translate(-50%, -50%) rotate(${rot}deg) scale(${scale})`
              : undefined,
            transformOrigin: 'center center',
            lineHeight: 0,
          }}
        >
          <img ref={imgRef} src={det.imageUrl!} alt="" style={{ width: box.w || '100%', display: 'block' }} onLoad={draw} />
          <canvas ref={canvasRef} style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }} />
        </div>
      </div>
      <button
        type="button"
        style={rotateBtn}
        title="Rotate this image 90° (click again to keep turning). View only — not saved."
        onClick={() => setRot((r) => (r + 90) % 360)}
      >
        ⟳ Rotate 90°{rot ? ` · ${rot}°` : ''}
      </button>
    </div>
  );
}

// The image gallery, shared by the All-images and Detections pages.
//   mode="all"         -> every capture, newest first
//   mode="detections"  -> only analyzed captures with an animal or a person
export default function CaptureGallery({ mode }: { mode: 'all' | 'detections' }) {
  const [items, setItems] = useState<Detection[]>([]);
  const [error, setError] = useState('');
  const [showBoxes, setShowBoxes] = useState(true);

  useEffect(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('wps.showBoxes') : null;
    if (saved !== null) setShowBoxes(saved === 'true');
  }, []);
  useEffect(() => {
    if (typeof window !== 'undefined') window.localStorage.setItem('wps.showBoxes', String(showBoxes));
  }, [showBoxes]);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await authedFetch('/api/detections');
        const data = await res.json();
        if (!active) return;
        if (res.ok) setItems(data.detections || []);
        else setError(data.error || 'Failed to load images');
      } catch (e: any) {
        if (active) setError(e?.message || 'Failed to load images');
      }
    }
    load();
    const t = setInterval(load, 10000); // refresh every 10s

    // Kick the in-cloud AI while an image page is open: any unanalyzed photos
    // get Gemini labels + boxes (keyless, server-side — see /api/analyze-pending).
    async function analyze() {
      try { await authedFetch('/api/analyze-pending', { method: 'POST' }); } catch { /* non-fatal */ }
    }
    analyze();
    const ta = setInterval(analyze, 30000);
    return () => { active = false; clearInterval(t); clearInterval(ta); };
  }, []);

  const shown = mode === 'detections' ? items.filter(hasAnimalOrPerson) : items;
  const emptyMsg = mode === 'detections'
    ? 'No animals or people spotted yet. Photos appear here once the AI finds one.'
    : 'No images yet. They show up here as soon as a camera uploads one.';

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '4px 0 12px' }}>
        <span style={{ fontSize: 13, color: ui.slate }}>
          {shown.length} {mode === 'detections' ? 'detection' : 'image'}{shown.length === 1 ? '' : 's'}
        </span>
        <button
          onClick={() => setShowBoxes((v) => !v)}
          style={{ fontSize: 12, padding: '2px 8px', cursor: 'pointer' }}
        >
          {showBoxes ? 'hide boxes' : 'show boxes'}
        </button>
      </div>
      {error && <p style={{ color: ui.danger }}>{error}</p>}
      {shown.length === 0 ? (
        <p style={{ opacity: 0.7 }}>{emptyMsg}</p>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {shown.map((det) => {
            const drawn = det.boxes ?? [];
            const labels = det.detections ?? [];
            // Prefer the model's per-label list (species + confidence); fall back
            // to the drawn-box counts (external/annotated captures). analyzed:false
            // → still "analyzing…", NOT the same as "analyzed and found nothing".
            let summary: React.ReactNode;
            if (labels.length > 0) {
              summary = labels.map((x) => `${x.label ?? '?'} (${Math.round((x.confidence ?? 0) * 100)}%)`).join(', ');
            } else if (drawn.length > 0) {
              const parts = [
                drawn.filter((b) => b.class === 'animal').length,
                drawn.filter((b) => b.class === 'human').length,
              ];
              summary = [`${parts[0]} animal`, `${parts[1]} human`].filter((_, i) => parts[i] > 0).join(' · ') || 'nothing';
            } else if (det.analyzed) {
              summary = <span style={{ opacity: 0.6 }}>no animals</span>;
            } else {
              summary = <span style={{ fontSize: 12, padding: '1px 8px', borderRadius: 4, background: '#e0e7ff', color: '#3730a3' }}>⏳ analyzing…</span>;
            }
            return (
              <div key={det.id} style={card}>
                <b>{det.deviceId}</b>{' '}
                <span style={{ fontSize: 12, opacity: 0.7 }}>{new Date(det.capturedAt).toLocaleString()}</span>
                <div style={{ marginTop: 2, fontSize: 15 }}>{summary}</div>
                {det.imageUrl && <CaptureImage det={det} showBoxes={showBoxes} />}
                {det.imageUrl && (
                  <a href={det.imageUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: ui.slate }}>
                    view full image
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
