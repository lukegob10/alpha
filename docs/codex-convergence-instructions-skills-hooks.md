# Instruction, skill and hook convergence

This design translates the applicable Codex behavior into Alpha's existing TypeScript harness. The reference source was
inspected on 2026-10-15 at Codex commit `bb64b894fd67158be0f874872e6d7bfe717e7368`. VS Code 1.125.0 remains the host contract.

Primary references are the pinned [skill renderer](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/ext/skills/src/render.rs),
[skill discovery](https://github.com/openai/codex/tree/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/ext/skills/src/loader),
[project instructions](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/core/src/agents_md.rs),
[hook runtime](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/core/src/hook_runtime.rs)
and [hook event contracts](https://github.com/openai/codex/tree/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/hooks/src/events).
Alpha retains its own execution protections, provider adapters, built-in skills, HTML preview, Tickets and scheduled tasks.

## Bounded skill metadata

The shared skill formatter bounds repeated metadata using an explicit token allowance capped at 10,000, otherwise two
percent of the captured model context window, otherwise 8,000 Unicode characters. Token accounting uses UTF-8 bytes divided
by four as a deterministic approximation. Fixed usage guidance remains outside this metadata allocation. Names and paths
take precedence over descriptions; descriptions share the remaining allowance fairly before identities are omitted.
Frozen child launch context uses the unknown-window fallback because that early boundary has no selected model window.
Its complete inherited identity/path/digest manifest remains authoritative for subsequent loading and discovery.

The existing `skill` tool supports `action: "list"` with a digest-bound cursor. Pages contain at most 50 entries and 8,000
UTF-8 bytes, also respecting the remaining tool-output allowance. Oversized entries are reported and scanned with a bound.
Catalog changes invalidate cursors. Explicit-only skills remain hidden from implicit discovery; an allowed explicit load
continues through the existing policy and captured-path checks. Calls that omit `action` retain the existing load behavior.

Portable `.agents/skills` roots discover nested packs with sorted traversal, depth six, 2,000 directories and 20,000 entries.
Hidden directories and realpath cycles do not expand the traversal. Alpha-specific and built-in layouts retain their
existing discovery rules, override priority, strict metadata validation and exact inherited identities.

## Captured project boundaries

`alpha.projectRootMarkers` defaults to `[".git"]`; an empty array keeps discovery at the task directory.
`alpha.projectDocFallbackFilenames` defaults to `[]`. Both application settings are captured from user/default values only,
copied and frozen, then shared by instruction and portable-skill ancestry. A task retains its admitted skills-manager
configuration until an explicit fresh request boundary supplies a new snapshot. Children keep captured instructions.

Fallback precedence is `AGENTS.override.md`, `AGENTS.md`, configured fallbacks, then compatible `AGENT.md` behavior.
`AGENTS.local.md`, existing rule formats, regular-file/realpath checks and the shared 32 KiB project-document budget remain.
Basenames reject separators, NUL, colon, `.` and `..` on every platform. This portable subset is intentionally stricter than
POSIX-only basename acceptance upstream. A fallback that selects `AGENTS.local.md` is loaded once.

## Native lifecycle hooks

The existing machine-scoped `alpha.completionHooks` setting retains `stop` and `subagentStop`, and adds optional arrays:

| Setting                         | Native boundary                                                          |
| ------------------------------- | ------------------------------------------------------------------------ |
| `sessionStart`, `subagentStart` | Root startup/resume/compact, or managed child start                      |
| `userPromptSubmit`              | Fresh authoritative human input before model admission                   |
| `preToolUse`, `postToolUse`     | Validated call before execution, or successful terminal result afterward |
| `permissionRequest`             | Pending native approval request                                          |
| `preCompact`, `postCompact`     | Actual summary/truncation attempt and accepted persisted change          |
| `interrupt`, `sessionEnd`       | Joined root-turn interruption and root-session termination               |

User/default configuration alone can install executable hooks. Commands use absolute executables without a shell and
retain the existing process, output, timeout and descendant-cleanup bounds. Configured tool hooks serialize tool lanes and
disable speculative reads before the assistant transcript commit. Schema visibility, path policy and approvals stay in the
canonical scheduler. Rewrites reenter all checks; denial dominates rewrites, and the most recently completed valid rewrite
wins. Permission-hook allowance is advisory and cannot satisfy native human, protected-file or MCP review. This is an
intentional preservation of Alpha's approval authority.

Post-tool feedback preserves actual execution and exit status. A blocked result or failed adapter carries completed-effect
guidance so the model can inspect existing state before repeating a mutation. Cancellation or a later hook failure retains
already completed sibling receipts. Every accepted call still receives one terminal result.

Start/submission context is agent-origin history with bounded event/run provenance. Hook rejection saves a separate durable
agent receipt before acknowledging every merged queue claim or admission callback; rejected input bodies stay out of model
history. Successful submission inspection is deduplicated across retries. Cancelled inspection can run again, and late or
superseded Task output cannot install context or control a new owner.

Compaction hooks run only around actual work. PostCompact follows the ordinary successful UI receipt and its save fence;
typed hook stops become awaiting-user control. A current admitted stop suppresses another automatic post-turn compaction,
and that suppression resets at the next engine-turn boundary. Proactive metrics retain completed physical compaction after
its receipt commits. Manual-command metrics cover the complete hook phase and record a controlled stop as cancelled.

Interrupt dispatch joins tool receipts before fresh steering. SessionEnd joins the existing termination owner once.
Cleanup has a three-second event/transcript-lookup budget plus the existing at-most-two-second Windows descendant-kill
grace. Root cleanup events do not fire for managed children. Alpha dispatches real startup, resume and compact transitions;
the compatible clear/fork payload names do not fabricate host transitions. Historical Stop/SubagentStop provenance remains
readable; new event names require the updated reader, and unknown names are rejected.

## Frozen child relevance metadata

New child manifests retain an optional captured skill description, including hidden entries, as untrusted relevance
metadata. The value must be nonblank and at most 1,024 UTF-16 code units. Readers do not trim, default or backfill it.
Legacy absence remains absent with the same canonical shape and hash. The existing full manifest digest binds a present
description; skill instruction-body digests, contextRefs and approval authority keep their existing meaning. This is
backward reading compatibility, not a promise that an older strict reader accepts a newer record.

The inclusive new-admission limit is 1 MiB of added description data per manifest. One shared platform-neutral helper
counts every stored occurrence's canonical `,"description":<JSON.stringify(value)>` fragment in escaped UTF-8 bytes,
including hidden and duplicate entries. This explicit limit is not a total-manifest cap or a measured optimum. Over-limit
new capture fails before child/control/descriptor/runtime/usage admission and releases existing reservations. Root
preparation can precede capture. No later description is silently dropped to fit this quota.

Nested capture and recovered startup catalogs use the durable metadata without live catalog lookup. Child listing
resolves before manager initialization, while retaining ordinary approval, cancellation, hashed cursors and the existing
page/remaining-output limits. Legacy descriptions can display as empty text without rewriting the persisted record.
Ordinary listing and exact-path/body-verified loading keep their existing manager path. Initial catalog bounds still
apply; a page-fit skill omitted there remains discoverable with its frozen description through list pages. The existing
oversized-entry limitation remains explicit.

Applicable Codex skill guidance remains closely aligned, with Alpha's native tool, captured authority and compaction
adaptations. The existing Alpha reminder to continue the authorized objective across skill stages remains explicit;
selecting a skill does not replace that objective or create new authority.

## Validation

Focused regression coverage owns catalog bounds, nested discovery, captured settings, paginated loading, inherited child
context, event parsing, scheduler policy/receipts, queue rejection, lifecycle cancellation and compaction-stop admission.
Run the focused `src` files, `pnpm --dir src check-types`, affected provider/persistence/managed-agent consumers and
`pnpm --filter @alpha-code/vscode-e2e test:smoke:1250` for an integrated change. Pure source probes and formatting receipts
are supplemental evidence; extension-host and common-gate results must bind the integrated source epoch.
