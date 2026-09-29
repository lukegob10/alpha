import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { AgentMessageInbox } from "../AgentMessageInbox"

let directory: string
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-agent-inbox-"))
})
afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true })
})

it("recovers accepted messages after reload and retains them if transcript persistence fails", async () => {
	const inbox = new AgentMessageInbox("recipient", directory)
	const message = { id: "message-1", senderTaskId: "sender", text: "Inspect the race" }
	await inbox.receive(message)
	await inbox.receive(message)
	const reloaded = new AgentMessageInbox("recipient", directory)
	await expect(
		reloaded.deliver(async () => {
			throw new Error("disk failure")
		}),
	).rejects.toThrow("disk failure")
	expect(reloaded.hasPending()).toBe(true)
	const persist = vi.fn(async () => undefined)
	await reloaded.deliver(persist)
	expect(persist).toHaveBeenCalledExactlyOnceWith(message)
	expect(reloaded.hasPending()).toBe(false)
	await new AgentMessageInbox("recipient", directory).deliver(persist)
	expect(persist).toHaveBeenCalledOnce()
})

it("retains input received during delivery for the next boundary", async () => {
	const inbox = new AgentMessageInbox("recipient", directory)
	await inbox.receive({ id: "first", senderTaskId: "sender", text: "First" })
	let release!: () => void
	let started!: () => void
	const barrier = new Promise<void>((resolve) => {
		release = resolve
	})
	const entered = new Promise<void>((resolve) => {
		started = resolve
	})
	const delivery = inbox.deliver(async () => {
		started()
		await barrier
	})
	await entered
	const second = inbox.receive({ id: "second", senderTaskId: "sender", text: "Second" })
	expect(inbox.hasPending()).toBe(true)
	release()
	await delivery
	await second
	expect(inbox.hasPending()).toBe(true)
	const persist = vi.fn(async () => undefined)
	await inbox.deliver(persist)
	expect(persist).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "second" }))
})

it("rejects conflicting IDs and oversized messages without discarding accepted input", async () => {
	const inbox = new AgentMessageInbox("recipient", directory)
	const message = { id: "one", senderTaskId: "sender", text: "First" }
	await inbox.receive(message)
	await expect(inbox.receive({ ...message, text: "Different" })).rejects.toThrow("ID conflict")
	await expect(inbox.receive({ ...message, id: "big", text: "x".repeat(64_001) })).rejects.toThrow()
	const persist = vi.fn(async () => undefined)
	await inbox.deliver(persist)
	expect(persist).toHaveBeenCalledExactlyOnceWith(message)
})
