import { createToolFailure, formatToolFailureGuidance, normalizeToolFailure } from "../ToolFailure"

describe("trusted failure metadata", () => {
	const failure = createToolFailure({
		reason: "pre_launch_rejected",
		scopeKind: "capability",
		scopeIdentity: ["private-token", "/private/workspace", "secret command"],
		effectsStarted: "no",
		outcome: "known",
		recovery: { kind: "repair" },
	})

	it("retains only bounded fingerprints and supported metadata fields", () => {
		const normalized = normalizeToolFailure({
			...failure,
			output: "private-token",
			recovery: { ...failure.recovery, command: "secret command" },
		})
		expect(normalized).toEqual(failure)
		expect(JSON.stringify(normalized)).not.toMatch(/private-token|private\/workspace|secret command/)
	})

	it("rejects unbounded scope and recovery identifiers", () => {
		expect(
			normalizeToolFailure({ ...failure, affectedScope: { kind: "workspace", fingerprint: "private path" } }),
		).toBeUndefined()
		expect(
			normalizeToolFailure({ ...failure, recovery: { kind: "alternative", toolName: "x".repeat(129) } }),
		).toBeUndefined()
	})

	it("requires reconciliation when a caller suggests retrying an unknown outcome", () => {
		const unknown = normalizeToolFailure({ ...failure, outcome: "unknown", effectsStarted: "unknown" })
		expect(unknown?.recovery).toEqual({ kind: "verify-outcome" })
		expect(formatToolFailureGuidance(unknown!)).toContain("before repeating")
	})
})
