import { describe, expect, it } from "vitest"

import { checkAutoApproval } from "../index"

describe("checkAutoApproval", () => {
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
})
