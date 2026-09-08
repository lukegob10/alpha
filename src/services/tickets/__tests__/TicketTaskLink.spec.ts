import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "fs/promises"
import path from "path"
import os from "os"
import { TicketStore } from "../TicketStore"
import { workOnTicket } from "../TicketTaskLink"
import type { ClineProvider } from "../../../core/webview/ClineProvider"

describe("ticket task linkage", () => {
	let home: string, store: TicketStore
	const start = vi.fn(),
		abortTask = vi.fn(),
		createTask = vi.fn(),
		showTaskWithId = vi.fn()
	const provider = { createTask, showTaskWithId } as unknown as ClineProvider
	beforeEach(async () => {
		vi.clearAllMocks()
		home = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ticket-link-"))
		store = await TicketStore.forWorkspace(home, home)
		createTask.mockResolvedValue({ taskId: "linked-task", start, abortTask })
	})
	afterEach(async () => {
		await fs.rm(home, { recursive: true, force: true })
	})
	it("links before starting and deduplicates concurrent launch requests", async () => {
		const ticket = await store.create({ name: "Work" })
		const results = await Promise.all([
			workOnTicket(store, provider, ticket.id, ticket.revision),
			workOnTicket(store, provider, ticket.id, ticket.revision),
		])
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
		const restored = await TicketStore.forWorkspace(home, home)
		await workOnTicket(restored, provider, ticket.id, results[0].revision)
		expect(createTask).toHaveBeenCalledTimes(1)
	})
	it("keeps a ticket in backlog when launch fails", async () => {
		const ticket = await store.create({ name: "Work" })
		createTask.mockRejectedValueOnce(new Error("No model"))
		await expect(workOnTicket(store, provider, ticket.id, ticket.revision)).rejects.toThrow("No model")
		expect(await store.read(ticket.id)).toMatchObject({ status: "backlog", linkedTaskIds: [] })
		expect(start).not.toHaveBeenCalled()
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
