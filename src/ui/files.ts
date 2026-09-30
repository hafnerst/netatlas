/**
 * Local files: reading a file the user picked or dropped, and saving text by
 * letting the browser download it. Nothing is ever uploaded: reading uses the
 * File API, saving uses a Blob URL.
 */
import { MAX_INPUT_BYTES, Origin } from '../editor/document';

/** Read a user-chosen file as strict UTF-8 text, refusing oversized files before reading them. */
export async function readTextFile(file: File): Promise<{ text: string } | { error: string }> {
  if (file.size > MAX_INPUT_BYTES) {
    return { error: `The file is ${(file.size / 1048576).toFixed(1)} MiB; the limit is ${MAX_INPUT_BYTES / 1048576} MiB.` };
  }
  try {
    const buf = await file.arrayBuffer();
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
  } catch (e) {
    return { error: 'The file is not valid UTF-8 text. Save it as UTF-8 and try again.' };
  }
}

/**
 * Suggested name for downloading a model. An imported file is saved as a new
 * copy ("<name>-edited.yaml") so the original is obviously left alone.
 */
export function exportFileName(fileName: string, origin: Origin | null): string {
  if (!fileName) return 'network.yaml';
  const base = fileName.replace(/\.(ya?ml)$/i, '');
  if (origin === 'file') return /-edited$/.test(base) ? base + '.yaml' : base + '-edited.yaml';
  return base + '.yaml';
}

/** Normalize a user-typed download name: non-empty, .yaml/.yml extension, no path characters. */
export function safeYamlFileName(typed: string, fallback: string): string {
  let name = typed.trim() || fallback;
  if (!/\.ya?ml$/i.test(name)) name += '.yaml';
  return name.replace(/[\\/:*?"<>|]+/g, '_');
}

/** Offer text as a local download (Blob URL; nothing leaves the machine). */
export function downloadText(doc: Document, text: string, name: string, type: string): void {
  downloadBlob(doc, new Blob([text], { type }), name);
}

/** Offer a blob as a local download. */
export function downloadBlob(doc: Document, blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ------------------------------------------------------------------ pictures

/** Base name of exported pictures: the model's file name without its extension, safe as a file name. */
export function pictureBaseName(fileName: string): string {
  return (fileName.replace(/\.[^.]*$/, '') || 'netatlas').replace(/[\\/:*?"<>|]+/g, '_');
}

/** PNG exports are drawn at twice the diagram's size (sharp text), unless the picture would become too large. */
export const PNG_SCALE = 2;
/** Limits every current browser's canvas can handle: longest side, and total pixels. */
export const PNG_MAX_SIDE = 16000;
export const PNG_MAX_PIXELS = 64000000;

/** The scale a picture of w × h diagram units is drawn at: PNG_SCALE, reduced just enough to stay within the limits. */
export function pngScale(w: number, h: number): number {
  if (!(w > 0) || !(h > 0)) return PNG_SCALE;
  const bySide = PNG_MAX_SIDE / Math.max(w, h);
  const byArea = Math.sqrt(PNG_MAX_PIXELS / (w * h));
  return Math.min(PNG_SCALE, bySide, byArea);
}

export interface PngPicture {
  blob: Blob;
  /** size in pixels */
  width: number;
  height: number;
  /** pixels per diagram unit */
  scale: number;
}

/**
 * Draw a standalone SVG document of w × h units into a PNG, entirely in the
 * page: the SVG is decoded as an image from a data: URL and painted onto a
 * canvas. Rejects with an explanation when the browser cannot do it.
 */
export function svgToPng(doc: Document, svgText: string, w: number, h: number, background: string): Promise<PngPicture> {
  return new Promise((resolve, reject) => {
    const scale = pngScale(w, h);
    const width = Math.max(1, Math.round(w * scale));
    const height = Math.max(1, Math.round(h * scale));
    const img = new Image();
    img.onerror = () => reject(new Error('the browser could not draw the diagram as an image'));
    img.onload = () => {
      try {
        const canvas = doc.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error(`the browser could not create a ${width} × ${height} pixel picture`);
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (blob) resolve({ blob, width, height, scale });
          else reject(new Error(`the browser could not encode a ${width} × ${height} pixel picture`));
        }, 'image/png');
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
  });
}
