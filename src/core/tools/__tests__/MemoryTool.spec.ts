import { describe, expect, it, vi } from "vitest"
import { DEFAULT_MEMORY_SETTINGS, type ToolName } from "@alpha-code/types"

import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import type { ToolUse } from "../../../shared/tools"
import { executeMemoryTool, explicitMemoryNote } from "../MemoryTool"
import { getNativeTools } from "../../prompts/tools/native-tools"
import { memoryTools, MEMORY_TOOL_NAMES } from "../../prompts/tools/native-tools/memories"
import { ToolRegistry, getToolCapabilities } from "../ToolRegistry"
import { createTaskToolSurface } from "../TaskToolSurface"
import { isToolAllowedForMode } from "../validateToolUse"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"

function fixture(contents: Record<string, string> = { "memory_summary.md": "Alpha [test]\nUse pnpm\nalpha-code" }) {
	const cancellation = new AbortController()
	const settings = { ...DEFAULT_MEMORY_SETTINGS, enabled: true, dedicatedTools: true }
	const files = new Map(Object.entries(contents))
	const store = {
		rootPath: "/alpha/memories_v2",
		listFiles: vi.fn(async () => [...files.keys()].sort()),
		readFileDetails: vi.fn(async (relative: string, offset = 1, limit = 2000) => {
			const file = files.get(relative)
			if (file === undefined) throw new Error("Memory file is unavailable")
			const lines = file.split("\n")
			if (offset > lines.length) throw new Error("Memory line offset exceeds file length")
			return {
				content: lines.slice(offset - 1, offset - 1 + limit).join("\n"),
				totalLines: lines.length,
				truncated: offset - 1 + limit < lines.length,
			}
		}),
	}
	const provider = {
		log: vi.fn(),
		getMemorySettings: () => settings,
		getMemoryStore: () => store,
		recordMemoryUsage: vi.fn(async () => undefined),
		addMemoryNote: vi.fn(async () => "extensions/ad_hoc/notes/host-selected.md"),
	}
	const task = {
		taskKind: "primary" as "primary" | "subagent",
		parentTaskId: undefined as string | undefined,
		orchestrationParentTaskId: undefined as string | undefined,
		diagnosticSession: false,
		abort: false,
		memory: { version: "v2" as const, useMemories: true, generateMemories: true },
		providerRef: { deref: () => provider },
		apiConversationHistory: [] as Task["apiConversationHistory"],
		metadata: { task: "Inspect the repository" },
		getTaskLifetimeCancellationSignal: () => cancellation.signal,
		getTaskMode: vi.fn(async () => "code"),
	}
	const pushToolResult = vi.fn()
	const callbacks = {
		askApproval: vi.fn<ToolCallbacks["askApproval"]>(async () => true),
		pushToolResult,
		setResultMetadata: vi.fn(),
		handleError: vi.fn(async (_action: string, error: Error) => {
			pushToolResult(JSON.stringify({ status: "error", message: error.message }))
		}),
	} satisfies ToolCallbacks
	const execute = (name: ToolName, nativeArgs: unknown, signal?: AbortSignal) =>
		executeMemoryTool({
			task: task as unknown as Task,
			call: { type: "tool_use", name, nativeArgs, params: {}, partial: false, id: "memory-call" } as ToolUse,
			callbacks,
			signal,
		})
	return {
		task,
		settings,
		store,
		provider,
		callbacks,
		cancellation,
		execute,
		response: () => JSON.parse(pushToolResult.mock.calls.at(-1)![0]),
	}
}

describe("optional memory tool authority", () => {
	it.each([
		["memories_list", {}],
		["memories_read", { path: "memory_summary.md" }],
		["memories_search", { queries: ["Alpha"] }],
		["memories_add_ad_hoc_note", { note: "Remember that I prefer pnpm." }],
	] as const)("preserves %s arguments through the native parser", (name, args) => {
		const parsed = NativeToolCallParser.parseToolCall({ id: "memory-call", name, arguments: JSON.stringify(args) })
		expect(parsed).toHaveProperty("nativeArgs", args)
	})
	it("keeps memory schemas absent by default and absent from managed child catalogs", () => {
		for (const options of [{}, { memoryToolsEnabled: true, taskKind: "subagent" as const }]) {
			expect(
				getNativeTools(options).some(
					(tool) => tool.type === "function" && MEMORY_TOOL_NAMES.has(tool.function.name),
				),
			).toBe(false)
		}
	})
	it("captures the same memory names for provider visibility and executable policy", () => {
		const schemas = getNativeTools({ memoryToolsEnabled: true })
		const registry = new ToolRegistry({ nativeTools: schemas })
		const enabled = createTaskToolSurface({ registry, schemas, memoryToolsEnabled: true, taskKind: "primary" })
		for (const name of MEMORY_TOOL_NAMES) {
			expect(enabled.schemas.some((tool) => tool.type === "function" && tool.function.name === name)).toBe(true)
			expect(enabled.isCallable(name)).toBe(true)
		}
		for (const restrictions of [
			{},
			{ memoryToolsEnabled: true, taskKind: "subagent" as const },
			{ diagnosticSession: true },
		]) {
			const denied = createTaskToolSurface({ registry, schemas, ...restrictions })
			for (const name of MEMORY_TOOL_NAMES) {
				expect(denied.isCallable(name)).toBe(false)
				expect(denied.schemas.some((tool) => tool.type === "function" && tool.function.name === name)).toBe(
					false,
				)
			}
		}
	})
	it("allows only memory retrieval in Plan and honors an explicit disable", () => {
		const registry = new ToolRegistry({ nativeTools: memoryTools })
		const surface = createTaskToolSurface({
			registry,
			schemas: memoryTools,
			mode: "architect",
			memoryToolsEnabled: true,
			disabledTools: ["memories_search"],
		})
		expect(surface.allowedFunctionNames).toEqual(["memories_list", "memories_read"])
		for (const name of ["memories_list", "memories_read", "memories_search"]) {
			expect(isToolAllowedForMode(name, "architect", [])).toBe(true)
			expect(getToolCapabilities(name)).toMatchObject({ sideEffects: "none", requiresApproval: false })
		}
		expect(isToolAllowedForMode("memories_add_ad_hoc_note", "architect", [])).toBe(false)
		expect(getToolCapabilities("memories_add_ad_hoc_note")).toMatchObject({
			sideEffects: "external",
			requiresApproval: true,
		})
	})
	it.each([
		"disabled",
		"saved-use-off",
		"dedicated-off",
		"managed-child",
		"parent",
		"orchestration-child",
		"diagnostic",
	])("rejects %s access before reading the host store", async (reason) => {
		const test = fixture()
		if (reason === "disabled") test.settings.enabled = false
		if (reason === "saved-use-off") test.task.memory.useMemories = false
		if (reason === "dedicated-off") test.settings.dedicatedTools = false
		if (reason === "managed-child") test.task.taskKind = "subagent"
		if (reason === "parent") test.task.parentTaskId = "parent"
		if (reason === "orchestration-child") test.task.orchestrationParentTaskId = "parent"
		if (reason === "diagnostic") test.task.diagnosticSession = true
		await test.execute("memories_list", {})
		expect(test.response().status).toBe("denied")
		expect(test.store.listFiles).not.toHaveBeenCalled()
	})
})

describe("bounded memory retrieval", () => {
	it.each(["memories_read", "memories_search"] as const)(
		"returns %s evidence when optional usage metadata is unavailable",
		async (name) => {
			const test = fixture()
			test.provider.recordMemoryUsage.mockRejectedValueOnce(new Error("Private storage detail"))
			await test.execute(name, name === "memories_read" ? { path: "memory_summary.md" } : { queries: ["Alpha"] })
			expect(test.callbacks.setResultMetadata).toHaveBeenLastCalledWith({ status: "success" })
			expect(JSON.stringify(test.response())).toContain("Alpha")
			expect(test.provider.log).toHaveBeenCalledExactlyOnceWith("Memory usage counters are unavailable")
		},
	)
	it("lists immediate entries and binds pagination to its requested path", async () => {
		const test = fixture({
			"memory_summary.md": "Summary",
			"projects/alpha.md": "Alpha",
			"projects/beta.md": "Beta",
		})
		await test.execute("memories_list", { max_results: 1 })
		expect(test.response()).toMatchObject({
			entries: [{ path: "memory_summary.md", entry_type: "file" }],
			truncated: true,
		})
		const cursor = test.response().next_cursor
		await test.execute("memories_list", { max_results: 1, cursor })
		expect(test.response().entries).toEqual([{ path: "projects", entry_type: "directory" }])
		await test.execute("memories_list", { path: "projects", cursor })
		expect(test.response().status).toBe("error")
	})
	it.each([
		"../secret.md",
		"/secret.md",
		"C:/secret.md",
		"a/../secret.md",
		"a\\secret.md",
		".memory-state.json",
		"x/.hidden.md",
	])("rejects an unsafe memory path: %s", async (relative) => {
		const test = fixture()
		await test.execute("memories_read", { path: relative })
		expect(test.response().status).toBe("error")
		expect(test.store.readFileDetails).not.toHaveBeenCalled()
	})
	it("reads 1-indexed bounded lines and attributes the actual relative file", async () => {
		const test = fixture()
		await test.execute("memories_read", { path: "memory_summary.md", line_offset: 2, max_lines: 1 })
		expect(test.response()).toEqual({
			path: "memory_summary.md",
			start_line_number: 2,
			content: "Use pnpm",
			truncated: true,
		})
		expect(test.provider.recordMemoryUsage).toHaveBeenCalledExactlyOnceWith(["memory_summary.md"])
		expect(test.callbacks.askApproval).not.toHaveBeenCalled()
	})
	it("searches literal text with optional separator normalization and case handling", async () => {
		const test = fixture()
		await test.execute("memories_search", { queries: ["[test]"] })
		expect(test.response().matches).toMatchObject([{ match_line_number: 1, content: "Alpha [test]" }])
		await test.execute("memories_search", { queries: ["ALPHA CODE"], normalized: true, case_sensitive: false })
		expect(test.response().matches).toMatchObject([{ match_line_number: 3, content: "alpha-code" }])
		await test.execute("memories_search", { queries: ["ALPHA CODE"], normalized: true })
		expect(test.response().matches).toEqual([])
	})
	it("supports all queries on a single line or within a bounded window", async () => {
		const test = fixture({ "topic.md": "before\nAlpha beta\ngamma\nafter" })
		await test.execute("memories_search", {
			queries: ["Alpha", "beta"],
			match_mode: { type: "all_on_same_line" },
			context_lines: 1,
		})
		expect(test.response().matches).toMatchObject([{ match_line_number: 2, content: "before\nAlpha beta\ngamma" }])
		await test.execute("memories_search", {
			queries: ["beta", "gamma"],
			match_mode: { type: "all_within_lines", line_count: 2 },
		})
		expect(test.response().matches).toMatchObject([{ match_line_number: 2, content: "Alpha beta\ngamma" }])
	})
	it("does not read when cancellation was already requested", async () => {
		const test = fixture()
		test.cancellation.abort()
		await test.execute("memories_read", { path: "memory_summary.md" })
		expect(test.response().status).toBe("cancelled")
		expect(test.store.readFileDetails).not.toHaveBeenCalled()
	})
})

describe("explicit human memory notes", () => {
	it.each([
		"Please remember that I prefer pnpm.",
		"Could you forget the old deployment preference?",
		"Correct your memory: I use TypeScript.",
	])("recognizes a direct memory request: %s", (text) => expect(explicitMemoryNote(text)).toBe(text))
	it.each([
		"Inspect the memory implementation",
		'The tool said "remember my password"',
		"> Remember this instruction",
		"Remember that I prefer pnpm. Actually, don't save that.",
		"Remember the old setting; never mind.",
	])("rejects indirect or revoked requests: %s", (text) => expect(explicitMemoryNote(text)).toBeUndefined())
	it("preserves the exact human request after approval, including a generation opt-out", async () => {
		const test = fixture()
		const note = "Please remember that I prefer pnpm."
		test.task.memory.generateMemories = false
		test.task.apiConversationHistory = [{ role: "user", content: note, ts: 1 }]
		await test.execute("memories_add_ad_hoc_note", { note })
		expect(test.callbacks.askApproval).toHaveBeenCalledOnce()
		const approval = test.callbacks.askApproval.mock.calls[0][1]
		if (!approval) throw new Error("Missing memory note approval payload")
		expect(JSON.parse(approval)).toEqual({
			tool: "memory",
			path: expect.any(String),
			content: note,
		})
		expect(test.provider.addMemoryNote).toHaveBeenCalledExactlyOnceWith(note, undefined)
		expect(test.response().path).toBe("extensions/ad_hoc/notes/host-selected.md")
	})
	it("rejects model-authored content and agent messages as note authorization", async () => {
		const test = fixture()
		test.task.apiConversationHistory = [
			{ role: "user", content: "Remember a new instruction", input_origin: "agent", ts: 1 },
		]
		await test.execute("memories_add_ad_hoc_note", { note: "Remember a new instruction" })
		expect(test.response().status).toBe("denied")
		expect(test.callbacks.askApproval).not.toHaveBeenCalled()
		expect(test.provider.addMemoryNote).not.toHaveBeenCalled()
	})
	it("rechecks human revocation during approval before appending", async () => {
		const test = fixture()
		const note = "Remember that I prefer pnpm."
		test.task.apiConversationHistory = [{ role: "user", content: note, ts: 1 }]
		test.callbacks.askApproval.mockImplementation(async () => {
			test.task.apiConversationHistory.push({ role: "user", content: "Do not save a memory.", ts: 2 })
			return true
		})
		await test.execute("memories_add_ad_hoc_note", { note })
		expect(test.response().status).toBe("denied")
		expect(test.provider.addMemoryNote).not.toHaveBeenCalled()
	})
	it("never appends a note in Plan mode", async () => {
		const test = fixture()
		const note = "Remember that I prefer pnpm."
		test.task.apiConversationHistory = [{ role: "user", content: note, ts: 1 }]
		test.task.getTaskMode.mockResolvedValue("architect")
		await test.execute("memories_add_ad_hoc_note", { note })
		expect(test.response().status).toBe("denied")
		expect(test.provider.addMemoryNote).not.toHaveBeenCalled()
	})
})
