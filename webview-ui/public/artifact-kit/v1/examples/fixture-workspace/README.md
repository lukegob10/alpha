# Fictional task export review workspace

These deliberately defective TypeScript files supply real source targets for the HTML review and its equivalent Markdown baseline. They are review material, not Alpha implementation code. No real filesystem adapter, package manifest, build setup, or execution command is supplied. Do not copy this implementation into production.

Open this directory as the workspace folder in the supported VS Code host, then open the packaged `review.html` through Alpha's HTML viewer and `review-baseline.md` through its existing Markdown flow. Their source paths resolve relative to this workspace. Keep the source files unchanged while comparing the two formats.

Perform the same three tasks in each format:

1. State the merge recommendation and its required changes.
2. Locate the highest-priority finding and inspect the evidence.
3. Activate its source reference and verify that the editor selects the path-joining statement in `src/export/resolveDestination.ts`.

Record the actual interaction steps, keyboard access, source file and selected line, and any dead ends. Repeat source navigation for the writer and success-only test references. A styled link alone is not evidence of successful navigation. Check narrow views and the supported light, dark, and contrast themes separately from task completion.

The deliberate defects are an unchecked display title used in a destination path, a write directly to the final filename, and tests limited to successful output. The archive interfaces keep the example self-contained; they do not represent a working ZIP implementation. Read-only review requirements are not saved approval state. This fixture does not claim that a comparison or test run has already passed.
