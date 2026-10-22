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
   `build/netatlas-test.html`) and runs every test suite. Commit the
   regenerated files (`dist/netatlas.html`, `src/generated/`,
   `docs/SUPPORT.md`) together with the source changes, and look at what
   changed in them (`git diff --stat`): a generated file that changed although
   its source did not is a finding. A new example is either public
   (`examples/`, listed in the catalog) or a test scenario
   (`test/examples/`): see [examples/README.md](examples/README.md). Keep
   imports within the layer rules in
   [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
4. **Refresh the branch, then verify, then push.** If `dev` moved on since
   step 1, bring the branch up to date *before* asking for review (see
   [Keeping a branch current](#keeping-a-branch-current)), run
   `npm run verify` (or at least `npm test`), and push.
5. **Open a pull request into `dev`.** Fill in the template briefly: what
   changed and why, the commands run and their results, screenshots for a
   visible change, a model-format change if there is one, and what was not
   done or not checked. CI runs on the pull request; its checks are listed
   in [docs/TESTING.md](docs/TESTING.md#ci).
6. **Request review from @hafnerst.** Then stop. The author never approves,
   merges or bypasses protections for their own pull request, and no
   automation merges it (auto-merge is off and nothing enables it).
7. **Wait for the merge.** An opened or approved PR is not a merged one. The
   next task starts from the updated `dev` (step 1).
8. **The working branch is deleted after the merge.** Only `main` and `dev`
   are long-lived. GitHub deletes the merged branch automatically
   ("Automatically delete head branches"). Clean up your local copy too:
   ```sh
   git fetch --prune origin      # forget remote branches deleted on GitHub
   git switch dev && git pull --ff-only
   git branch -d <topic-branch>  # -d refuses to delete unmerged work
   ```
   A branch whose PR was closed without merging is deleted only after
   confirming that nothing on it is still needed.

### Keeping a branch current

Any push to a pull request dismisses an approval it already has (the branch
rules' *Dismiss stale approvals*), so update a branch **before** review is
requested, not after it was approved:

* **A branch that is not under review yet:** rebase it onto the latest
  `dev` (`git fetch origin && git rebase origin/dev`), run the checks again,
  and push with `git push --force-with-lease`. That rewrites only your own
  working branch, never `dev` or `main`.
* **A branch under review, or one another branch builds on:** don't rewrite
  it. Merge `dev` into it (`git merge origin/dev`) only when a conflict or a
  needed change on `dev` requires it; otherwise leave it as reviewed. The
  rules do not require a branch to be up to date with `dev` before it is
  merged, so a PR whose base moved on does not need a new push (and a new
  approval) just for that.
* **Dependent work** (a task that needs another PR's change) waits until
  that PR is merged and then starts from the updated `dev`. Don't stack
  branches on unmerged ones: every rebase of the lower branch would dismiss
  the upper one's approval.
* Regenerated files conflict easily (`dist/netatlas.html` is one long line).
  Resolve such a conflict by taking either side and running `npm run build`
  again, then check that `npm run check:dist` passes.

Existing history is never rewritten to meet a convention; conventions apply
to new branches and commits.

## Building and testing

Requirements: Node.js 22 or later; CI and releases use Node 24 (the LTS line
in `.nvmrc`). The only dependency is the TypeScript compiler (a
devDependency, pinned by `package-lock.json`). There are no runtime or
application-library dependencies.

| Task | Command |
|---|---|
| Install the pinned dependencies | `npm ci` |
| Type check (writes nothing) | `npm run typecheck` |
| Regenerate everything | `npm run build` |
| Are the committed generated files current? (writes nothing) | `npm run check:dist` |
| Two builds identical, no committed file changed by a build | `npm run check:repro` |
| Fast tests (no browser) | `npm run test:unit` (after `npm run build`) |
| Browser tests, on the test build | `npm run test:browser` (after `npm run build`) |
| The shipped page: its self-test, offline, package check | `npm run test:public` |
| Viewport check at ten window sizes | `npm run test:viewport` (after `npm run build`) |
| Build and every test suite | `npm test` |
| Everything CI checks, in CI's order | `npm run verify` |
| Release package check of `dist/netatlas.html` | `npm run release:check` |
| Release assets in `release/`, without publishing | `npm run release:prepare` |

`npm run verify` is the full verification of a clean checkout: the type
check, then the freshness of the committed files *before* anything
regenerates them, then the reproducibility check (which regenerates them,
twice), the release package check, and all four test suites. What each
suite contains is in [docs/TESTING.md](docs/TESTING.md).

```sh
npm ci             # installs typescript only
npm run build      # -> dist/netatlas.html (and the test build, build/netatlas-test.html)
```

`npm run build` does five things:

1. `scripts/gen-examples.mjs` embeds the public examples (`examples/*.yaml`,
   in the order of its `CATALOG`) into `src/generated/examples.ts` for the
   **File** menu, and the internal test examples and fixtures
   (`test/examples/*.yaml`, `test/fixtures/*.yaml`) into
   `src/generated/test-examples.ts`, which only the test build imports.
2. `scripts/gen-help.mjs` embeds `LICENSE` and the manual's screenshots
   (`docs/img/manual/*.webp`) into `src/generated/help-assets.ts` for the
   **Help** menu, the images as `data:` URLs (the page may load nothing else).
3. `tsc` compiles `src/**/*.ts` to CommonJS JavaScript in `build/js/`.
4. `scripts/gen-support.mjs` writes `docs/SUPPORT.md` from the support
   catalog (`src/model/support-catalog.ts` and the protocols' own
   statements); edit those, never the generated file.
5. `scripts/build.mjs` bundles those modules into one inline `<script>`. It's
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

`check:dist` checks every generated file in memory and writes none of them:
`src/generated/examples.ts` and `test-examples.ts`, `src/generated/help-assets.ts`,
the fixtures in `test/fixtures/`, `docs/SUPPORT.md` and
`dist/netatlas.html` (it compiles to `build/js`, which is not committed). A
stale file fails with the command that regenerates it. It prints the sha256
of the bundle. `npm run check:repro` then builds twice and confirms that both
builds are byte-identical and change no committed file: the build embeds no
date, time or machine, so the same source always gives the same file.

### Optional: a pre-push hook

`.githooks/pre-push` runs the quick checks before a push: the type check,
`check:dist` and the unit tests (about a minute; no browser). It is not
installed automatically. To use it:

```sh
git config core.hooksPath .githooks       # enable (this clone only)
git config --unset core.hooksPath         # disable
```

It is a convenience, not the enforcement: CI runs the same checks and more
on every pull request. `git push --no-verify` skips it.

What each test suite checks, and the manual check in other browsers, are in
[docs/TESTING.md](docs/TESTING.md).

## Releasing

A release is a pull request **from `dev` into `main`**, opened only when the
maintainer asks for a release. @hafnerst reviews and merges it. Nothing else
targets `main`; CI's *Release PR source* check fails a pull request into
`main` from any other branch.

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
3. **Tag** by @hafnerst, on the merge commit in `main`. The version is the
   maintainer's choice; no automation picks or creates it:
   ```sh
   git fetch origin && git switch main && git pull --ff-only
   npm ci && npm run verify                   # optional locally: the release workflow runs it too
   git tag -a vX.Y.Z -m "NetAtlas vX.Y.Z" && git push origin vX.Y.Z
   ```
4. **Package** with the **Release** workflow (*Actions → Release → Run
   workflow*, tag `vX.Y.Z`), started by @hafnerst. It:
   * checks that the tag is `vX.Y.Z` (or `vX.Y.Z-pre`, a prerelease), that
     its commit is on `main`, that `package.json`, `package-lock.json` and the
     HTML say the same version and that `CHANGELOG.md` has its section;
   * verifies the committed `dist/netatlas.html` (fresh, reproducible, no
     test payload, within the size budget) and runs every test suite with
     the pinned browser;
   * writes the assets: `netatlas.html`, `SHA256SUMS`, `provenance.json`
     (version, commit, model format, toolchain, checksum), and a build
     provenance attestation for `netatlas.html`;
   * waits for the approval of the `release` environment, then attaches the
     assets to a **draft** release with the `CHANGELOG.md` section as notes.
   It never moves a tag, never replaces an attached asset that differs (the
   run fails instead), and on a re-run leaves identical assets alone.
5. **Publish** the draft on GitHub after reading it (*Releases → Edit →
   Publish release*). That is the maintainer's step.
6. **After the release**, check that `dev` still exists (see
   [docs/REPOSITORY-SETTINGS.md](docs/REPOSITORY-SETTINGS.md), "Branch
   cleanup").

To try the packaging locally without publishing anything:
`npm run release:prepare` writes the same assets to `release/` (not
committed); `node scripts/release-check.mjs --tag vX.Y.Z` also checks a
tag on the current commit.

(GitHub itself can't require that the source branch of a PR into `main` is
`dev`. CI's *Release PR source* check does, once it is a required check; see
[docs/REPOSITORY-SETTINGS.md](docs/REPOSITORY-SETTINGS.md).)

## Repository settings

The branch rules (pull requests required, approval by the code owner, no
force pushes or deletion) are configured as a GitHub **ruleset**; that only
the maintainer merges is policy. The exact settings, what is applied and
what is only proposed (the required CI checks, the `release` environment,
the release-tag rules), and what they can and cannot enforce, are in
[docs/REPOSITORY-SETTINGS.md](docs/REPOSITORY-SETTINGS.md).
