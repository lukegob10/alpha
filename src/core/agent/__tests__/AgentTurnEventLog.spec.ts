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
import { AgentTurnEventLog, readAgentTurnEvents } from "../AgentTurnEventLog"

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
		await log.flush()

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

	it("supports an explicit idempotent close and redacts inline secrets without hiding usage", async () => {
		const storagePath = await fs.mkdtemp(path.join(tmpdir(), "agent-turn-events-close-"))
		const log = new AgentTurnEventLog("task-close", storagePath, { runId: "run-fixed" })

		await log.append({
			type: "assistant_committed",
			response: {
				items: [
					{ type: "text", text: "Authorization: Bearer super-secret" },
					{ type: "usage", inputTokens: 3, outputTokens: 4, cacheReadTokens: 2 },
				],
				text: "Authorization: Bearer super-secret",
				reasoning: "",
				toolCalls: [],
			},
		})
		await Promise.all([log.close(), log.close()])

		expect(log.getRunId()).toBe("run-fixed")
		await expect(log.append({ type: "progress", text: "late" })).rejects.toThrow("closed")

		const records = await readFileRecords(storagePath, "task-close")
		expect(records[0].event).toMatchObject({
			type: "assistant_committed",
			response: {
				items: [
					{ type: "text", text: "Authorization: Bearer [redacted]" },
					{ type: "usage", inputTokens: 3, outputTokens: 4, cacheReadTokens: 2 },
				],
			},
		})
	})

	it("surfaces queued write failures while allowing later appends", async () => {
		const storagePath = await fs.mkdtemp(path.join(tmpdir(), "agent-turn-events-recovery-"))
		const log = new AgentTurnEventLog("task-recovery", storagePath)
		const eventsPath = path.join(storagePath, "task-recovery", GlobalFileNames.agentTurnEvents)
		// A directory at the JSONL target makes the first append fail without
		// mocking the ESM fs namespace. Removing it restores the target for the
		// subsequent append and models a transient filesystem repair.
		await fs.mkdir(eventsPath, { recursive: true })

		const failedAppend = log.append({ type: "progress", text: "first" })
		await expect(failedAppend).rejects.toMatchObject({ code: "EISDIR" })
		await expect(log.flush()).rejects.toMatchObject({ code: "EISDIR" })

		await fs.rm(eventsPath, { recursive: true, force: true })
		await expect(log.append({ type: "progress", text: "second" })).resolves.toBeUndefined()
		await expect(log.flush()).resolves.toBeUndefined()
		await log.close()

		const records = await readFileRecords(storagePath, "task-recovery")
		expect(records).toHaveLength(1)
		expect(records[0].event).toEqual({ type: "progress", text: "second" })
	})

	it("replays overlapping per-run sequences in deterministic chronological order", async () => {
		const storagePath = await fs.mkdtemp(path.join(tmpdir(), "agent-turn-events-multi-run-"))
		const taskId = "task-multi-run"
		const eventsPath = path.join(storagePath, taskId, GlobalFileNames.agentTurnEvents)
		await fs.mkdir(path.dirname(eventsPath), { recursive: true })

		// Simulate two runs written to one task journal. Their sequence counters
		// both restart at one, so sorting by sequence alone would interleave them
		// incorrectly and lose the actual cross-run chronology.
		await fs.writeFile(
			eventsPath,
			[
				{
					taskId,
					runId: "run-a",
					sequence: 2,
					timestamp: 400,
					event: { type: "progress", text: "a2" },
				},
				{
					taskId,
					runId: "run-b",
					sequence: 1,
					timestamp: 100,
					event: { type: "progress", text: "b1" },
				},
				{
					taskId,
					runId: "run-a",
					sequence: 1,
					timestamp: 200,
					event: { type: "progress", text: "a1" },
				},
				{
					taskId,
					runId: "run-b",
					sequence: 2,
					timestamp: 300,
					event: { type: "progress", text: "b2" },
				},
			]
				.map((record) => JSON.stringify(record) + "\n")
				.join(""),
			"utf8",
		)

		const replay = await readAgentTurnEvents(taskId, storagePath)
		expect(replay.map((record) => `${record.runId}:${record.sequence}`)).toEqual([
			"run-b:1",
			"run-a:1",
			"run-b:2",
			"run-a:2",
		])

		const sequencesByRun = replay.reduce((groups, record) => {
			const group = groups.get(record.runId) ?? []
			group.push(record)
			groups.set(record.runId, group)
			return groups
		}, new Map<string, typeof replay>())
		expect(sequencesByRun.get("run-a")?.map((record) => record.sequence)).toEqual([1, 2])
		expect(sequencesByRun.get("run-b")?.map((record) => record.sequence)).toEqual([1, 2])
	})

	it("uses stable run and sequence tie-breakers when runs share a timestamp", async () => {
		const storagePath = await fs.mkdtemp(path.join(tmpdir(), "agent-turn-events-tie-breaker-"))
		const taskId = "task-tie-breaker"
		const eventsPath = path.join(storagePath, taskId, GlobalFileNames.agentTurnEvents)
		await fs.mkdir(path.dirname(eventsPath), { recursive: true })

		await fs.writeFile(
			eventsPath,
			[
				{ taskId, runId: "run-z", sequence: 1, timestamp: 100, event: { type: "progress", text: "z" } },
				{ taskId, runId: "run-a", sequence: 1, timestamp: 100, event: { type: "progress", text: "a" } },
			]
				.map((record) => JSON.stringify(record) + "\n")
				.join(""),
			"utf8",
		)

		const replay = await readAgentTurnEvents(taskId, storagePath)
		expect(replay.map((record) => record.runId)).toEqual(["run-a", "run-z"])
	})

	it("preserves every run sequence under randomized clock rollback", async () => {
		const storagePath = await fs.mkdtemp(path.join(tmpdir(), "agent-turn-events-rollback-"))
		const taskId = "task-rollback"
		const eventsPath = path.join(storagePath, taskId, GlobalFileNames.agentTurnEvents)
		await fs.mkdir(path.dirname(eventsPath), { recursive: true })
		let seed = 0x51f15e
		const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000
		const records = ["run-a", "run-b", "run-c"].flatMap((runId) =>
			Array.from({ length: 20 }, (_, index) => ({
				taskId,
				runId,
				sequence: index + 1,
				// Deliberately unrelated to sequence, including frequent rollback.
				timestamp: Math.floor(random() * 100),
				event: { type: "progress", text: `${runId}:${index + 1}` },
			})),
		)
		for (let index = records.length - 1; index > 0; index--) {
			const swap = Math.floor(random() * (index + 1))
			;[records[index], records[swap]] = [records[swap], records[index]]
		}
		await fs.writeFile(eventsPath, records.map((record) => JSON.stringify(record)).join("\n"), "utf8")

		const replay = await readAgentTurnEvents(taskId, storagePath)
		for (const runId of ["run-a", "run-b", "run-c"]) {
			expect(replay.filter((record) => record.runId === runId).map((record) => record.sequence)).toEqual(
				Array.from({ length: 20 }, (_, index) => index + 1),
			)
		}
	})

	it("rejects malformed persisted records instead of partially replaying them", async () => {
		const storagePath = await fs.mkdtemp(path.join(tmpdir(), "agent-turn-events-invalid-"))
		const taskId = "task-invalid"
		const eventsPath = path.join(storagePath, taskId, GlobalFileNames.agentTurnEvents)
		await fs.mkdir(path.dirname(eventsPath), { recursive: true })
		await fs.writeFile(eventsPath, JSON.stringify({ taskId, runId: "run", sequence: 0 }), "utf8")
		await expect(readAgentTurnEvents(taskId, storagePath)).rejects.toThrow("Invalid agent turn event at line 1")
	})
})

async function readFileRecords(storagePath: string, taskId: string) {
	const contents = await fs.readFile(path.join(storagePath, taskId, GlobalFileNames.agentTurnEvents), "utf8")
	return contents
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { event: any })
}
