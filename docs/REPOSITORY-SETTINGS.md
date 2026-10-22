# Repository settings for the branch workflow

These settings enforce the workflow in [CONTRIBUTING.md](../CONTRIBUTING.md).
Only a repository **admin** can apply them. On this personal-account
repository that is the owner, @hafnerst. The automation account
@hafnerst-agent has *write* access and cannot change them.

A JSON file in [`docs/rulesets/`](rulesets/) is a record or a proposal, never
proof that a rule is active: what is active is what GitHub shows under
*Settings → Rules → Rulesets*, or publicly at
`https://api.github.com/repos/hafnerst/netatlas/rules/branches/dev`.

## Applied and proposed (as read on 2026-10-19)

Read through the API by @hafnerst-agent (write access; some settings need
admin access to read and are marked so).

| Setting | State | |
|---|---|---|
| Ruleset A "dev and main: pull requests only" | **applied**, active, empty bypass list | [below](#ruleset-a-pull-requests-approval-history-protection) |
| Ruleset B "dev and main: required checks" | **proposed**, not applied | [below](#ruleset-b-required-checks) |
| Environment `release` with a required reviewer | **applied** on 2026-10-22: reviewer @hafnerst, self-review allowed, branch `main` only, no secrets (read through the API that day) | [below](#the-release-environment) |
| Ruleset C "release tags: maintainer only" (optional) | **proposed**, not applied | [below](#ruleset-c-release-tags-optional) |
| Automatically delete head branches | applied (on) | |
| Allow auto-merge | applied (**off**); keep it off | |
| Merge methods | merge, squash and rebase allowed | |
| Actions: workflow permissions, allowed actions, fork approval | not readable without admin access | [below](#github-actions-settings) |
| Dependabot alerts | **off** | [below](#security-features) |
| Private vulnerability reporting | off | [below](#security-features) |
| Code scanning default setup, secret scanning, push protection | not readable without admin access | [below](#security-features) |
| Immutable releases | off (the four releases so far are not immutable) | [below](#security-features) |
| Releases | v0.1.0 to v0.1.3, published by @hafnerst, **no assets attached**; tags are lightweight | |

## What is enforced here, and how

| Requirement | Enforced by | Enforceable? |
|---|---|---|
| No direct pushes to `dev` / `main`; changes only via PR | Ruleset A: *Require a pull request* | Yes (applied) |
| At least one approval | Ruleset A: *Required approvals: 1* | Yes (applied) |
| The approval must come from @hafnerst | Ruleset A: *Require review from Code Owners* + `.github/CODEOWNERS` (`* @hafnerst`) | Yes (applied) |
| Any push after the approval needs a new approval | Ruleset A: *Dismiss stale approvals when new commits are pushed* | Yes (applied) |
| Review conversations are resolved before the merge | Ruleset A: *Require conversation resolution* | Yes (applied) |
| No force pushes, no deletion of `dev` / `main` | Ruleset A: *Block force pushes*, *Restrict deletions* | Yes (applied) |
| CI must pass | Ruleset B: *Require status checks to pass* with CI's checks | Yes, **once Ruleset B is applied** |
| Release PRs into `main` come only from `dev` | CI's *Release PR source* check, required by Ruleset B | Yes, **once Ruleset B is applied** |
| A release is attached only after the maintainer approves | the `release` environment's required reviewer | Yes (applied); see its limits |
| Only @hafnerst clicks *Merge* | — | **No** (policy), see below |
| The author never approves their own PR | GitHub itself | Yes (authors cannot approve their own PRs) |
| Nothing merges by itself | *Allow auto-merge* off; no workflow merges or approves | Yes (applied; the workflows have no write access to pull requests) |

Code-owner approval and the required checks are separate requirements: each
must be met on its own, and neither replaces the other. No workflow, app or
account is on a bypass list, and none should be added to make a merge or a
release easier.

**Your approval is the gate.** Nothing reaches `dev` or `main` without
@hafnerst's approval of exactly the latest commit of the PR. With the approval
in place, GitHub shows the normal *Merge* button; no rule has to be bypassed.

**Who clicks *Merge* is policy.** A personal-account repository can't restrict
merging to one person without making every merge a rule bypass (a *Restrict
updates* rule lets only its bypass actors update the branch, so even the
owner's normal merge shows up as *"Merge without waiting for requirements to
be met (bypass rules)"*). That ruleset ("merges by repository admin only")
was therefore removed. Once a PR is approved, a collaborator with write access,
including @hafnerst-agent, could technically merge it; @hafnerst-agent never
does, and it could only merge the exact state that was approved.

Classic branch protection's "Restrict who can push to matching branches"
exists only for organization repositories and isn't available here.

Limits you should know about:
* **The owner can always change or disable the rules.** They restrict
  collaborators, not the admin.
* **Pull requests you author yourself.** Ruleset A applies to everyone,
  including @hafnerst. A PR you open needs an approval from someone else, and
  the only other collaborator is @hafnerst-agent, which must not approve.
  So PRs, including release PRs, are opened by @hafnerst-agent on your
  request, and you review and merge them. Don't require an approval that
  nobody can give: a second required approval, or *Require approval of the
  most recent reviewable push* on a PR you pushed to last, would leave such
  a PR unmergeable without a bypass.
* **Write access is broad.** A collaborator with write access can also run
  workflows by hand, push branches with changed workflows, and create
  releases through the API. The environment and the rules below make the
  intended path the only one that works without being noticed; they do not
  make write access harmless. @hafnerst-agent does none of this unasked.
* **Strongest isolation (optional):** remove @hafnerst-agent as a
  collaborator and let it open PRs from a fork. It then has no write access
  at all, so only you can merge, run the release workflow or create
  releases. Workflows of a fork's pull request then run with a read-only
  token and without secrets, which CI is built for. That costs a more
  complicated setup.
* **Please verify after changing rules.** The rules for a branch are public
  at `https://api.github.com/repos/hafnerst/netatlas/rules/branches/dev`.

## Setup sequence

For a fresh copy of this setup:

1. **Create `dev` from `main`** (no content change). As @hafnerst:
   *Code → Branches → New branch → name `dev`, source `main`*.
2. **Import Ruleset A**: *Settings → Rules → Rulesets → New ruleset →
   Import a ruleset* with
   [`dev-main-pull-requests.json`](rulesets/dev-main-pull-requests.json),
   then check that it is **Active** and its bypass list is empty.
3. **General settings** (*Settings → General → Pull Requests*):
   * **required:** enable **Automatically delete head branches**. Only `main`
     and `dev` are long-lived; every working branch is deleted as soon as its
     PR is merged (see "Branch cleanup" below);
   * keep **Allow auto-merge** off;
   * keep merge commits, squash and rebase as you prefer (the workflow works
     with any);
   * keep `main` as the default branch. PRs from @hafnerst-agent always set
     base `dev` explicitly.
4. **Actions settings**, **the `release` environment**, and **Ruleset B**
   after CI has run once: the sections below.
5. Pull requests into `dev` can then be opened and reviewed under the rules.

## Branch cleanup

The repository keeps only two long-lived branches, `main` and `dev`.

* **Merged working branches:** GitHub deletes them when the PR is merged,
  through *Automatically delete head branches*. Only an admin can change that
  setting; @hafnerst-agent can't.
* **`dev` itself is never deleted.** When a release PR from `dev` into `main`
  is merged, `dev` is the head branch. Ruleset A's *Restrict deletions*
  protects it, so the automatic cleanup can't remove it. After the first
  release, check that `dev` still exists. If it doesn't, recreate it from
  `main` and report it, because that would mean the protection didn't apply.
* **Branches left over** (e.g. from before the setting was enabled, or a PR
  closed without merging): they are deleted only after checking that the
  branch's last commit is contained in `dev`
  (`git merge-base --is-ancestor origin/<branch> origin/dev`), or, for an
  unmerged branch, that it is no longer needed.
* **Local clones:** `git fetch --prune origin` removes the deleted remote
  branches; `git branch -d <branch>` removes the local copy and refuses if it
  isn't merged.

## Ruleset A: pull requests, approval, history protection

File: [`docs/rulesets/dev-main-pull-requests.json`](rulesets/dev-main-pull-requests.json).
**Applied** (ruleset 24171342). The file matches what the API returns for it.

| Setting | Value |
|---|---|
| Name | `dev and main: pull requests only` |
| Enforcement | Active |
| Bypass list | *(empty)* |
| Target branches | `dev`, `main` |
| Restrict deletions | on |
| Block force pushes | on |
| Require a pull request before merging | on |
| – Required approvals | **1** |
| – Dismiss stale approvals when new commits are pushed | on |
| – Require review from Code Owners | **on** |
| – Require approval of the most recent reviewable push | **off** |
| – Require conversation resolution before merging | on |
| – Extra approval for unattributed changes | on (GitHub's default) |

Until 2026-10-19 this file said *Require approval of the most recent
reviewable push: on*, but the applied ruleset has it off. Off is the
consistent choice here: *Dismiss stale approvals* already requires a new
approval after every push, and with it on, a PR to which @hafnerst pushed
last could not be approved by anyone (see "Pull requests you author
yourself"). The file now records the applied state.

**Stale approvals and new commits.** Any push dismisses the approval;
@hafnerst approves the new head again. That is why a branch is refreshed
*before* review is requested (CONTRIBUTING.md, "Keeping a branch current"),
and why Ruleset B does not require branches to be up to date with `dev`.

## Ruleset B: required checks

File: [`docs/rulesets/dev-main-required-checks.json`](rulesets/dev-main-required-checks.json).
**Proposed, not applied.** It only adds to Ruleset A (rules of several
rulesets apply together); it changes nothing in it.

It requires these checks of the CI workflow (`.github/workflows/ci.yml`),
each from GitHub Actions (integration 15368), on pull requests into `dev`
and `main`:

`Source and generated files`, `Model and analysis tests`,
`Compatibility (Node 22 on Linux)`, `Compatibility (Node 24 on Windows)`,
`Browser regression tests`, `Public artifact`, `Viewport checks`,
`Workflow lint`, `Release PR source`.

(`test/workflows.test.mjs` fails if the job names and this file drift
apart.) The Security workflow's checks (CodeQL, Dependency review) are not
required: they depend on features below and on GitHub's advisories, which
change without a change to the code.

* **Require branches to be up to date before merging:** off. A PR need not be
  rebased onto every new `dev` (each rebase dismisses the approval). The
  push run on `dev` after a merge verifies the result; with one maintainer
  merging one PR at a time, a broken combination is found there at once. Turn
  it on if that ever happens repeatedly.
* **No merge queue.** With one maintainer and a handful of PRs a week, it
  would add waiting and a second set of runs without catching anything the
  push run on `dev` doesn't.

**To apply** (as @hafnerst):
1. Merge the PR that adds the workflows, or let CI run once on any PR: a
   check can be required only after GitHub has seen it.
2. *Settings → Rules → Rulesets → New ruleset → Import a ruleset* with the
   file. Check that it is **Active**, its bypass list is empty, and the nine
   checks are listed with the source *GitHub Actions*.
3. Verify at `https://api.github.com/repos/hafnerst/netatlas/rules/branches/dev`:
   a `required_status_checks` rule appears beside Ruleset A's rules.

## The `release` environment

**Applied on 2026-10-22**, before the first release run, as below (read
back through the API that day). The release workflow's publishing job
(`.github/workflows/release.yml`, *Attach to a draft release*) runs in the
environment `release`. GitHub creates an environment of that name, without
any protection, the first time a workflow uses it; if it is ever deleted,
set it up again **before** the next release run:

1. *Settings → Environments → New environment*, name `release`.
2. **Required reviewers:** @hafnerst. Leave *Prevent self-review* **off**:
   you start the run and approve it yourself, and no one else can.
3. **Deployment branches and tags:** *Selected branches and tags*, add the
   branch `main`. The workflow is started from `main` (*Run workflow → Use
   workflow from: main*), so only the release workflow as reviewed into
   `main` can reach the publishing job.
4. No secrets: the job uses the workflow's own token, with `contents: write`
   (the release), `id-token: write` and `attestations: write` (the
   attestation) for that job only.

The job also refuses to run when anyone but the repository owner started
the run. Both are guards, not walls: see "Write access is broad" above.

The workflow attaches the assets to a **draft**; publishing it is a manual
step. It never replaces an attached asset with different content and never
creates, moves or deletes a tag.

## Ruleset C: release tags (optional)

File: [`docs/rulesets/release-tags.json`](rulesets/release-tags.json).
**Proposed, not applied.** It restricts creating, moving and deleting
`v*` tags to the *Repository admin* role (@hafnerst), so that no other
account can create the tag the release workflow packages. Your own tag push
then counts as a rule bypass, which GitHub records. Apply it like Ruleset B
(*New ruleset → Import*) if you want that; the release workflow does not
depend on it. It is optional because the workflow already checks that the
tag names the version in `package.json` and a commit on `main`.

## GitHub Actions settings

Not readable without admin access, so not verified. Recommended (*Settings →
Actions → General*):

* **Workflow permissions:** *Read repository contents and packages
  permissions* (the default token is read-only; the workflows ask for more
  per job where needed) and **Allow GitHub Actions to create and approve
  pull requests: off**.
* **Actions permissions:** *Allow hafnerst, and select non-hafnerst, actions
  and reusable workflows*, with *Allow actions created by GitHub* and these:
  `browser-actions/setup-chrome@*`, `zizmorcore/zizmor-action@*`. Turn on
  **Require actions to be pinned to a full-length commit SHA**: every
  action here is pinned that way already (`test/workflows.test.mjs` checks
  it).
* **Fork pull request workflows:** *Require approval for all external
  contributors*.
* **Artifact and log retention:** the workflows set 7 days (14 for release
  assets); the repository default does not need to change.

## Security features

| Feature | State | Recommendation |
|---|---|---|
| Dependabot **version updates** (`.github/dependabot.yml`) | in this file: monthly, grouped, into `dev`, at most 2 PRs per ecosystem, a week's cooldown; npm lockfile-only (the `~5.9` range stays) | they work without any setting; each PR is reviewed like any other |
| Dependabot **alerts** and security updates | off (API: "Dependabot alerts are disabled") | turn on (*Settings → Advanced Security*); the only dependency is TypeScript, a build tool |
| Dependency graph | **off** for this repository: the review's API answers 403 and the first CI run said "Dependency review is not supported on this repository" | turn it on (*Settings → Advanced Security → Dependency graph*). Until then the Dependency review job skips the review with a notice saying so, and passes |
| Code scanning | the CodeQL job in `.github/workflows/security.yml` (advanced setup); default setup not readable | keep **default setup off**: with default setup on, GitHub rejects the workflow's uploads and the CodeQL job fails. If you prefer default setup, delete the `codeql` job instead |
| Secret scanning, push protection | free for public repositories; not readable | turn both on (*Settings → Advanced Security*). The workflows use no secrets |
| Private vulnerability reporting | off | optional: turn on to receive reports privately |
| Immutable releases | off | optional: turn on (*Settings → General → Releases*) so that a published release's assets and tag cannot change; drafts stay editable, so the workflow works either way |

None of these is a required check, so a feature that is off or unavailable
shows up as a failed or skipped advisory job, never as a pull request that
cannot be merged.
