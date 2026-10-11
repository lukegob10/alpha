# Bounded MCP catalog pagination

Date: 2026-10-11. Reference host: VS Code 1.125.0. Alpha starting checkpoint:
`14fc29614911d0d3b88670135a8a5c11abb75103`.

## Verified reference contract

The source comparison uses current Codex commit
[`27065a91ccbf5ba8532844be3777fcf83b77820d`](https://github.com/openai/codex/commit/27065a91ccbf5ba8532844be3777fcf83b77820d),
committed at 2026-10-11T17:43:08Z and inspected on 2026-10-11. The shared source checkout was read only. This supersedes
the relevant pagination observations from the older October 11 divergence audit; that audit referenced `a07c8ebd`.

The owning upstream functions are
[`collect_paginated` and `collect_paginated_with_limit`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/codex-mcp/src/pagination.rs).
They collect ordered pages into a temporary vector and return it only when the continuation cursor is absent. An empty
string is a valid cursor, so a truthiness check cannot determine completeness. Any page error rejects the collection.

| Invariant     | Current Codex behavior                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Page count    | At most 100 requests; a continuation after page 100 fails before request 101.                                                     |
| Item count    | At most 2,048 ordinary catalog items, counted across all pages before insertion.                                                  |
| Cursor size   | At most 64 KiB in UTF-8 bytes; oversized cursors fail before they are sent.                                                       |
| Cursor cycles | Every returned continuation cursor is tracked, including empty and nonconsecutive cursors. A repeated cursor fails.               |
| Duration      | One deadline covers the whole collection; a configured timeout applies, otherwise 30 seconds. It does not reset per page.         |
| Result        | Successful completion contains every collected item in page order. Errors and limits never return a truncated successful catalog. |

The corresponding
[`pagination_tests.rs`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/codex-mcp/src/pagination_tests.rs)
contains `collects_all_pages_including_an_empty_cursor`, `rejects_nonconsecutive_repeated_cursors`,
`rejects_excessive_pagination_before_fetching_another_page`, both item-limit tests,
`rejects_oversized_pagination_cursors_before_following_them`, `forwards_page_failures`,
`applies_a_default_timeout_when_no_timeout_is_configured`, and
`applies_one_timeout_across_individually_timely_pages`. These tests were inspected, not executed in Alpha's worktree.

The callers establish which operations this contract serves:

- [`list_tools_for_client_uncached`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/codex-mcp/src/rmcp_client.rs)
  collects `tools/list` before converting tools and publishing a successful startup catalog. Ordinary servers use the
  2,048 limit. Codex Apps has a separate 8,192-item allowance that does not apply to Alpha's ordinary MCP connections.
- [`McpConnectionSet::list_all_resources` and `list_all_resource_templates`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/codex-mcp/src/connection_manager/resources.rs)
  collect complete catalogs per captured client. A failed server is omitted with an error log. The single-page
  `list_resources` and `list_resource_templates` methods retain the caller's pagination parameters.
- [`McpBindingClients`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/codex-mcp/src/binding_clients.rs)
  uses the same collector for clients captured for a model step.
- [`legacy_tool_catalog_rejects_repeated_pagination_cursor`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/codex-mcp/src/connection_manager_tests.rs)
  verifies repeated-cursor rejection through a real in-process client with the older protocol.

No prompt catalog listing exists in Alpha's MCP hub, shared MCP server types, or model-facing resource tools. Current
`codex-mcp` and `rmcp-client` also have no `prompts/list` caller. This change therefore covers the existing tools,
resources, and resource-template catalogs without creating a prompt feature, OAuth, or elicitation flow.

Current
[`LoggingClientHandler::on_resource_list_changed`, `on_tool_list_changed`, and `on_prompt_list_changed`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/rmcp-client/src/logging_client_handler.rs)
only log the notification; they do not refresh or invalidate a catalog. Codex's explicit Apps refresh separately uses
[`ClientToolCatalog::refresh`](https://github.com/openai/codex/blob/27065a91ccbf5ba8532844be3777fcf83b77820d/codex-rs/codex-mcp/src/client_tool_catalog.rs)
to serialize fetching/publication and invalidate prior prepared calls. Alpha's notification-driven catalog refresh below
is an intentional native extension behavior, not a claim that Codex currently does the same.

## Native Alpha ownership and failure

`src/services/mcp/McpHub.ts` owns connections, capability discovery, configured tool grants, resource page requests, and
webview catalog projection. At the starting checkpoint, `fetchToolsList`, `fetchResourcesList`, and
`fetchResourceTemplatesList` fetched only the first page and converted listing failures to successful empty arrays.
Initial connection and refresh paths assigned the three arrays after separate awaits. A later error or reconnect could
therefore expose a partial catalog or mix connection generations. Public resource-page requests also omitted an empty
cursor because they tested its truthiness.

`src/core/tools/McpResourceTools.ts` owns approved model-facing resource listing and reading. Its all-server resource and
template loop also treated empty cursors as terminal, lacked cursor-byte and overall-time limits, and resolved the hub
connection anew for each page. Its single-server output dropped an empty `nextCursor`. The existing global 10,000-item
output ceiling protects aggregate tool output and remains useful independently of the per-server catalog bound.

`packages/types/src/mcp.ts` remains the server/tool/resource wire contract. `McpHub` keeps original server and tool names,
the existing project-over-global lookup rules, configured `alwaysAllow` and `disabledTools` semantics, and tool metadata.
Discovery never creates approval authority. Resource reading, command policy, and provider response schemas remain under
their existing owners. SDK 1.12.0's
[`Protocol.connect`](https://github.com/modelcontextprotocol/typescript-sdk/blob/1.12.0/src/shared/protocol.ts) replaces
transport close/error callbacks; lifecycle handling must also use the captured client's `onclose`/`onerror` callbacks to
remain effective after SDK connection. Client protocol diagnostics, such as a late response to a cancelled request, stay
nonfatal. Actual transport errors compose the SDK handler with Alpha's captured lifecycle handler.

## Implementation contract

Use `src/services/mcp/pagination.ts` as a small native TypeScript collector shared by hub catalog discovery and the
model-facing aggregate listings.
Enforce the reference page, item, cursor-byte, cycle, and overall-time limits. Forward abort signals to MCP requests and
settle promptly when a transport ignores cancellation. Remove timers and listeners on every terminal path, and keep
handlers attached to late request settlement so cancellation cannot create an unhandled rejection.

Capture the exact connection/client for each hub refresh and the exact server object for each model-facing listing.
Check that ownership is still current before requesting a page, after awaited work, and immediately before publication.
Deletion, disposal, transport closure, and replacement invalidate pending discovery. A superseded refresh cannot publish
over its successor or change a replacement connection's status through an old transport callback.

Each connection attempt has an abortable generation keyed by original server name and project/global source before its
first await. A replacement or disposal also invalidates attempts waiting for configuration injection or transport startup.
Provisional clients/transports have an explicit cleanup path, including a transport that finishes starting after abort.
An older attempt cannot remove a newer attempt's watchers or publish a duplicate connection for the same scope.

Stage complete tools, resources, and templates for a full hub refresh, then publish them together without an intervening
await. Initial discovery stays `connecting` until completion. A refresh failure keeps the last complete arrays and records
the actionable failure; it does not replace them with an apparently successful empty or partial catalog. Tool-grant
configuration read/parse failures and missing server configuration reject the refresh instead of resetting configured
grants or exposing disabled tools through successful default visibility. Local grant reading shares the tools collector's
original deadline, including when the final remote page succeeds but configuration reading stalls. Persisted grant
changes immediately update the existing complete tool schemas' approval and visibility metadata, so a failed remote
refresh cannot preserve revoked authority. A tools-only grant refresh publishes only a complete tools catalog. A grant
refresh promotes to a full refresh when a full discovery is pending or a previous catalog
failure needs recovery; changing grants cannot dismiss a resource/template failure without refetching it. Successful
recovery clears the current catalog failure while retaining its bounded error history and preserving a different current
transport error. Catalog notifications remain projections of the hub's canonical connection state.

Tools/resources list-change handlers capture their owning connection, invalidate an older pending discovery, and request
the common complete catalog refresh. Synchronous notification bursts coalesce through a microtask. An active refresh
allows one pending successor instead of an unbounded refresh queue; repeated notifications keep that successor pending.
Lifecycle invalidation makes old callbacks and queued work inert. Initial connection waits for its current refresh so a
notification cannot make an aborted older fetch mark a replacement catalog disconnected or prematurely ready.

The public `listResources` and `listResourceTemplates` methods remain single-page APIs. They preserve `cursor: ""`,
server source, cancellation, and returned `nextCursor`. A selected-server resource tool likewise returns one page and its
cursor; its page is bounded to 2,048 items and its input/continuation cursors to 64 KiB. All-server tool listings collect
every page per server with the shared limits and retain the 10,000-item total output ceiling. One 30-second monotonic
deadline covers the entire approved aggregate fetch across all servers; each server collector receives only the remaining
budget. Approval waiting occurs before that deadline begins. They publish one result only after every selected catalog
succeeds.

Capability discovery uses Alpha's pinned
[`@modelcontextprotocol/sdk` 1.12.0 client](https://github.com/modelcontextprotocol/typescript-sdk/blob/1.12.0/src/client/index.ts).
`resources/list` and `resources/templates/list` share the `resources` capability; there is no separate template flag.
Explicitly absent capabilities skip their discovery requests. The SDK's
[`McpServer.setResourceRequestHandlers`](https://github.com/modelcontextprotocol/typescript-sdk/blob/1.12.0/src/server/mcp.ts)
registers both list operations, including an empty template list. RPC errors, including `MethodNotFound` from an advertised
resource capability, reject discovery. There is no broad unsupported-method or later-page fallback that can hide an
incomplete catalog. These SDK sources and the
[2025-03-26 resources specification](https://modelcontextprotocol.io/specification/2025-03-26/server/resources)
were checked on 2026-10-11.

## Intentional Alpha differences

- Alpha uses its existing TypeScript MCP service and extension harness. No Codex runtime, prompt, sandbox architecture,
  or source implementation is ported.
- Alpha publishes the three hub catalog arrays as one complete server refresh, whereas Codex aggregates resource catalog
  types separately. This prevents a webview or task surface from observing mixed refresh generations.
- Alpha refreshes complete catalogs on list-change notifications with bounded coalescing. Current Codex's corresponding
  callbacks log those notifications. Both require complete, generation-safe publication at their actual refresh boundary.
- Alpha's model-facing aggregate listing fails the tool result if any selected server fails. Codex's cross-server
  resource listing omits failed servers. Alpha preserves its existing error-result policy while removing false completion.
- Alpha keeps the 10,000-item aggregate model-facing ceiling as well as the 2,048-item per-server catalog bound.
- Alpha bounds an aggregate model-facing resource/template fetch to one 30-second deadline across all selected servers.
  Codex bounds each individual server collection, including all of its pages. Alpha's shared collector preserves that
  contract while the resource tools additionally pass a decreasing aggregate budget to avoid server-count amplification.
- Alpha has no Codex Apps special catalog allowance. All ordinary MCP discovery uses the shared 2,048-item bound.
- Alpha catalog discovery uses the 30-second default independently of its existing tool-execution timeout setting. That
  setting continues to govern tool calls; this change does not reinterpret saved configuration.
- Alpha keeps its existing project/global identity, approval grants, tool policy, resource-reading behavior, built-in
  tools, and exact VS Code 1.125.0 compatibility contract.

## Validation record

The implementation chat used three human-authorized collaboration subagents: upstream contract/design review and
model-facing resource regressions, the shared collector and its regressions, and independent hub/lifecycle regressions.
The lead owns integration and review of their changes in the isolated worktree. No additional chats, pushes, or releases
were created by these subagents.

Validation used Node.js 24.21.0, pnpm 11.24.0, and TypeScript 5.8.3 in the isolated worktree. Dependencies were installed
with `pnpm install --frozen-lockfile`; the lockfile was unchanged.

The lowest-boundary reproductions failed for the intended reasons before their corresponding fixes:

- With the checkpoint's `McpHub.ts` temporarily restored, the focused test matching
  `collects tools, resources, and templates through empty` failed because discovery returned only the first tool page.
- With only the immediate saved-policy projection removed, both tests matching `applies a persisted` failed because a
  later page error left revoked approval or visibility metadata enabled. Each reproduction restored the implementation
  in a `finally` block before further validation.

The final focused run passed **11 files and 366 tests**, with at most two workers:

```sh
pnpm --dir src test services/mcp/__tests__ core/tools/__tests__/McpResourceTools.spec.ts core/tools/__tests__/accessMcpResourceTool.spec.ts core/tools/__tests__/useMcpToolTool.spec.ts core/auto-approval/__tests__/AutoApprovalHandler.spec.ts core/auto-approval/__tests__/mcpApprovalPolicy.spec.ts core/auto-approval/__tests__/checkAutoApproval.spec.ts core/auto-approval/__tests__/taskSessionApprovalGrants.spec.ts --maxWorkers=2
```

This covers tools/resources/templates across pages; empty, repeated, and UTF-8 oversized cursors; exact and overflowing
item/page limits; a shared timeout across individually timely pages and servers; grant reads within the original deadline;
page errors; ignored aborts and late settlement; disposal/reconnect/replacement; notification coalescing; atomic publication;
and preserved tool grants, source-specific identity, approvals, and reading behavior.

The initial standard extension typecheck failed because this fresh worktree lacked generated `@alpha-code/types`
declarations. A temporary source-alias typecheck passed, and its validation config was removed. After the parent authorized
`pnpm --filter @alpha-code/types build`, that dependency build passed and the final standard
`pnpm --dir src check-types` passed. No extension bundle or webview build was performed in this chat.

ESLint passed for the seven touched TypeScript files. Prettier was applied only to the eight touched files; its final
check and `git diff --cached --check` passed. The commit hook's `pnpm exec lint-staged` formatting also passed separately.
The hook is disabled only for this commit because it additionally invokes the repository-wide `pnpm lint`, which belongs
to the parent's serial validation below.

Repository-wide gates, bundle/VSIX, exact VS Code 1.125.0 smoke, and the dedicated live Copilot profile are deferred to the
parent's serial integration validation. No substituted host or live run is claimed by this change.
