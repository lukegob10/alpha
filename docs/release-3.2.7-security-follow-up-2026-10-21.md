# Alpha 3.2.7 dependency security follow-up

GitHub refreshed the dependency scan after the release preparation merge on October 21, 2026. The new scan included
runtime redirect vulnerabilities, so publication was held while the affected dependency floors were updated.
This work is separate from the intermittent custom-tool catalog investigation.

## Scope and primary evidence

| Dependency                  | Before | After  | Applicable surface                                                                      |
| --------------------------- | ------ | ------ | --------------------------------------------------------------------------------------- |
| `@modelcontextprotocol/sdk` | 1.31.0 | 1.32.0 | Alpha's Streamable HTTP and SSE clients, including the custom EventSource fetch adapter |
| `follow-redirects`          | 1.16.0 | 1.16.1 | The retained Axios dependency and developer publication tooling                         |
| `markdown-it`               | 14.3.1 | 14.3.3 | VSIX/publication tooling; no extension-runtime import was found                         |
| `vite`                      | 6.4.3  | 6.4.4  | Development/build tooling; Vite's dev server is not part of the installed extension     |

The extension and webview manifests and the shared `pnpm-workspace.yaml` floors agree. No new production dependency or
dependency major was introduced. The lockfile was resolved with pnpm 11.24.0 and then installed with
`pnpm install --frozen-lockfile --ignore-scripts`. Pnpm also reused/deduplicated already-locked HTTP/parser and file-glob
transitives in the affected graph; the final lockfile diff must be reviewed with the release.

The MCP advisory [GHSA-6prh-2h8m-c8cw](https://github.com/advisories/GHSA-6prh-2h8m-c8cw) applies to HTTP client
transports. Previously, a foreign redirect could receive custom credential headers, session IDs, and, for method-preserving
redirects, request bodies. Alpha uses both affected transports and supplies custom headers. The fixed SDK's default is
same-origin redirect handling. The [pinned SDK source](https://github.com/modelcontextprotocol/typescript-sdk/tree/32549b00a9a808265f35a29f92fdf27fa4aac2ef)
was inspected on October 21, 2026, including `src/client/sse.ts`: its protection wraps the custom EventSource fetch path as
well as the default fetch path. Alpha does not enable the insecure `redirectPolicy: "follow"` compatibility option.

The same SDK release addresses server-side advisories
[GHSA-22jm-h49p-29qw](https://github.com/advisories/GHSA-22jm-h49p-29qw),
[GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453), and
[GHSA-rvq5-wwqv-78pq](https://github.com/advisories/GHSA-rvq5-wwqv-78pq). Their presence in a runtime dependency is not
evidence that Alpha exposes those server endpoints.

The redirect dependency fixes
[array-form credential headers](https://github.com/advisories/GHSA-q3jh-wrc6-jgq8) and
[metacharacters in declared sensitive header names](https://github.com/advisories/GHSA-8r9p-f939-6h3c).
The npm release identifies upstream commit `46301256333c90b7faac7aa126effe72ec16d16e`. The regressions exercise the actual
dependency resolved through Axios, rather than copying its filtering implementation. Alpha's ordinary Axios calls do not
establish reachability of every vulnerable option combination; the dependency floor protects retained consumers.

Development fixes cover Vite's launch-editor advisories
[GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm),
[GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv), and
[GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw), plus markdown-it's parser/rendering advisories
[GHSA-gfr2-rv44-r23c](https://github.com/advisories/GHSA-gfr2-rv44-r23c),
[GHSA-vfgh-jcmw-g37q](https://github.com/advisories/GHSA-vfgh-jcmw-g37q), and
[GHSA-r7fv-28h4-cvq7](https://github.com/advisories/GHSA-r7fv-28h4-cvq7). These are tooling updates, not claims that the
installed webview runs a Vite server or uses markdown-it to render chat content.

## Reproduction and validation

`scripts/dependency-redirect-security.test.mjs` uses ephemeral local HTTP servers and fake credentials. It verifies both
MCP transport paths refuse foreign redirects, preserves a legitimate same-origin 307 POST redirect, and checks both
array-form and metacharacter credentials in the real redirect dependency. Servers, connections, and transports are
explicitly closed. The tests make no external network requests.

- Before the dependency update: **four failed, one passed**. Failures demonstrated foreign MCP requests and forwarded
  redirect credentials; the same-origin compatibility control passed. An initial array-header fixture lacking a Host
  header was corrected before the retained failing reproduction.
- After the update: **all five passed**; the five existing dependency-security tests also passed (**10 total**).
- Existing MCP consumer coverage: **171 passed across four files**.
- Repository tooling: **293 passed**, including the five new regressions and webview build/preload coverage.
- Root type checks: **nine tasks passed**, all freshly executed.
- Frozen installation: **passed** with supply-chain policy validation and no dependency resolution step.
- Windows VSIX: **packaged and verified**, including 1,817 entries and 16 document assets matching source; installed
  successfully into an isolated VS Code **1.125.0** profile.
- Exact VS Code **1.138.0** smoke: **47 passed / 13 suites** with the updated dependencies.
- The additional local **1.125.0** compatibility run was **blocked before preflight** by VS Code's Windows update lock
  (`Code is currently being updated`); a running CodeSetup process confirmed the environmental blocker. Installation is
  not a substitute for this gate. Committed-source CI and release validation must run the exact minimum-host checks.

Logs are retained under the ignored `artifacts/harness/release-3.2.7/` directory. These focused results do not replace
final committed-source CI, exact-host compatibility, packaging, or public-download verification.

## Compatibility and limits

Configured MCP endpoints that intentionally redirect to another origin must use their final URL. Legitimate same-origin,
method-preserving redirects remain supported and are covered. No saved MCP configuration format, public Alpha API,
approval authority, execution policy, or host minimum changes.

Dependency alert counts are scanner observations, not an exploitability assessment or a zero-vulnerability certificate.
The retained `sprintf-js` precision patch and its tests are unchanged. The custom-tool intermittent hang needs its own
evidence and must not be declared fixed because the dependency updates passed.
