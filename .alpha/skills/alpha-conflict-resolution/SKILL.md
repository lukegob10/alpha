---
name: alpha-conflict-resolution
description: Provides comprehensive guidelines for resolving merge conflicts intelligently using git history and commit context. Use when tasks involve merge conflicts, rebasing, PR conflicts, or git conflict resolution. This skill analyzes commit messages, git blame, and code intent to make intelligent resolution decisions.
---

# Alpha Conflict Resolution Skill

## When to Use This Skill

Use this skill when the task involves:

- Resolving merge conflicts for a specific pull request
- Rebasing a branch that has conflicts with the target branch
- Understanding and analyzing conflicting code changes
- Making intelligent decisions about which changes to keep, merge, or discard
- Using git history to inform conflict resolution decisions

## When NOT to Use This Skill

Do NOT use this skill when:

- There are no merge conflicts to resolve
- The task is about general code review without conflicts
- You're working on fresh code without any merge scenarios

## Workflow Overview

This skill resolves merge conflicts by analyzing git history, commit messages, and code changes to make intelligent resolution decisions. Given a PR number (e.g., "#123"), it handles the entire conflict resolution process.

## Initialization Steps

### Step 1: Parse PR Number

Extract the PR number from input like "#123" or "PR #123". Validate that a PR number was provided.

### Step 2: Fetch PR Information

```bash
gh pr view [PR_NUMBER] --json title,body,headRefName,baseRefName,url
```

Get PR title and description to understand the intent and identify the source and target branches.

### Step 3: Checkout PR Branch and Prepare for Rebase

Record the current branch and HEAD with `git branch --show-current` and `git rev-parse HEAD`, then inspect
`git status --porcelain`. Continue only with a clean working tree and no merge or rebase in progress. Otherwise stop and
preserve the existing work. Use a fresh resolution branch so existing local branches keep their commits.

```bash
gh pr checkout [PR_NUMBER] --branch [NEW_RESOLUTION_BRANCH]
git fetch [BASE_REMOTE] [BASE_REF_NAME]
git -c core.editor=true rebase FETCH_HEAD
```

Use the PR's `baseRefName` for `[BASE_REF_NAME]` and the remote for its base repository for `[BASE_REMOTE]`; verify that
remote against the PR URL. Choose an unused `[NEW_RESOLUTION_BRANCH]`, such as `codex/resolve-pr-123`. Do not force
checkout, reset an existing branch, or stash unrelated changes automatically.

### Step 4: Check for Merge Conflicts

```bash
git status --porcelain
git diff --name-only --diff-filter=U
```

Identify every unmerged file reported by `git diff --name-only --diff-filter=U`, including added or deleted conflicts.

## Main Workflow Phases

### Phase 1: Conflict Analysis

Analyze each conflicted file to understand the changes:

1. Read the conflicted file to identify conflict markers
2. Extract the conflicting sections between `<<<<<<<` and `>>>>>>>`
3. Run git blame on both sides of the conflict
4. Fetch commit messages and diffs for relevant commits
5. Analyze the intent behind each change

### Phase 2: Resolution Strategy

Determine the best resolution strategy for each conflict:

1. Categorize changes by intent (bugfix, feature, refactor, etc.)
2. Evaluate recency and relevance of changes
3. Check for structural overlap vs formatting differences
4. Identify if changes can be combined or if one should override
5. Consider test updates and related changes

### Phase 3: Conflict Resolution

Apply the resolution strategy to resolve conflicts:

1. For each conflict, apply the chosen resolution
2. Ensure proper escaping of conflict markers in diffs
3. Validate that resolved code is syntactically correct
4. Stage resolved files with `git add`

### Phase 4: Validation

Verify the resolution and prepare for commit:

1. Run `git status` to confirm all conflicts are resolved
2. Check for any compilation or syntax errors
3. Review the final diff to ensure sensible resolutions
4. Prepare a summary of resolution decisions

## Git Commands Reference

| Command                                                          | Purpose                                    |
| ---------------------------------------------------------------- | ------------------------------------------ |
| `gh pr checkout [PR_NUMBER] --branch [NEW_RESOLUTION_BRANCH]`    | Check out the PR on a new local branch     |
| `git fetch [BASE_REMOTE] [BASE_REF_NAME]`                        | Fetch the PR's actual base branch          |
| `git -c core.editor=true rebase FETCH_HEAD`                      | Rebase onto the fetched base commit        |
| `git blame -L [start],[end] [commit] -- [file]`                  | Get commit information for specific lines  |
| `git show --format="%H%n%an%n%ae%n%ad%n%s%n%b" --no-patch [sha]` | Get commit metadata                        |
| `git show [sha] -- [file]`                                       | Get the actual changes made in a commit    |
| `git ls-files -u`                                                | List unmerged files with stage information |
| `git -c core.editor=true rebase --continue`                      | Continue rebase after resolving conflicts  |

## Best Practices

### Intent-Based Resolution (High Priority)

Always prioritize understanding the intent behind changes rather than just looking at the code differences. Commit messages, PR descriptions, and issue references provide crucial context.

**Example:** When there's a conflict between a bugfix and a refactor, apply the bugfix logic within the refactored structure rather than simply choosing one side.

### Preserve All Valuable Changes (High Priority)

When possible, combine non-conflicting changes from both sides rather than discarding one side entirely. Both sides of a conflict often contain valuable changes that can coexist if properly integrated.

### Escape Conflict Markers (High Priority)

When using `apply_diff`, always escape merge conflict markers with backslashes to prevent parsing errors:

- Correct: `\<<<<<<< HEAD`
- Wrong: `<<<<<<< HEAD`

### Consider Related Changes (Medium Priority)

Look beyond the immediate conflict to understand related changes in tests, documentation, or dependent code. A change might seem isolated but could be part of a larger feature or fix.

## Resolution Heuristics

| Category            | Rule                                               | Exception                               |
| ------------------- | -------------------------------------------------- | --------------------------------------- |
| Bugfix vs Feature   | Bugfixes generally take precedence                 | When features include the fix           |
| Recent vs Old       | More recent changes are often more relevant        | When older changes are security patches |
| Test Updates        | Changes with test updates are likely more complete | -                                       |
| Formatting vs Logic | Logic changes take precedence over formatting      | -                                       |

## Common Pitfalls

### Blindly Choosing One Side

**Problem:** You might lose important changes or introduce regressions.
**Solution:** Always analyze both sides using git blame and commit history.

### Ignoring PR Context

**Problem:** The PR description often explains the why behind changes.
**Solution:** Always fetch and read the PR information before resolving.

### Not Validating Resolved Code

**Problem:** Merged code might be syntactically incorrect or introduce logical errors.
**Solution:** Always check for syntax errors and review the final diff.

### Unescaped Conflict Markers in Diffs

**Problem:** Unescaped conflict markers (`<<<<<<`, `=======`, `>>>>>>`) will be interpreted as diff syntax.
**Solution:** Always escape with backslash (`\`) when they appear in content.

## Apply Diff Example

When resolving conflicts with `apply_diff`, use this pattern:

```
<<<<<<< SEARCH
:start_line:45
-------
\<<<<<<< HEAD
function oldImplementation() {
  return "old";
}
\=======
function newImplementation() {
  return "new";
}
\>>>>>>> feature-branch
=======
function mergedImplementation() {
  // Combining both approaches
  return "merged";
}
>>>>>>> REPLACE
```

## Quality Checklist

### Before Resolution

- [ ] Fetch PR title and description for context
- [ ] Identify all files with conflicts
- [ ] Understand the overall change being merged

### During Resolution

- [ ] Run git blame on conflicting sections
- [ ] Read commit messages for intent
- [ ] Consider if changes can be combined
- [ ] Escape conflict markers in diffs

### After Resolution

- [ ] Verify no conflict markers remain
- [ ] Check for syntax/compilation errors
- [ ] Review the complete diff
- [ ] Document resolution decisions

## Completion Criteria

- All merge conflicts have been resolved
- Resolved files have been staged
- No syntax errors in resolved code
- Resolution decisions are documented
- The new resolution branch is reported and remains available for review

## Communication Guidelines

When reporting resolution progress:

- Be direct and technical when explaining resolution decisions
- Focus on the rationale behind each conflict resolution
- Provide clear summaries of what was merged and why

### Progress Update Format

```
Conflict in [file]:
- HEAD: [brief description of changes]
- Incoming: [brief description of changes]
- Resolution: [what was decided and why]
```

### Completion Message Format

```
Successfully resolved merge conflicts for PR #[number] "[title]".

Resolution Summary:
- [file1]: [brief description of resolution]
- [file2]: [brief description of resolution]

[Key decision explanation if applicable]

All conflicts have been resolved and files have been staged for commit.
```
