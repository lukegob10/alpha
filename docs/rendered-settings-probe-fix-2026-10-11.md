# Rendered settings probe click readiness — 2026-10-11

## Evidence and scope

This bounded fix starts exactly from `ceaa4c3c7efbd3edbfc77076a1b63c0b2d974e82`, in the fresh isolated managed worktree
`rendered-settings-probe-20261011` and branch `codex/rendered-settings-probe-20261011`. The earlier settings implementation
worktree and branch are preserved. Primary checkout files are not changed by this follow-up.

Three collaboration subagents participated: `contract_review` reproduced the failure at the driver boundary and owns the
focused regression tests; `agents_controls` owns the smallest probe fix; `approval_review` independently reviews source,
evidence, and the final change. The integrating lead owns dependency setup, ordinary typechecks, this note, and the commit.

The retained run has nonce `5734061f-d265-4a00-a12e-d0a902bb6925`. Its source log is
`F:/roo-fork/Alpha-Code/artifacts/cleanup-integrated-final-rendered-ceaa.log`; retained output is
`F:/alpha-e2e/cleanup-rendered-settings-final-20261011`; original evidence is
`C:/Users/Luke Goblirsch/AppData/Local/Temp/alpha-rendered-probe-gANi2p/evidence/ui-5734061f-d265-4a00-a12e-d0a902bb6925`.
The run used exact VS Code **1.125.0**, a scripted provider, a dedicated temporary workspace/profile, and the real built
webview. Host ownership and capture completed; the host exited. This follow-up inspects those artifacts read-only and
does not launch a replacement host.

`ui-failed-control.json` records this actual failed expression:

```js
d.querySelector(
	"[data-testid=settings-content] [data-testid=terminal-output-preview-size-dropdown]",
)?.textContent?.includes("Large (20KB)")
```

The failed screenshot shows Terminal's preview selector closed at **Medium (10KB)** and **Save disabled**. Both added
Agents basic/advanced captures had already succeeded, as had restoration of the original selected tab and Save state.
The probe never acknowledged `ui-done-settings-edit`. Consequently the fixture's later deliberate authoritative refresh
to `small` had not run; `ui_settings-edit_timeout` is a downstream host-barrier failure after `rendered_control_timeout`.
The retained evidence does not contain a pointer-hit trace, so it does not prove which animated rectangle received that
specific input.

## Owning contract and diagnosis

The affected owner is
[`renderedAcceptance.ts`](../apps/vscode-e2e/src/ui/renderedAcceptance.ts), called by the rendered UI campaign. Its host
partner is
[`managed-agents.acceptance.test.ts`](../apps/vscode-e2e/src/suite/managed-agents.acceptance.test.ts).
[`TerminalSettings`](../webview-ui/src/components/settings/TerminalSettings.tsx) receives the preview value from
SettingsView's `cachedState` and forwards selection through `setCachedStateField`. Tab changes affect presentation.
The host fixture independently checks that the rendered Large edit leaves authoritative Medium untouched, survives two
state pushes, supports Cancel, and Discards to the latest authoritative Small value. Those assertions are retained.

Two probe defects are established by source and controlled regressions:

1. `Runtime.evaluate` requested `returnByValue` but omitted `awaitPromise`. The existing double-animation-frame Promise
   therefore was not an awaited paint barrier. The official
   [CDP Runtime schema](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/js_protocol.json),
   retrieved **2026-10-11**, defines `awaitPromise` as awaiting the returned Promise's resolution.
2. `activate` accepted a positive-width node, then `click` scrolled and measured it immediately. That does not establish
   a stable, unobstructed pointer target. The native Select portal uses positioning and finite enter animations. Installed
   `@radix-ui/react-select` **2.2.4**, resolved by the frozen lockfile, selects mouse items on `pointerup`. A nonzero option
   rectangle is therefore insufficient evidence that the dispatched press/release will reach that option.

The official
[CDP Input schema](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json),
retrieved **2026-10-11**, defines mouse coordinates in the main frame's viewport CSS pixels. The fix retains that coordinate
space and the existing trusted `Input.dispatchMouseEvent` interaction. An animated/positioned portal miss is a supported
explanation for the retained outcome, not a demonstrated production edit-buffer regression.

This is a rendered test-driver contract change. It does not change agent behavior, provider selection, tool policy,
persisted formats, production settings state, or the VS Code reference version. No Codex behavior divergence is introduced.

## Small owning fix

The existing control operations are exposed as `createRenderedAcceptanceControls` within the same probe module so unit
tests execute the actual renderer expressions and CDP input path. The scenario uses that helper; it does not gain a second
driver or a production settings seam.

Renderer evaluation now enables `awaitPromise` and checks cancellation after the awaited CDP result. A click scrolls its
target once with instant behavior, then samples it on actual awaited animation frames. Each sample resolves the current
node in the current iframe document, requires nonzero finite geometry and visible ancestry, waits for finite ancestor
animations, and verifies both local option/descendant hit ownership and outer iframe hit ownership. Infinite animation
loops do not block a stable target. Two consecutive matching rectangles establish stable coordinates.

After trusted `mouseMoved`, the driver rechecks geometry and hit ownership before pressing once. Hover-induced movement
can update the pointer position within the same bounded operation; it does not repeat the click. A `finally` release
prevents a failed/cancelled press from leaving a mouse button held. Readiness failures use the same retained screenshot
and failed-expression JSON path as the existing scenario predicates.

Activation shares one **15,000 ms** absolute deadline across presence and click readiness, including hover retargeting.
The existing CDP request bound remains **5,000 ms**. No timeout value is increased, sleep added, scenario predicate
weakened, fixture setting saved, or `cachedState` behavior changed. The original Large edit, authoritative Medium, two
refreshes, Cancel, and Discard-to-Small assertions are unchanged.

## Validation and limitations

Before the behavior fix, the focused driver command below first failed **3 tests and passed 0**, then **4 failed and 0
passed** after adding node replacement coverage. It executes the real exported controls through a controlled `node:vm`
renderer and a CDP transport model: renderer Promises, animation frames, moving geometry, hit ownership, and trusted input
dispatch are observable without launching a host or using arbitrary sleeps.

Independent review found an additional document-replacement race after the initial fix: the captured document can be
replaced during an awaited frame while its old node still reports `isConnected`. A new regression produced **7 passed and
1 failed** before adding the current-document guard. This counterexample is separate from the unrecorded pointer hit in
the original host capture.

```sh
pnpm exec tsx --test --test-concurrency=2 apps/vscode-e2e/src/ui/renderedAcceptance.spec.ts
```

Final reviewed checks, using Node **24.21.0**, pnpm **11.24.0**, workspace TypeScript **5.8.3**, and at most two test workers:

| Check                                                                                                                    | Actual result                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`                                                                                         | Passed in the fresh worktree; no manifest or lockfile changes.                                                                                                                             |
| `pnpm --filter @alpha-code/types build`                                                                                  | Passed; supplied the immediately required internal declarations for ordinary runner checks. No extension/webview bundle was built.                                                         |
| Focused source command above                                                                                             | Final **12 passed, 0 failed** after the fixes.                                                                                                                                             |
| `pnpm --dir apps/vscode-e2e check-types`                                                                                 | Passed through the ordinary package gate. Its first final run caught two unchecked array accesses in the new test; explicit `assert.ok` narrowing corrected them before the passing rerun. |
| `pnpm --dir apps/vscode-e2e compile`                                                                                     | Passed with the normal CommonJS runner configuration. This compiles fixtures without launching them.                                                                                       |
| `node --test --test-concurrency=2 apps/vscode-e2e/out/ui/renderedAcceptance.spec.js`                                     | **12 passed, 0 failed**, using the compiled probe and regression file.                                                                                                                     |
| `pnpm --dir apps/vscode-e2e exec eslint src/ui/renderedAcceptance.ts src/ui/renderedAcceptance.spec.ts --max-warnings=0` | Passed.                                                                                                                                                                                    |
| Scoped Prettier checks and `git diff --check`                                                                            | Passed; source, tests, and this note reviewed.                                                                                                                                             |

The twelve regressions cover awaited paint, moving/covered/replaced options, iframe document replacement, finite ancestor
animations and infinite loops, hover-induced geometry retargeting with one press, an already-expired absolute deadline
with no CDP activity, cancellation during paint before input, and cancellation/transport failure after press with exact
error propagation and one release. Independent source/evidence review approved the corrected probe and test contract.

Only these three files change:

- [`renderedAcceptance.ts`](../apps/vscode-e2e/src/ui/renderedAcceptance.ts)
- [`renderedAcceptance.spec.ts`](../apps/vscode-e2e/src/ui/renderedAcceptance.spec.ts)
- This design note.

Exact-host rendered scenario, live Copilot, extension/webview bundles, full suites, and managed-agent certification remain
owned by parent integration. No corrected host receipt or general reliability/performance improvement is claimed by these
lower-level checks. The final handoff reports the exact commit SHA, worktree, and normal Git hook result. The earlier
implementation worktree remains clean at `fc7816b9ca9d46b96c652f2e0b849821af60f3dd` on
`codex/settings-agents-approvals-20261011`.
