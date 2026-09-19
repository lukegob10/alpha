# GitHub CLI

Alpha uses `gh` through `execute_command` for GitHub work. Install the
[GitHub CLI](https://cli.github.com/) on the machine or remote environment running
the extension, then authenticate interactively:

```sh
gh --version
gh auth login
gh auth status
```

Run repository commands from the intended checkout, or specify the repository
explicitly with a command's `--repo` option. For example:

```sh
gh pr list --repo OWNER/REPO
gh pr checks NUMBER --repo OWNER/REPO
```

Authentication belongs to GitHub CLI. Alpha does not copy its former GitHub token
setting into CLI credentials. Automation can supply `GH_TOKEN` through its secret
environment; the existing release workflows use the job's GitHub token with
`contents: write` to create releases. Grant only the permissions required by the
automation. Do not put credentials in command arguments or repository settings.

## Execution and compatibility

GitHub commands use the existing command approval, workspace scope, cancellation,
and output controls. Installing or authenticating `gh` does not grant approval to
execute commands. CLI aliases, extensions, and API requests do not gain a separate
trusted execution path. Offline extension workflow fixtures continue to approve
only their exact scripted commands.

The former `github_api` tool, direct REST/cURL client, and GitHub settings panel are
retired. Obsolete saved GitHub settings are removed or ignored on load/import.
Historical GitHub activity remains readable, but a historical tool name cannot
restore an executable integration. Retired custom-mode GitHub permissions do not
grant command permissions.

Use built-in CLI subcommands where available. `gh api` is also a CLI command and
must receive the same command-policy review. Its method is normally GET, but
adding fields changes the default to POST; GraphQL requests can contain mutations.
Do not infer that an API request is read-only from the `gh api` prefix.

## References

Primary documentation reviewed on 2026-09-19:

- [GitHub CLI authentication](https://cli.github.com/manual/gh_auth_login)
- [CLI environment variables and token precedence](https://cli.github.com/manual/gh_help_environment)
- [API request methods and fields](https://cli.github.com/manual/gh_api)
