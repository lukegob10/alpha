import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"

// Mocks (use hoisted to avoid initialization ordering issues)
const hoisted = vi.hoisted(() => ({
	safeWriteJsonMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: hoisted.safeWriteJsonMock,
}))

// Import after mocks
import { saveTaskMessages, readTaskMessages, TaskMessagesReadError } from "../taskMessages"

let tmpBaseDir: string

beforeEach(async () => {
	hoisted.safeWriteJsonMock.mockClear()
	// Create a unique, writable temp directory to act as globalStoragePath
	tmpBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-test-"))
})

afterEach(async () => {
	vi.restoreAllMocks()
	await fs.rm(tmpBaseDir, { recursive: true, force: true })
})

describe("taskMessages.saveTaskMessages", () => {
	beforeEach(() => {
		hoisted.safeWriteJsonMock.mockClear()
	})

	it("persists messages as-is", async () => {
		const messages: any[] = [
			{
				role: "assistant",
				content: "Hello",
				metadata: {
					other: "keep",
				},
			},
			{ role: "user", content: "Do thing" },
		]

		await saveTaskMessages({
			messages,
			taskId: "task-1",
			globalStoragePath: tmpBaseDir,
		})

		expect(hoisted.safeWriteJsonMock).toHaveBeenCalledTimes(1)
		const [, persisted] = hoisted.safeWriteJsonMock.mock.calls[0]
		expect(persisted).toEqual(messages)
	})

	it("persists messages without modification when no metadata", async () => {
		const messages: any[] = [
			{ role: "assistant", content: "Hi" },
			{ role: "user", content: "Yo" },
		]

		await saveTaskMessages({
			messages,
			taskId: "task-2",
			globalStoragePath: tmpBaseDir,
		})

		const [, persisted] = hoisted.safeWriteJsonMock.mock.calls[0]
		expect(persisted).toEqual(messages)
	})
})

describe("taskMessages.readTaskMessages", () => {
	it.each(["{broken json", '"not an array"'])(
		"preserves invalid bytes during strict reopen: %s",
		async (contents) => {
			const taskId = "strict-invalid"
			const taskDir = path.join(tmpBaseDir, "tasks", taskId)
			await fs.mkdir(taskDir, { recursive: true })
			const filePath = path.join(taskDir, "ui_messages.json")
			await fs.writeFile(filePath, contents, "utf8")
			await expect(
				readTaskMessages({ taskId, globalStoragePath: tmpBaseDir, requireExisting: true }),
			).rejects.toMatchObject({ name: "TaskMessagesReadError", kind: "invalid" })
			expect(await fs.readFile(filePath, "utf8")).toBe(contents)
			expect(hoisted.safeWriteJsonMock).not.toHaveBeenCalled()
		},
	)

	it("distinguishes missing existing history from an explicitly empty saved transcript", async () => {
		const options = { taskId: "strict-missing", globalStoragePath: tmpBaseDir, requireExisting: true }
		await expect(readTaskMessages(options)).rejects.toMatchObject({ kind: "not_found" })
		await fs.writeFile(path.join(tmpBaseDir, "tasks", options.taskId, "ui_messages.json"), "[]", "utf8")
		await expect(readTaskMessages(options)).resolves.toEqual([])
		expect(hoisted.safeWriteJsonMock).not.toHaveBeenCalled()
	})

	it("reports I/O failure without interpreting it as empty history", async () => {
		await fs.mkdir(path.join(tmpBaseDir, "tasks", "strict-io", "ui_messages.json"), { recursive: true })
		await expect(
			readTaskMessages({ taskId: "strict-io", globalStoragePath: tmpBaseDir, requireExisting: true }),
		).rejects.toEqual(new TaskMessagesReadError("io_error"))
		expect(hoisted.safeWriteJsonMock).not.toHaveBeenCalled()
	})

	it("returns empty array when file contains invalid JSON", async () => {
		const taskId = "task-corrupt-json"
		// Manually create the task directory and write corrupted JSON
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "ui_messages.json")
		await fs.writeFile(filePath, "{not valid json!!!", "utf8")

		const result = await readTaskMessages({
			taskId,
			globalStoragePath: tmpBaseDir,
		})

		expect(result).toEqual([])
	})

	it("returns [] when file contains valid JSON that is not an array", async () => {
		const taskId = "task-non-array-json"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "ui_messages.json")
		await fs.writeFile(filePath, JSON.stringify("hello"), "utf8")

		const result = await readTaskMessages({
			taskId,
			globalStoragePath: tmpBaseDir,
		})

		expect(result).toEqual([])
	})
})
