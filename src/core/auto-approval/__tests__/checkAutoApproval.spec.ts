import { describe, expect, it } from "vitest"
import { disabledSubagentAutoApprovalPolicy } from "@alpha-code/types"

import { checkAutoApproval, checkAutoApprovalWithInheritedPolicy } from "../index"
import { createSubagentCommandApprovalPolicy } from "../commands"

const ticketCreate = JSON.stringify({
	tool: "ticket",
	ticketActivity: { operation: "create", state: "pending", name: "Ticket" },
})
const ticketUpdate = JSON.stringify({
	tool: "ticket",
	ticketActivity: { operation: "update", state: "pending", name: "Ticket" },
})
const ticketDelete = JSON.stringify({
	tool: "ticket",
	ticketActivity: { operation: "delete", state: "pending", name: "Ticket" },
})
const spawnExplore = JSON.stringify({ tool: "spawnAgent", agent: { role: "explore" } })
const spawnWorker = JSON.stringify({ tool: "spawnAgent", agent: { role: "worker" } })
const writeInside = JSON.stringify({ tool: "editedExistingFile", path: "src/foo.ts", isOutsideWorkspace: false })
const writeOutside = JSON.stringify({
	tool: "editedExistingFile",
	path: "../other/file",
	isOutsideWorkspace: true,
})
const writeProtected = JSON.stringify({
	tool: "editedExistingFile",
	path: ".alphaignore",
	isOutsideWorkspace: false,
})
const readInside = JSON.stringify({ tool: "readFile", path: "src/foo.ts", isOutsideWorkspace: false })
const readOutside = JSON.stringify({ tool: "readFile", path: "../code.ts", isOutsideWorkspace: true })

describe("checkAutoApproval", () => {
	it("keeps mixed batch reads under outside-read approval", async () => {
		await expect(
			checkAutoApproval({
				ask: "tool",
				text: JSON.stringify({
					tool: "readFile",
					batchFiles: [
						{ path: "inside.ts", isOutsideWorkspace: false },
						{ path: "../outside.ts", isOutsideWorkspace: true },
					],
				}),
				state: { approvalMode: "auto" },
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it.each([
		{ mode: "ask" as const, ask: "tool" as const, text: readInside, decision: "approve" },
		{ mode: "ask" as const, ask: "tool" as const, text: writeInside, decision: "ask" },
		{ mode: "ask" as const, ask: "tool" as const, text: spawnExplore, decision: "ask" },
		{ mode: "ask" as const, ask: "tool" as const, text: ticketCreate, decision: "ask" },
		{ mode: "ask" as const, ask: "tool" as const, text: ticketUpdate, decision: "ask" },
		{ mode: "ask" as const, ask: "tool" as const, text: ticketDelete, decision: "ask" },
		{ mode: "ask" as const, ask: "command" as const, text: "pnpm test", decision: "ask" },
		{ mode: "auto" as const, ask: "tool" as const, text: readInside, decision: "approve" },
		{ mode: "auto" as const, ask: "tool" as const, text: writeInside, decision: "approve" },
		{ mode: "auto" as const, ask: "tool" as const, text: spawnExplore, decision: "approve" },
		{ mode: "auto" as const, ask: "tool" as const, text: spawnWorker, decision: "approve" },
		{ mode: "auto" as const, ask: "tool" as const, text: ticketCreate, decision: "approve" },
		{ mode: "auto" as const, ask: "tool" as const, text: ticketUpdate, decision: "approve" },
		{ mode: "auto" as const, ask: "tool" as const, text: ticketDelete, decision: "approve" },
		{ mode: "auto" as const, ask: "tool" as const, text: writeOutside, decision: "ask" },
		{ mode: "auto" as const, ask: "tool" as const, text: writeProtected, decision: "ask" },
		{ mode: "auto" as const, ask: "tool" as const, text: readOutside, decision: "ask" },
		{ mode: "auto" as const, ask: "command" as const, text: "pnpm test", decision: "approve" },
		{ mode: "bypass" as const, ask: "tool" as const, text: writeOutside, decision: "approve" },
		{ mode: "bypass" as const, ask: "tool" as const, text: writeProtected, decision: "approve" },
		{ mode: "bypass" as const, ask: "tool" as const, text: readOutside, decision: "approve" },
		{ mode: "bypass" as const, ask: "tool" as const, text: ticketDelete, decision: "approve" },
	])("applies $mode to $text → $decision", async ({ mode, ask, text, decision }) => {
		await expect(
			checkAutoApproval({
				ask,
				text,
				isProtected: text === writeProtected,
				state: { approvalMode: mode },
			}),
		).resolves.toEqual({ decision })
	})

	it.each([
		{ mode: "ask" as const, workspaceMode: "shared", decision: "ask" },
		{ mode: "auto" as const, workspaceMode: "shared", decision: "approve" },
		{ mode: "auto" as const, workspaceMode: "worktree", decision: "ask" },
		{ mode: "bypass" as const, workspaceMode: "worktree", decision: "approve" },
		{ mode: "auto" as const, workspaceMode: "invalid", decision: "ask" },
	])("$mode create_task with $workspaceMode workspace → $decision", async ({ mode, workspaceMode, decision }) => {
		await expect(
			checkAutoApproval({
				ask: "tool",
				text: JSON.stringify({ tool: "create_task", workspaceMode }),
				state: { approvalMode: mode },
			}),
		).resolves.toEqual({ decision })
	})

	it.each(["send_task_message", "steer_task", "stop_task"])("lets Auto manage its own %s call", async (tool) => {
		await expect(
			checkAutoApproval({ ask: "tool", text: JSON.stringify({ tool }), state: { approvalMode: "auto" } }),
		).resolves.toEqual({ decision: "approve" })
	})

	it("approves Git commands in Auto with an empty saved allowlist", async () => {
		await expect(
			checkAutoApproval({
				ask: "command",
				text: "git status --short",
				state: { approvalMode: "auto", allowedCommands: [] },
			}),
		).resolves.toEqual({ decision: "approve" })
	})

	it("limits an Ask-mode GitHub version probe to its approved command", async () => {
		const state = { approvalMode: "ask" as const, allowedCommands: ["gh --version"] }
		await expect(checkAutoApproval({ ask: "command", text: "gh --version", state })).resolves.toEqual({
			decision: "approve",
		})
		for (const text of ["gh issue create", "gh api repos/owner/repo/issues", "gh --version && gh issue create"]) {
			await expect(checkAutoApproval({ ask: "command", text, state })).resolves.toEqual({ decision: "ask" })
		}
	})

	it.each([
		{ mode: "ask" as const, decision: "ask" },
		{ mode: "auto" as const, decision: "approve" },
		{ mode: "bypass" as const, decision: "approve" },
	])("applies $mode to an unknown command", async ({ mode, decision }) => {
		await expect(
			checkAutoApproval({
				ask: "command",
				text: "custom-command --version",
				state: { approvalMode: mode, allowedCommands: [] },
			}),
		).resolves.toEqual({ decision })
	})

	it("still asks for an advanced Ask allowlist miss and honors a hit", async () => {
		await expect(
			checkAutoApproval({
				ask: "command",
				text: "pnpm test",
				state: { approvalMode: "ask", allowedCommands: ["git"] },
			}),
		).resolves.toEqual({ decision: "ask" })
		await expect(
			checkAutoApproval({
				ask: "command",
				text: "git status",
				state: { approvalMode: "ask", allowedCommands: ["git"] },
			}),
		).resolves.toEqual({ decision: "approve" })
	})

	it("uses a persisted prefix after task restart while keeping denies and dynamic commands guarded", async () => {
		const storedSettings = { allowedCommands: ["git status --short"] }
		const restartedTaskState = {
			approvalMode: "ask" as const,
			allowedCommands: [...storedSettings.allowedCommands],
			deniedCommands: [] as string[],
		}

		await expect(
			checkAutoApproval({
				ask: "command",
				text: "git status --short --branch",
				state: restartedTaskState,
			}),
		).resolves.toEqual({ decision: "approve" })

		await expect(
			checkAutoApproval({
				ask: "command",
				text: "git status --short --porcelain",
				state: { ...restartedTaskState, deniedCommands: ["git status --short --porcelain"] },
			}),
		).resolves.toEqual({ decision: "deny" })

		await expect(
			checkAutoApproval({
				ask: "command",
				text: "git status --short && $NEXT_COMMAND",
				state: restartedTaskState,
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it("does not let an Ask allowlist wildcard approve unrelated commands", async () => {
		await expect(
			checkAutoApproval({
				ask: "command",
				text: "pnpm test",
				state: { approvalMode: "ask", allowedCommands: ["*", "git status"] },
			}),
		).resolves.toEqual({ decision: "ask" })
		await expect(
			checkAutoApproval({
				ask: "command",
				text: "git status",
				state: { approvalMode: "ask", allowedCommands: ["*", "git status"] },
			}),
		).resolves.toEqual({ decision: "approve" })
	})

	it("ignores a leftover write-outside chip in Auto and still asks", async () => {
		await expect(
			checkAutoApproval({
				ask: "tool",
				text: writeOutside,
				state: {
					approvalMode: "auto",
					alwaysAllowWriteOutsideWorkspace: true,
					alwaysAllowWriteProtected: true,
					allowedCommands: ["*"],
				},
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it("lets Auto enable protected writes without becoming Bypass", async () => {
		await expect(
			checkAutoApproval({
				ask: "tool",
				text: writeProtected,
				isProtected: true,
				state: { approvalMode: "auto", alwaysAllowWriteProtected: true },
			}),
		).resolves.toEqual({ decision: "approve" })
		await expect(
			checkAutoApproval({
				ask: "tool",
				text: writeOutside,
				state: { approvalMode: "auto", alwaysAllowWriteProtected: true },
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it.each([
		{ deniedCommands: [], decision: "ask" },
		{ deniedCommands: ["node"], decision: "deny" },
	])(
		"preserves mandatory command approval and configured denial: $decision",
		async ({ deniedCommands, decision }) => {
			await expect(
				checkAutoApproval({
					ask: "command",
					text: "node script.js",
					requiresExplicitApproval: true,
					state: {
						approvalMode: "auto",
						allowedCommands: ["*"],
						deniedCommands,
					},
				}),
			).resolves.toEqual({ decision })
		},
	)

	it("keeps explicit deny-list matches denied in every mode, including Bypass", async () => {
		for (const mode of ["ask", "auto", "bypass"] as const) {
			await expect(
				checkAutoApproval({
					ask: "command",
					text: "rm -rf /",
					state: { approvalMode: mode, allowedCommands: [], deniedCommands: ["rm"] },
				}),
			).resolves.toEqual({ decision: "deny" })
		}
	})

	it("auto-approves outside command paths in Bypass even when path review flagged them", async () => {
		await expect(
			checkAutoApproval({
				ask: "command",
				text: 'echo changed > "../outside/file.txt"',
				requiresExplicitApproval: true,
				state: { approvalMode: "bypass", deniedCommands: [] },
			}),
		).resolves.toEqual({ decision: "approve" })
	})

	it("does not let Auto or Full Access auto-approve explicit-only spawn", async () => {
		for (const mode of ["auto", "bypass"] as const) {
			await expect(
				checkAutoApproval({
					ask: "tool",
					text: spawnExplore,
					requiresExplicitApproval: true,
					state: { approvalMode: mode },
				}),
			).resolves.toEqual({ decision: "ask" })
		}
	})

	it("requires explicit approval for outside writes even with leftover auto-approval enabled", async () => {
		await expect(
			checkAutoApproval({
				ask: "tool",
				text: writeOutside,
				state: {
					autoApprovalEnabled: true,
					alwaysAllowWrite: true,
					alwaysAllowWriteOutsideWorkspace: true,
					alwaysAllowWriteProtected: true,
				},
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it.each([
		undefined,
		{ operation: "read", state: "pending" },
		{ operation: "list", state: "pending" },
		{ operation: "create", state: "success", name: "Ticket" },
	])("does not broaden ticket authorization to unsupported activity: %j", async (ticketActivity) => {
		await expect(
			checkAutoApproval({
				ask: "tool",
				text: JSON.stringify({ tool: "ticket", ticketActivity }),
				state: { approvalMode: "auto" },
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it.each([
		{ ask: "tool" as const, text: JSON.stringify({ tool: "newFileCreated", path: "ticket.md" }) },
		{ ask: "command" as const, text: "git status" },
		{
			ask: "use_mcp_server" as const,
			text: JSON.stringify({ type: "use_mcp_tool", serverName: "linear", toolName: "update_issue" }),
		},
	])("does not authorize other categories through Alpha Tickets: $text", async (request) => {
		await expect(
			checkAutoApproval({
				...request,
				state: { approvalMode: "ask", alwaysAllowTickets: true, allowedCommands: [] },
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it("auto-approves MCP tools in Full Access without a per-tool alwaysAllow flag", async () => {
		await expect(
			checkAutoApproval({
				ask: "use_mcp_server",
				text: JSON.stringify({ type: "use_mcp_tool", serverName: "linear", toolName: "update_issue" }),
				state: {
					approvalMode: "bypass",
					mcpServers: [{ name: "linear", tools: [{ name: "update_issue", alwaysAllow: false }] } as never],
				},
			}),
		).resolves.toEqual({ decision: "approve" })
		await expect(
			checkAutoApproval({
				ask: "use_mcp_server",
				text: JSON.stringify({ type: "use_mcp_tool", serverName: "linear", toolName: "update_issue" }),
				state: {
					approvalMode: "auto",
					alwaysAllowMcp: true,
					mcpServers: [{ name: "linear", tools: [{ name: "update_issue", alwaysAllow: false }] } as never],
				},
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it.each(["resources/list", "resources/templates/list"])(
		"asks before listing %s through an MCP server in Ask mode",
		async (uri) => {
			await expect(
				checkAutoApproval({
					ask: "use_mcp_server",
					text: JSON.stringify({ type: "access_mcp_resource", serverName: "docs", uri }),
					state: { approvalMode: "ask" },
				}),
			).resolves.toEqual({ decision: "ask" })
		},
	)

	it("keeps MCP prompts in Auto unless the individual tool is explicitly allowed", async () => {
		await expect(
			checkAutoApproval({
				ask: "use_mcp_server",
				text: JSON.stringify({
					type: "use_mcp_tool",
					serverName: "linear",
					toolName: "get_issue",
					annotations: { readOnlyHint: true },
				}),
				state: { approvalMode: "auto" },
			}),
		).resolves.toEqual({ decision: "ask" })
		await expect(
			checkAutoApproval({
				ask: "use_mcp_server",
				text: JSON.stringify({
					type: "use_mcp_tool",
					serverName: "linear",
					toolName: "update_issue",
					annotations: { readOnlyHint: true, destructiveHint: true },
				}),
				state: { approvalMode: "auto" },
			}),
		).resolves.toEqual({ decision: "ask" })
		await expect(
			checkAutoApproval({
				ask: "use_mcp_server",
				text: JSON.stringify({ type: "use_mcp_tool", serverName: "linear", toolName: "update_issue" }),
				state: {
					approvalMode: "auto",
					alwaysAllowMcp: true,
					mcpServers: [{ name: "linear", tools: [{ name: "update_issue", alwaysAllow: true }] } as never],
				},
			}),
		).resolves.toEqual({ decision: "approve" })
		await expect(
			checkAutoApproval({
				ask: "use_mcp_server",
				text: JSON.stringify({ type: "use_mcp_tool", serverName: "linear", toolName: "update_issue" }),
				state: {
					autoApprovalEnabled: true,
					alwaysAllowMcp: true,
					mcpServers: [{ name: "linear", tools: [{ name: "update_issue", alwaysAllow: true }] } as never],
				},
			}),
		).resolves.toEqual({ decision: "approve" })
	})

	it("auto-approves delegation control tools when a session dial is active", async () => {
		await expect(
			checkAutoApproval({
				state: { approvalMode: "ask" },
				ask: "tool",
				text: JSON.stringify({ tool: "newTask", mode: "Architect" }),
			}),
		).resolves.toEqual({ decision: "approve" })
		await expect(
			checkAutoApproval({
				state: { approvalMode: "auto" },
				ask: "tool",
				text: JSON.stringify({ tool: "finishTask" }),
			}),
		).resolves.toEqual({ decision: "approve" })
		await expect(
			checkAutoApproval({
				state: { approvalMode: "auto" },
				ask: "tool",
				text: JSON.stringify({ tool: "switchMode", mode: "Code" }),
			}),
		).resolves.toEqual({ decision: "deny" })
	})

	it("does not use the legacy subtask permission for sub-agent delegation", async () => {
		await expect(
			checkAutoApproval({
				ask: "tool",
				text: JSON.stringify({ tool: "delegateTask" }),
				state: { approvalMode: "ask", alwaysAllowSubtasks: true },
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it.each([ticketCreate, ticketUpdate, ticketDelete])(
		"honors live and captured Auto ticket grants for managed children: %s",
		async (text) => {
			const inheritedAuto = {
				...disabledSubagentAutoApprovalPolicy,
				autoApprovalEnabled: true,
				alwaysAllowReadOnly: true,
				alwaysAllowWrite: true,
				alwaysAllowExecute: true,
				alwaysAllowTickets: true,
			}
			await expect(
				checkAutoApprovalWithInheritedPolicy({
					state: { approvalMode: "auto" },
					inheritedState: inheritedAuto,
					ask: "tool",
					text,
				}),
			).resolves.toEqual({ decision: "approve" })
			await expect(
				checkAutoApprovalWithInheritedPolicy({
					state: { approvalMode: "auto" },
					inheritedState: { ...inheritedAuto, alwaysAllowTickets: false },
					ask: "tool",
					text,
				}),
			).resolves.toEqual({ decision: "ask" })
			await expect(
				checkAutoApprovalWithInheritedPolicy({
					state: { approvalMode: "ask" },
					inheritedState: inheritedAuto,
					ask: "tool",
					text,
				}),
			).resolves.toEqual({ decision: "ask" })
		},
	)

	it("uses the captured mode as the ceiling for child action review", async () => {
		const liveState = { approvalMode: "auto" as const, allowedCommands: ["*"], deniedCommands: [] }
		const inheritedAll = {
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowReadOnlyOutsideWorkspace: false,
			alwaysAllowWrite: true,
			alwaysAllowWriteOutsideWorkspace: false,
			alwaysAllowWriteProtected: false,
			alwaysAllowExecute: true,
			alwaysAllowSubagents: true,
			commandApproval: createSubagentCommandApprovalPolicy(["*"], [], "4".repeat(64)),
		}
		const inheritedState = {
			...inheritedAll,
			alwaysAllowExecute: false,
			alwaysAllowSubagents: false,
			commandApproval: createSubagentCommandApprovalPolicy([], [], "5".repeat(64)),
		}

		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state: liveState,
				inheritedState,
				ask: "command",
				text: "pnpm test",
			}),
		).resolves.toEqual({ decision: "ask" })

		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state: liveState,
				inheritedState,
				ask: "tool",
				text: spawnExplore,
			}),
		).resolves.toEqual({ decision: "ask" })

		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state: liveState,
				inheritedState: inheritedAll,
				ask: "command",
				text: "pnpm test",
			}),
		).resolves.toEqual({ decision: "approve" })

		const commandLimitedState = {
			...inheritedAll,
			commandApproval: createSubagentCommandApprovalPolicy(["git"], ["git push"], "6".repeat(64)),
		}
		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state: liveState,
				inheritedState: commandLimitedState,
				ask: "command",
				text: "git diff",
			}),
		).resolves.toEqual({ decision: "approve" })
		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state: liveState,
				inheritedState: commandLimitedState,
				ask: "command",
				text: "npm test",
			}),
		).resolves.toEqual({ decision: "ask" })
		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state: liveState,
				inheritedState: commandLimitedState,
				ask: "command",
				text: "git push origin main",
			}),
		).resolves.toEqual({ decision: "deny" })
		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state: { approvalMode: "ask" },
				inheritedState: inheritedAll,
				ask: "command",
				text: "pnpm test",
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it("keeps Auto child actions inside the captured write and command policy", async () => {
		const inheritedAuto = {
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowReadOnlyOutsideWorkspace: false,
			alwaysAllowWrite: true,
			alwaysAllowWriteOutsideWorkspace: false,
			alwaysAllowWriteProtected: false,
			alwaysAllowExecute: true,
			alwaysAllowSubagents: true,
			commandApproval: createSubagentCommandApprovalPolicy(["git"], ["git push"], "a".repeat(64)),
		}

		const state = { approvalMode: "auto" as const, allowedCommands: ["git"], deniedCommands: [] }

		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state,
				inheritedState: inheritedAuto,
				ask: "tool",
				text: writeInside,
			}),
		).resolves.toEqual({ decision: "approve" })
		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state,
				inheritedState: inheritedAuto,
				ask: "command",
				text: "pnpm test",
			}),
		).resolves.toEqual({ decision: "ask" })

		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state,
				inheritedState: { ...inheritedAuto, alwaysAllowWrite: false, alwaysAllowExecute: false },
				ask: "command",
				text: "pnpm test",
			}),
		).resolves.toEqual({ decision: "ask" })
		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state,
				inheritedState: inheritedAuto,
				ask: "command",
				text: "git status",
			}),
		).resolves.toEqual({ decision: "approve" })
		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state,
				inheritedState: inheritedAuto,
				ask: "command",
				text: "pnpm test",
			}),
		).resolves.toEqual({ decision: "ask" })
		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state,
				inheritedState: inheritedAuto,
				ask: "command",
				text: "git status",
				requiresExplicitApproval: true,
			}),
		).resolves.toEqual({ decision: "ask" })
		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state,
				inheritedState: inheritedAuto,
				ask: "command",
				text: "git push origin main",
			}),
		).resolves.toEqual({ decision: "deny" })
	})

	it("requires review when either the live or captured subagent mode is Ask", async () => {
		const inheritedAuto = {
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowReadOnlyOutsideWorkspace: false,
			alwaysAllowWrite: true,
			alwaysAllowWriteOutsideWorkspace: false,
			alwaysAllowWriteProtected: false,
			alwaysAllowExecute: true,
			alwaysAllowSubagents: true,
			commandApproval: createSubagentCommandApprovalPolicy(["*"], [], "b".repeat(64)),
		}
		const liveAuto = { approvalMode: "auto" as const, allowedCommands: ["*"] }
		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state: { approvalMode: "ask" },
				inheritedState: inheritedAuto,
				ask: "command_output",
			}),
		).resolves.toEqual({ decision: "approve" })
		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state: { approvalMode: "ask" },
				inheritedState: inheritedAuto,
				ask: "tool",
				text: readInside,
			}),
		).resolves.toEqual({ decision: "ask" })

		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state: { approvalMode: "ask" },
				inheritedState: inheritedAuto,
				ask: "command",
				text: "pnpm test",
			}),
		).resolves.toEqual({ decision: "ask" })

		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state: liveAuto,
				inheritedState: { ...inheritedAuto, alwaysAllowWrite: false, alwaysAllowExecute: false },
				ask: "command",
				text: "pnpm test",
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it("preserves nested command denials while auto-approving other child actions", async () => {
		const allowAll = createSubagentCommandApprovalPolicy(["*"], [], "7".repeat(64))
		const ancestorLimit = createSubagentCommandApprovalPolicy(["git"], ["git push"], "8".repeat(64))
		const inheritedState = {
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowReadOnlyOutsideWorkspace: true,
			alwaysAllowWrite: true,
			alwaysAllowWriteOutsideWorkspace: true,
			alwaysAllowWriteProtected: true,
			alwaysAllowExecute: true,
			alwaysAllowSubagents: true,
			commandApproval: allowAll,
			commandApprovalCeilings: [ancestorLimit],
		}
		const liveState = { approvalMode: "bypass" as const, allowedCommands: ["*"], deniedCommands: [] }

		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state: liveState,
				inheritedState,
				ask: "command",
				text: "git diff",
			}),
		).resolves.toEqual({ decision: "approve" })
		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state: liveState,
				inheritedState,
				ask: "command",
				text: "npm test",
			}),
		).resolves.toEqual({ decision: "approve" })
		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state: liveState,
				inheritedState,
				ask: "command",
				text: "git push origin main",
			}),
		).resolves.toEqual({ decision: "deny" })
	})
})
