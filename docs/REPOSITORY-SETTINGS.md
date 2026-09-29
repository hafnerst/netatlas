# Repository settings for the branch workflow

These settings enforce the workflow in [CONTRIBUTING.md](../CONTRIBUTING.md).
Only a repository **admin** can apply them. On this personal-account
repository that is the owner, @hafnerst. The automation account
@hafnerst-agent has *write* access and cannot change them.

## What is enforced here, and how

One ruleset ("Ruleset A" below) protects `dev` and `main`.

| Requirement | Enforced by | Enforceable? |
|---|---|---|
| No direct pushes to `dev` / `main`; changes only via PR | Ruleset A: *Require a pull request* | Yes |
| At least one approval | Ruleset A: *Required approvals: 1* | Yes |
| The approval must come from @hafnerst | Ruleset A: *Require review from Code Owners* + `.github/CODEOWNERS` (`* @hafnerst`) | Yes |
| Any push after the approval needs a new approval | Ruleset A: *Dismiss stale approvals*, *Require approval of the most recent reviewable push* | Yes |
| No force pushes, no deletion of `dev` / `main` | Ruleset A: *Block force pushes*, *Restrict deletions* | Yes |
| Only @hafnerst clicks *Merge* | — | **No** (policy), see below |
| Release PRs into `main` come only from `dev` | — | **No** (policy); can be enforced later with a CI check |
| CI must pass | *Require status checks* | Not yet: the repository has no CI |
| The author never approves their own PR | GitHub itself | Yes (authors cannot approve their own PRs) |

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
  request, and you review and merge them.
* **Strongest isolation (optional):** remove @hafnerst-agent as a
  collaborator and let it open PRs from a fork. It then has no write access
  at all, so only you can merge. That costs a more complicated setup.
* **Please verify after changing rules.** The rules for a branch are public
  at `https://api.github.com/repos/hafnerst/netatlas/rules/branches/dev`.

## Setup sequence

For a fresh copy of this setup:

1. **Create `dev` from `main`** (no content change). As @hafnerst:
   *Code → Branches → New branch → name `dev`, source `main`*.
2. **Import the ruleset** below: *Settings → Rules → Rulesets → New ruleset →
   Import a ruleset* with the JSON file, then check that it is **Active** and
   its bypass list is empty.
3. **General settings** (*Settings → General → Pull Requests*):
   * **required:** enable **Automatically delete head branches**. Only `main`
     and `dev` are long-lived; every working branch is deleted as soon as its
     PR is merged (see "Branch cleanup" below);
   * keep merge commits, squash and rebase as you prefer (the workflow works
     with any);
   * keep `main` as the default branch. PRs from @hafnerst-agent always set
     base `dev` explicitly.
4. Pull requests into `dev` can then be opened and reviewed under the rules.

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

File: [`docs/rulesets/dev-main-pull-requests.json`](rulesets/dev-main-pull-requests.json)

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
| – Require approval of the most recent reviewable push | on |
| – Require conversation resolution before merging | on |
| Require status checks to pass | *later, when CI exists (see below)* |

## Later: CI

When a CI workflow exists (e.g. a GitHub Actions job running `npm test`):

* add **Require status checks to pass** with that job to Ruleset A, and
  enable *Require branches to be up to date before merging* if you want PRs
  tested against the latest `dev`;
* optionally add a check that fails unless the head branch of a PR into
  `main` is `dev`, and require it on `main`. That turns the "releases come
  from `dev`" policy into an enforced rule.

Never weaken existing rules when adding these; only add to them.
