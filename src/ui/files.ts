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
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
