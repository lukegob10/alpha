# Explicit-only portable skills

Alpha supports the optional `policy.allow_implicit_invocation` setting in a skill's `agents/openai.yaml`.
A value of `false` omits the resolved skill from the automatic model catalog while retaining explicit invocation.
The setting controls discovery in model context; it does not grant execution authority or disable a skill.

```yaml
policy:
    allow_implicit_invocation: false
```

## Verified upstream reference

Reviewed the current official Codex source at commit `27065a91ccbf5ba8532844be3777fcf83b77820d`, dated
`2026-10-11T17:43:08Z`, on 2026-10-11. The read-only source checkout was
`C:/Users/Luke Goblirsch/AppData/Local/Temp/alpha-codex-comparison-20261011-101414/codex`.
This review rechecks the current implementation rather than relying on the earlier divergence audit at `a07c8ebd`.

| Upstream owner                                                                                                                                                                                                                           | Verified behavior                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [`loader/metadata.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/ext/skills/src/loader/metadata.rs), `load_host_skill_metadata`, `resolve_policy`                                           | Loads optional `agents/openai.yaml`; absent, unreadable, or invalid metadata does not prevent loading a valid `SKILL.md`.                   |
| [`skills/src/model.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/skills/src/model.rs), `SkillMetadata::allows_implicit_invocation`, `EnvironmentSkillMetadata::allows_implicit_invocation` | Missing policy or missing invocation field defaults to `true`.                                                                              |
| [`provider/host.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/ext/skills/src/provider/host.rs), `catalog_entry_from_skill`, `HostSkillProvider::read`                                      | A false policy marks an entry hidden from the prompt; it remains loaded and readable.                                                       |
| [`catalog.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/ext/skills/src/catalog.rs), `SkillCatalogEntry::is_model_visible`                                                                  | Automatic visibility requires both enabled status and prompt visibility. These are separate decisions.                                      |
| [`selection.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/ext/skills/src/selection.rs), `collect_explicit_skill_mentions`, `select_by_path`                                                | Explicit name and path resolution checks enabled status without requiring prompt visibility.                                                |
| [`tools/read.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/ext/skills/src/tools/read.rs), `ReadTool::handle`                                                                               | Direct package reads require enabled status and matching authority, without checking prompt visibility or a prior human-invocation receipt. |
| [`host_roots.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/ext/skills/src/host_roots.rs), `repo_agents_skill_roots`                                                                        | Discovers portable `.agents/skills` roots between the project root and task working directory.                                              |
| [`host_service.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/ext/skills/src/host_service.rs), `HostSkillsService`, `watchable_skill_root_paths`, `clear_cache`                             | Discovery and invalidation belong to the service; providers consume immutable snapshots.                                                    |

The following current upstream tests provide observable evidence:

- [`loader/host_tests.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/ext/skills/src/loader/host_tests.rs):
  `loads_host_frontmatter_dependencies_and_policy` preserves false policy;
  `invalid_optional_metadata_fails_open` retains a valid skill with no optional policy and no loading error.
- [`loader/host_io_tests.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/ext/skills/src/loader/host_io_tests.rs):
  `host_loading_reuses_walk_inventory_for_symlinked_skill_pack` retains false policy on a discovered linked skill.
- [`loader/environment_tests.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/ext/skills/src/loader/environment_tests.rs):
  `direct_environment_loader_preserves_plugin_dependencies_and_product_policy` and
  `executor_bundle_parser_matches_direct_environment_loader` preserve false policy across loading paths.
- [`skills/src/model_tests.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/skills/src/model_tests.rs):
  `missing_policy_allows_implicit_invocation_and_all_products` and
  `policy_restricts_implicit_invocation_and_products` verify the default and opt-out.
- [`tests/skills_extension.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/ext/skills/tests/skills_extension.rs):
  `prompt_hidden_skill_can_still_be_invoked` submits `$hidden-skill`, excludes it from the automatic catalog, includes
  its explicit instruction fragment, and verifies the provider read;
  `skills_list_only_returns_model_visible_bounded_metadata` excludes a hidden entry from model-directed listing.
- [`host_service_tests.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/ext/skills/src/host_service_tests.rs):
  `skills_for_cwd_uses_cached_result_until_force_reload` verifies refresh behavior;
  `skills_for_config_bounds_plugin_generations_and_preserves_live_snapshots` verifies retained snapshots survive cache
  eviction and later generations.

These Rust tests were inspected as contract evidence; they were not executed for the native TypeScript change.

## Human input and explicit reads

Upstream `collect_explicit_skill_mentions` receives `TurnInputContext.user_input`, with typed skill, mention, and text
inputs. The selector inspects those inputs rather than optional metadata or arbitrary provider transcript text.
`ReadTool::handle` permits an enabled hidden package when its exact ID is supplied; prompt visibility filters automatic
listing and alias construction rather than imposing a proof-of-intent read gate.

Alpha preserves existing explicit named tool reads, human slash selection, and configured scheduled skill invocation.
Adding a human-receipt requirement to every hidden skill read would diverge from the verified upstream contract and break
these callers. Existing tool approval and task authority still apply. Metadata supplies only a validated boolean; its
text cannot become a human invocation, approval receipt, dependency installation request, or authority grant.

Automatic slash expansion has a distinct input boundary: external agent, MCP, repository, or other tool output cannot
become admitted human input merely by including a `<user_message>` wrapper. `Task` records host-owned origin for each raw
input block before merging notifications and queued replies or promoting an envelope's display origin. An unrelated
human message in the same request does not authorize an agent notification. The ephemeral origin sidecar retains the raw
block identities used by retry and interrupted-steering paths after consumable queue receipts or notification ACK markers
have been removed.

Each mention-processing call receives a snapshot of primitive block origins, copied before parsing can await.
Missing entries in a supplied snapshot are agent input. Replacement user text retains its captured origin; generated
file context and slash help are agent input. Task adopts returned origins without widening an existing agent origin.
The change preserves accepted tool-result ordering and the persisted wire shape. Reload uses the committed transcript
tail as stored rather than processing it again; fresh admitted input receives its own origin.

Task snapshots exact raw source block references before asynchronous preparation. The existing successful transcript-save
callback retires those original notification identities together with their prepared replacements. Failed saves retain
pending originals, and notifications arriving after the snapshot belong to a later boundary. Origin sidecar values
remain available after this acknowledgment.

`Task` separately passes the IDs of pending successful human-feedback results into `processUserContentMentions`.
The stateless
`src/services/skills/skillInvocationProvenance.ts` helper matches those result IDs to accepted assistant calls for
`ask_followup_question` or `attempt_completion`; forged tags, arbitrary content, different reused result bodies,
conflicting IDs, and error results do not establish that provenance. Identical persisted feedback can retain its origin
across the existing result-persistence barrier and retry/reload. Unproven automatic expansion suppresses only a skill
whose policy is boolean `false`; ordinary skills and the existing command/mode handling retain their behavior. No
human-intent ledger or authority text is introduced. This boundary is independent of direct skill-tool readability.

## Alpha ownership and compatibility

`packages/types/src/skills.ts` adds optional `SkillMetadata.allowImplicitInvocation`. Existing metadata and records that
omit it retain automatic discovery. The optional field in `packages/types/src/subagent-context.ts` retains the captured
choice in a child's durable skill manifest without requiring a migration of older manifests.

`src/services/skills/SkillsManager.ts` owns metadata loading, source and mode override resolution, and refreshes.
`src/services/skills/skillPolicy.ts` owns bounded parsing and optional metadata reads.
`getSkillsForMode` keeps the complete enabled, mode-resolved catalog for explicit selection. `getImplicitSkillsForMode`
filters that result with `allowImplicitInvocation !== false`. Filtering follows override resolution: an explicit-only
nearer or Alpha-specific winner must not expose a lower-priority automatic skill with the same name.

`src/core/prompts/sections/skills.ts` applies the same visibility rule to both live and already captured catalogs.
An empty implicit catalog emits no automatic skill list. Built-in skills without optional metadata remain discoverable
and invocable, alongside portable `.agents` and Alpha-specific `.alpha` skills.

`src/core/tools/SkillTool.ts` and `src/services/skills/skillInvocation.ts` retain explicit name/path lookup and existing
approval, cancellation, task-mode, and content-digest checks. Automatic missing-skill suggestions exclude explicit-only
entries. Child suggestions derive from the child's captured catalog so a refresh cannot reveal newly discovered skills.
Settings and explicit human skill-selection surfaces retain the full discovery catalog.

`src/core/agent/SubagentContextCapture.ts` and `src/core/webview/AlphaProvider.ts` capture the optional flag with each
skill's exact path and instruction digest. Child and descendant manifests retain explicit-only entries for invocation;
rendered inherited catalogs omit them. Descendants copy the captured policy instead of consulting a newer same-name
override. Existing frozen instructions and step snapshots remain fixed across metadata refreshes. A new capture receives
the refreshed policy, while explicit reads still apply Alpha's existing exact-path and stale-content checks.

The captured flag is part of the manifest digest and survives through `HistoryItem.subagentContextManifest` and
`src/core/task-persistence/taskMetadata.ts`. `Task` validates and clones that history-owned manifest on reload. Transcript
compaction operates on provider history rather than replacing this manifest; subsequent child lookup and descendant
capture use the held manifest instead of the refreshed runtime manager. Omitting the new optional field preserves the
representation and digest of legacy manifests.

Before child slash expansion, `Task` wraps the manager with `getSkillLookupForCapturedCatalog`. The wrapper copies the
captured identities and policy, reads only the exact captured path, and checks the name and instruction digest. It
projects the captured policy onto verified content rather than adopting newly edited metadata. A newly discovered name,
deleted file, changed content, or replacement path cannot substitute for the frozen skill. Direct `SkillTool` loading
continues to use its existing captured path/content checks, including after reload or compaction.

File watchers include metadata creation, change, and deletion under every existing global and task-scoped portable or
Alpha-specific skill tree. They use the existing generation-guarded full-catalog refresh and disposal lifecycle.

## Deliberate Alpha differences

- Alpha uses its existing native TypeScript skills service and VS Code adapters; no Rust code, copied prompt, new
  production dependency, or parallel runtime is introduced.
- This change reads only the optional invocation policy. Unrelated interface, product, and dependency metadata does not
  configure providers, install tools, or widen approval or execution authority.
- Optional metadata reads are capped at 64 KiB, parser nesting is capped at 64 frames, and YAML alias expansion is
  disabled. Malformed, oversized, unreadable, excessively nested, multi-document, or unsupported invocation metadata is
  ignored, preserving the existing automatic-discovery default and valid skill.
  Only a supported boolean `false` opts out; string values such as `"false"` do not silently disable discovery.
- Alpha preserves its existing project-over-global, nearer-ancestor, Alpha-over-portable, and mode-specific precedence,
  user enablement controls, built-in skill set, and exact captured path/content checks.
- The reference host remains VS Code **1.125.0**, independent of model or provider selection.

## Validation

The final consolidated extension run passed all 16 focused files and 991 tests after the origin and notification cleanup.
The shared child-manifest schema run passed 1 file and 24 tests, for 17 distinct focused files. Reported run counts
include existing coverage and are not additive with earlier overlapping runs.

| Check                                                                                               | Result                     |
| --------------------------------------------------------------------------------------------------- | -------------------------- |
| Consolidated extension skills, prompts, input, task, persistence, capture, and provider regressions | 16 files, 991 tests passed |
| Shared subagent context schema                                                                      | 1 file, 24 tests passed    |

The consolidated extension run used `pnpm --dir src test <files> --maxWorkers=2` with these file filters relative to
`src/`:

```text
services/skills/__tests__/SkillsManager.policy.spec.ts
services/skills/__tests__/SkillsManager.spec.ts
services/skills/__tests__/skillInvocation.spec.ts
services/skills/__tests__/skillInvocationProvenance.spec.ts
core/prompts/sections/__tests__/skills.spec.ts
core/prompts/__tests__/system-prompt.spec.ts
core/tools/__tests__/skillTool.spec.ts
core/agent/__tests__/SubagentContextCapture.spec.ts
core/mentions/__tests__/processUserContentMentions.spec.ts
core/task-persistence/__tests__/taskMetadata.spec.ts
core/task-persistence/__tests__/apiMessages.input-metadata.spec.ts
core/task/__tests__/Task.compaction-safety.spec.ts
core/task/__tests__/Task.subagent-context.spec.ts
core/task/__tests__/Task.spec.ts
core/task/__tests__/Task.pending-queue-receipts.spec.ts
core/webview/__tests__/AlphaProvider.subagents.spec.ts
```

The schema run used
`pnpm --filter @alpha-code/types test src/__tests__/subagent-context.test.ts --maxWorkers=2`.

A deterministic Node 24 catalog assertion reproduced the explicit-only entry appearing in the automatic root catalog
before the change and passed after the visibility filter. Earlier capture fixture/setup failures were repaired before
the final consolidated run passed.

An actual Task merge and mention-parser reproduction failed four new mixed-origin integration cases before the fix:
a forged agent notification expanded an explicit-only skill beside unrelated human `Keep working`, and a genuine
adjacent human slash invocation inserted the skill body twice. A targeted post-fix origin run passed 101 tests.
Coverage verifies origin retention after queue ACK and notification-marker deletion, missing or copied origin-map keys,
primitive snapshots across asynchronous resolution, and accepted tool feedback independent of a text block's origin.

Strengthened notification cleanup coverage reproduced five intended pre-fix failures before the raw-source save-fence
snapshot was added. The complete `Task.pending-queue-receipts.spec.ts` suite then passed all 30 tests, including
successful-save retirement of cloned notifications, failed-save retention, and a controlled later-notification race.
The final consolidated run includes these regressions.

The other focused coverage includes true, false, absent, malformed, typed-invalid, alias, oversized, multi-document, and
excessively nested metadata; explicit invocation; override winners; watcher refresh; built-ins; captured catalogs and descendants;
history/reload and compaction retention; missing-skill suggestions; forged human-invocation text; genuine feedback; and
identical-result retry compatibility.

Ordinary project checks passed: the final `pnpm --dir src check-types` rerun, `pnpm --dir webview-ui check-types`, the shared
types package's typecheck and lint, and focused ESLint from the owning package for all touched production and test
TypeScript files. These checks used the normal workspace scripts and internal package resolution, without source-alias
substitutes. Locked workspace dependencies were restored with `pnpm install --frozen-lockfile`; the existing shared types
package was built with `pnpm exec turbo build --filter=@alpha-code/types --concurrency=1 --log-order=grouped`.

Documentation passed Prettier checking and a deterministic check that all 14 unique pinned upstream source links resolve
to files in the verified checkout. The upstream Rust tests were reviewed, not run.

The implementation lead launched three collaboration subagents with disjoint ownership for contract research and this
note, native implementation, and observable regressions plus independent review.

Run focused Vitest filters directly after `test`, with at most two workers, followed by affected package typechecks.
The ordinary commit hook runs `lint-staged` and default `pnpm lint`; its result is recorded in the handoff.
The integration parent owns the deferred full repository checks (`pnpm check-types`, `pnpm test`, `pnpm knip`),
managed-agent certification (`pnpm certify:managed-agents:automated`), packaging (`pnpm bundle`, `pnpm vsix`, and
`node scripts/verify-vsix-contents.mjs <path-to-vsix>`), and the exact host gate:

```sh
pnpm --filter @alpha-code/vscode-e2e test:smoke:1250
```

These integration gates have not run for this bounded change. No other VS Code version or live-model run substitutes for
the exact VS Code 1.125.0 gate.
