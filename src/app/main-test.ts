// The entry of the test build, build/netatlas-test.html (scripts/build.mjs):
// the released application plus the internal examples and fixtures, the full
// in-browser self-test ("#selftest") and the viewport check
// ("#viewportcheck"). Never shipped: dist/netatlas.html is built from main.ts,
// which imports none of this.
import { boot } from './boot';
import { registerInternalExamples } from '../ui/examples';
import { INTERNAL_EXAMPLES } from '../generated/test-examples';
import { runSelfTest } from './selftest';
import { runViewportCheck } from './viewport-check';

registerInternalExamples(INTERNAL_EXAMPLES);
boot({ selftest: runSelfTest, viewportcheck: runViewportCheck });
