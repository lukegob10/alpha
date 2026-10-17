---
description: "Resolve merge conflicts intelligently using git history analysis"
argument-hint: "#PR-number"
---

Resolve merge conflicts for a specific pull request by analyzing git history, commit messages, and code changes to make intelligent resolution decisions.

## Quick Start

1. **Provide a PR number** (e.g., `#123` or just `123`)

2. The workflow will automatically:
    - Fetch PR information (title, description, branches)
    - Checkout the PR branch
    - Rebase onto the target branch to reveal conflicts
    - Analyze and resolve conflicts using git history

## Workflow Steps

### 1. Initialize PR Resolution

Record the current branch and HEAD with `git branch --show-current` and `git rev-parse HEAD`, then inspect
`git status --porcelain`. Continue only with a clean working tree and no merge or rebase in progress. Otherwise stop and
preserve the existing work. Use a fresh resolution branch so existing local branches keep their commits.

```bash
# Fetch PR info
gh pr view [PR_NUMBER] --json title,body,headRefName,baseRefName,url

# Check out the PR on a new local branch
gh pr checkout [PR_NUMBER] --branch [NEW_RESOLUTION_BRANCH]

# Fetch the actual PR base and rebase onto that fetched commit
git fetch [BASE_REMOTE] [BASE_REF_NAME]
git -c core.editor=true rebase FETCH_HEAD
```

Use the PR's `baseRefName` for `[BASE_REF_NAME]` and the remote for its base repository for `[BASE_REMOTE]`; verify that
remote against the PR URL. Choose an unused `[NEW_RESOLUTION_BRANCH]`, such as `codex/resolve-pr-123`. Do not force
checkout, reset an existing branch, or stash unrelated changes automatically.

### 2. Identify Conflicts

```bash
git diff --name-only --diff-filter=U
```

### 3. Analyze Each Conflict

For each conflicted file:

- Read the conflict markers
- Run `git blame` on conflicting sections
- Fetch commit messages for context
- Determine the intent behind each change

### 4. Apply Resolution Strategy

Based on the analysis:

- **Bugfixes** generally take precedence over features
- **Recent changes** are often more relevant (unless older is a security fix)
- **Combine** non-conflicting changes when possible
- **Preserve** test updates alongside code changes

### 5. Complete Resolution

```bash
git add [resolved-files]
git -c core.editor=true rebase --continue
```

## Key Guidelines

- Always escape conflict markers with `\` when using `apply_diff`
- Document resolution decisions in the summary
- Report the new resolution branch and leave it available for review
- Verify no syntax errors after resolution
- Preserve valuable changes from both sides when possible

## Examples

- `/alpha-resolve-conflicts #123` - Resolve conflicts for PR #123
- `/alpha-resolve-conflicts 456` - Resolve conflicts for PR #456
