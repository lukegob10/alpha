import { describe, expect, it } from "vitest"
import {
	deriveAutoApprovalFlags,
	disabledSubagentAutoApprovalPolicy,
	inferApprovalModeFromPolicy,
	type McpServer,
} from "@alpha-code/types"

import {
	captureToolReviewPolicy,
	checkAutoApproval,
	checkAutoApprovalWithInheritedPolicy,
	type CheckAutoApprovalInput,
} from "../index"
import { createToolPolicySnapshot } from "../../agent/ToolPolicy"
import { applyExecutionProfile, resolveExecutionProfile } from "../../agent/ExecutionProfile"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { createSubagentCommandApprovalPolicy } from "../commands"

const protectedWrite = JSON.stringify({ tool: "editedExistingFile", path: ".alphaignore" })
const mcpUse = (overrides: Record<string, unknown> = {}) =>
	JSON.stringify({ type: "use_mcp_tool", serverName: "fixture", source: "global", toolName: "lookup", ...overrides })

function state(): NonNullable<CheckAutoApprovalInput["state"]> & { mcpServers: McpServer[] } {
	return {
		approvalMode: "auto",
		alwaysAllowWriteProtected: true,
		alwaysAllowMcp: true,
		mcpServers: [
			{
				name: "fixture",
				source: "global",
				config: "{}",
				status: "connected",
				tools: [{ name: "lookup", alwaysAllow: true }],
			},
		],
	}
}

describe("captured tool review ceiling", () => {
	it("copies and freezes protected-file and exact MCP options without retaining mutable settings", () => {
		const live = state()
		const captured = captureToolReviewPolicy(live)
		live.alwaysAllowWriteProtected = false
		live.alwaysAllowMcp = false
		live.mcpServers[0].source = "project"
		live.mcpServers[0].tools![0].name = "changed"
		live.mcpServers[0].tools!.push({ name: "later", alwaysAllow: true })

		expect(captured).toMatchObject({
			protectedWriteAllowed: true,
			mcp: {
				enabled: true,
				grants: expect.arrayContaining([{ serverName: "fixture", source: "global", toolName: "lookup" }]),
			},
		})
		expect(captured.mcp.grants).toHaveLength(1)
		expect(Object.isFrozen(captured)).toBe(true)
		expect(Object.isFrozen(captured.mcp)).toBe(true)
		expect(Object.isFrozen(captured.mcp.grants)).toBe(true)
		expect(Object.isFrozen(captured.mcp.grants[0])).toBe(true)
	})

	it.each([
		{ captured: false, live: true, decision: "ask" },
		{ captured: true, live: false, decision: "ask" },
		{ captured: true, live: true, decision: "approve" },
	])("intersects protected-file options ($captured/$live → $decision)", async (testCase) => {
		const live = state()
		live.alwaysAllowWriteProtected = testCase.captured
		const reviewPolicy = captureToolReviewPolicy(live)
		live.alwaysAllowWriteProtected = testCase.live

		await expect(
			checkAutoApproval({ state: live, reviewPolicy, ask: "tool", text: protectedWrite, isProtected: true }),
		).resolves.toEqual({ decision: testCase.decision })
	})

	it.each([
		{ captured: false, live: true, decision: "ask" },
		{ captured: true, live: false, decision: "ask" },
		{ captured: true, live: true, decision: "approve" },
	])("intersects protected command-write options ($captured/$live → $decision)", async (testCase) => {
		const live = state()
		live.allowedCommands = ["Set-Content"]
		live.alwaysAllowWriteProtected = testCase.captured
		const reviewPolicy = captureToolReviewPolicy(live)
		live.alwaysAllowWriteProtected = testCase.live

		await expect(
			checkAutoApproval({
				state: live,
				reviewPolicy,
				ask: "command",
				text: "Set-Content AGENTS.md synthetic-content",
				isProtected: true,
			}),
		).resolves.toEqual({ decision: testCase.decision })
	})

	it.each([false, true])("retains inherited protected command-write permission %s", async (permitted) => {
		const live = state()
		live.allowedCommands = ["Set-Content"]
		const inheritedState = {
			...disabledSubagentAutoApprovalPolicy,
			...deriveAutoApprovalFlags("auto"),
			alwaysAllowWriteProtected: permitted,
			commandApproval: createSubagentCommandApprovalPolicy(["Set-Content"], []),
		}

		await expect(
			checkAutoApprovalWithInheritedPolicy({
				state: live,
				inheritedState,
				reviewPolicy: captureToolReviewPolicy(live),
				ask: "command",
				text: "Set-Content AGENTS.md synthetic-content",
				isProtected: true,
			}),
		).resolves.toEqual({ decision: permitted ? "approve" : "ask" })
	})

	it("retains explicit command denials before protected-write review", async () => {
		const live = state()
		live.allowedCommands = ["Set-Content"]
		live.deniedCommands = ["Set-Content"]
		live.alwaysAllowWriteProtected = false

		await expect(
			checkAutoApproval({
				state: live,
				reviewPolicy: captureToolReviewPolicy(live),
				ask: "command",
				text: "Set-Content AGENTS.md synthetic-content",
				isProtected: true,
			}),
		).resolves.toEqual({ decision: "deny" })
	})

	it.each(["ask", "auto"] as const)("requires both captured and live exact MCP grants in %s", async (mode) => {
		const live = state()
		live.approvalMode = mode
		live.mcpServers[0].tools![0].alwaysAllow = false
		const withoutGrant = captureToolReviewPolicy(live)
		live.mcpServers[0].tools![0].alwaysAllow = true
		await expect(
			checkAutoApproval({ state: live, reviewPolicy: withoutGrant, ask: "use_mcp_server", text: mcpUse() }),
		).resolves.toEqual({ decision: "ask" })

		const granted = captureToolReviewPolicy(live)
		await expect(
			checkAutoApproval({ state: live, reviewPolicy: granted, ask: "use_mcp_server", text: mcpUse() }),
		).resolves.toEqual({ decision: "approve" })
		live.mcpServers[0].tools![0].alwaysAllow = false
		await expect(
			checkAutoApproval({ state: live, reviewPolicy: granted, ask: "use_mcp_server", text: mcpUse() }),
		).resolves.toEqual({ decision: "ask" })
	})

	it.each([{ serverName: "other" }, { toolName: "other" }, { source: "project" }])(
		"does not transfer an exact MCP grant to a changed identity: %j",
		async (changed) => {
			const live = state()
			const reviewPolicy = captureToolReviewPolicy(live)
			live.mcpServers.push({
				...live.mcpServers[0],
				name: typeof changed.serverName === "string" ? changed.serverName : "fixture",
				source: changed.source === "project" ? "project" : "global",
				tools: [
					{ name: typeof changed.toolName === "string" ? changed.toolName : "lookup", alwaysAllow: true },
				],
			})

			await expect(
				checkAutoApproval({ state: live, reviewPolicy, ask: "use_mcp_server", text: mcpUse(changed) }),
			).resolves.toEqual({ decision: "ask" })
		},
	)

	it.each([
		{ captured: false, live: true, decision: "ask" },
		{ captured: true, live: false, decision: "ask" },
		{ captured: true, live: true, decision: "approve" },
	])("intersects MCP global/resource options ($captured/$live → $decision)", async (testCase) => {
		const live = state()
		live.alwaysAllowMcp = testCase.captured
		const reviewPolicy = captureToolReviewPolicy(live)
		live.alwaysAllowMcp = testCase.live
		for (const text of [mcpUse(), mcpUse({ type: "access_mcp_resource", uri: "fixture://proof" })]) {
			await expect(
				checkAutoApproval({ state: live, reviewPolicy, ask: "use_mcp_server", text }),
			).resolves.toEqual({
				decision: testCase.decision,
			})
		}
	})

	it("preserves Full Access without requiring exact MCP grants", async () => {
		const live = state()
		live.approvalMode = "bypass"
		live.alwaysAllowWriteProtected = false
		live.alwaysAllowMcp = false
		live.mcpServers = []
		const reviewPolicy = captureToolReviewPolicy(live)

		expect(reviewPolicy).toMatchObject({ protectedWriteAllowed: true, mcp: { enabled: true, grants: [] } })
		await expect(
			checkAutoApproval({ state: live, reviewPolicy, ask: "tool", text: protectedWrite, isProtected: true }),
		).resolves.toEqual({ decision: "approve" })
		await expect(
			checkAutoApproval({
				state: live,
				reviewPolicy,
				ask: "command",
				text: "Set-Content AGENTS.md synthetic-content",
				isProtected: true,
			}),
		).resolves.toEqual({ decision: "approve" })
		await expect(
			checkAutoApproval({ state: live, reviewPolicy, ask: "use_mcp_server", text: mcpUse() }),
		).resolves.toEqual({ decision: "approve" })
	})

	it("denies child Full Access permissions outside a closed invoking review ceiling", async () => {
		const live = state()
		live.approvalMode = "bypass"
		const reviewPolicy = captureToolReviewPolicy()
		const inheritedState = {
			...disabledSubagentAutoApprovalPolicy,
			...deriveAutoApprovalFlags("bypass"),
			commandApproval: { ...disabledSubagentAutoApprovalPolicy.commandApproval, allowAll: true },
		}
		expect(inferApprovalModeFromPolicy(inheritedState)).toBe("bypass")
		for (const input of [
			{ ask: "tool" as const, text: protectedWrite, isProtected: true },
			{ ask: "command" as const, text: "Set-Content AGENTS.md synthetic-content", isProtected: true },
			{ ask: "use_mcp_server" as const, text: mcpUse() },
		]) {
			await expect(
				checkAutoApprovalWithInheritedPolicy({ ...input, state: live, inheritedState, reviewPolicy }),
			).resolves.toEqual({ decision: "deny" })
		}
	})

	it("preserves legacy source-less MCP server selection without granting a new source", async () => {
		const live = state()
		live.mcpServers[0].source = undefined
		const reviewPolicy = captureToolReviewPolicy(live)
		for (const source of [undefined, "global", "project"]) {
			await expect(
				checkAutoApproval({ state: live, reviewPolicy, ask: "use_mcp_server", text: mcpUse({ source }) }),
			).resolves.toEqual({ decision: "approve" })
		}
	})

	it.each(["scoped-duplicate", "legacy-added-source"] as const)(
		"does not transfer a source-less review grant when live server selection changes (%s)",
		async (scenario) => {
			const live = state()
			if (scenario === "legacy-added-source") live.mcpServers[0].source = undefined
			const project: McpServer = {
				...live.mcpServers[0],
				source: "project",
				tools: [{ name: "lookup", alwaysAllow: false }],
			}
			if (scenario === "scoped-duplicate") live.mcpServers.push(project)
			const reviewPolicy = captureToolReviewPolicy(live)
			await expect(
				checkAutoApproval({
					state: live,
					reviewPolicy,
					ask: "use_mcp_server",
					text: mcpUse({ source: undefined }),
				}),
			).resolves.toEqual({ decision: "approve" })

			project.tools![0].alwaysAllow = true
			live.mcpServers = [project, live.mcpServers[0]]
			for (const source of [undefined, "project"]) {
				await expect(
					checkAutoApproval({ state: live, reviewPolicy, ask: "use_mcp_server", text: mcpUse({ source }) }),
				).resolves.toEqual({ decision: "ask" })
			}
			if (scenario === "scoped-duplicate") {
				await expect(
					checkAutoApproval({ state: live, reviewPolicy, ask: "use_mcp_server", text: mcpUse() }),
				).resolves.toEqual({ decision: "approve" })
			}
		},
	)

	it("preserves legacy no-step decisions when a caller has no captured ceiling", async () => {
		const live = state()
		await expect(
			checkAutoApproval({ state: live, ask: "tool", text: protectedWrite, isProtected: true }),
		).resolves.toEqual({ decision: "approve" })
		await expect(checkAutoApproval({ state: live, ask: "use_mcp_server", text: mcpUse() })).resolves.toEqual({
			decision: "approve",
		})
	})

	it.each([
		(live: ReturnType<typeof state>) => (live.alwaysAllowWriteProtected = false),
		(live: ReturnType<typeof state>) => (live.alwaysAllowMcp = false),
		(live: ReturnType<typeof state>) => (live.mcpServers[0].tools![0].alwaysAllow = false),
		(live: ReturnType<typeof state>) => (live.mcpServers[0].source = "project"),
	])("includes each review option in the locally computed policy digest", (change) => {
		const live = state()
		const capture = () =>
			createToolPolicySnapshot({ visibleTools: ["read_file"], reviewPolicy: captureToolReviewPolicy(live) })
		const before = capture()
		change(live)

		expect(capture().digest).not.toBe(before.digest)
		expect(before.approval.reviewPolicy).toMatchObject({
			protectedWriteAllowed: true,
			mcp: {
				enabled: true,
				grants: expect.arrayContaining([{ serverName: "fixture", toolName: "lookup", source: "global" }]),
			},
		})
	})

	it.each(["work", "plan"] as const)(
		"retains the ceiling through the %s profile and surface rehydration",
		(profile) => {
			const reviewPolicy = captureToolReviewPolicy(state())
			const policy = createToolPolicySnapshot({ visibleTools: [], reviewPolicy })
			const profiled = applyExecutionProfile(resolveExecutionProfile(profile), policy, [])
			const surface = createTaskToolSurface({
				registry: new ToolRegistry({ includeBuiltIns: false }),
				policy: structuredClone(profiled.policy),
				profile,
			})
			const rehydrated = createTaskToolSurface({
				registry: new ToolRegistry({ includeBuiltIns: false }),
				policy: structuredClone(surface.policy),
				profile,
			})

			expect(profiled.policy.approval.reviewPolicy).toEqual(reviewPolicy)
			expect(surface.policy.approval.reviewPolicy).toEqual(reviewPolicy)
			expect(rehydrated.policy.approval.reviewPolicy).toEqual(reviewPolicy)
			expect(rehydrated.policy.digest).toBe(surface.policy.digest)
			expect(Object.isFrozen(rehydrated.policy.approval.reviewPolicy?.mcp.grants)).toBe(true)
		},
	)
})
