import fs from "fs/promises"

import { fileExistsAtPath } from "../../../utils/fs"
import { experiments } from "../../../shared/experiments"
import { ApplyDiffTool } from "../ApplyDiffTool"
import { MultiSearchReplaceDiffStrategy } from "../../diff/strategies/multi-search-replace"
import { DiffViewProvider } from "../../../integrations/editor/DiffViewProvider"
import { ToolRegistry } from "../ToolRegistry"
import { ToolScheduler } from "../../agent/ToolScheduler"
import type { AgentTurnEvent } from "../../agent/AgentTurnEvents"

vi.mock("@alpha-code/telemetry", () => ({
	TelemetryService: { instance: { captureDiffApplicationError: vi.fn() } },
}))

vi.mock("fs/promises", () => ({
	default: {
		readFile: vi.fn().mockResolvedValue("old\n"),
		writeFile: vi.fn(),
	},
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

vi.mock("../../../shared/experiments", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../shared/experiments")>()
	return { ...actual, experiments: { isEnabled: vi.fn(() => true) } }
})

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((message: string) => `Error: ${message}`),
		toolDenied: vi.fn(() => "The user denied this operation."),
		rooIgnoreError: vi.fn((filePath: string) => `Access denied: ${filePath}`),
		createPrettyPatch: vi.fn(() => "mock-diff"),
	},
}))

vi.mock("../../diff/stats", () => ({
	computeDiffStats: vi.fn(() => ({ additions: 1, deletions: 1 })),
	sanitizeUnifiedDiff: vi.fn((diff: string) => diff),
}))

const mockedFs = vi.mocked(fs)
const mockedFileExists = vi.mocked(fileExistsAtPath)

function createTask() {
	return {
		cwd: "/workspace",
		consecutiveMistakeCount: 0,
		consecutiveMistakeCountForApplyDiff: new Map(),
		didEditFile: false,
		didRejectTool: false,
		didToolFailInCurrentTurn: false,
		taskId: "task",
		api: { getModel: vi.fn(() => ({ id: "claude-3" })) },
		rooIgnoreController: { validateAccess: vi.fn(() => true) },
		rooProtectedController: { isWriteProtected: vi.fn(() => false) },
		providerRef: {
			deref: () => ({
				runWorkspaceMutation: async (_task: unknown, _label: string, run: () => Promise<void>) => run(),
				getState: vi.fn(async () => ({
					diagnosticsEnabled: false,
					writeDelayMs: 0,
					experiments: {},
				})),
			}),
		},
		diffStrategy: {
			applyDiff: vi.fn(async () => ({ success: true, content: "new\n" })),
		},
		diffViewProvider: {
			editType: undefined,
			originalContent: undefined,
			open: vi.fn(),
			update: vi.fn(),
			scrollToFirstDiff: vi.fn(),
			saveDirectly: vi.fn(),
			saveChanges: vi.fn(),
			reset: vi.fn(),
			revertChanges: vi.fn(),
			pushToolWriteResult: vi.fn(async () => "write complete"),
		},
		fileContextTracker: { trackFileContext: vi.fn() },
		say: vi.fn(),
		recordToolError: vi.fn(),
		recordToolUsage: vi.fn(),
		processQueuedMessages: vi.fn(),
		checkpointSave: vi.fn(),
		sayAndCreateMissingParamError: vi.fn(async () => "Missing required parameter"),
	} as any
}

function createCallbacks() {
	return {
		askApproval: vi.fn(async () => true),
		pushToolResult: vi.fn(),
		handleError: vi.fn(),
		setResultMetadata: vi.fn(),
	}
}

function patchBlock(search: string, replacement: string, line = 1) {
	return `<<<<<<< SEARCH\n:start_line:${line}\n-------\n${search}\n=======\n${replacement}\n>>>>>>> REPLACE`
}

async function runScheduledDiff(task: ReturnType<typeof createTask>, diff: string, approve = true) {
	const published: unknown[] = []
	const events: AgentTurnEvent[] = []
	Object.assign(task, {
		abort: false,
		userMessageContent: [],
		ask: vi.fn(async () => ({ response: approve ? "yesButtonClicked" : "noButtonClicked" })),
		pushToolResultToUserContent: (result: unknown) => {
			published.push(result)
			return true
		},
	})
	const call = {
		type: "tool_call" as const,
		id: "diff-regression",
		name: "apply_diff",
		arguments: { path: "test.txt", diff },
	}
	const outcome = await new ToolScheduler({
		task,
		registry: new ToolRegistry(),
		mode: "code",
		validateCall: () => {},
		onEvent: (event) => {
			events.push(event)
		},
	}).run({ items: [call], text: "", reasoning: "", toolCalls: [call] })
	return { outcome, published, events }
}

describe("ApplyDiffTool", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(experiments.isEnabled).mockReturnValue(true)
		mockedFileExists.mockResolvedValue(true)
		mockedFs.readFile.mockResolvedValue("old\n")
	})

	it("records an identical patch as one error in the scheduler, trace, and provider history without writing", async () => {
		const task = createTask()
		task.diffStrategy = new MultiSearchReplaceDiffStrategy()
		const { outcome, published, events } = await runScheduledDiff(task, patchBlock("old", "old"))

		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0]).toMatchObject({ status: "error", content: expect.stringContaining("identical") })
		expect(published).toEqual([expect.objectContaining({ tool_use_id: "diff-regression", is_error: true })])
		expect(events.filter((event) => event.type === "tool_result")).toEqual([
			expect.objectContaining({ callId: "diff-regression", status: "error" }),
		])
		expect(task.ask).not.toHaveBeenCalled()
		expect(task.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
		expect(task.diffViewProvider.saveChanges).not.toHaveBeenCalled()
		expect(task.didEditFile).toBe(false)
	})

	it.each([true, false])("reports partial writes and only the failed block with direct writes=%s", async (direct) => {
		vi.mocked(experiments.isEnabled).mockReturnValue(direct)
		mockedFs.readFile.mockResolvedValue("old\nkeep\n")
		const task = createTask()
		task.diffStrategy = new MultiSearchReplaceDiffStrategy()
		Object.assign(task.diffViewProvider, { relPath: "test.txt" })
		task.diffViewProvider.pushToolWriteResult = DiffViewProvider.prototype.pushToolWriteResult
		// Input order differs from line order: identify the submitted block, not its sorted position.
		const { outcome, published } = await runScheduledDiff(
			task,
			[patchBlock("keep", "keep", 2), patchBlock("old", "new\nadded")].join("\n"),
		)

		expect(outcome.results[0]).toMatchObject({ status: "error" })
		const output = String(outcome.results[0].content)
		expect(output).toContain('"operation":"modified"')
		expect(output).toContain("SEARCH/REPLACE block 1 (original start line: 2)")
		expect(output).toContain("identical")
		expect(output).toContain("Do not reapply successful blocks")
		expect(output).not.toContain("You do not need to re-read")
		expect(published).toEqual([expect.objectContaining({ is_error: true })])
		expect(task.didEditFile).toBe(true)
		expect(task.recordToolError).toHaveBeenCalledWith("apply_diff", expect.stringContaining("identical"))
		if (direct) {
			expect(task.diffViewProvider.saveDirectly).toHaveBeenCalledExactlyOnceWith(
				"test.txt",
				"new\nadded\nkeep\n",
				false,
				false,
				0,
				{ exists: true, content: "old\nkeep\n" },
			)
			expect(task.diffViewProvider.saveChanges).not.toHaveBeenCalled()
		} else {
			expect(task.diffViewProvider.update).toHaveBeenCalledWith("new\nadded\nkeep\n", true)
			expect(task.diffViewProvider.saveChanges).toHaveBeenCalledOnce()
			expect(task.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
		}
	})

	it.each([true, false])(
		"does not save or claim partial changes after denial with direct writes=%s",
		async (direct) => {
			vi.mocked(experiments.isEnabled).mockReturnValue(direct)
			mockedFs.readFile.mockResolvedValue("old\nkeep\n")
			const task = createTask()
			task.diffStrategy = new MultiSearchReplaceDiffStrategy()
			const { outcome, published } = await runScheduledDiff(
				task,
				[patchBlock("keep", "keep", 2), patchBlock("old", "new")].join("\n"),
				false,
			)
			expect(outcome.results[0].status).toBe("denied")
			expect(published).toEqual([expect.objectContaining({ is_error: true })])
			expect(task.diffViewProvider.saveDirectly).not.toHaveBeenCalled()
			expect(task.diffViewProvider.saveChanges).not.toHaveBeenCalled()
			expect(task.diffViewProvider.pushToolWriteResult).not.toHaveBeenCalled()
			expect(task.didEditFile).toBe(false)
		},
	)

	it.each(["missing path", "missing diff", "missing file", "ignored file"])(
		"reports the structured status for %s before requesting approval",
		async (scenario) => {
			const task = createTask()
			const callbacks = createCallbacks()
			if (scenario === "missing file") mockedFileExists.mockResolvedValue(false)
			if (scenario === "ignored file") task.rooIgnoreController.validateAccess.mockReturnValue(false)
			await new ApplyDiffTool().execute(
				{
					path: scenario === "missing path" ? "" : "test.txt",
					diff: scenario === "missing diff" ? "" : patchBlock("old", "new"),
				},
				task,
				callbacks,
			)
			expect(callbacks.handleError).not.toHaveBeenCalled()
			expect(callbacks.setResultMetadata).toHaveBeenCalledWith({
				status: scenario === "ignored file" ? "denied" : "error",
			})
			expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
			expect(callbacks.askApproval).not.toHaveBeenCalled()
		},
	)

	it("retains every failed block when none can be applied", async () => {
		const task = createTask()
		task.diffStrategy = new MultiSearchReplaceDiffStrategy()
		const callbacks = createCallbacks()
		await new ApplyDiffTool().execute(
			{ path: "test.txt", diff: [patchBlock("old", "old"), patchBlock("missing", "new", 2)].join("\n") },
			task,
			callbacks,
		)
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("identical"))
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("No sufficiently similar match"))
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }))
	})

	it("preserves success for an applied patch", async () => {
		const task = createTask()
		task.diffStrategy = new MultiSearchReplaceDiffStrategy()
		const { outcome, published } = await runScheduledDiff(task, patchBlock("old", "new"))
		expect(outcome.results[0].status).toBe("success")
		expect(published).toEqual([expect.objectContaining({ is_error: false })])
		expect(task.diffViewProvider.saveDirectly).toHaveBeenCalledOnce()
		expect(task.recordToolError).not.toHaveBeenCalled()
	})

	it("resets direct approval state before handling another path", async () => {
		const task = createTask()
		const callbacks = createCallbacks()
		callbacks.askApproval.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
		const tool = new ApplyDiffTool()

		await tool.execute(
			{ path: "first.txt", diff: "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE" },
			task,
			callbacks as any,
		)
		await tool.execute(
			{ path: "second.txt", diff: "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE" },
			task,
			callbacks as any,
		)

		expect(task.diffViewProvider.reset).toHaveBeenCalledTimes(2)
		expect(task.diffViewProvider.saveDirectly).toHaveBeenCalledTimes(1)
		expect(task.diffViewProvider.saveDirectly.mock.invocationCallOrder[0]).toBeGreaterThan(
			task.diffViewProvider.reset.mock.invocationCallOrder[0],
		)
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	it("passes the raw baseline to the diff preview after diff computation", async () => {
		vi.mocked(experiments.isEnabled).mockReturnValue(false)
		const rawBaseline = "old\r\n"
		const task = createTask()
		const callbacks = createCallbacks()
		task.diffStrategy.applyDiff.mockImplementationOnce(async () => {
			// A later disk read must not become the preview baseline.
			mockedFs.readFile.mockResolvedValueOnce("changed while computing diff")
			return { success: true, content: "new\r\n" }
		})
		mockedFs.readFile.mockResolvedValueOnce(rawBaseline)

		await new ApplyDiffTool().execute(
			{ path: "test.txt", diff: "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE" },
			task,
			callbacks as any,
		)

		expect(task.diffViewProvider.open).toHaveBeenCalledWith("test.txt", {
			exists: true,
			content: rawBaseline,
		})
	})
})
