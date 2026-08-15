import type { Task } from "../../task/Task"
import { SearchFilesTool } from "../SearchFilesTool"

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
			rooIgnoreController: undefined,
		}) as unknown as Task

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
})
