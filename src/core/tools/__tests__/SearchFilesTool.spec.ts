import type { Task } from "../../task/Task"
import searchFilesDefinition from "../../prompts/tools/native-tools/search_files"
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

	it("bounds approval and model-facing output from broad searches", async () => {
		regexSearchFilesMock.mockResolvedValue("match\n".repeat(10_000))
		const task = createTask()
		const askApproval = vi.fn().mockResolvedValue(true)
		const pushToolResult = vi.fn()
		const tool = new SearchFilesTool()

		await tool.execute({ path: ".", regex: "TODO|FIXME" }, task, {
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
	})

	it("hard-bounds metadata-only overflow and reports dropped batch entries", async () => {
		regexSearchFilesMock.mockResolvedValue("ok")
		const task = createTask()
		const askApproval = vi.fn().mockResolvedValue(true)
		const pushToolResult = vi.fn()
		const oversizedMetadata = "\u0000".repeat(30_000)

		await new SearchFilesTool().execute(
			{
				queries: Array.from({ length: 8 }, (_, index) => ({
					path: `src/query-${index}`,
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
