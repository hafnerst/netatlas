// The entry of the released application, dist/netatlas.html: the public
// examples only. "#selftest" runs the public self-test (its examples, both
// themes, the Objects list, offline); the full self-test and the viewport
// check need the internal examples and run on the test build (main-test.ts).
import { boot } from './boot';
import { runPublicSelfTest, notInThisBuild } from './public-selftest';

boot({ selftest: runPublicSelfTest, viewportcheck: notInThisBuild });
