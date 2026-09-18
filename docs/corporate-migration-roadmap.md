# Roadmap: move Alpha into the corporate environment

We want to keep developing Alpha in the new environment and have a reliable way to tell whether our changes actually make it better.

**The order:** do 1 and 2 first. Then 3, 4, and 5 can happen at the same time. Once those are finished, work through 6–10 in order.

## 1. Find out what the new environment allows

Confirm which software, package downloads, AI providers, and automated tests we can use. Find out how we will install and share the extension.

**Finished when:** we have a short list of what is available and what still needs to be arranged.

## 2. Find out what works today

Run the existing tests and build the extension before changing anything. Save the results and list any existing problems, so we can tell whether later changes caused a new problem.

**Finished when:** we know what passes, what fails, and what we could not test.

## 3. Update Node, pnpm, and npm

Use Node **24.14.1**, pnpm **11.24.0**, and npm **11.11.0**. Update the setup files, package settings, scripts, and automated builds to agree. Check that dependencies still install and the extension still builds and runs.

Keep pnpm as the package manager and keep testing the extension in **VS Code 1.122.1**.

**Finished when:** a fresh copy of the repo installs, builds, and passes the required checks using those versions.

## 4. Clean up the repo

Go through the folders and identify what the extension and its tests actually use. Remove abandoned code and outdated scripts. Save useful historical results before removing old files. Make it obvious where development, tests, and instructions belong.

**Finished when:** we can explain why each remaining area exists, and the cleanup has not broken anything.

## 5. Review whether our tests tell us enough

Look at what each test actually checks. Work out which of these questions it answers:

- Did we break existing behavior?
- Does the extension work inside real VS Code?
- Can the AI finish the task correctly?
- Did our change improve the result, speed, or model usage?

**Finished when:** we have a clear list of useful tests, weak or duplicate tests, and missing tests.

## 6. Improve the tests and the information they give us

Work through the missing and weak tests from step 5. Cover things like getting stuck, stopping a task, saving and reopening work, tool failures, and background tasks. Improve the recorded events and results so we can understand where a failure happened.

Build on the testing tools already in the repo. Check that the tests actually catch the problems they are supposed to catch.

**Finished when:** a failed test gives us enough information to investigate, and the important behaviors are covered.

## 7. Set up a fair way to compare changes

Run the old and changed versions on the same tasks with the same model and settings. Repeat the runs. Compare correct completion first, then time and model usage. Include failures in the results.

Decide what counts as an improvement before running the comparison. If the results are too close or inconsistent, say we do not know yet.

**Finished when:** we can show whether a change helped, hurt, or needs more testing.

## 8. Write and try the development routine

Make instructions that any coding agent can follow:

**Research an idea → decide what it should improve → make one change → run the tests → compare results → keep or undo the change → record what we learned.**

Set limits on time, model usage, and repeated attempts. If a test needs changing, explain why; do not make it easier just to get a pass. Try the whole routine on one small improvement.

**Finished when:** the routine has worked from beginning to end and another agent could repeat it.

## 9. Try the whole setup in the corporate environment

Start with a fresh copy of the repo. Follow written setup instructions. Install dependencies, develop and debug, run the required tests, use an approved AI provider, and package and install the extension.

Check that saved work still opens and that we can return to the previous version if something goes wrong. Fix anything that depends on your current computer or access the new environment does not allow.

**Finished when:** we can do the full development cycle there by following the instructions.

## 10. Start using it there, then keep improving it

Try normal work on a few representative repositories. Resolve any problems before making this the main development environment.

Then repeat step 8 for new research and ideas. Turn real bugs into tests so they stay fixed.

**Finished when:** the new environment supports everyday work and we have a working routine for continued improvement.

---

Steps 3–5 can be investigated separately, but coordinate edits to shared files. Run the required checks from [AGENTS.md](../AGENTS.md) on the combined changes. A test we could not run is still untested.

This is the plan. The migration work has not been carried out as part of writing it.
