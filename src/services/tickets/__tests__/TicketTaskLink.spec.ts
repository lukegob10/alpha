import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "fs/promises"
import path from "path"
import os from "os"
import { TicketStore } from "../TicketStore"
import { workOnTicket } from "../TicketTaskLink"
import * as atomicWrite from "../../../core/task-persistence/atomicWrite"
import type { AlphaProvider } from "../../../core/webview/AlphaProvider"

describe("ticket task linkage", () => {
	let home: string, store: TicketStore
	const start = vi.fn(),
		abortTask = vi.fn(),
		createTask = vi.fn(),
		showTaskWithId = vi.fn()
	const provider = { createTask, showTaskWithId } as unknown as AlphaProvider
	beforeEach(async () => {
		vi.clearAllMocks()
		home = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ticket-link-"))
		store = await TicketStore.forWorkspace(home, home)
		createTask.mockResolvedValue({ taskId: "linked-task", start, abortTask })
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(home, { recursive: true, force: true })
	})
	it("links before starting and deduplicates concurrent launch requests", async () => {
		const ticket = await store.create({ name: "Work" })
		const settled = await Promise.allSettled([
			workOnTicket(store, provider, ticket.id, ticket.revision),
			workOnTicket(store, provider, ticket.id, ticket.revision),
		])
		// Join both launch owners before an assertion can fail and remove their files.
		const results = settled.map((result) => {
			expect(result.status).toBe("fulfilled")
			if (result.status === "rejected") throw result.reason
			return result.value
		})
		expect(createTask).toHaveBeenCalledTimes(1)
		expect(createTask).toHaveBeenCalledWith(
			expect.any(String),
			undefined,
			undefined,
			expect.objectContaining({ startTask: false, preserveExisting: true }),
		)
		expect(start).toHaveBeenCalledTimes(1)
		expect(showTaskWithId).toHaveBeenCalledWith("linked-task")
		expect(results[0]).toMatchObject({ status: "in-progress", linkedTaskIds: ["linked-task"] })
		expect(results[0]).not.toBe(results[1])
		expect(results[0].linkedTaskIds).not.toBe(results[1].linkedTaskIds)
		const restored = await TicketStore.forWorkspace(home, home)
		await workOnTicket(restored, provider, ticket.id, results[0].revision)
		expect(createTask).toHaveBeenCalledTimes(1)
	})
	it("joins a blocked local launch instead of exhausting a second advisory-lock acquisition", async () => {
		const ticket = await store.create({ name: "Work" })
		const secondStore = await TicketStore.forWorkspace(home, home)
		let entered!: () => void
		let release!: () => void
		const launching = new Promise<void>((resolve) => (entered = resolve))
		const gate = new Promise<void>((resolve) => (release = resolve))
		createTask.mockImplementationOnce(async () => {
			entered()
			await gate
			return { taskId: "linked-task", start, abortTask }
		})
		const lock = atomicWrite.withFileLock
		let launchAcquisitions = 0
		vi.spyOn(atomicWrite, "withFileLock").mockImplementation(async (file, operation) => {
			if (path.basename(file) === ".launch" && ++launchAcquisitions > 1)
				throw Object.assign(new Error("Launch acquisition deadline exhausted"), { code: "ELOCKED" })
			return lock(file, operation)
		})
		const first = workOnTicket(store, provider, ticket.id, ticket.revision)
		let second: ReturnType<typeof workOnTicket> | undefined
		try {
			await launching
			// Make the contender's two preflight awaits controlled microtasks. Its
			// acquisition cannot depend on filesystem or wall-clock speed.
			vi.spyOn(secondStore, "recoverPendingMoves").mockResolvedValue()
			vi.spyOn(secondStore, "read").mockResolvedValue(ticket)
			second = workOnTicket(secondStore, provider, ticket.id, ticket.revision)
			const settled = Promise.allSettled([first, second])
			await Promise.resolve()
			await Promise.resolve()
			release()
			const results = await settled
			expect(results).toEqual([
				{ status: "fulfilled", value: expect.objectContaining({ linkedTaskIds: ["linked-task"] }) },
				{ status: "fulfilled", value: expect.objectContaining({ linkedTaskIds: ["linked-task"] }) },
			])
			expect(launchAcquisitions).toBe(1)
			expect(createTask).toHaveBeenCalledOnce()
			expect(start).toHaveBeenCalledOnce()
			expect(showTaskWithId).toHaveBeenCalledWith("linked-task")
		} finally {
			release()
			await Promise.allSettled([first, second])
		}
	})
	it("keeps a ticket in backlog when launch fails", async () => {
		const ticket = await store.create({ name: "Work" })
		createTask.mockRejectedValueOnce(new Error("No model"))
		await expect(workOnTicket(store, provider, ticket.id, ticket.revision)).rejects.toThrow("No model")
		expect(await store.read(ticket.id)).toMatchObject({ status: "backlog", linkedTaskIds: [] })
		expect(start).not.toHaveBeenCalled()
		await expect(workOnTicket(store, provider, ticket.id, ticket.revision)).resolves.toMatchObject({
			status: "in-progress",
			linkedTaskIds: ["linked-task"],
		})
		expect(createTask).toHaveBeenCalledTimes(2)
		expect(start).toHaveBeenCalledOnce()
	})
	it("does not start work on a canceled ticket until it is reopened", async () => {
		const ticket = await store.create({ name: "Do not work" })
		const canceled = await store.update({ id: ticket.id, expectedRevision: ticket.revision, status: "canceled" })
		await expect(workOnTicket(store, provider, ticket.id, canceled.revision)).rejects.toThrow("Reopen")
		expect(createTask).not.toHaveBeenCalled()
		const reopened = await store.update({ id: ticket.id, expectedRevision: canceled.revision, status: "backlog" })
		await workOnTicket(store, provider, ticket.id, reopened.revision)
		expect(createTask).toHaveBeenCalledTimes(1)
	})
	it("aborts the unstarted task if a concurrent edit prevents linkage", async () => {
		const ticket = await store.create({ name: "Work" })
		createTask.mockImplementationOnce(async () => {
			await store.update({ id: ticket.id, expectedRevision: ticket.revision, name: "External edit" })
			return { taskId: "linked-task", start, abortTask }
		})
		await expect(workOnTicket(store, provider, ticket.id, ticket.revision)).rejects.toThrow("changed")
		expect(abortTask).toHaveBeenCalledTimes(1)
		expect(start).not.toHaveBeenCalled()
		expect((await store.read(ticket.id)).name).toBe("External edit")
	})
	it("aborts an unstarted task when its ticket is deleted during launch", async () => {
		const ticket = await store.create({ name: "Deleted during launch" })
		createTask.mockImplementationOnce(async () => {
			await store.delete({ id: ticket.id, expectedRevision: ticket.revision })
			return { taskId: "linked-task", start, abortTask }
		})
		await expect(workOnTicket(store, provider, ticket.id, ticket.revision)).rejects.toThrow("not found")
		expect(abortTask).toHaveBeenCalledTimes(1)
		expect(start).not.toHaveBeenCalled()
		expect((await store.list()).total).toBe(0)
	})
	it("deletes the ticket without stopping or deleting its linked task", async () => {
		const ticket = await store.create({ name: "Linked ticket" })
		const linked = await workOnTicket(store, provider, ticket.id, ticket.revision)
		expect(start).toHaveBeenCalledTimes(1)
		await store.delete({ id: linked.id, expectedRevision: linked.revision })
		expect(abortTask).not.toHaveBeenCalled()
		expect(createTask).toHaveBeenCalledTimes(1)
		expect((await store.list()).total).toBe(0)
	})
})
