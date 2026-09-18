# Contributing to Alpha

Thanks for helping improve Alpha. Keep contributions focused, easy to review, and tied to a clear issue.

## Start With An Issue

- Search existing issues before opening a new one.
- Use GitHub Issues for bugs, enhancements, and coordination: https://github.com/lukegob10/alpha/issues
- For security problems, use a private advisory: https://github.com/lukegob10/alpha/security/advisories/new
- If you want to work on an issue, comment "Claiming" and wait for maintainer confirmation.

## Pull Requests

- Link the issue in the PR description, for example `Closes #123`.
- Keep each PR focused on one bug, feature, or docs update.
- Describe what changed, why it changed, and how you tested it.
- Include screenshots or short videos for visible UI changes.
- Start as a draft PR if you want early feedback.

## Local Development

```sh
pnpm install
pnpm lint
pnpm check-types
pnpm bundle
pnpm test
```

For the release-host contract, run `pnpm --filter @alpha-code/vscode-e2e test:smoke:1221` on VS Code 1.122.1.
Optional evaluator coverage is explicit: `pnpm test:evals` or `pnpm test:evals:offline`. For all retained workspace
checks, use `pnpm lint:all`, `pnpm check-types:all`, and `pnpm test:all`.

For extension debugging, open the repo in VS Code and press `F5`. The repository uses Node.js 24.14.1, npm 11.11.0,
and pnpm 11.24.0. The extension remains compatible with the VS Code 1.122.1 release host.

## Standards

- Follow the existing code style and TypeScript patterns.
- Add or update tests when behavior changes.
- Keep docs Alpha-branded and avoid legacy community, support, or marketing links.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the Apache 2.0 License.
