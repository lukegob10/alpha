import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { AlphaMessage } from "@alpha-code/types"
import { Task } from "../Task"
import { readTaskMessages, saveTaskMessages } from "../../task-persistence/taskMessages"

vi.mock("../../../utils/storage", async (original) => ({
	...(await original<typeof import("../../../utils/storage")>()),
	getTaskDirectoryPath: async (root: string, id: string) => {
		const directory = path.join(root, "tasks", id)
		await fs.mkdir(directory, { recursive: true })
		return directory
	},
}))

let directory: string
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-execution-status-"))
})
afterEach(async () => {
	vi.restoreAllMocks()
	await fs.rm(directory, { recursive: true, force: true })
})

function fixture(seed: AlphaMessage[]) {
	const updated = vi.fn(async () => undefined)
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "task",
		globalStoragePath: directory,
		alphaMessages: seed,
		providerRef: { deref: () => undefined },
		commandExecutionEvidence: new Map(),
		updateAlphaMessage: updated,
		publishParentVerificationEvidence: vi.fn(),
		saveAlphaMessages: vi.fn(async function (this: Task) {
			await saveTaskMessages({
				messages: structuredClone(this.alphaMessages),
				taskId: this.taskId,
				globalStoragePath: directory,
			})
			return true
		}),
	}) as Task
	return { task, updated }
}

it("persists command start/output/exit on the original approval and replays after a new Task loads", async () => {
	const { task, updated } = fixture([{ ts: 101, type: "ask", ask: "command", toolCallId: "call" }])
	const identity = { executionId: "101", taskId: "task", toolCallId: "call" }
	await task.recordCommandExecutionStatus({ ...identity, status: "started", command: "pnpm test", pid: 42 })
	const writes = vi.mocked(task["saveAlphaMessages"]).mock.calls.length
	await task.recordCommandExecutionStatus({ ...identity, status: "output", output: "Retained output" })
	expect(vi.mocked(task["saveAlphaMessages"]).mock.calls).toHaveLength(writes)
	expect(updated).toHaveBeenLastCalledWith(expect.objectContaining({ commandExecutionOutput: "Retained output" }))
	await task.recordCommandExecutionStatus({ ...identity, status: "exited", exitCode: 7 })
	const cold = fixture([]).task
	expect((await cold["getSavedAlphaMessages"](true))[0]).toMatchObject({
		commandExecutionStatus: { ...identity, status: "exited", exitCode: 7 },
		commandExecutionOutput: "Retained output",
	})
})

it("reconciles interrupted running records on reload without inventing success or changing old unknown records", async () => {
	const original: AlphaMessage[] = [
		{
			ts: 101,
			type: "ask",
			ask: "command",
			commandExecutionStatus: { executionId: "101", status: "started", command: "run", pid: 42 },
		},
		{
			ts: 102,
			type: "ask",
			ask: "use_mcp_server",
			mcpExecutionStatus: { executionId: "102", status: "started", serverName: "server", toolName: "tool" },
		},
		{ ts: 103, type: "ask", ask: "command", text: "Legacy" },
	]
	await saveTaskMessages({ messages: original, taskId: "task", globalStoragePath: directory })
	const cold = fixture([]).task
	const messages = await cold["getSavedAlphaMessages"](true)
	expect(messages[0].commandExecutionStatus?.status).toBe("cancelled")
	expect(messages[1].mcpExecutionStatus?.status).toBe("cancelled")
	expect(messages[2]).toEqual(original[2])
	expect((await readTaskMessages({ taskId: "task", globalStoragePath: directory }))[0]).toEqual(original[0])
})

it.each(["failed", "cancelled", "timed_out"] as const)(
	"projects canonical command %s onto its original approval",
	async (outcome) => {
		const { task } = fixture([{ ts: 101, type: "ask", ask: "command", toolCallId: "call" }])
		await task.recordCommandExecutionStatus({
			executionId: "101",
			toolCallId: "call",
			status: "started",
			command: "run",
		})
		task["commandExecutionEvidence"].set("call", {
			toolCallId: "call",
			executionId: "101:physical",
			status: "running",
			startedAt: 1,
		})
		task.failCommandExecution("call", outcome, "101:physical")
		expect(task.alphaMessages[0].commandExecutionStatus?.status).toBe(
			outcome === "failed" ? "error" : outcome === "timed_out" ? "timeout" : "cancelled",
		)
		await task["requireAlphaMessagesSaved"]("test terminal join")
	},
)

it("retains bounded MCP error output and cancellation through durable reload", async () => {
	const { task } = fixture([{ ts: 101, type: "ask", ask: "use_mcp_server", toolCallId: "call" }])
	const identity = { executionId: "101", taskId: "task", toolCallId: "call" }
	await task.recordMcpExecutionStatus({ ...identity, status: "started", serverName: "server", toolName: "tool" })
	await task.recordMcpExecutionStatus({ ...identity, status: "output", response: "x".repeat(200_000) })
	await task.recordMcpExecutionStatus({ ...identity, status: "cancelled" })
	await task.recordMcpExecutionStatus({ ...identity, status: "completed", response: "Late success" })
	await task.recordMcpExecutionStatus({ ...identity, status: "output", response: "Late output" })
	const cold = fixture([]).task
	const [saved] = await cold["getSavedAlphaMessages"](true)
	expect(saved.mcpExecutionStatus?.status).toBe("cancelled")
	expect(saved.mcpExecutionResponse).toHaveLength(100_000)
	expect(saved.mcpExecutionResponse).toContain("[Output preview truncated]")
	expect(saved.mcpExecutionResponse).not.toContain("Late")
})

it("fences terminal command status against late start and cross-task or cross-call events", async () => {
	const { task } = fixture([{ ts: 101, type: "ask", ask: "command", toolCallId: "call" }])
	const identity = { executionId: "101", taskId: "task", toolCallId: "call" }
	await task.recordCommandExecutionStatus({ ...identity, status: "cancelled" })
	await task.recordCommandExecutionStatus({ ...identity, status: "started", command: "Late start" })
	await task.recordCommandExecutionStatus({ ...identity, status: "exited", exitCode: 0 })
	await task.recordCommandExecutionStatus({ ...identity, status: "fallback" })
	await task.recordCommandExecutionStatus({ ...identity, status: "fallback" }, { confirmedPrelaunchFallback: true })
	await task.recordCommandExecutionStatus({
		...identity,
		taskId: "other-task",
		status: "output",
		output: "Wrong task",
	})
	await task.recordCommandExecutionStatus({
		...identity,
		toolCallId: "other-call",
		status: "output",
		output: "Wrong call",
	})
	expect(task.alphaMessages[0].commandExecutionStatus?.status).toBe("cancelled")
	expect(task.alphaMessages[0].commandExecutionOutput).toBeUndefined()
})

it("retains running command status when the same Task still owns the live process during hydration", async () => {
	const { task } = fixture([{ ts: 101, type: "ask", ask: "command" }])
	await task.recordCommandExecutionStatus({ executionId: "101", status: "started", command: "run", pid: 42 })
	task.terminalProcess = { executionId: "101:physical", isSettled: false } as Task["terminalProcess"]
	expect((await task["getSavedAlphaMessages"](true))[0].commandExecutionStatus?.status).toBe("started")
})

it.each(["command", "mcp"] as const)(
	"publishes %s terminal memory state while preserving a durability failure",
	async (kind) => {
		const { task, updated } = fixture([
			{ ts: 101, type: "ask", ask: kind === "command" ? "command" : "use_mcp_server" },
		])
		const failure = new Error("Disk unavailable")
		vi.mocked(task["saveAlphaMessages"]).mockRejectedValue(failure)
		const terminal = { executionId: "101", status: "cancelled" } as const
		const update =
			kind === "command" ? task.recordCommandExecutionStatus(terminal) : task.recordMcpExecutionStatus(terminal)
		await expect(update).rejects.toBe(failure)
		expect(updated).toHaveBeenCalledWith(
			expect.objectContaining({
				[kind === "command" ? "commandExecutionStatus" : "mcpExecutionStatus"]: terminal,
			}),
		)
	},
)

it.each(["command-error", "mcp-error", "command-started"] as const)(
	"bounds retained %s text without splitting Unicode or changing its original invocation",
	async (kind) => {
		const marker = "\n[Output preview truncated]"
		const prefix = "x".repeat(100_000 - marker.length - 1)
		const original = prefix + "😀" + "y".repeat(200_000)
		const { task } = fixture([
			{ ts: 101, type: "ask", ask: kind === "mcp-error" ? "use_mcp_server" : "command", text: original },
		])
		if (kind === "mcp-error") {
			await task.recordMcpExecutionStatus({ executionId: "101", status: "error", error: original })
		} else if (kind === "command-error") {
			await task.recordCommandExecutionStatus({ executionId: "101", status: "error", error: original })
		} else {
			await task.recordCommandExecutionStatus({ executionId: "101", status: "started", command: original })
		}
		const [saved] = await readTaskMessages({ taskId: "task", globalStoragePath: directory })
		const status = saved.mcpExecutionStatus ?? saved.commandExecutionStatus
		const retained =
			status?.status === "error"
				? status.error
				: status?.status === "started" && "command" in status
					? status.command
					: undefined
		expect(retained).toBe(prefix + marker)
		expect(retained!.length).toBeLessThanOrEqual(100_000)
		expect(JSON.stringify(status).length).toBeLessThan(100_512)
		expect(saved.text).toBe(original)
	},
)
