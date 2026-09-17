import type { Task } from "../../task/Task"
import searchFilesDefinition from "../../prompts/tools/native-tools/search_files"
import { SearchFilesTool } from "../SearchFilesTool"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import { ToolScheduler } from "../../agent/ToolScheduler"
import { ToolRegistry } from "../ToolRegistry"
import { createTaskToolSurface } from "../TaskToolSurface"

const { regexSearchFilesMock } = vi.hoisted(() => ({
	regexSearchFilesMock: vi.fn(),
}))

vi.mock("../../../services/ripgrep", () => ({
	regexSearchFiles: regexSearchFilesMock,
}))

describe("SearchFilesTool", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		regexSearchFilesMock.mockImplementation(
			async (_cwd: string, _absolutePath: string, regex: string) => `results for ${regex}`,
		)
	})

	const createTask = () =>
		({
			cwd: "F:\\workspace",
			consecutiveMistakeCount: 0,
			didToolFailInCurrentTurn: false,
			recordToolError: vi.fn(),
			sayAndCreateMissingParamError: vi.fn(
				async (_tool: string, parameter: string) => `Missing required parameter: ${parameter}`,
			),
			alphaIgnoreController: undefined,
		}) as unknown as Task

	it("preserves valid searches when a batch contains an empty workspace path", async () => {
		const callbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			setResultMetadata: vi.fn(),
		}
		const call = NativeToolCallParser.parseToolCall({
			id: "pulse-search",
			name: "search_files",
			arguments: JSON.stringify({
				path: "src",
				regex: "brand",
				queries: [
					{ path: "src", regex: "brand" },
					{ path: "", regex: "PULSE" },
				],
			}),
		})!
		if (call.type !== "tool_use") throw new Error("Expected search_files call")
		await new SearchFilesTool().handle(createTask(), call, callbacks)
		expect(regexSearchFilesMock).toHaveBeenCalledOnce()
		expect(callbacks.pushToolResult.mock.calls[0][0]).toContain("results for brand")
		expect(callbacks.pushToolResult.mock.calls[0][0]).toContain('Use "." for the workspace root')
		expect(JSON.parse(callbacks.askApproval.mock.calls[0][1]).batchSearches).toMatchObject([
			{ searchStatus: "success" },
			{ searchStatus: "error" },
		])
	})

	it.each(["content", "files", "count", null] as const)(
		"carries native mode %s and literal through parsing and execution",
		async (output_mode) => {
			const args = { path: "src", regex: "foo(.bar", output_mode, literal: true }
			const call = NativeToolCallParser.parseToolCall({
				id: "search-options",
				name: "search_files",
				arguments: JSON.stringify(args),
			})
			if (call?.type !== "tool_use") throw new Error("Expected a native search_files call")
			expect(call.nativeArgs).toMatchObject(args)
			const askApproval = vi.fn().mockResolvedValue(true)
			const pushToolResult = vi.fn()
			await new SearchFilesTool().handle(createTask(), call, {
				askApproval,
				pushToolResult,
				handleError: vi.fn(),
			})
			expect(regexSearchFilesMock.mock.calls[0][6]).toEqual({
				outputMode: output_mode ?? "content",
				literal: true,
			})
			expect(JSON.parse(askApproval.mock.calls[0][1])).toMatchObject({
				outputMode: output_mode ?? "content",
				literal: true,
				searchStatus: "success",
			})
		},
	)

	it("keeps successful query results beside a failed regex in one approved result", async () => {
		regexSearchFilesMock.mockRejectedValueOnce(new Error("regex parse error: unclosed group"))
		const task = createTask()
		const callbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			setResultMetadata: vi.fn(),
		}
		await new SearchFilesTool().execute(
			{
				queries: [
					{ path: ".", regex: "(" },
					{ path: ".", regex: "TODO", output_mode: "files" },
				],
			},
			task,
			callbacks,
		)
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(callbacks.pushToolResult.mock.calls[0][0]).toContain("regex parse error: unclosed group")
		expect(callbacks.pushToolResult.mock.calls[0][0]).toContain("results for TODO")
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "success" })
		expect(JSON.parse(callbacks.askApproval.mock.calls[0][1]).batchSearches).toMatchObject([
			{ searchStatus: "error" },
			{ searchStatus: "success", outputMode: "files" },
		])
	})

	it("declares nullable mode and literal inputs for single and batch queries", () => {
		const schema = searchFilesDefinition.function.parameters as any
		for (const object of [schema, schema.properties.queries.items]) {
			expect(object.additionalProperties).toBe(false)
			expect(object.properties.output_mode).toMatchObject({
				type: ["string", "null"],
				enum: ["content", "files", "count", null],
			})
			expect(object.properties.literal).toMatchObject({ type: ["boolean", "null"] })
		}
	})

	it("preserves per-query options in native batches and recovered concatenated calls", () => {
		const queries = [
			{ path: ".", regex: "foo(", literal: true, output_mode: "files" },
			{ path: ".", regex: "TODO", literal: null, output_mode: "count" },
		]
		for (const args of [JSON.stringify({ queries }), queries.map((query) => JSON.stringify(query)).join("")]) {
			const call = NativeToolCallParser.parseToolCall({
				id: "search-options",
				name: "search_files",
				arguments: args,
			})
			if (call?.type !== "tool_use") throw new Error("Expected a native search_files batch")
			expect(call.nativeArgs).toEqual({ queries })
		}
	})

	it.each([{ output_mode: "paths" }, { literal: "true" }])("rejects malformed new native options %j", (options) => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			const query = { path: ".", regex: "TODO", ...options }
			for (const args of [query, { queries: [query] }]) {
				expect(
					NativeToolCallParser.parseToolCall({
						id: "bad-option",
						name: "search_files",
						arguments: JSON.stringify(args),
					}),
				).toBeNull()
			}
		} finally {
			errorSpy.mockRestore()
		}
	})

	it.each([false, true])("emits one scheduler receipt for a batch (all errors: %s)", async (allErrors) => {
		regexSearchFilesMock.mockRejectedValueOnce(new Error("regex parse error: unclosed group"))
		if (allErrors) regexSearchFilesMock.mockRejectedValueOnce(new Error("permission denied"))
		const task = createTask()
		const push = vi.fn(() => true)
		Object.assign(task, {
			cwd: process.cwd(),
			taskId: "search-batch",
			abort: false,
			userMessageContent: [],
			userMessageContentReady: false,
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
			say: vi.fn(),
			recordToolUsage: vi.fn(),
			pushToolResultToUserContent: push,
		})
		const surface = createTaskToolSurface({
			registry: new ToolRegistry(),
			schemas: [searchFilesDefinition],
			cwd: task.cwd,
			mode: "code",
		})
		expect(surface.isCallable("search_files")).toBe(true)
		expect(surface.schemas).toEqual([searchFilesDefinition])
		const call = {
			type: "tool_call" as const,
			id: "search-batch",
			name: "search_files",
			arguments: {
				queries: [
					{ path: ".", regex: "(" },
					{ path: ".", regex: "TODO", output_mode: "files" },
				],
			},
		}
		const outcome = await new ToolScheduler({
			task,
			registry: surface.registry,
			policy: surface.policy,
			mode: "code",
			validateCall: () => {},
		}).run({ items: [call], toolCalls: [call], text: "", reasoning: "" })
		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0].status).toBe(allErrors ? "error" : "success")
		expect(push).toHaveBeenCalledOnce()
		expect(JSON.stringify(push.mock.calls)).toContain("regex parse error: unclosed group")
		expect(JSON.stringify(push.mock.calls)).toContain(allErrors ? "permission denied" : "results for TODO")
	})

	it("treats a successful no-match query beside an error as overall success", async () => {
		regexSearchFilesMock.mockRejectedValueOnce(new Error("bad regex")).mockResolvedValueOnce("Found 0 files.")
		const callbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			setResultMetadata: vi.fn(),
		}
		await new SearchFilesTool().execute(
			{
				queries: [
					{ path: ".", regex: "(" },
					{ path: ".", regex: "absent", output_mode: "files" },
				],
			},
			createTask(),
			callbacks,
		)
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "success" })
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(callbacks.pushToolResult.mock.calls[0][0]).toContain("Found 0 files.")
	})

	it("settles cancelled children without approving or publishing partial success", async () => {
		const controller = new AbortController()
		const reason = new Error("cancelled search batch")
		let started!: () => void
		const searching = new Promise<void>((resolve) => {
			started = resolve
		})
		regexSearchFilesMock.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					controller.signal.addEventListener("abort", () => reject(reason), { once: true })
					started()
				}),
		)
		const callbacks = {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			setResultMetadata: vi.fn(),
			signal: controller.signal,
		}
		const run = new SearchFilesTool().execute(
			{
				queries: [
					{ path: ".", regex: "pending" },
					{ path: ".", regex: "TODO" },
				],
			},
			createTask(),
			callbacks,
		)
		await searching
		controller.abort(reason)
		await run
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "cancelled" })
		expect(callbacks.handleError).toHaveBeenCalledWith("searching files", reason)
	})

	it("keeps outside-workspace approval flags for compact results", async () => {
		const callbacks = {
			askApproval: vi.fn().mockResolvedValue(false),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			setResultMetadata: vi.fn(),
		}
		await new SearchFilesTool().execute(
			{
				queries: [
					{ path: "src", regex: "TODO", output_mode: "files" },
					{ path: "../outside", regex: "TODO", output_mode: "count" },
				],
			},
			createTask(),
			callbacks,
		)
		const approval = JSON.parse(callbacks.askApproval.mock.calls[0][1])
		expect(approval.isOutsideWorkspace).toBe(true)
		expect(
			approval.batchSearches.map((query: { isOutsideWorkspace: boolean }) => query.isOutsideWorkspace),
		).toEqual([false, true])
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "denied" })
	})

	it("executes a bounded query batch with one approval and one tool result", async () => {
		const task = createTask()
		const askApproval = vi.fn().mockResolvedValue(true)
		const pushToolResult = vi.fn()
		const tool = new SearchFilesTool()

		await tool.execute(
			{
				queries: [
					{ path: "frontend/src", regex: "fetch|submit", file_pattern: "*.tsx" },
					{ path: "backend/app", regex: "@router|def ", file_pattern: "*.py" },
				],
			},
			task,
			{
				askApproval,
				handleError: vi.fn(),
				pushToolResult,
			},
		)

		expect(regexSearchFilesMock).toHaveBeenCalledTimes(2)
		expect(regexSearchFilesMock.mock.calls.map((call) => call[2])).toEqual(["fetch|submit", "@router|def "])
		expect(askApproval).toHaveBeenCalledTimes(1)

		const approval = JSON.parse(askApproval.mock.calls[0][1])
		expect(approval.tool).toBe("searchFiles")
		expect(approval.batchSearches).toHaveLength(2)
		expect(approval.batchSearches[0]).toMatchObject({
			path: "frontend/src",
			regex: "fetch|submit",
			filePattern: "*.tsx",
			content: "results for fetch|submit",
		})

		expect(pushToolResult).toHaveBeenCalledTimes(1)
		expect(pushToolResult.mock.calls[0][0]).toContain("Search 1: path=frontend/src")
		expect(pushToolResult.mock.calls[0][0]).toContain("Search 2: path=backend/app")
	})

	it("preserves the single-query result contract", async () => {
		const task = createTask()
		const askApproval = vi.fn().mockResolvedValue(true)
		const pushToolResult = vi.fn()
		const tool = new SearchFilesTool()

		await tool.execute({ path: "src", regex: "TODO", file_pattern: null }, task, {
			askApproval,
			handleError: vi.fn(),
			pushToolResult,
		})

		expect(askApproval).toHaveBeenCalledTimes(1)
		expect(JSON.parse(askApproval.mock.calls[0][1])).toMatchObject({
			tool: "searchFiles",
			path: "src",
			regex: "TODO",
			content: "results for TODO",
		})
		expect(pushToolResult).toHaveBeenCalledWith("results for TODO")
	})

	it.each(["content", "files", "count"] as const)(
		"bounds approval and model-facing output from broad %s searches",
		async (output_mode) => {
			regexSearchFilesMock.mockResolvedValue("match\n".repeat(10_000))
			const task = createTask()
			const askApproval = vi.fn().mockResolvedValue(true)
			const pushToolResult = vi.fn()
			const tool = new SearchFilesTool()

			await tool.execute({ path: ".", regex: "TODO|FIXME", output_mode }, task, {
				askApproval,
				handleError: vi.fn(),
				pushToolResult,
			})

			const approvalPayload = askApproval.mock.calls[0][1] as string
			const modelResult = pushToolResult.mock.calls[0][0] as string
			expect(approvalPayload.length).toBeLessThanOrEqual(16_000)
			expect(modelResult.length).toBeLessThanOrEqual(16_000)
			expect(approvalPayload).toContain("Search output truncated")
			expect(modelResult).toContain("Search output truncated")
		},
	)

	it.each(["files", "count"] as const)(
		"keeps complete %s entries when the 16k budget truncates output",
		async (output_mode) => {
			const lines = Array.from(
				{ length: 300 },
				(_, index) => `file-${index}-${"x".repeat(80)}.txt${output_mode === "count" ? ": 123456789" : ""}`,
			)
			regexSearchFilesMock.mockResolvedValue(lines.join("\n"))
			const callbacks = {
				askApproval: vi.fn().mockResolvedValue(true),
				handleError: vi.fn(),
				pushToolResult: vi.fn(),
			}
			await new SearchFilesTool().execute({ path: ".", regex: "TODO", output_mode }, createTask(), callbacks)
			const content = callbacks.pushToolResult.mock.calls[0][0] as string
			expect(content).toContain("Search output truncated")
			const visibleLines = content.split("\n").filter((line) => line && !line.startsWith("[Search output"))
			expect(visibleLines.length).toBeGreaterThan(0)
			expect(visibleLines.every((line) => lines.includes(line))).toBe(true)
		},
	)

	it("hard-bounds metadata-only overflow and reports dropped batch entries", async () => {
		regexSearchFilesMock.mockResolvedValue("ok")
		const task = createTask()
		const askApproval = vi.fn().mockResolvedValue(true)
		const pushToolResult = vi.fn()
		const oversizedMetadata = "\u0000".repeat(30_000)

		await new SearchFilesTool().execute(
			{
				queries: Array.from({ length: 8 }, (_, index) => ({
					path: index === 7 ? "../outside" : `src/query-${index}`,
					regex: oversizedMetadata,
					file_pattern: oversizedMetadata,
				})),
			},
			task,
			{ askApproval, handleError: vi.fn(), pushToolResult },
		)

		const approvalPayload = askApproval.mock.calls[0][1] as string
		const modelResult = pushToolResult.mock.calls[0][0] as string
		const approval = JSON.parse(approvalPayload)
		const visibleSearches = approval.batchSearches ?? [approval]

		expect(approvalPayload.length).toBeLessThanOrEqual(16_000)
		expect(modelResult.length).toBeLessThanOrEqual(16_000)
		expect(visibleSearches.length).toBeGreaterThan(0)
		expect(visibleSearches.length).toBeLessThan(8)
		expect(approval.isOutsideWorkspace).toBe(true)
		expect(visibleSearches[0].regex).toContain("...[truncated]")
		expect(visibleSearches[0].filePattern).toContain("...[truncated]")
		expect(approvalPayload).toContain("showing")
		expect(modelResult).toContain("showing")
	})

	it("declares bounded path, regex, and file-pattern schema inputs", () => {
		const schema = searchFilesDefinition.function.parameters as any
		const batchProperties = schema.properties.queries.items.properties

		expect(schema.properties.path.maxLength).toBe(4_096)
		expect(schema.properties.regex.maxLength).toBe(8_192)
		expect(schema.properties.file_pattern.maxLength).toBe(2_048)
		expect(batchProperties.path.maxLength).toBe(4_096)
		expect(batchProperties.regex.maxLength).toBe(8_192)
		expect(batchProperties.file_pattern.maxLength).toBe(2_048)
	})
})
