# Alpha Code security remediation plan

Fix the ticket-reference parser and verify the HTML viewer boundary first, then remove unsafe TLS and shell behavior and
clean up the developer-tool findings. Resolve the synthetic secret fixture with recorded evidence and restore dependency
alerts and required security checks. Scanner severity and actual exposure both determine the order below.

Status: proposed remediation. Repository and GitHub evidence retrieved on **2026-10-14**. Implementation, alert
dispositions, and repository settings changes remain pending.

## Verified baseline

- Repository: [lukegob10/alpha](https://github.com/lukegob10/alpha), default branch `main`.
- Local checkout and latest main-branch CodeQL analysis both cover commit
  `3b8671eb9b4bf93f9221dc410f49f5303b3b708a`.
- CodeQL analysis `1951318768`, completed **2026-10-14 12:43:24 UTC**, used CodeQL **2.27.2**, 87 rules, and reported
  **32 open alerts: 6 high and 26 medium**. The workflow is
  [codeql.yml](../.github/workflows/codeql.yml), with JavaScript/TypeScript analysis on pushes, pull requests, and a weekly
  schedule. The `security-extended` query configuration is currently commented out.
- GitHub contains **no Issues and no open pull requests** for this repository. The actionable findings are in
  [code scanning](https://github.com/lukegob10/alpha/security/code-scanning) and
  [secret scanning](https://github.com/lukegob10/alpha/security/secret-scanning).
- Secret scanning has **one open Google API Key alert**, marked publicly leaked with unknown validity. Secret scanning
  and push protection are enabled; this alert was not recorded as a push-protection bypass.
- The Dependabot endpoint returned `403: Dependabot alerts are disabled for this repository`. Repository metadata also
  reports Dependabot security updates disabled. Dependency exposure is therefore **unassessed**, rather than zero.
  Historical Dependabot pull requests are closed or merged and are not a current vulnerability inventory.
- The active `protect-main` ruleset (`16181755`) requires pull requests and prevents deletion and non-fast-forward
  updates. Its effective rules do **not** require status checks, code-scanning results, or approving reviews. Classic
  branch protection is absent; the ruleset is the current protection mechanism.
- Nine other CodeQL alerts are already `fixed`: 2, 3, 4, 6, 11, 12, 15, 16, and 20. Keep those closed.

## Finding inventory

CodeQL numbers in this table refer to Security alerts, not GitHub Issues. Source links identify the owning files at the
reviewed checkout; line numbers in GitHub alerts identify the analyzed locations.

| Finding                           | GitHub alerts                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Count and scanner severity | Owning code                                                                                                           | Assessment and proposed disposition                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Google credential pattern         | [Secret 1](https://github.com/lukegob10/alpha/security/secret-scanning/1)                                                                                                                                                                                                                                                                                                                                                                                                                  | 1 secret alert             | [SubagentContextCapture.spec.ts](../src/core/agent/__tests__/SubagentContextCapture.spec.ts)                          | Strong evidence of a synthetic test value. Confirm provenance, preserve redaction coverage, then resolve as `used_in_tests`.               |
| Polynomial ticket regex           | [10](https://github.com/lukegob10/alpha/security/code-scanning/10)                                                                                                                                                                                                                                                                                                                                                                                                                         | 1 high                     | [ticket.ts](../packages/types/src/ticket.ts)                                                                          | Reproduced excessive backtracking. Fix the exported normalizer and its consumers.                                                          |
| HTML insertion from messages      | [14](https://github.com/lukegob10/alpha/security/code-scanning/14)                                                                                                                                                                                                                                                                                                                                                                                                                         | 1 high                     | [viewer.js](../webview-ui/public/html-document/viewer.js), [host viewer](../src/core/webview/html-document/viewer.ts) | Host sanitization exists. Verify the complete boundary before deciding between a fix and a documented false positive.                      |
| Certificate verification disabled | [7](https://github.com/lukegob10/alpha/security/code-scanning/7)                                                                                                                                                                                                                                                                                                                                                                                                                           | 1 high                     | [networkProxy.ts](../src/utils/networkProxy.ts)                                                                       | Development-only opt-in, but the override affects the shared process. Replace with trusted CA configuration.                               |
| Mention space escaping            | [1](https://github.com/lukegob10/alpha/security/code-scanning/1)                                                                                                                                                                                                                                                                                                                                                                                                                           | 1 high                     | [path-mentions.ts](../webview-ui/src/utils/path-mentions.ts), [shared grammar](../src/shared/context-mentions.ts)     | Format escaping rather than a proven injection sink. Verify round trips and retain legacy mention readability.                             |
| Windows cleanup shell             | [5](https://github.com/lukegob10/alpha/security/code-scanning/5), [8](https://github.com/lukegob10/alpha/security/code-scanning/8), [9](https://github.com/lukegob10/alpha/security/code-scanning/9)                                                                                                                                                                                                                                                                                       | 3 medium                   | [esbuild.ts](../packages/build/src/esbuild.ts)                                                                        | All three reach the same interpolated `attrib` shell command in the final cleanup fallback. Fix that sink once.                            |
| Rich-document command quoting     | [21](https://github.com/lukegob10/alpha/security/code-scanning/21)                                                                                                                                                                                                                                                                                                                                                                                                                         | 1 high                     | [rich-documents.test.ts](../apps/vscode-e2e/src/suite/rich-documents.test.ts)                                         | A file path is embedded inside both JavaScript and shell syntax. Remove the manual quoting while retaining the fixture's command coverage. |
| Generated verifier escaping       | [13](https://github.com/lukegob10/alpha/security/code-scanning/13)                                                                                                                                                                                                                                                                                                                                                                                                                         | 1 high                     | [managed-agent-live-playbook-preflight.mjs](../scripts/certification/managed-agent-live-playbook-preflight.mjs)       | Only the first newline is escaped. Current input is a fixed one-newline fixture; remove the brittle source-construction pattern.           |
| Request-input browser probes      | [39](https://github.com/lukegob10/alpha/security/code-scanning/39), [40](https://github.com/lukegob10/alpha/security/code-scanning/40), [41](https://github.com/lukegob10/alpha/security/code-scanning/41), [42](https://github.com/lukegob10/alpha/security/code-scanning/42)                                                                                                                                                                                                             | 4 medium                   | [renderedRequestUserInput.ts](../apps/vscode-e2e/src/ui/renderedRequestUserInput.ts)                                  | Migrate dynamic values to CDP arguments.                                                                                                   |
| Acceptance browser probes         | [37](https://github.com/lukegob10/alpha/security/code-scanning/37), [38](https://github.com/lukegob10/alpha/security/code-scanning/38)                                                                                                                                                                                                                                                                                                                                                     | 2 medium                   | [renderedAcceptance.ts](../apps/vscode-e2e/src/ui/renderedAcceptance.ts)                                              | Preserve deadline, cancellation, paint-frame, and input-release behavior during migration.                                                 |
| Composer browser probes           | [36](https://github.com/lukegob10/alpha/security/code-scanning/36)                                                                                                                                                                                                                                                                                                                                                                                                                         | 1 medium                   | [renderedComposer.ts](../apps/vscode-e2e/src/ui/renderedComposer.ts)                                                  | Migrate dynamic values to CDP arguments.                                                                                                   |
| Reasoning browser probes          | [17](https://github.com/lukegob10/alpha/security/code-scanning/17), [18](https://github.com/lukegob10/alpha/security/code-scanning/18), [19](https://github.com/lukegob10/alpha/security/code-scanning/19)                                                                                                                                                                                                                                                                                 | 3 medium                   | [renderedReasoning.ts](../apps/vscode-e2e/src/ui/renderedReasoning.ts)                                                | Migrate dynamic values to CDP arguments.                                                                                                   |
| History browser probes            | [22](https://github.com/lukegob10/alpha/security/code-scanning/22), [28](https://github.com/lukegob10/alpha/security/code-scanning/28), [30](https://github.com/lukegob10/alpha/security/code-scanning/30), [31](https://github.com/lukegob10/alpha/security/code-scanning/31), [32](https://github.com/lukegob10/alpha/security/code-scanning/32), [33](https://github.com/lukegob10/alpha/security/code-scanning/33), [34](https://github.com/lukegob10/alpha/security/code-scanning/34) | 7 medium                   | [runHistoryUi.ts](../apps/vscode-e2e/src/runHistoryUi.ts)                                                             | Migrate values and navigation-probe inputs without changing measurement timing.                                                            |
| Navigation browser probes         | [29](https://github.com/lukegob10/alpha/security/code-scanning/29)                                                                                                                                                                                                                                                                                                                                                                                                                         | 1 medium                   | [runTaskNavigationUi.ts](../apps/vscode-e2e/src/runTaskNavigationUi.ts)                                               | Migrate dynamic values to CDP arguments.                                                                                                   |
| Ticket browser probes             | [23](https://github.com/lukegob10/alpha/security/code-scanning/23), [24](https://github.com/lukegob10/alpha/security/code-scanning/24), [25](https://github.com/lukegob10/alpha/security/code-scanning/25), [26](https://github.com/lukegob10/alpha/security/code-scanning/26), [27](https://github.com/lukegob10/alpha/security/code-scanning/27)                                                                                                                                         | 5 medium                   | [runTicketsUi.ts](../apps/vscode-e2e/src/runTicketsUi.ts)                                                             | Migrate dynamic values to CDP arguments.                                                                                                   |

The browser-probe group accounts for **23 of 32 CodeQL alerts**. Those run against an owned test Electron instance through
loopback CDP. The CodeQL rule flags JavaScript construction using `JSON.stringify`, including contexts where HTML
`script` termination matters; these findings do not by themselves establish shipped-extension code execution.
Removing data interpolation gives the helpers a clearer contract and avoids relying on that contextual distinction.
[CodeQL query guidance](https://codeql.github.com/codeql-query-help/javascript/js-bad-code-sanitization/).

## Remediation sequence

### Initial secret disposition and dependency visibility

Owner: repository maintainer. Start this triage before merging remediation code.

Secret alert 1 points to line 538 of
[historical commit 59f0598](https://github.com/lukegob10/alpha/blob/59f059853009cd7b1d7eb0bfb39982ec2f6e12db/src/core/agent/__tests__/SubagentContextCapture.spec.ts#L538).
Its Google-shaped value matches the current alphabet-and-digit synthetic fixture in the test
`redacts credentials from inherited conversation evidence`. The historical file contains one matching Google-key
pattern. No key value needs to be copied into a report or tested against a provider.

1. Confirm the fixture was generated for this test and never represents an issued credential. Unknown validity is not
   evidence of revocation. If it is an issued credential, revoke/rotate it and review provider usage before closing the
   alert. [GitHub validity guidance](https://docs.github.com/en/code-security/tutorials/remediate-leaked-secrets/evaluating-alerts).
2. Construct the synthetic value at test runtime with a clearly named fixture helper. Keep the runtime shape and the
   assertion that it is removed from inherited context. Do not weaken the redactor to silence scanning.
3. Record the test provenance and resolve this specific alert as `used_in_tests` after the fixture change is verified.
   Preserve history; rewriting the repository is unnecessary for a confirmed synthetic fixture.
4. Enable Dependabot alerts and security updates for this repository, inventory the resulting advisories against the
   current `pnpm-lock.yaml`, and prioritize shipped/reachable critical or high dependencies. Keep unrelated major-version
   upgrades separate. [GitHub configuration guidance](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configure-dependabot-alerts).

Acceptance: the secret alert has a recorded disposition; the redaction regression still passes; dependency alerts are
available with assigned remediation owners. Newly discovered dependency findings require their own scoped patches.

### PR 1 Bound ticket-reference parsing

Priority: P1. Owner: shared types, with ticket-store and webview consumers. Alert: 10.

The normalizer has adjacent `\s*` groups around an optional separator. Invalid whitespace-heavy strings cause excessive
backtracking. `ticketLocatorSchema` bounds some inputs, but `normalizeTicketReference` is also called directly by
`useTicketSearch`, `TicketStore`, and mention processing. Fixing only the schema leaves those paths exposed.

- Bound the trimmed candidate to the existing locator limit of 80 characters inside the exported helper and replace
  the ambiguous matching with linear parsing or non-overlapping bounded branches.
- Preserve `PM-01`, `pm1`, `PM #1`, and `PM number 1`, uppercase normalization, zero rejection, and path rejection.
  Preserve legacy leading/trailing whitespace handling within the normalized contract.
- Add direct-helper regressions for long tabs/spaces, trailing non-digits, mixed whitespace, and digit limits. Exercise
  ticket search and saved-ticket readers, not only Zod validation.
- Re-run the baseline below after the fix. Use a generous timeout or isolated-process check for regression coverage;
  avoid a brittle millisecond assertion in the ordinary unit suite.

Acceptance: all existing valid reference forms remain usable, long invalid candidates are rejected before ambiguous
matching, and CodeQL no longer reports alert 10. Bounding inputs and removing regex ambiguity follow
[CodeQL ReDoS guidance](https://codeql.github.com/codeql-query-help/javascript/js-polynomial-redos/).

### PR 2 Verify and harden the HTML viewer boundary

Priority: P1. Owner: extension-side HTML document adapter and packaged viewer. Alert: 14.

CodeQL traces `event.data.html` into `content.innerHTML`. The real host pipeline is `DocumentParser` →
`sanitizeDocument` → `hydrateDocumentImages` → authenticated document message. The sanitizer reconstructs an allowlist;
the viewer checks document ID, a random token, and revision. The CSP disallows authored scripts and remote connections.
These protections are relevant evidence, but a token and CSP do not replace sanitization.

- Add adversarial tests through the complete pipeline, including browser reparsing after image hydration. Cover event
  handlers, script/SVG/MathML/template content, malformed nesting, `javascript:` and command URLs, dangerous attributes,
  and image alt text. Assert the resulting DOM contains no executable content or unintended external resource URLs.
- Extend message-boundary tests for wrong token, wrong document, stale revision, malformed fields, and bounded payloads.
  Size validation must account for host-hydrated raster data; the 512 KiB source limit is not the final message limit.
- Keep sanitization in the existing host adapter. Fix any bypass there and test the packaged viewer. Avoid introducing
  an independent rendering policy or adding a new sanitizer dependency merely to satisfy the scanner.
- If the complete pipeline proves safe, document the exact producer, sanitizer, hydration, authentication, and sink
  chain and dismiss alert 14 as a reviewed false positive. Otherwise keep it open until the bypass is fixed. A cast,
  branding type, or suppression comment is insufficient evidence.
- Preserve filters, disclosures, scroll and focus restoration, reload behavior, scoped images, and source-link policy.

Acceptance: hostile authored HTML is harmless after the actual host-to-browser path, valid documents retain their
behavior, and alert 14 is fixed or has a defensible recorded dismissal. Keep CSP and input sanitization together as
required by [VS Code webview security guidance](https://code.visualstudio.com/api/extension-guides/webview#security),
retrieved 2026-10-14; verify runtime behavior on exact VS Code 1.125.0.

### PR 3 Replace global TLS bypasses with trusted CA setup

Priority: P2 because production activation exits before this debug-only feature. Owner: network adapter. Alert: 7.

`applyTlsVerificationOverride` sets `NODE_TLS_REJECT_UNAUTHORIZED=0`; the Undici proxy also disables verification for
request and proxy TLS. This is intentional development behavior, but the environment override affects the shared
extension-host process. Existing `lgtm` comments have not resolved the alert.

- Remove the process-wide verification override and both `rejectUnauthorized: false` branches.
- Document trusted local proxy CA setup for the dedicated development host. Verify the trust mechanism in exact
  VS Code 1.125.0 and for both native HTTP clients and Undici. Node's `NODE_EXTRA_CA_CERTS` must be supplied before process
  launch; assigning it at runtime is ineffective. [Node 24.21.0 CA configuration](https://nodejs.org/download/release/v24.21.0/docs/api/cli.html#node_extra_ca_certsfile).
- Read the legacy `alpha.debugProxy.tlsInsecure` setting compatibly, deprecate it, and fail closed with an English
  migration message. Update the extension manifest, NLS description, and proxy tests together. This deliberately changes
  the old development workflow: inspection requires trusting the CA rather than disabling validation.
- Test trusted and untrusted local certificates, production/test mode, reconfiguration, disable, disposal, and ownership
  of global fetch/dispatcher changes. Preserve proxy URL redaction.

Acceptance: Alpha never turns off TLS verification, debug inspection works with an explicitly trusted CA, and alert 7 is
fixed. Do not claim that production users were already subject to this debug-only override.

### PR 4 Remove the Windows cleanup shell sink

Priority: P2. Owner: build package. Alerts: 5, 8, and 9.

Replace the final `execSync` fallback with an argument-based executable invocation, such as `execFileSync` with a
separate `attrib` argument array, `shell: false`, and `windowsHide: true`. Keep arguments unquoted at the API boundary.
Validate the cleanup target against the intended output directory before recursive operations, including traversal and
symlink escape cases. Preserve legitimate callers, retry limits, and actionable final errors.

Add tests that force the Windows fallback and verify paths with spaces, ampersands, percent signs, and Unicode remain
one argument and cannot execute commands. Include a Windows filesystem smoke check and a non-Windows build regression.
Node distinguishes direct executable arguments from shell command strings in its
[24.21.0 child-process contract](https://nodejs.org/download/release/v24.21.0/docs/api/child_process.html#child_processexecfilesyncfile-args-options).

Acceptance: all three alerts disappear from the same sink change; cleanup stays within its intended output tree; bundle
and VSIX contents remain correct. Do not attempt separate escaping patches at `copyPaths` line 130.

### PR 5 Make mention formatting round trips explicit

Priority: P2. Owner: shared mention grammar and webview encoder. Alert: 1.

`escapeSpaces` only inserts the mention grammar's backslash-space sequence; it is not used as an HTML or JavaScript
sanitizer. The shared decoder only removes that sequence, and the grammar does not generally accept literal backslashes.
Blindly doubling backslashes in the encoder would change behavior without fixing the readers.

- Add encoder → grammar → decoder tests for repeated spaces, literal backslashes, mixed raw/escaped input, trailing
  backslashes, Windows drive/UNC paths, and POSIX filenames. Keep raw paths distinct from already formatted mentions.
- Fix any demonstrated round-trip defect in the shared codec and update all encoder/decoder consumers in the same PR.
  Retain readers for legacy `\ ` mentions; preserve workspace containment and `.alphaignore` checks.
- If the existing format is correct for its supported input contract and there is no security sink, document that
  contract and resolve the generic escaping warning as a false positive instead of changing saved-path semantics.

Acceptance: existing saved mentions remain readable; newly supported paths round-trip correctly; alert 1 has an
evidence-backed disposition. Incomplete escaping can cause correctness errors even outside a security sink, as described
by [CodeQL](https://codeql.github.com/codeql-query-help/javascript/js-incomplete-sanitization/).

### PR 6 Pass browser-test values as data

Priority: P2. Owner: VS Code E2E adapters and certification fixtures. Alerts: the 23 browser probes, 21, and 13.

- Extend the existing CDP test abstraction with static function declarations and serialized arguments through
  `Runtime.callFunctionOn`. Pass selectors, labels, text, task IDs, and metrics as argument values. Do not pass a dynamic
  expression to `eval` inside that function. The protocol supports argument values, awaited promises, and returned JSON
  values. [CDP Runtime contract](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-callFunctionOn),
  retrieved 2026-10-14; test the supported subset against the Chromium shipped with VS Code 1.125.0.
- Migrate all seven flagged adapters to that abstraction. Keep trusted script bodies static, preserve the owned
  loopback transport, bounded pending requests, cancellation, timeouts, and exception reporting. Release remote handles
  and reacquire them across reload or target changes if the adapter uses object IDs.
- Preserve acceptance controls' controlled paint frames, native keyboard/mouse input, balanced press/release cleanup,
  and history/navigation timing. Update their existing deterministic tests to exercise the new protocol boundary.
- For alert 21, retain scripted `exec_command` coverage but remove manual JavaScript/shell quoting of the path. A bounded
  UTF-8 path encoded with a fixed base64 alphabet and decoded by static Node code is one narrow option for this fixture.
  Test apostrophes, dollar signs, backticks, Unicode, and platform-specific path cases without executing hostile text.
  `JSON.stringify` alone does not quote a shell argument.
- For alert 13, keep verifier code static and supply baseline fixture content as data, or use complete serialization of
  the fixed fixture with a tested source-literal contract. Remove the first-occurrence newline replacement and cover
  repeated newlines, CRLF, quotes, and backslashes.

Acceptance: all 25 alerts in this PR are fixed without disabling test-tree scanning; scripted UI scenarios still exercise
the real extension and original acceptance semantics. Extend existing adapters rather than adding a parallel browser
automation engine.

### Require security validation before merge

Owner: repository maintainer. Apply after required checks are demonstrated reliable; dependency-alert visibility can
be restored immediately during initial triage.

- Extend `protect-main` with required CI and CodeQL checks and a code-scanning merge rule that blocks new high/critical
  findings, using the actual check names and supported repository rules. Review bypass permissions explicitly.
- Keep analysis coverage for developer tools, scripts, and webview assets. Do not exclude the test tree or disable rules
  to reduce alert counts.
- Evaluate `security-extended` on a pull request with a recorded baseline, then adopt it once the additional findings
  have been triaged. Pin security workflow actions to reviewed full commit SHAs while retaining their intended versions
  and least-privilege job permissions.
- Keep secret-scanning push protection enabled. Require a specific evidence record for each false-positive/test-fixture
  resolution and each future bypass.
- Use Dependabot security updates with normal PR review and pnpm lockfile validation. Version-update batching is a
  separate maintenance choice; reopening old dependency PRs is not a remediation strategy.

## Validation and closure

Each implementation PR starts with a failing behavioral regression where a bug is confirmed. Run focused tests, then
the affected typechecks. These commands are acceptance gates for future implementation, not recorded passing results.

| Change                    | Focused coverage and required gates                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synthetic fixture         | `pnpm --dir src test core/agent/__tests__/SubagentContextCapture.spec.ts`; `pnpm --dir src check-types`                                                                                                                                                                                                                                                 |
| Ticket parser             | `pnpm --filter @alpha-code/types test src/__tests__/ticket.test.ts`; types typecheck; `TicketStore`/search tests; webview `useTicketSearch` tests; affected src/webview typechecks                                                                                                                                                                      |
| HTML viewer               | `pnpm --dir src test core/webview/html-document/__tests__/sanitize.spec.ts core/webview/html-document/__tests__/images.spec.ts core/webview/html-document/__tests__/viewer.spec.ts core/webview/html-document/__tests__/bundledExamples.spec.ts`; `pnpm --dir webview-ui test src/utils/__tests__/html-document-viewer.spec.ts`; src/webview typechecks |
| Debug TLS                 | `pnpm --dir src test utils/__tests__/networkProxy.spec.ts`; local TLS fixture coverage; `pnpm --dir src check-types`                                                                                                                                                                                                                                    |
| Build cleanup             | Build-package tests for the cleanup fallback; `pnpm --filter @alpha-code/build test`; `pnpm --filter @alpha-code/build check-types`; Windows cleanup smoke; `pnpm bundle`; `pnpm vsix`; `node scripts/verify-vsix-contents.mjs <path-to-vsix>`                                                                                                          |
| Mention codec             | `pnpm --dir webview-ui test src/utils/__tests__/path-mentions.spec.ts src/utils/__tests__/context-mentions.spec.ts`; `pnpm --dir src test shared/__tests__/context-mentions.spec.ts`; affected mention-resolution tests; src/webview typechecks                                                                                                         |
| CDP adapters and fixtures | `pnpm --filter @alpha-code/vscode-e2e test:unit`; E2E typecheck; deterministic argument/exception/cancellation tests; the affected composer, reasoning, request-input, history, navigation, and tickets UI scripts from the E2E manifest                                                                                                                |
| Preflight verifier        | Focused Node fixture tests; `pnpm certify:managed-agents:live-preflight` in a controlled workspace                                                                                                                                                                                                                                                      |

Run `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` for the runtime, UI, command, contribution, and packaging
changes. Also run the exact-host HTML and rich-document scenarios for viewer/fixture changes. If exact-host validation
cannot run, record that gap explicitly and retain the requirement. No managed-agent execution contract is intended to
change; add `pnpm certify:managed-agents:automated` if an implementation changes that contract.

Before closure:

1. Run affected lint/typechecks and review the diff for scope, generated files, secrets, and lockfile churn.
2. Require a successful CodeQL analysis of the remediation commit and then the merged `main` commit. A green analysis
   job alone is insufficient; verify each original alert's `fixed` state or its reviewed dismissal record.
3. Account for all 32 original CodeQL alerts and the one secret alert, including findings renamed or relocated by the
   scanner. Record any new alerts and dependency advisories with explicit owners and follow-up scope.
4. Verify there are no open confirmed high/critical vulnerabilities in the remediated scope, no untriaged original
   findings, and no blanket suppressions. False-positive resolutions require concrete evidence; confirmed bugs require
   fixes.

## Ticket regex reproduction

The baseline used the exact regex extracted from `ticket.ts`, one call per size, on Windows with Node **24.21.0**.
Inputs were `PM` followed by tabs and a trailing `!`, which prevents trimming away the adversarial whitespace.

| Tabs   | Rejected | Elapsed milliseconds |
| ------ | -------- | -------------------- |
| 512    | Yes      | 1.522                |
| 2,048  | Yes      | 2.381                |
| 8,192  | Yes      | 37.045               |
| 16,384 | Yes      | 152.049              |

This is a focused reproduction of backtracking cost, not a production latency benchmark. Repeat on the same runtime and
workload after the fix; warm-up and multiple samples are required for a performance claim.

From the repository root, run the following JavaScript through Node, for example by piping a PowerShell single-quoted
here-string into `node`:

```js
const fs = require("node:fs")
const { performance } = require("node:perf_hooks")
const source = fs.readFileSync("packages/types/src/ticket.ts", "utf8")
const pattern = source.match(/const match = (\/.*\/i)\.exec/)[1]
const expression = new RegExp(pattern.slice(1, -2), "i")
for (const tabCount of [512, 2048, 8192, 16384]) {
	const value = "PM" + "\t".repeat(tabCount) + "!"
	const start = performance.now()
	const rejected = expression.exec(value.trim()) === null
	console.log({ tabCount, rejected, elapsedMs: performance.now() - start })
}
```

For after-fix measurements, call the exported normalizer rather than extracting a regex that may have been removed.

## Implementation ledger

The remediation is implemented on `codex/security-and-project-ticket-search`. Default-branch alert closure still depends
on merging and scanning that branch. No original CodeQL query, test directory, or security boundary is suppressed.

- Ticket references have an 80-character bound and an unambiguous separator expression. The original adversarial
  16,384-tab input now returns `undefined` without regex backtracking. Twenty calls per size on Node 24.21.0 recorded
  sub-0.001 ms medians; these microsecond samples demonstrate bounded behavior, not a reliable speed ratio.
- HTML previews retain the host allowlist and sanitize again with DOMPurify at the browser insertion boundary. The
  shared tag/attribute profile permits only host-generated image and reference attributes; authored scripts, handlers,
  external image URLs, and command URLs remain forbidden. Oversized messages fail closed. DOMPurify is a deliberate new
  direct webview dependency, and its built asset is required by the VSIX verifier.
- The legacy insecure debug-proxy setting remains readable but is deprecated and cannot disable TLS verification.
  Configure the inspection proxy's CA before launching VS Code; Node reads `NODE_EXTRA_CA_CERTS` at process startup.
- Build cleanup invokes `attrib.exe` with separate arguments and no shell. Copy destinations must remain descendants
  of the output directory and cannot traverse symlink aliases. A forced Windows retry test covers metacharacter paths.
- Mention encoding now round-trips literal backslashes and spaces while reading legacy escaped-space mentions. POSIX
  backslashes remain filename characters; Windows drive/UNC paths retain separator normalization.
- Browser test probes use one shared script-safe JSON literal encoder. This is a smaller change than the planned CDP
  `callFunctionOn` migration and preserves the probes' existing call, cancellation, and assertion behavior. Quotes,
  control characters, script terminators, Unicode separators, and structured values have round-trip tests.
- Generated rich-document/preflight path and baseline strings use UTF-8 base64 transport rather than partial escaping.
- Secret-scanning alert [#1](https://github.com/lukegob10/alpha/security/secret-scanning/1) is resolved as `used_in_tests`.
  Its sole historical location contains an explicit sequential alphabet/digit redaction fixture, never a credential
  issued by Google. Constructing the same synthetic fixture from fragments retains redaction coverage.
- Dependabot alerts and automated security fixes are enabled. CodeQL actions are pinned to verified full commit SHAs.
- The existing `protect-main` ruleset now requires the nine observed PR check names and CodeQL results at all severity
  levels. Its default-branch scope, no-bypass policy, deletion/history protections, and existing review rules are
  preserved. Push-only `release-vsix` is deliberately excluded from PR requirements because it cannot run before merge.

### Dependency remediation

Enabling Dependabot exposed additional retained dependency advisories. Production and tooling dependency floors are
updated deliberately in the manifests, `pnpm-workspace.yaml`, and `pnpm-lock.yaml`. Major-sensitive overrides retain
compatible APIs, including separate brace-expansion and minimatch majors and CommonJS-compatible UUID 11.

Vitest 4.1.11 is required by [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9); Vitest 3.2.6 fixes
the older UI-server advisory but does not fix the current mocker file-read advisory. The migration explicitly declares
Node types, confines package test discovery to source files, restores reused spies between tests, and makes constructor
mocks constructable. It does not relax test expectations or change extension lifecycle behavior.

Simple Git 4 uses its named `simpleGit` export. The MCP SDK update exposes `resource_link` in its result type; Alpha's
shared contract now preserves the link metadata as tool-result text without fetching its URI. Current Codex CLI source
at `0fd85b075288c4fee50f0df3e4e4f98f80c693fe`, `codex-rs/core/src/mcp_tool_call.rs`, preserves non-image/audio blocks with
`block.clone()`; Alpha's text projection follows that behavior within its existing result and policy boundaries.

Two advisories have no published upstream fixed release. They have tracked local pnpm patches and five executable
regressions in `scripts/dependency-security.test.mjs`:

| Dependency       | Local mitigation                                                                                                                                                          | Remaining scanner limitation                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| braces 3.0.3     | Parser and direct AST walkers reject nesting at a bounded depth of 128; ordinary workspace globs retain their results.                                                    | Version-only audits still report [GHSA-braces advisory](https://github.com/micromatch/braces/issues/70).   |
| sprintf-js 1.1.3 | Numeric precision is clamped to ECMAScript's 0–100 range, with a minimum of 1 for precision formatting. All document-parser/logger callers resolve the patched formatter. | Version-only audits still report [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c). |

`pnpm audit --json` now reports only these two locally patched versions: one high and one moderate. It reports zero
critical advisories and zero remaining advisories with an available upstream fixed version. There are no audit ignores,
fabricated package versions, or blanket GitHub dismissals. Replace the local patches with official fixed releases when
they become available.

### Project ticket lookup

Chat suggestions now find exact ticket numbers (with optional `#`), references, UUIDs, and titles only in the requesting conversation's project. Editor chats carry
their task ID, and an unknown task ID fails closed instead of falling back to the foreground project. The ticket editor's
full-text list still searches descriptions and context.

The existing bounded search cache now retains a watcher-invalidated project snapshot across keystrokes. It skips repeated
per-ticket metadata scans when unchanged, shares in-flight refreshes, and refreshes external edits, moves, and deletions.
Every lookup still revalidates directory protections and pending transactions. Caches remain limited to four projects,
10,000 records/16 MiB per project, with 16-file read batches, LRU watcher disposal, and extension-unload cleanup. A watcher
failure uses the original per-query inspection path. Suggestions remain limited to 50, and title-query debounce is 50 ms.
An externally malformed, oversized, or non-file ticket evicts its earlier search record during refresh, allowing the
remaining valid project records to return to the warm snapshot. A regression reproduced the unwanted Markdown reread
before the fix; 64 focused ticket-store/search/cancellation/recovery tests and the extension typecheck pass afterward.

Current Codex CLI file-search source at `0fd85b075288c4fee50f0df3e4e4f98f80c693fe` was checked on 2026-10-14. Its reusable,
root-scoped search sessions and bounded results inform this change; native Alpha Tickets remain implemented in Alpha's
existing TypeScript store rather than a second search runtime.

The 1,000-ticket fixture uses the same queries and Markdown contents as the before-fix run:

| Run                     | Cold empty query | Warm `backend` | Warm `backend cleanup` | Warm exact `PRO-500` | Warm missing query | Markdown reads |
| ----------------------- | ---------------: | -------------: | ---------------------: | -------------------: | -----------------: | -------------: |
| Before, one observation |         776.6 ms |        79.0 ms |                51.5 ms |              51.2 ms |            53.5 ms |          1,000 |
| After, sample 1         |       1,041.2 ms |         9.7 ms |                 9.6 ms |               8.7 ms |             8.5 ms |          1,000 |
| After, sample 2         |         864.9 ms |         8.6 ms |                 7.8 ms |               7.5 ms |             7.7 ms |          1,000 |
| After, sample 3         |       1,034.5 ms |        10.3 ms |                 8.9 ms |               9.2 ms |             7.7 ms |          1,000 |

The three after-fix observations were taken on Windows/Node 24.21.0 during other validation work, so cold times are not
comparable enough to claim a cold-start improvement. Warm lookup medians are 9.7/8.9/8.7/7.7 ms, with no Markdown rereads.
The deterministic regression additionally verifies that metadata-call count no longer scales with every project ticket
on each keystroke. To reproduce, set `ALPHA_TICKET_SEARCH_BENCHMARK=1` and run:

```sh
pnpm --dir src test services/tickets/__tests__/TicketStore.search.spec.ts --testNamePattern "measures a 1,000-ticket typing workload" --maxWorkers=1 --no-silent
```

### Validation and closure evidence

Passed: all workspace typechecks; extension-focused lint; knip; 15,484 extension/shared/webview unit tests (34 declared
skips retained); 222 repository tooling tests; 592 host-runner
unit tests; offline evaluator suites (384 unit, 20 contract, 5 certification); focused security/search tests; dependency
patch regressions; and Windows managed-agent preflight. Packaging produced `bin/alpha-3.1.12.vsix`; the verifier confirmed
1,676 entries, all required assets including DOMPurify, no packaged `.env` file, and 16 document assets matching source
bytes. The full local unit command was `pnpm test --env-mode=loose --concurrency=2` with `VITEST_MAX_WORKERS=2`, which
passes the worker limit through Turborepo. The final CI pass is being finalized.

CodeQL analysis [1954688717](https://github.com/lukegob10/alpha/actions/runs/38629894733), on PR #145's merge commit
`32632739235550762bfdbcd0d09bca4559fd8182` (head `2183a495b`), completed with CodeQL 2.27.2, 87 rules, zero results, and no
analysis error. The PR ref returned zero alerts; `main` still returned the original 32 open alerts pending merge. Open
secret-scanning alerts are zero. Confirm zero findings again on the final head and merged `main`.

The broader security upgrade exposed mock compatibility in 16 unit-test files. All 720 focused tests now pass after
constructable mock updates, explicit reset of module-mock implementations, and assertions on stable SDK error paths and
opaque bytes. Test expectations for policy, cancellation, persistence, and replay remain enforced. The initial macOS CI
install also hit GitHub's unauthenticated API limit in the existing ripgrep installer; the setup action now supplies its
supported `GITHUB_TOKEN` only during installation/rebuild. The installer strips authorization on non-GitHub redirects.

The exact `pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` gate was attempted locally. After fixing the transitive
module compatibility error, VS Code 1.125.0 itself refused to launch because the Windows `vscode-updating` mutex remained
held after its 30-second wait. The runner correctly retained a blocked receipt (`host-preflight-missing`); no other host
version was substituted. The clean GitHub runner passed the exact smoke, HTML-document extended coverage, and independently
asserted task outcomes on [the first remediation head](https://github.com/lukegob10/alpha/actions/runs/38629895246/job/116078526385).
Its evidence matrix marked all three lanes `executed-pass` with exact VS Code 1.125.0 and zero pending tests. The final head
must pass again before merge. The existing extended gate now also requires `rich-documents.test`, with the canonical
evidence inventory updated together; this verifies the changed document parser dependencies and generated read command
on the same exact host.
