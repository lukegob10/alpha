# Memory

Memory should not be a default feature for Alpha yet.

If the extension already has strong specs, updated READMEs, indexed code, test coverage, and an optional knowledge-base/RAG layer, then persistent memory has a narrow job. It is not a replacement for those systems. It only helps with context that is useful over time but does not belong in source files, docs, tests, or project specs.

## Where Memory Helps

- User preferences that should survive across sessions.
- Repeated local workflow choices that are too personal for repo docs.
- Project decisions that are still tentative and should not become formal documentation.
- Lightweight reminders about active investigations, recurring pain points, or unfinished reasoning.

## Where Memory Does Not Help

- Requirements that should be in specs.
- Architecture decisions that should be in docs.
- Code facts that should come from indexing.
- Domain knowledge that belongs in a knowledge base.
- Test expectations that should be executable.

## Risk

Memory can make the agent feel smarter while making behavior harder to reason about. If memory silently influences answers, it can conflict with current files, stale project state, or explicit user intent.

## Current Position

Do not build a complex memory system for Alpha now.

If memory is added later, it should be small, visible, editable, and clearly secondary to repo context. The first version should probably be a plain project note system, not an autonomous agent memory layer.
