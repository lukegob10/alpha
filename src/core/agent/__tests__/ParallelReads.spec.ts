import * as fs from "fs/promises"
import path from "path"
import { tmpdir } from "os"
import type { Task } from "../../task/Task"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { ToolScheduler } from "../ToolScheduler"

describe("retired native file calls", () => {
	let root: string
	let task: Task
	let content: any[]
	let registry: ToolRegistry
	let scheduler: ToolScheduler

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "retired-file-tools-")))
		await fs.writeFile(path.join(root, "sentinel.txt"), "must remain unchanged")
		content = []
		task = {
			taskId: "retired-file-calls",
			taskKind: "primary",
			cwd: root,
			abort: false,
			userMessageContent: content,
			ask: vi.fn(),
			say: vi.fn(),
			pushToolResultToUserContent(result: any) {
				content.push(result)
				return true
			},
		} as unknown as Task
		const surface = createTaskToolSurface({ registry: new ToolRegistry(), mode: "code", cwd: root })
		registry = surface.registry
		scheduler = new ToolScheduler({ task, registry, policy: surface.policy, mode: "code" })
	})

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	it("returns one terminal unknown-tool receipt per saved file call without invoking or changing files", async () => {
		const savedCalls = [
			{
				type: "tool_call" as const,
				id: "saved-read",
				name: "read_file",
				arguments: { files: [{ path: "sentinel.txt" }] },
			},
			{ type: "tool_call" as const, id: "saved-list", name: "list_files", arguments: { path: "." } },
			{
				type: "tool_call" as const,
				id: "saved-search",
				name: "search_files",
				arguments: { queries: [{ path: ".", regex: "sentinel" }] },
			},
		]

		for (const call of savedCalls) expect(registry.resolve(call.name)).toBeUndefined()
		const outcome = await scheduler.run(savedCalls)

		expect(outcome.results.map(({ callId, status, failure }) => [callId, status, failure?.reason])).toEqual(
			savedCalls.map((call) => [call.id, "error", "capability_unavailable"]),
		)
		for (const [index, result] of outcome.results.entries()) {
			expect(JSON.parse(String(result.content))).toMatchObject({
				status: "error",
				message: "The tool execution failed",
				error: expect.stringContaining(`Unknown tool "${savedCalls[index].name}"`),
			})
		}
		expect(content).toHaveLength(savedCalls.length)
		expect(content.map(({ tool_use_id, is_error }) => [tool_use_id, is_error])).toEqual(
			savedCalls.map(({ id }) => [id, true]),
		)
		expect(task.ask).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
		expect(await fs.readFile(path.join(root, "sentinel.txt"), "utf8")).toBe("must remain unchanged")
	})
})
