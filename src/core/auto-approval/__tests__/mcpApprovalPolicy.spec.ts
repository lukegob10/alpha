import type { McpServer } from "@alpha-code/types"

import { captureMcpApprovalPolicy, getMcpToolApprovalDecision } from "../mcpApprovalPolicy"

const toolUse = (annotations?: unknown) => ({
	type: "use_mcp_tool",
	serverName: "linear",
	toolName: "get_issue",
	annotations,
})

describe("captureMcpApprovalPolicy", () => {
	it("retains the first server and first tool for each selected source", () => {
		const server = (source: McpServer["source"], tools: NonNullable<McpServer["tools"]>): McpServer => ({
			name: "fixture",
			source,
			status: "connected",
			config: "{}",
			tools,
		})
		const servers = [
			server("global", [
				{ name: "blocked", alwaysAllow: false },
				{ name: "blocked", alwaysAllow: true },
				{ name: "allowed", alwaysAllow: true },
			]),
			server("global", [{ name: "later", alwaysAllow: true }]),
			server(undefined, [{ name: "legacy", alwaysAllow: true }]),
			server("project", [{ name: "project", alwaysAllow: true }]),
		]
		expect(captureMcpApprovalPolicy(true, servers).grants).toEqual([
			{ serverName: "fixture", source: "global", toolName: "allowed" },
			{ serverName: "fixture", source: "project", toolName: "project" },
		])
		expect(captureMcpApprovalPolicy(true, [servers[2], ...servers]).grants).toEqual(
			expect.arrayContaining([{ serverName: "fixture", toolName: "legacy" }]),
		)
	})

	it("captures a large catalog with a linear number of tool-name reads", () => {
		const count = 1_000
		let reads = 0
		const tools = Array.from({ length: count }, (_, index) => ({
			get name() {
				reads++
				return `lookup_${index}`
			},
			alwaysAllow: true,
		}))
		const policy = captureMcpApprovalPolicy(true, [
			{ name: "fixture", source: "global", status: "connected", config: "{}", tools },
		])
		expect(policy.grants).toHaveLength(count)
		expect(reads).toBeLessThanOrEqual(count * 3)
	})
})

describe("getMcpToolApprovalDecision", () => {
	it.each([
		["read-only annotation", { readOnlyHint: true }],
		["destructive annotation", { destructiveHint: true, readOnlyHint: true }],
		["incomplete annotations", { destructiveHint: false }],
		["unknown annotation", { readOnlyHint: true, futureHint: false }],
		["missing annotations", undefined],
	])("keeps an Auto MCP call gated with only a %s", (_name, annotations) => {
		expect(getMcpToolApprovalDecision("auto", toolUse(annotations), false)).toBe("ask")
	})

	it.each(["ask", "auto"] as const)("honors an explicit saved grant in %s", (mode) => {
		expect(getMcpToolApprovalDecision(mode, toolUse({ readOnlyHint: true, destructiveHint: true }), true)).toBe(
			"approve",
		)
		expect(getMcpToolApprovalDecision(mode, toolUse({ futureHint: true }), true)).toBe("approve")
	})

	it("keeps Ask strict when no saved grant exists and lets Bypass approve a valid MCP call", () => {
		expect(getMcpToolApprovalDecision("ask", toolUse({ readOnlyHint: true }), false)).toBe("ask")
		expect(getMcpToolApprovalDecision("bypass", toolUse({ futureHint: true }), false)).toBe("approve")
	})

	it.each([
		undefined,
		{ type: "use_mcp_tool", serverName: "linear", toolName: "" },
		{ type: "access_mcp_resource", serverName: "linear", toolName: "get_issue" },
		{ type: "use_mcp_tool", serverName: "linear", toolName: "get_issue", source: "other" },
	])("fails closed for malformed MCP tool identity: %j", (use) => {
		expect(getMcpToolApprovalDecision("bypass", use, true)).toBe("ask")
	})

	it("fails closed for an unknown approval mode even when a grant is present", () => {
		expect(getMcpToolApprovalDecision("unknown", toolUse({ readOnlyHint: true }), true)).toBe("ask")
	})

	it("preserves an explicit grant for the legacy settings path", () => {
		expect(getMcpToolApprovalDecision(undefined, toolUse(undefined), true)).toBe("approve")
		expect(getMcpToolApprovalDecision(undefined, toolUse(undefined), false)).toBe("ask")
	})
})
