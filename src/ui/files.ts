/**
 * Local files: reading a file the user picked or dropped, writing a model to
 * a file the user chose (where the browser can), and saving text by letting
 * the browser download it. Nothing is ever uploaded: reading uses the File
 * API, writing a file handle of the File System Access API, downloading a
 * Blob URL.
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

// ------------------------------------------------- files the page may write

/**
 * A file the page may write to: a handle of the browser's File System Access
 * API (Chromium-based browsers), obtained only from an explicit user action
 * (a save or open picker, or a dropped file). Typed structurally, with only
 * what NetAtlas uses, so it can be stood in for in the self-test.
 */
export interface WritableFile {
  kind?: string;
  name: string;
  getFile?(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
  queryPermission?(opts: { mode: 'readwrite' }): Promise<string>;
  requestPermission?(opts: { mode: 'readwrite' }): Promise<string>;
}

/** What the browser offers for picking files to open and save (feature-detected, never assumed). */
export interface FileAccess {
  /** a picker that returns a handle the page can write to (null: only downloads are possible) */
  saveFile: ((suggestedName: string) => Promise<WritableFile>) | null;
  /** a picker for opening that returns a handle with the file (null: use the file input) */
  openFile: (() => Promise<WritableFile>) | null;
}

const YAML_TYPES = [{ description: 'YAML file', accept: { 'text/yaml': ['.yaml', '.yml'] } }];

/** The browser's file pickers, where it has them (Chromium-based browsers; not Firefox or Safari). */
export function detectFileAccess(win: Window | null): FileAccess {
  const w = win as unknown as { showSaveFilePicker?: (o: object) => Promise<WritableFile>; showOpenFilePicker?: (o: object) => Promise<WritableFile[]>; isSecureContext?: boolean } | null;
  if (!w || w.isSecureContext === false) return { saveFile: null, openFile: null };
  const save = typeof w.showSaveFilePicker === 'function' ? w.showSaveFilePicker.bind(w) : null;
  const open = typeof w.showOpenFilePicker === 'function' ? w.showOpenFilePicker.bind(w) : null;
  return {
    saveFile: save ? (suggestedName: string) => save({ suggestedName, types: YAML_TYPES }) : null,
    openFile: open ? async () => (await open({ multiple: false, types: YAML_TYPES }))[0] : null,
  };
}

/** Did the user close a picker (or a permission prompt) without choosing? */
export function isCancel(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError';
}

/** Can the page write through this handle at all? (A handle from a file input never exists; one from a picker may be read-only.) */
export function isWritable(h: unknown): h is WritableFile {
  return !!h && typeof h === 'object' && typeof (h as WritableFile).createWritable === 'function' && ((h as WritableFile).kind === undefined || (h as WritableFile).kind === 'file');
}

export type WriteOutcome = { ok: true } | { ok: false; reason: 'denied' | 'failed'; message: string };

/**
 * Write text to a file handle, replacing its content. Asks for write
 * permission first when the browser hasn't granted it yet (the browser may
 * show its own prompt). Never throws: a refusal or a failed write is
 * returned, so the caller can keep the unsaved state.
 */
export async function writeFile(h: WritableFile, text: string): Promise<WriteOutcome> {
  try {
    if (h.queryPermission) {
      let p = await h.queryPermission({ mode: 'readwrite' });
      if (p !== 'granted' && h.requestPermission) p = await h.requestPermission({ mode: 'readwrite' });
      if (p !== 'granted') return { ok: false, reason: 'denied', message: 'the browser did not allow this page to write to the file' };
    }
    const w = await h.createWritable();
    await w.write(text);
    await w.close();
    return { ok: true };
  } catch (e) {
    if (isCancel(e)) return { ok: false, reason: 'denied', message: 'writing to the file was not allowed' };
    const name = e && typeof e === 'object' ? (e as { name?: string }).name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') return { ok: false, reason: 'denied', message: 'the browser did not allow this page to write to the file' };
    return { ok: false, reason: 'failed', message: e instanceof Error && e.message ? e.message : String(e) };
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
