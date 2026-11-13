import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { TaskMessageQueuePersistence } from "../TaskMessageQueuePersistence"
import * as apiMessages from "../apiMessages"
import * as atomicWrite from "../atomicWrite"

let storage: string
beforeEach(async () => {
	storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-pending-queue-"))
})
afterEach(async () => {
	vi.restoreAllMocks()
	await fs.rm(storage, { recursive: true, force: true })
})

it("loads an empty durable queue without reading the provider transcript", async () => {
	const persistence = new TaskMessageQueuePersistence("task", storage)
	await persistence.save([])
	await apiMessages.saveApiMessages({
		taskId: "task",
		globalStoragePath: storage,
		messages: [{ role: "user", content: "Already consumed", queued_message_ids: ["consumed"] }],
	})
	const readTranscript = vi.spyOn(apiMessages, "readApiMessages")

	await expect(persistence.load()).resolves.toEqual([])
	expect(readTranscript).not.toHaveBeenCalled()
})

it("recovers pending/claimed input and suppresses consumed IDs after the transcript commit precedes queue ACK", async () => {
	const queue = new MessageQueueService(new TaskMessageQueuePersistence("task", storage))
	await queue.ready
	const first = queue.addMessage("first")!
	const second = queue.addMessage("second")!
	queue.dequeueMessage()
	await queue.flush()
	queue.dispose()
	await apiMessages.saveApiMessages({
		taskId: "task",
		globalStoragePath: storage,
		messages: [{ role: "user", content: "first", queued_message_ids: [first.id] }],
	})

	const restored = new MessageQueueService(new TaskMessageQueuePersistence("task", storage))
	await restored.ready
	await restored.flush()
	expect(restored.messages).toEqual([second])
	expect(restored.getClaimedMessageIds()).toEqual([])
})

it("preserves the previous snapshot when atomic replacement fails", async () => {
	const persistence = new TaskMessageQueuePersistence("task", storage)
	const first = { id: "first", timestamp: 1, text: "first" }
	await persistence.save([first])
	const file = path.join(storage, "tasks", "task", "pending_queue.json")
	const before = await fs.readFile(file, "utf8")
	const write = vi.spyOn(atomicWrite, "atomicWriteJson").mockRejectedValueOnce(new Error("replace failed"))
	await expect(persistence.save([{ id: "second", timestamp: 2, text: "second" }])).rejects.toThrow("replace failed")
	expect(write).toHaveBeenCalledWith(file, expect.any(Array), { requireAtomicReplace: true })
	expect(await fs.readFile(file, "utf8")).toBe(before)
})

it("repairs consumed disk entries before transcript compaction can erase their receipts", async () => {
	const persistence = new TaskMessageQueuePersistence("task", storage)
	const consumed = { id: "consumed", timestamp: 1, text: "do this once" }
	const pending = { id: "pending", timestamp: 2, text: "later" }
	await persistence.save([consumed, pending])
	await apiMessages.saveApiMessages({
		taskId: "task",
		globalStoragePath: storage,
		messages: [{ role: "user", content: consumed.text, queued_message_ids: [consumed.id] }],
	})
	expect(await persistence.load()).toEqual([pending])
	await apiMessages.saveApiMessages({
		taskId: "task",
		globalStoragePath: storage,
		messages: [{ role: "user", content: "compacted summary", isSummary: true }],
	})
	expect(await persistence.load()).toEqual([pending])
})

it("rejects malformed persisted queue identities instead of silently dropping input", async () => {
	const persistence = new TaskMessageQueuePersistence("task", storage)
	const message = { id: "duplicate", timestamp: 1, text: "first" }
	await persistence.save([message])
	const file = path.join(storage, "tasks", "task", "pending_queue.json")
	await fs.writeFile(file, JSON.stringify([message, message]), "utf8")
	await expect(persistence.load()).rejects.toThrow("duplicate identities")
})
