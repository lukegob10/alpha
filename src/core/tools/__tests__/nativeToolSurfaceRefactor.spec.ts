import type Anthropic from "@anthropic-ai/sdk"
import { describe, expect, it, vi } from "vitest"

import { openAiModelInfoSaneDefaults, toolNames, toolUsageSchema, type McpServer } from "@alpha-code/types"

import { filterNativeToolsForMode } from "../../prompts/tools/filter-tools-for-mode"
import { getNativeTools, nativeTools } from "../../prompts/tools/native-tools"
import { TOOL_ALIASES, TOOL_DISPLAY_NAMES, TOOL_GROUPS, type NativeToolArgs } from "../../../shared/tools"
import { createAgentResponse, type AgentToolCall } from "../../agent/AgentResponse"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import { ToolRegistry } from "../ToolRegistry"
import type { CodeIndexManager } from "../../../services/code-index/manager"
import type { Task } from "../../task/Task"
import { buildNativeToolsArrayWithRestrictions, type BuildToolsOptions } from "../../task/build-tools"
import { TaskToolCatalogCache } from "../../task/TaskToolCatalogCache"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false }),
	},
}))

const retiredAdvertisedNames = [
	"apply_diff",
	"search_replace",
	"edit_file",
	"execute_command",
	"read_command_output",
	"delegate_task",
	"interrupt_agent",
	"cancel_agent",
	"report_progress",
] as const

function namesOf(tools: ReturnType<typeof getNativeTools>): string[] {
	return tools.flatMap((tool) => (tool.type === "function" ? [tool.function.name] : []))
}

function mcpDiscoveryFixture() {
	const server: McpServer = {
		name: "calendar",
		status: "connected",
		config: "{}",
		source: "project",
		tools: Array.from({ length: 12 }, (_, index) => ({
			name: `lookup_${String(index).padStart(2, "0")}`,
			description: `Calendar operation ${index}. ${"Returns scoped calendar records with stable identifiers. ".repeat(34)}`,
			inputSchema: {
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"],
				additionalProperties: false,
			},
		})),
	}
	const connection = { type: "connected", server, client: {}, transport: {} }
	const hub = { connections: [connection], getServers: () => [server] }
	const provider = { context: {}, getMcpHub: () => hub }
	const options: BuildToolsOptions = {
		provider: provider as unknown as BuildToolsOptions["provider"],
		cwd: process.cwd(),
		mode: "code",
		customModes: undefined,
		experiments: {},
		apiConfiguration: { apiProvider: "openai" },
		catalogCache: new TaskToolCatalogCache(),
		discoveryHistory: [],
	}
	return options
}

function discoveryHost(): ToolExecutionHost {
	const results: Anthropic.ToolResultBlockParam[] = []
	return {
		taskId: "native-tool-surface-fixture",
		cwd: process.cwd(),
		userMessageContent: results,
		ask: vi.fn(async () => ({ response: "yesButtonClicked" as const })),
		say: vi.fn(async () => {}),
		recordToolUsage: vi.fn(),
		taskFacade: {} as unknown as Task,
		pushToolResultToUserContent(result) {
			results.push(result)
			return true
		},
	}
}

function resultText(block: Anthropic.ToolResultBlockParam): string {
	if (!block.content || typeof block.content === "string") return block.content ?? ""
	return block.content
		.filter((part): part is Anthropic.TextBlockParam => part.type === "text")
		.map((part) => part.text)
		.join("\n")
}

describe("native tool-surface refactor contract", () => {
	describe("phase 0: locked advertised surface", () => {
		it("matches the exact Code catalog, including only the live browser tools", () => {
			const liveBrowserToolNames = ["open_browser_page", "read_page", "run_playwright_code"] as const
			const codeIndexManager = {
				isFeatureEnabled: true,
				isFeatureConfigured: true,
				isInitialized: true,
			} satisfies Partial<CodeIndexManager>
			const names = namesOf(
				filterNativeToolsForMode(
					getNativeTools({
						supportsImages: true,
						availableBrowserToolNames: liveBrowserToolNames,
						includeApplyPatch: true,
					}),
					"code",
					undefined,
					{ runSlashCommand: true },
					codeIndexManager as unknown as CodeIndexManager,
					{
						todoListEnabled: true,
						modelInfo: { ...openAiModelInfoSaneDefaults, includedTools: ["apply_patch"] },
					},
				),
			).sort()
			const expected = [
				"read_file",
				"search_files",
				"list_files",
				"codebase_search",
				"list_tickets",
				"read_ticket",
				"edit",
				"write_to_file",
				"create_ticket",
				"update_ticket",
				"delete_ticket",
				"apply_patch",
				"shell",
				"manage_command",
				"ask_followup_question",
				"attempt_completion",
				"new_task",
				"update_todo_list",
				"run_slash_command",
				"skill",
				"spawn_agent",
				"wait_agent",
				"send_message",
				"followup_task",
				"list_agents",
				"close_agent",
				...liveBrowserToolNames,
			].sort()

			expect(names).toEqual(expected)
			expect(new Set(names).size).toBe(names.length)
		})

		it("keeps the effective Plan allow-list read-only for provider supersets", async () => {
			const provider = {
				context: {},
				getMcpHub: () => ({ getServers: () => [] }),
			}
			const result = await buildNativeToolsArrayWithRestrictions({
				provider: provider as unknown as BuildToolsOptions["provider"],
				cwd: process.cwd(),
				mode: "architect",
				customModes: undefined,
				experiments: {},
				apiConfiguration: undefined,
				includeAllToolsWithRestrictions: true,
				taskKind: "primary",
			})
			expect(result.allowedFunctionNames?.slice().sort()).toEqual(
				[
					"list_tickets",
					"read_ticket",
					"read_file",
					"search_files",
					"list_files",
					"ask_followup_question",
					"attempt_completion",
					"shell",
					"spawn_agent",
					"list_agents",
					"wait_agent",
					"send_message",
					"followup_task",
					"close_agent",
				].sort(),
			)
		})

		it("advertises canonical names and omits retired names from the eager catalog", () => {
			const names = namesOf(getNativeTools({ availableBrowserToolNames: [] }))

			expect(names).toContain("shell")
			expect(names).toContain("edit")
			expect(names).toContain("write_to_file")
			expect(names).not.toContain("apply_patch")
			for (const name of retiredAdvertisedNames) {
				expect(names).not.toContain(name)
			}
		})

		it("keeps apply_patch opt-in at native catalog and registry boundaries", () => {
			expect(namesOf(getNativeTools())).not.toContain("apply_patch")
			expect(namesOf(nativeTools)).not.toContain("apply_patch")
			expect(namesOf(getNativeTools({ includeApplyPatch: true }))).toContain("apply_patch")
			expect(new ToolRegistry().getSchema("apply_patch")).toBeUndefined()
			expect(
				new ToolRegistry({ nativeTools: getNativeTools({ includeApplyPatch: true }) }).getSchema("apply_patch"),
			).toBeDefined()
		})

		it("does not let includedTools invent a schema missing from the native catalog", () => {
			const names = namesOf(
				filterNativeToolsForMode(
					getNativeTools({ availableBrowserToolNames: [] }),
					"code",
					undefined,
					{},
					undefined,
					{ modelInfo: { ...openAiModelInfoSaneDefaults, includedTools: ["apply_patch"] } },
				),
			)

			expect(names).not.toContain("apply_patch")
		})

		it.each([
			["openai", { provider: "openai", id: "gpt-5.5" }, true],
			["openai gpt-oss", { provider: "openai", id: "gpt-oss-120b" }, true],
			["vertex", { provider: "vertex", id: "o3" }, true],
			["vertex gpt-oss", { provider: "vertex", id: "gpt-oss" }, true],
			["vscode-lm", { provider: "vscode-lm", vendor: "copilot", family: "gpt-5.5" }, true],
			[
				"vscode-lm gpt-oss",
				{ provider: "vscode-lm", vendor: "copilot", family: "gpt-oss-120b" },
				true,
			],
			["codex", { provider: "openai", id: "codex" }, true],
			["claude", { provider: "openai", id: "claude-opus-4.7" }, false],
			["gemini", { provider: "openai", id: "gemini-3.1-pro" }, false],
			["grok", { provider: "openai", id: "xai/grok-4.6" }, false],
			["llama", { provider: "openai", id: "Meta-Llama-3.3-70B-Instruct" }, false],
		] as const)("gates patch schema for the verified %s identity", async (_name, modelIdentity, patchExpected) => {
			const provider = {
				context: {},
				getMcpHub: () => ({ getServers: () => [] }),
			}
			const result = await buildNativeToolsArrayWithRestrictions({
				provider: provider as unknown as BuildToolsOptions["provider"],
				cwd: process.cwd(),
				mode: "code",
				customModes: undefined,
				experiments: {},
				apiConfiguration: { apiProvider: modelIdentity.provider },
				modelIdentity,
			})
			const names = namesOf(result.tools)

			expect(names).toContain("edit")
			expect(names).toContain("write_to_file")
			expect(names.includes("apply_patch")).toBe(patchExpected)
		})

		it("keeps Plan read-only and excludes command management, editors, and ticket writes", () => {
			const names = namesOf(
				filterNativeToolsForMode(
					getNativeTools({
						availableBrowserToolNames: [],
						planMode: true,
						agentKinds: ["explore", "review"],
					}),
					"architect",
					[],
					{},
					undefined,
					{},
				),
			)

			expect(names).toContain("shell")
			expect(names).toEqual(expect.arrayContaining(["list_tickets", "read_ticket"]))
			for (const name of [
				"manage_command",
				"edit",
				"write_to_file",
				"apply_patch",
				"create_ticket",
				"update_ticket",
				"delete_ticket",
			]) {
				expect(names).not.toContain(name)
			}
		})

		it("does not place native product tools behind MCP discovery", () => {
			const names = namesOf(getNativeTools({ availableBrowserToolNames: [] }))

			expect(names).not.toContain("discover_tools")
		})

		it("resolves the renamed command through the canonical alias", () => {
			expect(TOOL_ALIASES.execute_command).toBe("shell")
		})

		it("discovers only deferred MCP candidates and never native product tools", async () => {
			const result = await buildNativeToolsArrayWithRestrictions(mcpDiscoveryFixture())
			const surface = result.surface!
			const advertisedNames = namesOf(result.tools)

			expect(advertisedNames).toContain("discover_tools")
			expect(advertisedNames.filter((name) => name.startsWith("mcp--"))).toEqual([])

			const executionHost = discoveryHost()
			const outcome = await new ToolScheduler({
				executionHost,
				registry: surface.registry,
				policy: surface.policy,
				mode: "code",
			}).run(
				createAgentResponse([
					{
						type: "tool_call",
						id: "discovery",
						name: "discover_tools",
						arguments: { query: "lookup_00", limit: 1 },
					} satisfies AgentToolCall,
				]),
			)

			expect(outcome.results).toHaveLength(1)
			expect(outcome.results[0].status).toBe("success")
			const block = executionHost.userMessageContent.find(
				(item): item is Anthropic.ToolResultBlockParam => item.type === "tool_result",
			)
			expect(block).toBeDefined()
			const payload = JSON.parse(resultText(block!)) as { status: string; tools?: Array<{ name: string }> }
			expect(payload.status).toBe("success")
			expect(payload.tools).toHaveLength(1)
			expect(payload.tools?.[0]?.name).toBe("mcp--calendar--lookup_00")
			expect(payload.tools?.every(({ name }) => name.startsWith("mcp--"))).toBe(true)
		})
	})

	describe("phase 1: names, groups, and aliases", () => {
		it("keeps canonical shell and historical names in the type-level catalog", () => {
			expect(toolNames).toContain("shell")
			for (const name of retiredAdvertisedNames) {
				expect(toolNames).toContain(name)
			}
		})

		it("keeps shell and retired tool usage records readable", () => {
			const usage = Object.fromEntries(
				["shell", ...retiredAdvertisedNames].map((name) => [name, { attempts: 1, failures: 0 }]),
			)
			expect(toolUsageSchema.parse(usage)).toEqual(usage)
		})

		it("keeps the shell contract thin and its display label stable", () => {
			const args: NativeToolArgs["shell"] = {
				command: "pnpm test",
				cwd: null,
				timeout: null,
			}
			expect(args).toEqual({ command: "pnpm test", cwd: null, timeout: null })
			expect(args).not.toHaveProperty("verification")
			expect(TOOL_DISPLAY_NAMES.shell).toBe("run commands")
		})

		it("defines the locked command, edit, and managed-agent groups", () => {
			expect(TOOL_GROUPS.command.tools).toEqual(["shell", "manage_command"])
			expect(TOOL_GROUPS.edit.tools).toEqual([
				"edit",
				"write_to_file",
				"create_ticket",
				"update_ticket",
				"delete_ticket",
			])
			expect(TOOL_GROUPS.edit.customTools).toEqual(["apply_patch"])
			expect(TOOL_GROUPS.agents.tools).toEqual([
				"spawn_agent",
				"wait_agent",
				"send_message",
				"followup_task",
				"list_agents",
				"close_agent",
			])
		})

		it("keeps compatibility aliases without aliasing payload-incompatible tools", () => {
			expect(TOOL_ALIASES).toMatchObject({
				execute_command: "shell",
				write_file: "write_to_file",
				search_and_replace: "edit",
			})
			expect(TOOL_ALIASES).not.toHaveProperty("apply_diff")
			expect(TOOL_ALIASES).not.toHaveProperty("search_replace")
			expect(TOOL_ALIASES).not.toHaveProperty("edit_file")
		})
	})
})
