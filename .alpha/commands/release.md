---
description: "Prepare or inspect a release of the Alpha VS Code extension"
argument-hint: "[optional-context]"
mode: code
---

Use this command only for a release action the user has explicitly requested. Preserve the requested branch and
versioning policy. Do not create a commit, push, tag, GitHub release, or pull request unless that action is part of the
user's request.

1. Releases run from `main` through `.github/workflows/release-vsix.yml`. Check the requested branch against that workflow
   before preparing a release.

2. Inspect `src/package.json`, `CHANGELOG.md`, `.changeset/`, and the current Git status. Keep the extension version,
   changelog entry, and changesets consistent. Use `pnpm exec changeset` to add a changeset and
   `pnpm changeset:version` to apply an approved changeset plan; never edit the version only to make a release command
   pass.

3. Run the local release checks:

    ```sh
    pnpm lint
    pnpm check-types
    pnpm test
    pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
    pnpm --filter @alpha-code/vscode-e2e test:command-paths:1250:run
    pnpm vsix
    ```

    Verify the produced package with `node scripts/verify-vsix-contents.mjs <vsix-path> --check-source`. The release
    workflow repeats the exact-host, outside-path, packaging, and source-asset checks in CI; do not bypass them.

4. For a local install, use `pnpm install:vsix`. Test development builds in an isolated VS Code profile or extension
   directory and use `--force` when replacing the same version.

5. For a requested GitHub release, dispatch or update the release workflow and inspect its artifact and release result.
   Releases use a `vsix-v<version>-<commit>` tag and are not sent to the VS Code Marketplace.

6. Report the version, commit, VSIX path or release tag, checks run, and any unresolved failures. Keep failed or
   superseded evidence in the external run directory referenced by the task; do not add generated logs or attempt output
   to Git.
