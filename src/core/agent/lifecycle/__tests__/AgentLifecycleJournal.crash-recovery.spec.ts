import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as lockfile from "proper-lockfile"

import type { AgentLifecycleEvent, AgentLifecycleSnapshot } from "@alpha-code/types"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, readFile: vi.fn(actual.readFile) }
})

vi.mock("../../../../utils/storage", () => ({
	getTaskDirectoryPath: async (globalStoragePath: string, taskId: string) => {
		const taskDirectory = path.join(globalStoragePath, taskId)
		await fs.mkdir(taskDirectory, { recursive: true })
		return taskDirectory
	},
}))

import { AgentLifecycleJournal, readAgentLifecycleEvents, type AgentLifecycleEventInput } from "../index.js"

type Identity = Pick<AgentLifecycleEvent, "taskId" | "runId" | "turnId">

const ids: Identity = { taskId: "task-crash-recovery", runId: "run-1", turnId: "turn-1" }

function phaseEvent(eventId: string, identity: Identity = ids): AgentLifecycleEventInput {
	return {
		version: 1,
		eventId,
		...identity,
		occurredAt: 1,
		type: "phase_changed",
		payload: { phase: "working" },
	}
}

function startEvent(eventId: string, identity: Identity = ids): AgentLifecycleEventInput {
	return {
		...phaseEvent(eventId, identity),
		type: "turn_started",
		payload: { phase: "working", effectTrackingVersion: 1 },
	}
}

function acceptedEvent(eventId: string, identity: Identity = ids): AgentLifecycleEventInput {
	return {
		...phaseEvent(eventId, identity),
		type: "tool_call_accepted",
		payload: {
			item: {
				itemId: "call-item",
				type: "tool_call",
				toolCallId: "call-1",
				name: "apply_patch",
				arguments: { path: "\u{1f600}\u6f22e\u0301.txt" },
				status: "accepted",
			},
		},
	}
}

function effectEvent(eventId: string, identity: Identity = ids): AgentLifecycleEventInput {
	return {
		...phaseEvent(eventId, identity),
		type: "tool_effect_started",
		payload: { toolCallId: "call-1" },
	}
}

function terminalEvent(eventId: string): AgentLifecycleEventInput {
	return { ...phaseEvent(eventId), type: "turn_completed", payload: { status: "completed" } }
}

describe("AgentLifecycleJournal crash recovery", () => {
	let storagePath: string

	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "agent-journal-crash-recovery-"))
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(storagePath, { recursive: true, force: true })
	})

	// These fixtures deliberately leave the last writer unclosed: close would
	// refresh its snapshot and remove the crash window being exercised.
	it.each([
		{ newline: "LF", delimiter: "\n", hasEffect: false },
		{ newline: "CRLF", delimiter: "\r\n", hasEffect: false },
		{ newline: "LF", delimiter: "\n", hasEffect: true },
		{ newline: "CRLF", delimiter: "\r\n", hasEffect: true },
	])("preserves UTF-8 $newline evidence with hasEffect=$hasEffect", async ({ delimiter, hasEffect }) => {
		const journal = await AgentLifecycleJournal.open(ids.taskId, storagePath)
		await journal.append(startEvent("turn-start"))
		await journal.append(acceptedEvent("call-accepted"))
		if (hasEffect) await journal.append(effectEvent("effect-started"), { durable: true })
		const eventsPath = await journal.getEventsFilePath()
		const prefix = Buffer.from((await fs.readFile(eventsPath, "utf8")).replaceAll("\n", delimiter), "utf8")
		await fs.writeFile(eventsPath, prefix)
		await fs.appendFile(
			eventsPath,
			Buffer.concat([Buffer.from('{"version":1,"eventId":"torn","path":"'), Buffer.from([0xf0, 0x9f])]),
		)

		const recovered = await AgentLifecycleJournal.open(ids.taskId, storagePath)
		expect(await fs.readFile(eventsPath)).toEqual(prefix)
		expect(recovered.getSnapshot()).toMatchObject({
			lastSequence: hasEffect ? 3 : 2,
			effectTrackingVersion: 1,
			acceptedToolCallIds: ["call-1"],
			effectStartedToolCallIds: hasEffect ? ["call-1"] : [],
		})

		const continuation = phaseEvent("after-recovery")
		const receipt = await recovered.append(continuation)
		expect(receipt.sequence).toBe(hasEffect ? 4 : 3)
		expect(await recovered.append(continuation)).toMatchObject({ sequence: receipt.sequence, replayed: true })
		expect((await fs.readFile(eventsPath)).subarray(0, prefix.length)).toEqual(prefix)

		const restarted = await AgentLifecycleJournal.open(ids.taskId, storagePath)
		expect(restarted.getSnapshot()).toEqual(receipt.snapshot)
		expect((await readAgentLifecycleEvents(ids.taskId, storagePath)).map((event) => event.eventId)).toEqual([
			"turn-start",
			"call-accepted",
			...(hasEffect ? ["effect-started"] : []),
			"after-recovery",
		])
		await restarted.close()
	})

	it.each([
		{ newline: "LF", delimiter: "\n", durable: false },
		{ newline: "CRLF", delimiter: "\r\n", durable: false },
		{ newline: "LF", delimiter: "\n", durable: true },
		{ newline: "CRLF", delimiter: "\r\n", durable: true },
	])("safely appends to valid UTF-8 $newline EOF with durable=$durable", async ({ delimiter, durable }) => {
		const journal = await AgentLifecycleJournal.open(ids.taskId, storagePath)
		await journal.append(startEvent("turn-start"))
		await journal.append(acceptedEvent("call-accepted"))
		const eventsPath = await journal.getEventsFilePath()
		const completeLines = (await fs.readFile(eventsPath, "utf8")).replaceAll("\n", delimiter)
		const unterminated = Buffer.from(completeLines.slice(0, -1), "utf8")
		await fs.writeFile(eventsPath, unterminated)

		const recovered = await AgentLifecycleJournal.open(ids.taskId, storagePath)
		const repairedOnce = await fs.readFile(eventsPath)
		await AgentLifecycleJournal.open(ids.taskId, storagePath)
		expect(await fs.readFile(eventsPath)).toEqual(repairedOnce)
		const receipt = await recovered.append(effectEvent("effect-started"), { durable })
		expect(receipt.sequence).toBe(3)
		expect(receipt.snapshot.acceptedToolCallIds).toEqual(["call-1"])
		expect(receipt.snapshot.effectStartedToolCallIds).toEqual(["call-1"])
		expect(await fs.readFile(eventsPath)).toEqual(
			Buffer.concat([unterminated, Buffer.from(`\n${JSON.stringify(receipt.event)}\n`, "utf8")]),
		)

		const restarted = await AgentLifecycleJournal.open(ids.taskId, storagePath)
		expect(restarted.getSnapshot()).toEqual(receipt.snapshot)
		expect((await readAgentLifecycleEvents(ids.taskId, storagePath)).map((event) => event.eventId)).toEqual([
			"turn-start",
			"call-accepted",
			"effect-started",
		])
		await restarted.close()
	})

	it.each([
		{ runId: "run-2", turnId: "turn-2" },
		{ runId: "run-1", turnId: "turn-2" },
	])("validates an older snapshot in its partition before resuming $runId/$turnId", async ({ runId, turnId }) => {
		const first = await AgentLifecycleJournal.open(ids.taskId, storagePath)
		await first.append(phaseEvent("first-start"))
		await first.append(phaseEvent("first-progress-1"))
		await first.append(phaseEvent("first-progress-2"))
		await first.append(terminalEvent("first-done"))
		await first.close()
		const eventsPath = await first.getEventsFilePath()
		const snapshotPath = await first.getSnapshotFilePath()
		const oldPrefix = await fs.readFile(eventsPath)
		const oldSnapshot = await fs.readFile(snapshotPath)
		const nextIdentity = { taskId: ids.taskId, runId, turnId }

		const next = await AgentLifecycleJournal.open(ids.taskId, storagePath)
		expect((await next.append(startEvent("next-start", nextIdentity))).sequence).toBe(1)
		expect(await fs.readFile(snapshotPath)).toEqual(oldSnapshot)

		const recovered = await AgentLifecycleJournal.open(ids.taskId, storagePath)
		expect(recovered.getSnapshot()).toMatchObject({ ...nextIdentity, lastSequence: 1, status: "in_progress" })
		const accepted = await recovered.append(acceptedEvent("next-accepted", nextIdentity))
		expect(accepted.sequence).toBe(2)
		const restarted = await AgentLifecycleJournal.open(ids.taskId, storagePath)
		expect(restarted.getSnapshot()).toEqual(accepted.snapshot)
		const effect = await restarted.append(effectEvent("next-effect", nextIdentity), { durable: true })
		expect(effect.sequence).toBe(3)
		const final = await AgentLifecycleJournal.open(ids.taskId, storagePath)
		expect(final.getSnapshot()).toEqual(effect.snapshot)
		expect((await fs.readFile(eventsPath)).subarray(0, oldPrefix.length)).toEqual(oldPrefix)
		expect((await readAgentLifecycleEvents(ids.taskId, storagePath)).map((event) => event.sequence)).toEqual([
			1, 2, 3, 4, 1, 2, 3,
		])
		await final.close()
	})

	it.each([
		{ change: "content", code: "snapshot_mismatch" },
		{ change: "identity", code: "snapshot_mismatch" },
		{ change: "sequence", code: "snapshot_ahead" },
	])("rejects older-partition snapshot $change corruption without repairing evidence", async ({ change, code }) => {
		const first = await AgentLifecycleJournal.open(ids.taskId, storagePath)
		await first.append(phaseEvent("first-start"))
		await first.append(terminalEvent("first-done"))
		await first.close()
		const next = await AgentLifecycleJournal.open(ids.taskId, storagePath)
		await next.append(startEvent("next-start", { ...ids, runId: "run-2", turnId: "turn-2" }))
		const snapshotPath = await next.getSnapshotFilePath()
		const eventsPath = await next.getEventsFilePath()
		const before = await fs.readFile(eventsPath)
		const snapshot = JSON.parse(await fs.readFile(snapshotPath, "utf8")) as AgentLifecycleSnapshot
		if (change === "content") snapshot.phase = "waiting"
		if (change === "identity") {
			snapshot.runId = "missing-run"
			snapshot.turnId = "missing-turn"
		}
		if (change === "sequence") {
			snapshot.lastSequence++
			snapshot.processedEvents.push({ eventId: "snapshot-only", sequence: 3, fingerprint: "snapshot-only" })
		}
		const corrupted = `${JSON.stringify(snapshot)}\n`
		await fs.writeFile(snapshotPath, corrupted, "utf8")

		await expect(AgentLifecycleJournal.open(ids.taskId, storagePath)).rejects.toMatchObject({ code })
		expect(await fs.readFile(eventsPath)).toEqual(before)
		expect(await fs.readFile(snapshotPath, "utf8")).toBe(corrupted)
	})

	it.each([
		{ suffix: "not-json\n", description: "malformed terminated record" },
		{ suffix: '{"version":1}', description: "schema-invalid complete EOF record" },
		{ suffix: "\r", description: "blank EOF record" },
	])("preserves evidence when rejecting a $description", async ({ suffix }) => {
		const journal = await AgentLifecycleJournal.open(ids.taskId, storagePath)
		await journal.append(startEvent("turn-start"))
		const eventsPath = await journal.getEventsFilePath()
		await fs.appendFile(eventsPath, suffix, "utf8")
		const before = await fs.readFile(eventsPath)

		await expect(AgentLifecycleJournal.open(ids.taskId, storagePath)).rejects.toMatchObject({
			code: "malformed_record",
		})
		expect(await fs.readFile(eventsPath)).toEqual(before)
	})

	it("holds the event lock for every public read that can repair the journal", async () => {
		const journal = await AgentLifecycleJournal.open(ids.taskId, storagePath)
		await journal.append(startEvent("turn-start"))
		const eventsPath = await journal.getEventsFilePath()
		const actualFs = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const readFile = vi.mocked(fs.readFile)
		const lockedReads: boolean[] = []
		readFile.mockImplementation(async (filePath, options) => {
			if (filePath === eventsPath) lockedReads.push(await lockfile.check(eventsPath, { realpath: false }))
			return actualFs.readFile(filePath, options)
		})

		try {
			expect((await readAgentLifecycleEvents(ids.taskId, storagePath)).map((event) => event.eventId)).toEqual([
				"turn-start",
			])
			expect(lockedReads.length).toBeGreaterThan(0)
			expect(lockedReads.every(Boolean)).toBe(true)
		} finally {
			readFile.mockImplementation(actualFs.readFile)
		}
	})
})
