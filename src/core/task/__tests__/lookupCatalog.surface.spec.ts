import { describe, expect, it, vi } from "vitest"

import { isToolAllowed } from "../../agent/ToolPolicy"
import { buildNativeToolsArrayWithRestrictions, type BuildToolsOptions } from "../../task/build-tools"
import { TaskToolCatalogCache } from "../../task/TaskToolCatalogCache"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true }),
	},
}))

function namesOf(tools: { type: string; function?: { name: string } }[]): string[] {
	return tools.flatMap((tool) => (tool.type === "function" && tool.function ? [tool.function.name] : [])).sort()
}

function options(overrides: Partial<BuildToolsOptions> = {}): BuildToolsOptions {
	const provider = {
		context: {},
		getMcpHub: () => ({ getServers: () => [] }),
	}
	return {
		provider: provider as unknown as BuildToolsOptions["provider"],
		cwd: process.cwd(),
		mode: "code",
		customModes: undefined,
		experiments: {},
		apiConfiguration: { apiProvider: "openai" },
		catalogCache: new TaskToolCatalogCache(),
		discoveryHistory: [],
		...overrides,
	}
}

describe("lookup catalog preset", () => {
	it("advertises only lookup-sized native names for a question-only request", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({ userRequestText: "Where is retryLimit defined?" }),
		)
		expect(namesOf(result.tools)).toEqual(
			["ask_followup_question", "codebase_search", "list_files", "read_file", "search_files", "shell"].sort(),
		)
		expect(result.surface?.isCallable("spawn_agent")).toBe(false)
		expect(result.surface?.isCallable("update_todo_list")).toBe(false)
		expect(result.surface?.isCallable("attempt_completion")).toBe(false)
		expect(result.surface?.isCallable("write_to_file")).toBe(false)
		expect(result.surface?.isCallable("skill")).toBe(false)
		expect(result.surface?.isCallable("list_tickets")).toBe(false)
		expect(result.surface?.resolve("spawn_agent")).toBeUndefined()
		expect(isToolAllowed(result.surface?.policy, "spawn_agent")).toBe(false)
		expect(result.surface?.isCallable("search_files")).toBe(true)
	})

	it("keeps workflow tools on an implementation request", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({ userRequestText: "Implement retry backoff in the scheduler." }),
		)
		const names = namesOf(result.tools)
		expect(names).toEqual(
			expect.arrayContaining(["spawn_agent", "write_to_file", "update_todo_list", "skill", "list_tickets"]),
		)
		expect(result.surface?.isCallable("spawn_agent")).toBe(true)
		expect(result.surface?.isCallable("write_to_file")).toBe(true)
	})

	it("does not guess a slim catalog when the request is uncertain", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({ userRequestText: "Handle the scheduler." }),
		)
		expect(namesOf(result.tools)).toEqual(expect.arrayContaining(["spawn_agent", "write_to_file"]))
	})

	it("widens at a later step when the captured user text becomes an implementation request", async () => {
		const cache = new TaskToolCatalogCache()
		const lookup = await buildNativeToolsArrayWithRestrictions(
			options({ catalogCache: cache, userRequestText: "Where is retryLimit defined?" }),
		)
		const implement = await buildNativeToolsArrayWithRestrictions(
			options({ catalogCache: cache, userRequestText: "Implement retry backoff in the scheduler." }),
		)
		expect(lookup.surface?.isCallable("write_to_file")).toBe(false)
		expect(implement.surface?.isCallable("write_to_file")).toBe(true)
		expect(lookup.digest).not.toBe(implement.digest)
	})

	it("does not grant write tools when a Plan-mode lookup intersects the inspect-only allow-list", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({ mode: "architect", userRequestText: "Where is retryLimit defined?" }),
		)
		expect(namesOf(result.tools)).toEqual(
			["ask_followup_question", "codebase_search", "list_files", "read_file", "search_files", "shell"].sort(),
		)
		expect(result.surface?.isCallable("write_to_file")).toBe(false)
		expect(result.surface?.isCallable("spawn_agent")).toBe(false)
	})

	it("does not narrow managed-child catalogs from lookup classification", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({
				taskKind: "subagent",
				enableAgentLifecycleTools: false,
				userRequestText: "Where is retryLimit defined?",
			}),
		)
		expect(namesOf(result.tools)).toEqual(expect.arrayContaining(["search_files", "write_to_file"]))
		expect(namesOf(result.tools)).not.toContain("wait_agent")
	})
})
