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
   `dist/netatlas.html` and runs the Node tests and the headless-browser
   self-test. Commit the regenerated `dist/netatlas.html` together with the
   source changes. `npm run check:dist` confirms that the committed HTML
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

## Releasing

A release is a pull request **from `dev` into `main`**, opened only when the
maintainer asks for a release. @hafnerst reviews and merges it. Nothing else
targets `main`.

Versions follow [semantic versioning](https://semver.org/); the version lives
in `package.json` (and `package-lock.json`), and the build writes it into the
HTML. The YAML format has its own version (`netatlas: 2`), independent of the
application version. Steps for a release `X.Y.Z`:

1. **Release preparation** on a working branch from `dev` (e.g.
   `chore/release-vX.Y.Z`): set the version, add the `CHANGELOG.md` section,
   update the documentation, rebuild `dist/netatlas.html`, run `npm test`,
   `npm run check:dist` and the manual checks in the README. PR into `dev`,
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
