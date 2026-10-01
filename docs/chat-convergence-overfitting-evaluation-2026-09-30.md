# Chat convergence: overfitting and generalization evaluation

September 30, 2026, New York. Follow-up to the
[implementation record](F:/roo-fork/Alpha-Code/docs/codex-cli-convergence-implementation-2026-09-30.md).
This evaluates the combined local chat/harness changes; it does not implement further fixes.

## Verdict and method

The receipt, lifecycle, cancellation and retry repairs use general state/identity invariants. No production branch
keyed to our conversation text, the unseen Copilot specification, fixture task names or a particular website was found
in the inspected repair paths. However, two input-text heuristics have demonstrated generalization failures, including
loss of a human revocation. The previous passing gates did not establish these semantic cases.

Root instructions and status were read first. The dirty prototype and user edits were preserved. Two existing
subagents independently reviewed messaging invariants/test composition and wording/model/progress/ingestion contracts.
The parent inspected callers and ran actual pure production functions through Node 24.14.1 from a temporary script.
There were no production/test edits, dependency changes, builds, Vitest runs or VS Code automation in this evaluation.
This separate document preserves the previously frozen review and certification artifacts.

CLI comparison remains pinned to `875bf9209bd9aeb0a5f102888ccd90b2b59cc3c9`; this evaluation does not claim a new upstream
HEAD refresh. The pinned [tool-planning source](https://github.com/openai/codex/blob/875bf9209bd9aeb0a5f102888ccd90b2b59cc3c9/codex-rs/core/src/tools/spec_plan.rs#L554)
was retrieved again. Its inspected model-visible tool construction uses registry exposure, model/tool mode and provider
capabilities. No equivalent English-question classifier was found in those inspected paths. This is a scoped source
comparison, not an assertion that no upstream module ever examines request content.

## Confirmed findings

### P1: literal protocol text can discard a human revocation

[Request extraction](F:/roo-fork/Alpha-Code/src/core/agent/requestWorkClass.ts:194) rejects any text containing
`<agent_message>` before unwrapping `<user_message>`. Explicit `input_origin: "human"` does not override that heuristic.
The extractor walks backward and can therefore return an older positive authorization.

The actual production-function probe used this history:

```text
Earlier human: Create a new independent task.
Latest human: Actually, don't create a new task. Explain the literal <agent_message> tag.
```

The extractor returned the earlier request; `isExplicitIndependentTaskRequest` returned `true`. Removing only the angle
brackets retained the latest revocation and returned `false`. An explicitly human `<user_message>` wrapper containing
the literal tag also reproduced the failure. Actual agent-mail controls correctly retained a preceding human revocation.

[Independent launch admission](F:/roo-fork/Alpha-Code/src/core/webview/AlphaProvider.ts:5039) uses this exact function
composition. The probe did not launch a chat, exercise the UI or bypass other host/workspace checks. What is confirmed
is stale authorization at that predicate, not an observed real launch. Existing
[revocation tests](F:/roo-fork/Alpha-Code/src/core/agent/__tests__/independentTaskAuthorization.spec.ts:91) cover real agent
mail after revocation, not a human discussing protocol text.

The invariant should be that structured host provenance determines authorship. A literal tag in human content must not
erase a revocation. Legacy unclassified envelopes need a bounded compatibility reader, not a global substring rule.
This is present in the combined dirty tree; attribution to a particular prior implementation pass is unproven.

### P2: catalog classification still depends on selected action verbs

[Implementation regexes](F:/roo-fork/Alpha-Code/src/core/agent/requestWorkClass.ts:67) run before a broad leading
`can/could/do/how` lookup rule. Unrecognized action wording reaches that lookup rule instead of the documented uncertain
full-surface fallback. These actual results demonstrate the issue:

| Input                                           | Actual catalog |
| ----------------------------------------------- | -------------- |
| `Can you repair the retry handler?`             | lookup         |
| `Would you repair the retry handler?`           | full           |
| `Repair the retry handler.`                     | full           |
| `Can you finish the implementation in spec.md?` | lookup         |
| `Do the changes described in spec.md.`          | lookup         |
| `What owns the timeout? Then patch it.`         | full           |

A fresh adversarial set contained 20 action requests and 10 informational controls: 10 action requests were narrowed
and 5 informational requests were broadened. These were purposively selected examples, not a representative sample or
an estimated failure rate. Broadening tool visibility does not itself grant write authority; existing mode, approval and
workspace policy remain enforced.

The classifier affects the actual [catalog](F:/roo-fork/Alpha-Code/src/core/task/build-tools.ts:594),
[delegation instructions](F:/roo-fork/Alpha-Code/src/core/task/Task.ts:13276), and
[declared acceptance-check aggregation](F:/roo-fork/Alpha-Code/src/core/task/Task.ts:6566). The latter skips this aggregation
for lookup turns; other completion fences still apply. This caller trace does not prove the original 10%-completion
incident, nor demonstrate that every false lookup completes a task.

The recent polite-question repair handles its selected examples, but does not establish a general action/question
distinction. Adding another growing verb list would continue the same weakness. Prefer conservative classification of
ambiguous/mixed requests, and keep optional catalog optimization separate from authoritative acceptance obligations.

## Repairs that generalize, with evidence limits

| Area                                   | Assessment                                                                                                                                                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ask admission and queue receipts       | Uses published ask identity, stable queued IDs, durable admission and claim compensation; independent of message wording.                                                                                              |
| Idle follow-up and lifecycle ownership | One owned wake and promise identity avoid competing starts/settlements; individual Task fixtures mock parts of resume.                                                                                                 |
| UI navigation and ACKs                 | Correlates task/request IDs and dispatches to the committed handler; duplicate/rejected/late receipts preserve the owning draft. The 16-send cap is explicit backpressure, not incident timing.                        |
| Retry pacing                           | Real-helper regressions cover policy and compatibility paths, elapsed/positive delays, cancellation and expired budgets. CLI preserves elapsed provider deadlines; Alpha local timing remains an explained difference. |
| Copilot instruction identity           | Separates selected host family from opaque execution identity and captures it per step; no rule targets the reported specification.                                                                                    |
| Exploration renewal                    | Uses the existing admitted progress cursor rather than raw call repetition. Novel command semantics can earn exploration credit without proving new returned evidence or implementation progress.                      |
| Truncation metadata                    | Reports clipping and the first shortened line independently of line counts. This proves honest metadata, not successful retrieval of every omitted tail.                                                               |

Coverage is layered. The [idle-wake fixture](F:/roo-fork/Alpha-Code/src/core/task/__tests__/Task.completion-followup.spec.ts:131)
substitutes resume and acknowledges IDs inside that stub. It proves ID forwarding and wake coalescing, not a real next
provider request plus disk commit. Separate [filesystem tests](F:/roo-fork/Alpha-Code/src/core/task-persistence/__tests__/TaskMessageQueuePersistence.spec.ts:21)
cover reload, and [handler tests](F:/roo-fork/Alpha-Code/src/core/webview/__tests__/published-ask-response.spec.ts:109)
cover durable admission. A composed lost-ACK -> actual follow-up -> reload -> same-ID retry remains valuable coverage.

Two additional scope limits deserve follow-up:

- Recovery guidance names `exec_command` for bounded character reads, but
  [Plan execution policy](F:/roo-fork/Alpha-Code/src/core/tools/validateToolUse.ts:201) permits a narrow command subset.
  Ordinary Node/PowerShell/Python file reads are outside that subset. Restricted Git inspection can cover particular
  cases; general recovery of an untracked long-line attachment through the advertised Plan surface was not demonstrated.
  Test the offered recovery path, not only its warning text, while preserving Plan authority.
- The existing [model prompt resolver](F:/roo-fork/Alpha-Code/src/core/prompts/codex-model-instructions.ts:57) accepts
  separator-prefixed known model suffixes. The pure probe confirms hypothetical family `custom-gpt-5.6-sol` selects
  GPT-5.6 instructions instead of fallback. No such host family was observed. Qualified execution-ID compatibility and
  verified-family resolution should be reviewed separately; unknown-family fallback is not universal today.

One source-slice matrix derives expectations using the same production parsing/formatting helpers. Independent boundary
controls mitigate that circularity; successful recovery through actual mode policy remains a separate assertion.

## Bounded next work

1. Preserve explicitly human provenance, reproduce quoted-tag revocation and actual legacy-mail controls in normal tests,
   then repair the extractor at its owning boundary.
2. Redesign conservative catalog narrowing with fresh paraphrase/negation/quotation/mixed-intent controls. Ensure a
   catalog hint cannot silently remove declared task acceptance obligations.
3. Add the composed lost-ACK/reload receipt case and mode-specific truncation-recovery case. Keep existing invariant-based
   repairs; no evidence supports reverting them wholesale or replacing the shared kernel.

Probe script/result: `alpha-chat-overfitting-probe-20260930.mjs` and `.json` in the Windows temporary directory. The source
was imported directly with Node's TypeScript support; no implementation was copied into the probe. No live Copilot run
or original-spec reproduction was performed. Passing prior gates remain evidence for their tested contracts, not proof
against all semantic overfitting or generalization failures.
