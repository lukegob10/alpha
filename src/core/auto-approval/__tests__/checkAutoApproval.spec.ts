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
})
