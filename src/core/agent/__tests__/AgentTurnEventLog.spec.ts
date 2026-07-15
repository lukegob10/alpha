import * as fs from "fs/promises"
import * as path from "path"
import { tmpdir } from "os"
import { describe, expect, it, vi } from "vitest"

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: async (globalStoragePath: string, taskId: string) => {
		const taskDirectory = path.join(globalStoragePath, taskId)
		await fs.mkdir(taskDirectory, { recursive: true })
		return taskDirectory
	},
}))

import { GlobalFileNames } from "../../../shared/globalFileNames"
import { AgentTurnEventLog } from "../AgentTurnEventLog"

describe("AgentTurnEventLog", () => {
	it("writes ordered bounded and redacted task events", async () => {
		const storagePath = await fs.mkdtemp(path.join(tmpdir(), "agent-turn-events-"))
		const log = new AgentTurnEventLog("task-1", storagePath)

		await Promise.all([
			log.append({ type: "progress", text: "a" }),
			log.append({
				type: "tool_result",
				callId: "call-1",
				name: "read_file",
				status: "success",
				output: { apiKey: "secret-token-value" },
			}),
			log.append({ type: "progress", text: "x".repeat(10_000) }),
		])

		const contents = await fs.readFile(path.join(storagePath, "task-1", GlobalFileNames.agentTurnEvents), "utf8")
		const records = contents
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as { sequence: number; event: { text?: string; output?: { apiKey?: string } } },
			)

		expect(records.map((record) => record.sequence)).toEqual([1, 2, 3])
		expect(records[1].event.output?.apiKey).toBe("[redacted]")
		expect(records[2].event.text).toContain("[truncated]")
	})
})
