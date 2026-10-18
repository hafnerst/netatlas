# Contributing: branch workflow

NetAtlas uses three kinds of branches. Every change reaches `dev` and `main`
through a reviewed pull request; nobody pushes to them directly.

| Branch | Purpose | How changes arrive | Who merges |
|---|---|---|---|
| `main` | Release branch (the default branch) | A deliberate **release pull request from `dev`** | The maintainer, **@hafnerst**, only |
| `dev` | Integration branch | Pull requests from working branches | The maintainer, **@hafnerst**, only |
| `feature/…`, `fix/…`, `docs/…`, `chore/…` | One short-lived branch per task | Commits by the author | (not merged directly; deleted after the PR is merged) |

```
feature/x ──PR──┐
fix/y ─────PR───┼──► dev ──release PR──► main
docs/z ────PR───┘
```

## Working on a task

These rules apply to every contributor, including the automation account
**@hafnerst-agent**.

1. **Start from the latest `dev`.** Fetch it first. Never assume an earlier PR
   was merged: check that it actually is on `dev`.
   ```sh
   git fetch origin
   git switch -c feature/<topic> origin/dev
   ```
2. **One branch per task.** Name it `feature/<topic>`, `fix/<topic>`,
   `docs/<topic>` or `chore/<topic>`, with a short, descriptive, lower-case
   topic (e.g. `feature/auto-arrange`, `fix/yaml-tab-crlf`). Never reuse a
   branch for an unrelated task.
3. **Implement and test on that branch.** Run `npm test`: it builds
   `dist/netatlas.html` (and the uncommitted test build,
   `build/netatlas-test.html`) and runs the Node tests and the
   headless-browser self-tests. Commit the regenerated `dist/netatlas.html`
   together with the source changes. A new example is either public
   (`examples/`, listed in the catalog) or a test scenario
   (`test/examples/`): see [examples/README.md](examples/README.md). `npm run check:dist` confirms that the committed HTML
   matches the source. Keep imports within the layer rules in
   [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
4. **Push the branch and open a pull request into `dev`.** Fill in the
   template: what changed, how it was verified (commands and results), and
   known limitations.
5. **Request review from @hafnerst.** Then stop. The author never approves,
   merges or bypasses protections for their own pull request.
6. **Wait for the merge.** An opened or approved PR is not a merged one. The
   next task starts from the updated `dev` (step 1).
7. **The working branch is deleted after the merge.** Only `main` and `dev`
   are long-lived. GitHub deletes the merged branch automatically
   ("Automatically delete head branches"). Clean up your local copy too:
   ```sh
   git fetch --prune origin      # forget remote branches deleted on GitHub
   git switch dev && git pull --ff-only
   git branch -d <topic-branch>  # -d refuses to delete unmerged work
   ```
   A branch whose PR was closed without merging is deleted only after
   confirming that nothing on it is still needed.

## Building and testing


Requirements: Node.js ≥ 18. The only dependency is the TypeScript compiler
(a devDependency). There are no runtime or application-library dependencies.

```sh
npm install        # installs typescript only
npm run build      # -> dist/netatlas.html (and the test build, build/netatlas-test.html)
```

`npm run build` does four things:

1. `scripts/gen-examples.mjs` embeds the public examples (`examples/*.yaml`,
   in the order of its `CATALOG`) into `src/generated/examples.ts` for the
   **File** menu, and the internal test examples and fixtures
   (`test/examples/*.yaml`, `test/fixtures/*.yaml`) into
   `src/generated/test-examples.ts`, which only the test build imports.
2. `scripts/gen-help.mjs` embeds `LICENSE` and the manual's screenshots
   (`docs/img/manual/*.webp`) into `src/generated/help-assets.ts` for the
   **Help** menu, the images as `data:` URLs (the page may load nothing else).
3. `tsc` compiles `src/**/*.ts` to CommonJS JavaScript in `build/js/`.
4. `scripts/build.mjs` bundles those modules into one inline `<script>`. It's
   a small wrapper that refuses any non-relative `require`. It then inlines
   `src/styles.css` into `src/index.html` and writes two pages:
   * **`dist/netatlas.html`**, the released application, from
     `src/app/main.ts`: the public examples only. The build fails if it would
     contain a test-only module (the internal examples and fixtures, the full
     self-test, the viewport check).
   * **`build/netatlas-test.html`**, the test build, from
     `src/app/main-test.ts`: the same application plus the internal examples
     and fixtures (loadable by name, never in the File menu), the full
     in-browser self-test and the viewport check. It is never committed or
     shipped; the browser tests, the screenshots and the manual cross-browser
     check use it.

   The browser never sees or compiles TypeScript.

To regenerate the test fixtures after changing the editing core, run
`node scripts/make-fixtures.mjs`. Use `--check` to only verify them.

To retake the screenshots of **Help → User Manual** after a UI change, run
`npm run build && npm run screenshots:manual && npm run build`.
`scripts/manual-screenshots.mjs` drives the built page in headless Chrome, Edge
or Chromium through the DevTools protocol (`scripts/cdp.mjs`, over a pipe:
no network port, no extra package) with real pointer and keyboard input, and
writes cropped WebP images to `docs/img/manual/`; the second build embeds them.

To retake the four README screenshots in `docs/img/` (`readme-*.png`) after
a UI change, run `node scripts/readme-screenshots.mjs` after `npm run build`.
It needs Chrome, Edge or Chromium, drives the released `dist/netatlas.html`
with its public examples, and crops each picture to what it shows; the
script lists the steps of each shot.

To add an example, put it in `examples/` and add it to `CATALOG` in
`scripts/gen-examples.mjs` (the build refuses a file in `examples/` that is
not in the catalog), or put a test scenario in `test/examples/`. See
[examples/README.md](examples/README.md).

### Is the checked-in HTML current?

`dist/netatlas.html` is committed so that it can be used without building.
To confirm that it was generated from the current source:

```sh
git status --short        # 1. clean working tree (no local edits)
npm ci                    # 2. the pinned TypeScript version
npm run check:dist        # 3. rebuild in memory and compare byte-for-byte
```

`check:dist` regenerates `src/generated/examples.ts` and the bundle in memory
and writes neither file. It prints the sha256 of the result, and exits with
status 1 if either committed file differs. The build is deterministic, so the
same source always gives the same file. `npm test` checks this too.

What each test suite checks, and the manual check in other browsers, are in
[docs/TESTING.md](docs/TESTING.md).

## Releasing

A release is a pull request **from `dev` into `main`**, opened only when the
maintainer asks for a release. @hafnerst reviews and merges it. Nothing else
targets `main`.

Versions follow [semantic versioning](https://semver.org/); the version lives
in `package.json` (and `package-lock.json`), and the build writes it into the
HTML. The YAML format has its own version (`netatlas: 1`), independent of the
application version. Steps for a release `X.Y.Z`:

1. **Release preparation** on a working branch from `dev` (e.g.
   `chore/release-vX.Y.Z`): set the version, add the `CHANGELOG.md` section,
   update the documentation, rebuild `dist/netatlas.html`, run `npm test`,
   `npm run check:dist` and the manual checks in
   [docs/TESTING.md](docs/TESTING.md). PR into `dev`,
   reviewed and merged by @hafnerst.
2. **Release PR** from `dev` into `main`, reviewed and merged by @hafnerst.
3. **Tag and GitHub release** by @hafnerst (or on explicit request), on the
   merge commit in `main`:
   ```sh
   git fetch origin && git switch main && git pull --ff-only
   npm ci && npm test && npm run check:dist   # the released HTML matches the source
   git tag -a vX.Y.Z -m "NetAtlas vX.Y.Z" && git push origin vX.Y.Z
   ```
   Create the GitHub release from tag `vX.Y.Z` with the `CHANGELOG.md`
   section as notes, and attach `dist/netatlas.html`.
4. **After the release**, check that `dev` still exists (see
   [docs/REPOSITORY-SETTINGS.md](docs/REPOSITORY-SETTINGS.md), "Branch
   cleanup").

(GitHub can't require that the source branch of a PR into `main` is `dev`.
This is a policy until a CI check enforces it; see
[docs/REPOSITORY-SETTINGS.md](docs/REPOSITORY-SETTINGS.md).)

## Repository settings

The branch rules (pull requests required, approval by the code owner, no
force pushes or deletion) are configured as a GitHub **ruleset**; that only
the maintainer merges is policy. The exact settings, and what they can and cannot
enforce, are in [docs/REPOSITORY-SETTINGS.md](docs/REPOSITORY-SETTINGS.md).
