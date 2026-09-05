import fs from "fs/promises"

import { fileExistsAtPath } from "../../../utils/fs"
import { experiments } from "../../../shared/experiments"
import { ApplyDiffTool } from "../ApplyDiffTool"

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
		rooIgnoreError: vi.fn((filePath: string) => `Access denied: ${filePath}`),
		createPrettyPatch: vi.fn(() => "mock-diff"),
	},
}))

vi.mock("../../diff/stats", () => ({
	computeDiffStats: vi.fn(() => ({ additions: 1, deletions: 1 })),
	sanitizeUnifiedDiff: vi.fn((diff: string) => diff),
}))

vi.mock("../../../utils/text-normalization", () => ({
	unescapeHtmlEntities: vi.fn((content: string) => content),
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
			saveDirectly: vi.fn(),
			reset: vi.fn(),
			pushToolWriteResult: vi.fn(async () => "write complete"),
		},
		fileContextTracker: { trackFileContext: vi.fn() },
		say: vi.fn(),
		recordToolError: vi.fn(),
		recordToolUsage: vi.fn(),
		processQueuedMessages: vi.fn(),
	} as any
}

function createCallbacks() {
	return {
		askApproval: vi.fn(async () => true),
		pushToolResult: vi.fn(),
		handleError: vi.fn(),
	}
}

describe("ApplyDiffTool", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(experiments.isEnabled).mockReturnValue(true)
		mockedFileExists.mockResolvedValue(true)
		mockedFs.readFile.mockResolvedValue("old\n")
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
})
