import { describe, expect, it } from "vitest"

import { checkAutoApproval, checkAutoApprovalWithInheritedPolicy } from "../index"
import { createSubagentCommandApprovalPolicy } from "../commands"

describe("checkAutoApproval", () => {
	describe.each(["create", "update"] as const)("Alpha Tickets %s", (operation) => {
		const request = {
			ask: "tool" as const,
			text: JSON.stringify({ tool: "ticket", ticketActivity: { operation, state: "pending", name: "Ticket" } }),
		}

		it.each([
			{ autoApprovalEnabled: true, alwaysAllowTickets: true, decision: "approve" },
			{ autoApprovalEnabled: true, alwaysAllowTickets: false, decision: "ask" },
			{ autoApprovalEnabled: true, alwaysAllowTickets: undefined, decision: "ask" },
			{ autoApprovalEnabled: false, alwaysAllowTickets: true, decision: "ask" },
			{ autoApprovalEnabled: undefined, alwaysAllowTickets: true, decision: "ask" },
		])("requires both switches: $autoApprovalEnabled / $alwaysAllowTickets", async ({ decision, ...state }) => {
			await expect(checkAutoApproval({ ...request, state })).resolves.toEqual({ decision })
		})

		it("asks when settings are unavailable", async () => {
			await expect(checkAutoApproval(request)).resolves.toEqual({ decision: "ask" })
		})

		it("does not inherit authorization from other approval categories", async () => {
			await expect(
				checkAutoApproval({
					...request,
					state: {
						autoApprovalEnabled: true,
						alwaysAllowReadOnly: true,
						alwaysAllowWrite: true,
						alwaysAllowWriteOutsideWorkspace: true,
						alwaysAllowWriteProtected: true,
						alwaysAllowExecute: true,
						allowedCommands: ["*"],
						alwaysAllowMcp: true,
					},
				}),
			).resolves.toEqual({ decision: "ask" })
		})

		it.each([
			{ live: true, captured: true, decision: "approve" },
			{ live: true, captured: false, decision: "ask" },
			{ live: true, captured: undefined, decision: "ask" },
			{ live: false, captured: true, decision: "ask" },
		])("respects live $live and captured $captured grants", async ({ live, captured, decision }) => {
			await expect(
				checkAutoApprovalWithInheritedPolicy({
					...request,
					state: { autoApprovalEnabled: true, alwaysAllowTickets: live },
					inheritedState: {
						autoApprovalEnabled: true,
						alwaysAllowTickets: captured,
						alwaysAllowReadOnly: false,
						alwaysAllowReadOnlyOutsideWorkspace: false,
						alwaysAllowWrite: false,
						alwaysAllowWriteOutsideWorkspace: false,
						alwaysAllowWriteProtected: false,
						alwaysAllowExecute: false,
						alwaysAllowSubagents: false,
						commandApproval: createSubagentCommandApprovalPolicy([], [], "9".repeat(64)),
					},
				}),
			).resolves.toEqual({ decision })
		})
	})

	it.each([
		{ ask: "tool" as const, text: JSON.stringify({ tool: "newFileCreated", path: "ticket.md" }) },
		{ ask: "tool" as const, text: JSON.stringify({ tool: "readFile", path: "ticket.md" }) },
		{ ask: "command" as const, text: "git status" },
		{
			ask: "use_mcp_server" as const,
			text: JSON.stringify({ type: "use_mcp_tool", serverName: "linear", toolName: "update_issue" }),
		},
	])("does not authorize other categories through Alpha Tickets: $text", async (request) => {
		await expect(
			checkAutoApproval({
				...request,
				state: { autoApprovalEnabled: true, alwaysAllowTickets: true, allowedCommands: ["*"] },
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
				state: { autoApprovalEnabled: true, alwaysAllowTickets: true },
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it("requires manual deletion approval even when all relevant auto-approval categories are enabled", async () => {
		await expect(
			checkAutoApproval({
				ask: "tool",
				text: JSON.stringify({
					tool: "ticket",
					ticketActivity: { operation: "delete", state: "pending", name: "Ticket" },
				}),
				state: {
					autoApprovalEnabled: true,
					alwaysAllowTickets: true,
					alwaysAllowWrite: true,
					alwaysAllowWriteOutsideWorkspace: true,
					alwaysAllowWriteProtected: true,
					alwaysAllowMcp: true,
				},
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it("auto-approves delegation control tools when auto-approval is enabled", async () => {
		const state = {
			autoApprovalEnabled: true,
			alwaysAllowModeSwitch: false,
			alwaysAllowSubtasks: false,
		}

		await expect(
			checkAutoApproval({
				state,
				ask: "tool",
				text: JSON.stringify({ tool: "newTask", mode: "Architect" }),
			}),
		).resolves.toEqual({ decision: "approve" })

		await expect(
			checkAutoApproval({
				state,
				ask: "tool",
				text: JSON.stringify({ tool: "finishTask" }),
			}),
		).resolves.toEqual({ decision: "approve" })

		await expect(
			checkAutoApproval({
				state,
				ask: "tool",
				text: JSON.stringify({ tool: "switchMode", mode: "Code" }),
			}),
		).resolves.toEqual({ decision: "approve" })
	})

	it("keeps delegation control tools interactive when auto-approval is disabled", async () => {
		await expect(
			checkAutoApproval({
				state: { autoApprovalEnabled: false },
				ask: "tool",
				text: JSON.stringify({ tool: "newTask", mode: "Architect" }),
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it("auto-approves read-only sub-agents only when sub-agents and reads are both allowed", async () => {
		const request = { ask: "tool" as const, text: JSON.stringify({ tool: "delegateTask" }) }

		await expect(
			checkAutoApproval({
				...request,
				state: { autoApprovalEnabled: true, alwaysAllowSubagents: true, alwaysAllowReadOnly: true },
			}),
		).resolves.toEqual({ decision: "approve" })

		await expect(
			checkAutoApproval({
				...request,
				state: { autoApprovalEnabled: true, alwaysAllowSubagents: true, alwaysAllowReadOnly: false },
			}),
		).resolves.toEqual({ decision: "ask" })

		await expect(
			checkAutoApproval({
				...request,
				state: { autoApprovalEnabled: true, alwaysAllowSubagents: false, alwaysAllowReadOnly: true },
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it("applies the same auto-approval policy to asynchronous sub-agent spawns", async () => {
		const readOnlyRequest = {
			ask: "tool" as const,
			text: JSON.stringify({ tool: "spawnAgent", agent: { role: "explore" } }),
		}

		await expect(
			checkAutoApproval({
				...readOnlyRequest,
				state: { autoApprovalEnabled: true, alwaysAllowSubagents: true, alwaysAllowReadOnly: true },
			}),
		).resolves.toEqual({ decision: "approve" })

		await expect(
			checkAutoApproval({
				...readOnlyRequest,
				state: { autoApprovalEnabled: true, alwaysAllowSubagents: false, alwaysAllowReadOnly: true },
			}),
		).resolves.toEqual({ decision: "ask" })

		const workerRequest = {
			ask: "tool" as const,
			text: JSON.stringify({ tool: "spawnAgent", agent: { role: "worker" } }),
		}

		await expect(
			checkAutoApproval({
				...workerRequest,
				state: {
					autoApprovalEnabled: true,
					alwaysAllowSubagents: true,
					alwaysAllowReadOnly: true,
					alwaysAllowWrite: false,
				},
			}),
		).resolves.toEqual({ decision: "ask" })

		await expect(
			checkAutoApproval({
				...workerRequest,
				state: {
					autoApprovalEnabled: true,
					alwaysAllowSubagents: true,
					alwaysAllowReadOnly: true,
					alwaysAllowWrite: true,
				},
			}),
		).resolves.toEqual({ decision: "approve" })
	})

	it("does not use the legacy subtask permission for sub-agent delegation", async () => {
		await expect(
			checkAutoApproval({
				ask: "tool",
				text: JSON.stringify({ tool: "delegateTask" }),
				state: {
					autoApprovalEnabled: true,
					alwaysAllowSubtasks: true,
					alwaysAllowSubagents: false,
					alwaysAllowReadOnly: true,
				},
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it("requires read and write approval for a worker while leaving Execute separate", async () => {
		const request = {
			ask: "tool" as const,
			text: JSON.stringify({ tool: "delegateTask", agents: [{ role: "worker" }] }),
		}
		await expect(
			checkAutoApproval({
				ask: request.ask,
				text: request.text,
				state: {
					autoApprovalEnabled: true,
					alwaysAllowSubagents: true,
					alwaysAllowReadOnly: true,
					alwaysAllowWrite: false,
					alwaysAllowExecute: true,
				},
			}),
		).resolves.toEqual({ decision: "ask" })

		await expect(
			checkAutoApproval({
				ask: request.ask,
				text: request.text,
				state: {
					autoApprovalEnabled: true,
					alwaysAllowSubagents: true,
					alwaysAllowReadOnly: true,
					alwaysAllowWrite: true,
					alwaysAllowExecute: false,
				},
			}),
		).resolves.toEqual({ decision: "approve" })
	})
	it("treats an inherited sub-agent policy as an approval ceiling", async () => {
		const liveState = {
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowWrite: true,
			alwaysAllowExecute: true,
			alwaysAllowSubagents: true,
			allowedCommands: ["*"],
			deniedCommands: [],
		}
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
				text: JSON.stringify({ tool: "spawnAgent", agent: { role: "explore" } }),
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
				state: { ...liveState, autoApprovalEnabled: false },
				inheritedState: inheritedAll,
				ask: "command",
				text: "pnpm test",
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it("requires every frozen nested command ceiling to approve", async () => {
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
		const liveState = {
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowWrite: true,
			alwaysAllowExecute: true,
			alwaysAllowSubagents: true,
			allowedCommands: ["*"],
			deniedCommands: [],
		}

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
		).resolves.toEqual({ decision: "ask" })
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
