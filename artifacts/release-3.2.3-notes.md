Alpha 3.2.3 refines the chat experience and improves thread reliability.

- Stabilize ticket mention previews and long-message overflow.
- Integrate thread orchestration, task titles, chat delivery, follow-ups, and history recovery.
- Remove dormant code and refresh repository guidance.

Download alpha-3.2.3.vsix below and install using VS Code's Extensions: Install from VSIX command, or:

```sh
code --install-extension alpha-3.2.3.vsix
```

Requires VS Code 1.125.0 or later.

Validation: extension build, workspace typechecks, announcement regression tests (3 passed), and VSIX contents/source-asset verification passed. Exact VS Code 1.125.0 smoke gate passed (43 tests across 13 suites). The full test suite was not rerun for this incremental snapshot release.

Source commit: ee2cea46c93bded3aecf22ae202b3723f3651795

SHA256: 0a3d2415308d7e63b3b65bb2c3edba00aaca226465c5c4289798ed40c80f4741
