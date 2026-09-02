import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { AgentLifecycleEvent } from "@alpha-code/types"

vi.mock("../../../../utils/storage", () => ({
	getTaskDirectoryPath: async (globalStoragePath: string, taskId: string) => {
		const taskDirectory = path.join(globalStoragePath, taskId)
		await fs.mkdir(taskDirectory, { recursive: true })
		return taskDirectory
	},
}))

import { GlobalFileNames } from "../../../../shared/globalFileNames"
import { AgentLifecycleJournal, AgentLifecycleRecoveryError, readAgentLifecycleEvents } from "../index.js"

const ids = { taskId: "task-journal", runId: "run-1", turnId: "turn-1" }

function phaseEvent(id: string, phase: "working" | "planning" = "working"): Omit<AgentLifecycleEvent, "sequence"> {
	return {
		version: 1,
		eventId: id,
		...ids,
		occurredAt: 1,
		type: "phase_changed",
		payload: { phase },
	}
}

function terminalEvent(
	id: string,
	identity: { taskId: string; runId: string; turnId: string } = ids,
): Omit<AgentLifecycleEvent, "sequence"> {
	return {
		version: 1,
		eventId: id,
		...identity,
		occurredAt: 2,
		type: "turn_completed",
		payload: { status: "completed" },
	}
}

describe("AgentLifecycleJournal", () => {
	let storagePath: string

	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "agent-lifecycle-journal-"))
	})

	afterEach(async () => {
		await fs.rm(storagePath, { recursive: true, force: true })
	})

	it("continues the monotonic sequence after a restart", async () => {
		const first = new AgentLifecycleJournal(ids.taskId, storagePath)
		const firstReceipt = await first.append(phaseEvent("event-1"))
		await first.close()

		const restarted = await AgentLifecycleJournal.open(ids.taskId, storagePath)
		const secondReceipt = await restarted.append(phaseEvent("event-2"))

		expect(firstReceipt.sequence).toBe(1)
		expect(secondReceipt.sequence).toBe(2)
		expect(restarted.getSequence()).toBe(2)
		await restarted.close()
	})

	it("flushes an append that was submitted immediately before close", async () => {
		const journal = new AgentLifecycleJournal(ids.taskId, storagePath)
		const append = journal.append(phaseEvent("event-1"))
		await journal.close()

		expect((await append).sequence).toBe(1)
		expect((await readAgentLifecycleEvents(ids.taskId, storagePath)).map(({ sequence }) => sequence)).toEqual([1])
	})

	it("orders replay behind the accepted write queue", async () => {
		const journal = new AgentLifecycleJournal(ids.taskId, storagePath)
		await journal.initialize()
		let releaseWrite!: () => void
		const queuedWrite = new Promise<void>((resolve) => {
			releaseWrite = resolve
		})
		;(journal as any).writeQueue = queuedWrite

		let replayed = false
		const replay = journal.replay().then((snapshot) => {
			replayed = true
			return snapshot
		})
		await Promise.resolve()
		expect(replayed).toBe(false)

		releaseWrite()
		await expect(replay).resolves.toBeUndefined()
		expect(replayed).toBe(true)
	})

	it("recovers an unterminated final JSONL record and permits the next append", async () => {
		const journal = new AgentLifecycleJournal(ids.taskId, storagePath)
		await journal.append(phaseEvent("event-1"))
		const eventsPath = await journal.getEventsFilePath()
		await fs.appendFile(eventsPath, '{"version":1,"eventId":"torn"', "utf8")

		const recovered = await AgentLifecycleJournal.open(ids.taskId, storagePath)
		expect(recovered.getSequence()).toBe(1)
		await recovered.append(phaseEvent("event-2"))
		expect(await readAgentLifecycleEvents(ids.taskId, storagePath)).toHaveLength(2)
		await recovered.close()
	})

	it("rejects malformed middle records with a typed recovery error", async () => {
		const journal = new AgentLifecycleJournal(ids.taskId, storagePath)
		await journal.append(phaseEvent("event-1"))
		const eventsPath = await journal.getEventsFilePath()
		await fs.appendFile(eventsPath, "not-json\n", "utf8")

		await expect(AgentLifecycleJournal.open(ids.taskId, storagePath)).rejects.toMatchObject({
			code: "malformed_record",
			taskId: ids.taskId,
		} satisfies Partial<AgentLifecycleRecoveryError>)
		await expect(fs.access(eventsPath)).resolves.toBeUndefined()
	})

	it("rejects gaps and duplicate sequences before replay can continue", async () => {
		const journal = new AgentLifecycleJournal(ids.taskId, storagePath)
		const eventsPath = await journal.getEventsFilePath()
		await fs.writeFile(
			eventsPath,
			`${JSON.stringify({ ...phaseEvent("event-1"), sequence: 1 })}\n${JSON.stringify({ ...phaseEvent("event-3"), sequence: 3 })}\n`,
			"utf8",
		)

		await expect(journal.initialize()).rejects.toMatchObject({ code: "sequence_gap" })
	})

	it("writes equivalent atomic snapshots on request and periodically", async () => {
		const journal = new AgentLifecycleJournal(ids.taskId, storagePath, { snapshotEvery: 1 })
		const receipt = await journal.append(phaseEvent("event-1"))
		const snapshotPath = await journal.getSnapshotFilePath()
		const persisted = JSON.parse(await fs.readFile(snapshotPath, "utf8"))

		expect(receipt.snapshotWritten).toBe(true)
		expect(persisted).toEqual(receipt.snapshot)
		expect(await journal.writeSnapshot()).toEqual(receipt.snapshot)
		await journal.close()
	})

	it("redacts secret-bearing lifecycle values before persistence", async () => {
		const journal = new AgentLifecycleJournal(ids.taskId, storagePath)
		await journal.append({
			...phaseEvent("event-1"),
			type: "tool_call_accepted",
			payload: {
				item: {
					itemId: "item-1",
					type: "tool_call",
					toolCallId: "call-1",
					name: "read_file",
					arguments: { apiKey: "do-not-persist" },
					status: "accepted",
				},
			},
		})
		const contents = await fs.readFile(await journal.getEventsFilePath(), "utf8")
		expect(contents).not.toContain("do-not-persist")
		expect(contents).toContain("[redacted]")
		await journal.close()
	})

	it("owns sequences and supports exact replay without appending a duplicate", async () => {
		const journal = new AgentLifecycleJournal(ids.taskId, storagePath)
		const first = await journal.append(phaseEvent("event-1"))
		const replay = await journal.append(phaseEvent("event-1"))

		expect(first.sequence).toBe(1)
		expect(first.replayed).toBe(false)
		expect(replay.sequence).toBe(1)
		expect(replay.replayed).toBe(true)
		expect(await readAgentLifecycleEvents(ids.taskId, storagePath)).toHaveLength(1)
		await journal.close()
	})

	it("partitions terminal turns in one task journal and resumes the latest partition after restart", async () => {
		const journal = new AgentLifecycleJournal(ids.taskId, storagePath)
		await journal.append(phaseEvent("turn-1-start"))
		await journal.append(terminalEvent("turn-1-done"))
		await journal.append({
			...phaseEvent("turn-2-start"),
			runId: "run-2",
			turnId: "turn-2",
		})
		await journal.append({
			...terminalEvent("turn-2-done", { ...ids, runId: "run-2", turnId: "turn-2" }),
		})

		expect(journal.getSequence()).toBe(2)
		expect(journal.getSnapshot()).toMatchObject({ runId: "run-2", turnId: "turn-2", lastSequence: 2 })
		await journal.close()

		const events = await readAgentLifecycleEvents(ids.taskId, storagePath)
		expect(events.map((event) => [event.runId, event.turnId, event.sequence])).toEqual([
			["run-1", "turn-1", 1],
			["run-1", "turn-1", 2],
			["run-2", "turn-2", 1],
			["run-2", "turn-2", 2],
		])

		const restarted = await AgentLifecycleJournal.open(ids.taskId, storagePath)
		expect(restarted.getSnapshot()).toMatchObject({ runId: "run-2", turnId: "turn-2", status: "completed" })
		const nextRun = await restarted.append({
			...phaseEvent("turn-3-start"),
			runId: "run-3",
			turnId: "turn-3",
		})
		expect(nextRun.sequence).toBe(1)
		expect(nextRun.snapshot.runId).toBe("run-3")
		await restarted.close()
	})

	it("rejects an identity transition while the current turn is in progress", async () => {
		const journal = new AgentLifecycleJournal(ids.taskId, storagePath)
		await journal.append(phaseEvent("event-1"))
		await expect(
			journal.append({ ...phaseEvent("event-2"), runId: "run-2", turnId: "turn-2" }),
		).rejects.toMatchObject({ code: "run_mismatch" })
		await expect(journal.close()).rejects.toMatchObject({ code: "run_mismatch" })
	})
})
