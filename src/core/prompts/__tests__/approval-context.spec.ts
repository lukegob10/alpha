import { describe, expect, it } from "vitest"

import { buildApprovalContextInstructionPart, buildApprovalContextInstructionPartForMode } from "../approval-context"

describe("buildApprovalContextInstructionPart", () => {
	it.each(["ask", "auto", "bypass"] as const)("projects captured %s guidance", (mode) => {
		const part = buildApprovalContextInstructionPart({
			approval: {
				mode,
				autoApprovalEnabled: mode !== "ask",
				liveRevalidation: true,
			},
		})

		expect(part).toMatchObject({ role: "developer", origin: "approval-context" })
		expect(part.content.toLowerCase()).toContain(`approval mode is ${mode}`)
		expect(part.content).not.toMatch(/sandbox|writable roots?/i)
		expect(Object.isFrozen(part)).toBe(true)
	})

	it.each(["ask", "auto", "bypass"] as const)("uses identical %s text from mode and policy snapshots", (mode) => {
		const fromMode = buildApprovalContextInstructionPartForMode(mode)
		const fromPolicy = buildApprovalContextInstructionPart({
			approval: { mode, autoApprovalEnabled: mode !== "ask", liveRevalidation: true },
		})

		expect(fromMode).toEqual(fromPolicy)
	})

	it("defaults legacy snapshots without a captured mode to Ask", () => {
		const part = buildApprovalContextInstructionPart({
			approval: { autoApprovalEnabled: true, liveRevalidation: true },
		})

		expect(part.content).toContain("approval mode is Ask")
		expect(part.content).not.toContain("Bypass")
	})

	it("keeps mandatory approval and host denials authoritative in every mode", () => {
		for (const mode of ["ask", "auto", "bypass"] as const) {
			const part = buildApprovalContextInstructionPart({
				approval: { mode, autoApprovalEnabled: mode !== "ask", liveRevalidation: true },
			})

			expect(part.content).toMatch(/host|explicit approval|approval request/i)
		}
	})
})
