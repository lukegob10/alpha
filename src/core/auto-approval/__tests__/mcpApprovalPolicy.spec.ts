import { requiresMcpToolApproval } from "../mcpApprovalPolicy"

describe("requiresMcpToolApproval", () => {
	it.each([
		["read-only tools", { readOnlyHint: true }, false],
		["closed-world non-destructive tools", { destructiveHint: false, openWorldHint: false }, false],
		["destructive tools", { destructiveHint: true, readOnlyHint: true }, true],
		["open-world tools", { destructiveHint: false, openWorldHint: true }, true],
		["incomplete annotations", { destructiveHint: false }, true],
		["empty annotations", {}, true],
		["missing annotations", undefined, true],
	])("Auto requires approval for %s", (_name, annotations, requiresApproval) => {
		expect(requiresMcpToolApproval("auto", annotations)).toBe(requiresApproval)
	})

	it.each([
		["read-only tools", { readOnlyHint: true }, false],
		["destructive read-only tools", { readOnlyHint: true, destructiveHint: true }, true],
		["tools that can write", { readOnlyHint: false }, true],
		["missing annotations", undefined, true],
	])("Writes requires approval for %s", (_name, annotations, requiresApproval) => {
		expect(requiresMcpToolApproval("writes", annotations)).toBe(requiresApproval)
	})

	it("always requires approval in Prompt mode and never in Approve mode", () => {
		const annotations = { readOnlyHint: true }
		expect(requiresMcpToolApproval("prompt", annotations)).toBe(true)
		expect(requiresMcpToolApproval("approve", undefined)).toBe(false)
	})

	it.each([[{ readOnlyHint: "true" }], [{ readOnlyHint: true, futureHint: false }], [{ audience: ["system"] }]])(
		"fails closed for invalid or unknown annotations: %j",
		(annotations) => {
			expect(requiresMcpToolApproval("auto", annotations)).toBe(true)
		},
	)

	it("fails closed for an unknown approval mode", () => {
		expect(requiresMcpToolApproval("unknown", { readOnlyHint: true })).toBe(true)
	})
})
