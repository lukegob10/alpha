import type { McpServer, ModelInfo, ModeConfig, CustomToolDefinition } from "@alpha-code/types"
import { parametersSchema as z } from "@alpha-code/types"
import { customToolRegistry } from "@alpha-code/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const testState = vi.hoisted(() => ({
	browserToolNames: [] as string[],
	codeIndex: {
		isFeatureEnabled: false,
		isFeatureConfigured: false,
		isInitialized: false,
	},
}))

vi.mock("../../../services/browser/VSCodeBrowserTools", () => ({
	getAvailableVSCodeBrowserToolNames: () => [...testState.browserToolNames],
}))

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => testState.codeIndex,
	},
}))

import type { ToolCallbacks } from "../../tools/BaseTool"
import type { TaskReadGrant, ToolDescriptor, ToolExecutionContext } from "../../tools/ToolRegistry"
import type { ClineProvider } from "../../webview/ClineProvider"
import type { Task } from "../Task"
import { buildNativeToolsArrayWithRestrictions, type BuildToolsOptions } from "../build-tools"
import { TaskToolCatalogCache } from "../TaskToolCatalogCache"

function createServer(): McpServer {
	return {
		name: "calendar",
		config: "{}",
		status: "connected",
		source: "global",
		tools: [
			{
				name: "lookup",
				description: "Look up a calendar entry.",
				inputSchema: {
					type: "object",
					properties: { query: { type: "string" } },
					required: ["query"],
					additionalProperties: false,
				},
			},
			{
				name: "list",
				description: "List calendar entries.",
				inputSchema: { type: "object", additionalProperties: false },
			},
		],
	}
}

function createFixture() {
	const servers = [createServer()]
	const hub = {
		connections: [],
		getServers: () => servers,
	}
	const provider = {
		context: {},
		getMcpHub: () => hub,
	}
	const modelInfo: ModelInfo = {
		contextWindow: 128_000,
		supportsPromptCache: false,
		supportsImages: false,
	}
	const options: BuildToolsOptions = {
		provider: provider as unknown as ClineProvider,
		cwd: "C:\\nor28-cache-fixture",
		mode: "code",
		customModes: undefined,
		experiments: {},
		apiConfiguration: { apiProvider: "anthropic" },
		modelInfo,
		catalogCache: new TaskToolCatalogCache(),
	}
	return { servers, hub, options }
}

async function capture(options: BuildToolsOptions) {
	const result = await buildNativeToolsArrayWithRestrictions(options)
	expect(result.surface).toBeDefined()
	return result.surface!
}

function functionNames(surface: Awaited<ReturnType<typeof capture>>): string[] {
	return surface.schemas
		.filter(
			(schema): schema is Extract<(typeof surface.schemas)[number], { type: "function" }> =>
				schema.type === "function",
		)
		.map((schema) => schema.function.name)
}

function customMode(groups: ModeConfig["groups"]): ModeConfig {
	return {
		slug: "limited",
		name: "Limited",
		roleDefinition: "A limited fixture mode.",
		groups,
	}
}

async function invokeDescriptor(descriptor: ToolDescriptor, value: unknown = "fixture") {
	const result: unknown[] = []
	const callbacks = {
		pushToolResult: (value: unknown) => {
			result.push(value)
		},
	} as ToolCallbacks
	const context = {
		task: { getTaskMode: async () => "code" } as unknown as Task,
		call: { id: "custom-call", nativeArgs: { value } },
		callbacks,
	} as unknown as ToolExecutionContext
	await descriptor.execute(context)
	return result
}

let initialCustomTools: CustomToolDefinition[]

beforeEach(() => {
	initialCustomTools = customToolRegistry.getAll()
	vi.spyOn(customToolRegistry, "loadFromDirectoriesIfStale").mockResolvedValue({ loaded: [], failed: [] })
	testState.browserToolNames = []
	testState.codeIndex = {
		isFeatureEnabled: false,
		isFeatureConfigured: false,
		isInitialized: false,
	}
})

afterEach(() => {
	customToolRegistry.clear()
	for (const definition of initialCustomTools) customToolRegistry.register(definition)
	vi.restoreAllMocks()
})

describe("TaskToolCatalogCache effective input invalidation", () => {
	it("reuses one capture for equivalent object keys and MCP tool order", async () => {
		const { servers, options } = createFixture()
		options.experiments = { imageGeneration: false, runSlashCommand: false }
		const first = await capture(options)

		servers[0].tools!.reverse()
		const second = await capture({
			...options,
			experiments: { runSlashCommand: false, imageGeneration: false },
		})

		expect(second).toBe(first)
		expect(second.digest).toBe(first.digest)
	})

	it("invalidates for auto approval and policy changes", async () => {
		const { options } = createFixture()
		const first = await capture(options)

		const autoApproved = await capture({ ...options, autoApprovalEnabled: true })
		expect(autoApproved).not.toBe(first)
		expect(autoApproved.policy.approval.autoApprovalEnabled).toBe(true)

		const policyLimited = await capture({
			...options,
			policy: {
				...first.policy,
				visibleTools: ["read_file"],
				allowedTools: ["read_file"],
			},
		})
		expect(policyLimited).not.toBe(autoApproved)
		expect(policyLimited.isCallable("read_file")).toBe(true)
		expect(policyLimited.isCallable("execute_command")).toBe(false)
	})

	it("invalidates model image capability and included or excluded tools", async () => {
		const { options } = createFixture()
		const baseModel = options.modelInfo!
		const first = await capture(options)
		const firstReadFile = first.schemas.find(
			(schema) => schema.type === "function" && schema.function.name === "read_file",
		)

		const imageCapable = await capture({
			...options,
			modelInfo: { ...baseModel, supportsImages: true },
		})
		const imageReadFile = imageCapable.schemas.find(
			(schema) => schema.type === "function" && schema.function.name === "read_file",
		)
		expect(imageCapable).not.toBe(first)
		expect(imageReadFile).not.toEqual(firstReadFile)

		const included = await capture({
			...options,
			modelInfo: { ...baseModel, includedTools: ["edit"] },
		})
		expect(included).not.toBe(imageCapable)
		expect(included.isCallable("edit")).toBe(true)
		expect(first.isCallable("edit")).toBe(false)

		const excluded = await capture({
			...options,
			modelInfo: { ...baseModel, excludedTools: ["write_to_file"] },
		})
		expect(excluded).not.toBe(included)
		expect(excluded.isCallable("write_to_file")).toBe(false)
	})

	it("invalidates mode, custom mode definitions, and child authority", async () => {
		const { options } = createFixture()
		const first = await capture(options)

		const plan = await capture({ ...options, mode: "architect" })
		expect(plan).not.toBe(first)
		expect(plan.isCallable("write_to_file")).toBe(false)

		const limited = customMode(["read"])
		const custom = await capture({ ...options, mode: limited.slug, customModes: [limited] })
		expect(custom).not.toBe(plan)
		expect(custom.isCallable("read_file")).toBe(true)
		expect(custom.isCallable("write_to_file")).toBe(false)

		const changedMode = await capture({
			...options,
			mode: limited.slug,
			customModes: [{ ...limited, groups: ["command"] }],
		})
		expect(changedMode).not.toBe(custom)
		expect(changedMode.isCallable("execute_command")).toBe(true)

		const child = await capture({
			...options,
			taskKind: "subagent",
			allowedToolNames: ["read_file"],
		})
		expect(child).not.toBe(changedMode)
		expect(child.allowedFunctionNames).toEqual(["read_file"])
		expect(child.isCallable("execute_command")).toBe(false)
	})

	it("invalidates browser and code index availability while reusing equivalent browser order", async () => {
		const { options } = createFixture()
		testState.browserToolNames = ["open_browser_page", "read_page"]
		const first = await capture(options)
		expect(first.isCallable("open_browser_page")).toBe(true)
		expect(first.isCallable("read_page")).toBe(true)
		expect(first.isCallable("codebase_search")).toBe(false)

		testState.browserToolNames = ["read_page", "open_browser_page"]
		const reordered = await capture(options)
		expect(reordered).toBe(first)

		testState.browserToolNames = ["open_browser_page", "read_page"]
		testState.codeIndex = {
			isFeatureEnabled: true,
			isFeatureConfigured: true,
			isInitialized: true,
		}
		const available = await capture(options)
		expect(available).not.toBe(first)
		expect(available.isCallable("read_page")).toBe(true)
		expect(available.isCallable("codebase_search")).toBe(true)

		testState.browserToolNames = ["open_browser_page"]
		const browserRemoved = await capture(options)
		expect(browserRemoved).not.toBe(available)
		expect(browserRemoved.isCallable("read_page")).toBe(false)
	})

	it("replaces custom schemas and executables without mutating the old registry descriptor", async () => {
		const name = "fixture_custom_tool"
		const oldExecute = vi.fn(async () => "old-result")
		const newExecute = vi.fn(async () => "new-result")
		const oldDefinition: CustomToolDefinition = {
			name,
			description: "Old custom tool contract.",
			parameters: z.object({ value: z.string() }),
			execute: oldExecute,
		}
		customToolRegistry.register(oldDefinition)

		const { options } = createFixture()
		const customOptions = { ...options, experiments: { customTools: true } }
		const first = await capture(customOptions)
		const oldDescriptor = first.resolve(name)
		expect(oldDescriptor).toBeDefined()
		expect(await invokeDescriptor(oldDescriptor!)).toEqual(["old-result"])

		const newDefinition: CustomToolDefinition = {
			name,
			description: "New custom tool contract.",
			parameters: z.object({ value: z.number() }),
			execute: newExecute,
		}
		customToolRegistry.register(newDefinition)
		const second = await capture(customOptions)
		const newDescriptor = second.resolve(name)

		expect(second).not.toBe(first)
		expect(newDescriptor).toBeDefined()
		expect(newDescriptor).not.toBe(oldDescriptor)
		expect(newDescriptor!.schema).not.toEqual(oldDescriptor!.schema)
		expect(await invokeDescriptor(newDescriptor!, 7)).toEqual(["new-result"])
		expect(await invokeDescriptor(oldDescriptor!)).toEqual(["old-result"])
		expect(oldExecute).toHaveBeenCalledTimes(2)
		expect(newExecute).toHaveBeenCalledOnce()
	})

	it("keeps the effective surface digest tied to schema and policy content", async () => {
		const { options } = createFixture()
		const first = await capture(options)
		const second = await capture({
			...options,
			disabledTools: ["write_to_file"],
		})
		expect(second).not.toBe(first)
		expect(second.digest).not.toBe(first.digest)
		expect(functionNames(second)).not.toContain("write_to_file")
	})
})

describe("TaskReadGrant cache identity", () => {
	function grant(overrides: Partial<TaskReadGrant> = {}): TaskReadGrant {
		return {
			enabled: true,
			workspaceRoot: "C:\\nor28-cache-fixture",
			showIgnoredFiles: false,
			...overrides,
		}
	}

	it.each([
		["enabled", grant({ enabled: false }), grant({ enabled: true })],
		[
			"workspaceRoot",
			grant({ workspaceRoot: "C:\\nor28-cache-fixture-a" }),
			grant({ workspaceRoot: "C:\\nor28-cache-fixture-b" }),
		],
		["showIgnoredFiles", grant({ showIgnoredFiles: false }), grant({ showIgnoredFiles: true })],
	] as const)(
		"invalidates the captured surface when read grant %s changes",
		async (_field, firstGrant, nextGrant) => {
			const { options } = createFixture()
			const first = await capture({ ...options, autoApprovalEnabled: true, readGrant: firstGrant })
			const next = await capture({ ...options, autoApprovalEnabled: true, readGrant: nextGrant })

			expect(next).not.toBe(first)
			expect(next.digest).not.toBe(first.digest)
			expect(first.readGrant).toEqual(firstGrant)
			expect(next.readGrant).toEqual(nextGrant)
		},
	)
})
