/**
 * The examples the application can load. The public ones (generated/examples)
 * are the File menu's catalog and part of every build. The internal ones are
 * test scenarios: only the test build registers them (src/app/main-test.ts,
 * from generated/test-examples), so dist/netatlas.html never contains them.
 * They are loaded by name and never listed in the File menu.
 */
import { EXAMPLES, Example } from '../generated/examples';

const internal: Example[] = [];

/** Make internal examples loadable by name (the test build only). */
export function registerInternalExamples(list: Example[]): void {
  for (const x of list) if (!internal.some((y) => y.name === x.name)) internal.push(x);
}

/** The internal examples registered (none in dist/netatlas.html). */
export function internalExamples(): readonly Example[] {
  return internal;
}

/** An example by its file name: a public one with its index in the catalog, else an internal one (index -1). */
export function findExample(name: string): { example: Example; index: number } | null {
  const i = EXAMPLES.findIndex((e) => e.name === name);
  if (i >= 0) return { example: EXAMPLES[i], index: i };
  const x = internal.find((e) => e.name === name);
  return x ? { example: x, index: -1 } : null;
}
