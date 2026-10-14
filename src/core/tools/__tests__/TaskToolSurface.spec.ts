import { describe, expect, it } from "vitest"

import { createToolPolicySnapshot, isCommandDeniedByPolicy, isPathAllowed } from "../../agent/ToolPolicy"
import { createTaskToolSurface } from "../TaskToolSurface"
import { ToolRegistry, type ToolDescriptor } from "../ToolRegistry"

function schema(name: string) {
	return {
		type: "function" as const,
		function: {
			name,
			description: `${name} fixture`,
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
	}
}

function descriptor(name: string, capabilities: ToolDescriptor["capabilities"]): ToolDescriptor {
	return {
		name,
		aliases: [],
		schema: schema(name),
		capabilities,
		execute: async () => {},
	}
}

const readCapabilities = {
	concurrency: "serial" as const,
	sideEffects: "none" as const,
	controlFlow: false,
	requiresApproval: false,
}
const writeCapabilities = {
	concurrency: "serial" as const,
	sideEffects: "workspace" as const,
	controlFlow: false,
	requiresApproval: true,
}

function registry() {
	const result = new ToolRegistry({ includeBuiltIns: false })
	result.register(descriptor("read_file", readCapabilities))
	result.register(descriptor("write_to_file", writeCapabilities))
	return result
}

describe("TaskToolSurface", () => {
	it.each(["ask", "auto", "bypass"] as const)(
		"captures the %s approval tier and carries it to child surfaces",
		(mode) => {
			const primary = createTaskToolSurface({
				registry: registry(),
				approvalMode: mode,
				autoApprovalEnabled: mode !== "ask",
			})
			const child = createTaskToolSurface({
				registry: registry(),
				policy: primary.policy,
				taskKind: "subagent",
			})

			expect(primary.policy.approval.mode).toBe(mode)
			expect(child.policy.approval.mode).toBe(mode)
			expect(child.policy.digest).toBe(primary.policy.digest)
		},
	)

	it.each(["code", "architect"])(
		"allows primary outside paths under the %s profile without widening inherited policy",
		(mode) => {
			const primary = createTaskToolSurface({
				registry: registry(),
				cwd: process.cwd(),
				taskKind: "primary",
				mode,
			})
			expect(primary.policy.execution.outsideWorkspace).toBe("approval")
			expect(primary.isCallable("write_to_file")).toBe(mode === "code")
			const child = createTaskToolSurface({
				registry: registry(),
				cwd: process.cwd(),
				taskKind: "subagent",
				policy: primary.policy,
				mode,
			})
			expect(child.policy.execution.outsideWorkspace).toBeUndefined()
			const restricted = createTaskToolSurface({ registry: registry(), cwd: process.cwd(), mode })
			expect(
				createTaskToolSurface({
					registry: registry(),
					cwd: process.cwd(),
					taskKind: "primary",
					policy: restricted.policy,
					mode,
				}).policy.execution.outsideWorkspace,
			).toBeUndefined()
		},
	)

	it("keeps an explicitly empty projection empty even when the sealed registry has descriptors", () => {
		const source = registry()
		const surface = createTaskToolSurface({ registry: source, schemas: [] })
		expect(source.has("read_file")).toBe(true)
		expect(source.isSealed()).toBe(true)
		expect(surface.schemas).toEqual([])
		expect(surface.allowedFunctionNames).toEqual([])
		expect(surface.isCallable("read_file")).toBe(false)
		expect(surface.resolve("read_file")).toBeUndefined()
	})

	it("keeps visible schemas and executable descriptors in one canonical namespace", () => {
		const surface = createTaskToolSurface({
			registry: registry(),
			schemas: [schema("read_file"), schema("write_file"), schema("write_to_file")],
			allowedToolNames: ["read_file", "write_file"],
			disabledTools: ["write_file"],
			mode: "code",
		})

		expect(surface.schemas.map((tool) => tool.type === "function" && tool.function.name)).toEqual(["read_file"])
		expect(surface.allowedFunctionNames).toEqual(["read_file"])
		expect(surface.resolve("read_file")?.name).toBe("read_file")
		expect(surface.resolve("write_file")).toBeUndefined()
		expect(surface.isCallable("write_file")).toBe(false)
		expect(surface.policy.disabledTools).toEqual(["write_to_file"])
	})

	it("limits diagnostic sessions to the registered evidence reader and denies workspace execution", () => {
		const source = new ToolRegistry({ includeBuiltIns: false })
		const diagnostic = descriptor("read_diagnostic_evidence", readCapabilities)
		source.register(diagnostic)
		source.register(descriptor("write_to_file", writeCapabilities))
		source.register(descriptor("spawn_agent", { ...readCapabilities, controlFlow: true, sideEffects: "task" }))
		source.register(descriptor("mcp__filesystem__read_file", readCapabilities))
		const callerSchema = schema("read_diagnostic_evidence")
		callerSchema.function.parameters.properties = { path: { type: "string" } }

		const surface = createTaskToolSurface({
			registry: source,
			schemas: [
				callerSchema,
				schema("write_to_file"),
				schema("spawn_agent"),
				schema("mcp--filesystem--read_file"),
			],
			visibleToolNames: [
				"read_diagnostic_evidence",
				"write_to_file",
				"spawn_agent",
				"mcp__filesystem__read_file",
			],
			allowedToolNames: [
				"read_diagnostic_evidence",
				"write_to_file",
				"spawn_agent",
				"mcp__filesystem__read_file",
			],
			includeAllToolsWithRestrictions: true,
			mode: "code",
			cwd: "F:/workspace",
			diagnosticSession: true,
			diagnosticSourceTaskId: "source-task-1",
		})

		expect(surface.schemas).toEqual([diagnostic.schema])
		expect(surface.schemas[0]).not.toMatchObject({
			function: { parameters: { properties: { path: expect.anything() } } },
		})
		expect(surface.allowedFunctionNames).toEqual(["read_diagnostic_evidence"])
		expect(surface.includeAllToolsWithRestrictions).toBe(false)
		expect(surface.isCallable("read_diagnostic_evidence")).toBe(true)
		expect(surface.resolve("write_to_file")).toBeUndefined()
		expect(surface.isCallable("spawn_agent")).toBe(false)
		expect(surface.isCallable("mcp__filesystem__read_file")).toBe(false)
		expect(surface.policy.execution.sandboxMode).toBe("read-only")
		expect(surface.policy.execution.workspaceRoots).toEqual([])
		expect(surface.policy.execution.outsideWorkspace).toBeUndefined()
		expect(isPathAllowed(surface.policy, "src/index.ts", "F:/workspace")).toBe(false)
		expect(isCommandDeniedByPolicy(surface.policy, "git status")).toBe(true)
		expect(surface.policy.summary).toContain("workspace access and commands are unavailable")
		expect(surface.policy.summary).not.toContain("Command approval: follows global")
	})

	it("keeps the diagnostic reader hidden from ordinary task surfaces", () => {
		const diagnostic = descriptor("read_diagnostic_evidence", readCapabilities)
		const source = new ToolRegistry({ includeBuiltIns: false })
		source.register(diagnostic)
		const surface = createTaskToolSurface({
			registry: source,
			schemas: [diagnostic.schema],
			visibleToolNames: ["read_diagnostic_evidence"],
			allowedToolNames: ["read_diagnostic_evidence"],
			mode: "code",
		})

		expect(surface.schemas).toEqual([])
		expect(surface.allowedFunctionNames).toEqual([])
		expect(surface.resolve("read_diagnostic_evidence")).toBeUndefined()
		expect(surface.isCallable("read_diagnostic_evidence")).toBe(false)
	})

	it("fails closed for missing, invalid, or subagent diagnostic authority", () => {
		const source = new ToolRegistry({ nativeTools: [schema("read_diagnostic_evidence")] })
		const input = {
			registry: source,
			schemas: [schema("read_diagnostic_evidence")],
			diagnosticSession: true,
		}

		expect(createTaskToolSurface(input).schemas).toEqual([])
		expect(createTaskToolSurface({ ...input, diagnosticSourceTaskId: "x".repeat(129) }).schemas).toEqual([])
		expect(
			createTaskToolSurface({ ...input, diagnosticSourceTaskId: "source-1", taskKind: "subagent" }).schemas,
		).toEqual([])
	})

	it("prefers a canonical schema when an alias appears first", () => {
		const alias = schema("write_file")
		alias.function.description = "legacy alias schema"
		const canonical = schema("write_to_file")
		canonical.function.description = "canonical schema"

		const surface = createTaskToolSurface({
			registry: registry(),
			schemas: [alias, canonical],
		})

		expect(surface.schemas).toHaveLength(1)
		expect(surface.schemas[0]).toMatchObject({
			function: { name: "write_to_file", description: "canonical schema" },
		})
	})

	it.each([
		["work", ["read_file", "write_to_file"]],
		["plan", ["read_file"]],
	] as const)("applies the %s profile once to callable names", (profile, expected) => {
		const surface = createTaskToolSurface({
			registry: registry(),
			schemas: [schema("read_file"), schema("write_to_file")],
			allowedToolNames: ["read_file", "write_to_file"],
			profile,
		})

		expect(surface.allowedFunctionNames).toEqual(expected)
		expect(surface.schemas.map((tool) => tool.type === "function" && tool.function.name)).toEqual(expected)
	})

	it("retains a provider schema superset while failing closed for disallowed calls", () => {
		const surface = createTaskToolSurface({
			registry: registry(),
			schemas: [schema("read_file"), schema("write_to_file")],
			allowedToolNames: ["read_file"],
			includeAllToolsWithRestrictions: true,
		})

		expect(surface.schemas.map((tool) => tool.type === "function" && tool.function.name)).toEqual([
			"read_file",
			"write_to_file",
		])
		expect(surface.allowedFunctionNames).toEqual(["read_file"])
		expect(surface.registry.resolve("write_to_file")).toBeDefined()
		expect(surface.resolve("write_to_file")).toBeUndefined()
		expect(surface.policy.visibleTools).toEqual(["read_file", "write_to_file"])
	})

	it("computes policy and surface digests instead of trusting caller values", () => {
		const input = {
			visibleTools: ["read_file"],
			allowedTools: ["read_file"],
			digest: "caller-controlled",
		}
		const firstPolicy = createToolPolicySnapshot(input)
		const secondPolicy = createToolPolicySnapshot({ ...input, digest: "a-different-value" })

		expect(firstPolicy.digest).not.toBe("caller-controlled")
		expect(firstPolicy.digest).toBe(secondPolicy.digest)

		const first = createTaskToolSurface({
			registry: registry(),
			schemas: [schema("read_file")],
			policy: firstPolicy,
		})
		const second = createTaskToolSurface({
			registry: registry(),
			schemas: [schema("read_file")],
			policy: secondPolicy,
		})
		expect(first.digest).toBe(second.digest)
	})

	it("captures a frozen read grant without changing descriptor approval metadata", () => {
		const source = new ToolRegistry({ includeBuiltIns: false })
		const readFixture = descriptor("fixture_read", { ...readCapabilities, requiresApproval: true })
		source.register(readFixture)
		const liveGrant = {
			enabled: true,
			workspaceRoot: "C:\\workspace",
			showIgnoredFiles: false,
		}
		const surface = createTaskToolSurface({
			registry: source,
			schemas: [readFixture.schema],
			visibleToolNames: ["fixture_read"],
			allowedToolNames: ["fixture_read"],
			autoApprovalEnabled: true,
			readGrant: liveGrant,
			applyProfile: false,
		})

		expect(surface.readGrant).toEqual(liveGrant)
		expect(surface.readGrant).not.toBe(liveGrant)
		expect(Object.isFrozen(surface.readGrant)).toBe(true)
		expect(surface.registry.resolve("fixture_read")?.capabilities.requiresApproval).toBe(true)
		expect(() => Object.assign(surface.readGrant!, { enabled: false })).toThrow()

		liveGrant.enabled = false
		liveGrant.workspaceRoot = "C:\\other-workspace"
		liveGrant.showIgnoredFiles = true
		expect(surface.readGrant).toEqual({
			enabled: true,
			workspaceRoot: "C:\\workspace",
			showIgnoredFiles: false,
		})
	})

	it("disables an omitted or non-auto-approved read grant", () => {
		const source = new ToolRegistry({ includeBuiltIns: false })
		const readFixture = descriptor("fixture_read", { ...readCapabilities, requiresApproval: true })
		source.register(readFixture)
		const input = {
			registry: source,
			schemas: [readFixture.schema],
			visibleToolNames: ["fixture_read"],
			allowedToolNames: ["fixture_read"],
			applyProfile: false,
		}

		expect(createTaskToolSurface(input).readGrant).toBeUndefined()
		const disabled = createTaskToolSurface({
			...input,
			autoApprovalEnabled: false,
			readGrant: {
				enabled: true,
				workspaceRoot: "C:\\workspace",
				showIgnoredFiles: true,
			},
		})
		expect(disabled.policy.approval.autoApprovalEnabled).toBe(false)
		expect(disabled.readGrant).toEqual({
			enabled: false,
			workspaceRoot: "C:\\workspace",
			showIgnoredFiles: true,
		})
	})

	it("normalizes dynamic MCP names while preserving one descriptor", () => {
		const mcpRegistry = new ToolRegistry({
			nativeTools: [],
			mcpTools: [schema("mcp--filesystem--read_file")],
		})
		const surface = createTaskToolSurface({
			registry: mcpRegistry,
			schemas: [schema("mcp__filesystem__read_file")],
		})

		expect(surface.schemas).toHaveLength(1)
		expect(surface.schemas[0]).toMatchObject({ function: { name: "mcp--filesystem--read_file" } })
		expect(surface.registry.resolve("mcp__filesystem__read_file")?.name).toBe("mcp--filesystem--read_file")
		expect(surface.isCallable("mcp__filesystem__read_file")).toBe(true)
	})
})
