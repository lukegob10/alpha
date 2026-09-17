---
description: "Prepare or inspect a stable or V2 preview release of the Alpha VS Code extension"
argument-hint: stable | preview
mode: code
---

Use this command only for a release action the user has explicitly requested. Preserve the requested branch, channel, and
versioning policy. Do not create a commit, push, tag, GitHub release, or pull request unless that action is part of the
user's request.

1. Select the workflow from the requested channel:

    - Stable releases run from `main` through `.github/workflows/release-vsix.yml`.
    - V2 preview releases run from `main-v2` through `.github/workflows/release-vsix-v2-preview.yml`.

2. Inspect `src/package.json`, `src/CHANGELOG.md`, `.changeset/`, and the current Git status. Keep the extension version,
   changelog entry, changesets, and requested release channel consistent. Use `pnpm exec changeset` to add a changeset and
   `pnpm changeset:version` to apply an approved changeset plan; never edit the version only to make a release command
   pass.

3. Run the local checks that match the requested release:

    ```sh
    pnpm lint
    pnpm check-types
    pnpm test
    pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
    pnpm --filter @alpha-code/vscode-e2e test:command-paths:1221:run
    pnpm vsix
    ```

    Verify the produced package with `node scripts/verify-vsix-contents.mjs <vsix-path> --check-source`. The stable and
    preview workflows repeat the exact-host, outside-path, packaging, and source-asset checks in CI; do not bypass them.

4. For a local install, use `pnpm install:vsix`. Preview builds share the production extension ID with stable builds, so
   test them in an isolated VS Code profile or extension directory and use `--force` when replacing the same version.

5. For a requested GitHub release, dispatch or update the matching workflow and inspect its artifact and release result.
   Stable releases publish a GitHub release with a `vsix-v<version>-<commit>` tag. Preview releases publish a prerelease
   with a `vsix-v2-preview-<version>-<commit>` tag and are not sent to the VS Code Marketplace.

6. Report the channel, version, commit, VSIX path or release tag, checks run, and any unresolved failures. Keep failed or
   superseded evidence in the external run directory referenced by the task; do not add generated logs or attempt output
   to Git.
