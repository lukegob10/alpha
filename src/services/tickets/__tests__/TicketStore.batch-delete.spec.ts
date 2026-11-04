import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { deleteTicketsSchema, type Ticket } from "@alpha-code/types"
import { TicketStore } from "../TicketStore"

vi.mock("fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof import("fs/promises")>()) }))

const selection = (tickets: Ticket[]) => ({
	tickets: tickets.map(({ id, revision }) => ({ id, expectedRevision: revision })),
})

describe("TicketStore batch deletion", () => {
	let home: string
	let store: TicketStore
	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ticket-batch-delete-"))
		const workspace = path.join(home, "project")
		await fs.mkdir(workspace)
		store = await TicketStore.forWorkspace(workspace, home)
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		TicketStore.disposeSearchCaches()
		await fs.rm(home, { recursive: true, force: true })
	})

	it("deletes a closed hierarchy child-first while receipts retain input order and linked conversations", async () => {
		const parent = await store.create({ name: "Parent" })
		const child = await store.create({ name: "Child", parentId: parent.id })
		let leaf = await store.create({ name: "Leaf", parentId: child.id })
		leaf = await store.update(
			{ id: leaf.id, expectedRevision: leaf.revision, status: "complete" },
			undefined,
			"conversation",
		)
		const keep = await store.create({ name: "Unselected" })
		const conversation = path.join(home, "conversation.json")
		await fs.writeFile(conversation, "preserved conversation")
		const unlink = vi.spyOn(fs, "unlink")
		await expect(store.deleteMany(selection([parent, leaf, child]))).resolves.toEqual([parent, leaf, child])
		expect(
			unlink.mock.calls.map(([file]) => path.basename(String(file))).filter((file) => file.endsWith(".md")),
		).toEqual([`${leaf.id}.md`, `${child.id}.md`, `${parent.id}.md`])
		expect(await store.read(keep.id)).toEqual(keep)
		expect(await fs.readFile(conversation, "utf8")).toBe("preserved conversation")
		await expect(fs.stat(path.join(store.directory, ".delete.json"))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("rejects one stale revision before deleting any selected record", async () => {
		const first = await store.create({ name: "First" })
		const second = await store.create({ name: "Second" })
		const file = await store.markdownPath(second.id)
		await fs.appendFile(file, "\n## External note\nKeep this edit.\n")
		const unlink = vi.spyOn(fs, "unlink")
		await expect(store.deleteMany(selection([first, second]))).rejects.toThrow("Tickets changed")
		expect(unlink).not.toHaveBeenCalled()
		expect(await store.read(first.id)).toEqual(first)
		expect((await store.list()).total).toBe(2)
		expect(await fs.readFile(file, "utf8")).toContain("Keep this edit")
		await expect(fs.stat(path.join(store.directory, ".delete.json"))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("does not infer a cascade to an omitted child", async () => {
		const parent = await store.create({ name: "Parent" })
		const child = await store.create({ name: "Child", parentId: parent.id })
		const unrelated = await store.create({ name: "Unrelated selected ticket" })
		await expect(store.deleteMany(selection([unrelated, parent]))).rejects.toThrow("child tickets")
		expect((await store.list()).total).toBe(3)
		expect(await store.read(parent.id)).toEqual(parent)
		expect(await store.read(child.id)).toEqual(child)
		expect(await store.read(unrelated.id)).toEqual(unrelated)
	})

	it("rejects empty, duplicate, oversized and path-like selections at the shared boundary", () => {
		const record = { id: "c9726a27-3185-4bea-a45c-c45d50299eb7", expectedRevision: "revision" }
		for (const tickets of [[], [record, record], Array(1001).fill(record), [{ ...record, id: "../outside" }]])
			expect(deleteTicketsSchema.safeParse({ tickets }).success).toBe(false)
		expect(deleteTicketsSchema.safeParse({ tickets: [record] }).success).toBe(true)
	})

	it("cancels before entry without changing ticket data", async () => {
		const ticket = await store.create({ name: "Preserved" })
		const controller = new AbortController()
		controller.abort(new Error("Stop before deletion"))
		await expect(store.deleteMany(selection([ticket]), controller.signal)).rejects.toThrow("Stop before deletion")
		expect(await store.read(ticket.id)).toEqual(ticket)
	})

	it("cancels during reference reservation before creating a durable deletion intent", async () => {
		const first = await store.create({ name: "First" })
		const second = await store.create({ name: "Second" })
		const controller = new AbortController()
		const rename = fs.rename
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			await rename(from, to)
			if (String(to).endsWith(".sequence.json")) controller.abort(new Error("Stop before intent"))
		})
		await expect(store.deleteMany(selection([first, second]), controller.signal)).rejects.toThrow(
			"Stop before intent",
		)
		expect((await store.list()).total).toBe(2)
		await expect(fs.stat(path.join(store.directory, ".delete.json"))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("finishes after cancellation crosses the durable intent barrier", async () => {
		const first = await store.create({ name: "First" })
		const second = await store.create({ name: "Second" })
		const controller = new AbortController()
		const rename = fs.rename
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			await rename(from, to)
			if (String(to).endsWith(".delete.json")) controller.abort(new Error("Stop after intent"))
		})
		await expect(store.deleteMany(selection([first, second]), controller.signal)).resolves.toEqual([first, second])
		expect((await store.list()).total).toBe(0)
	})

	it("recovers an interrupted batch without exposing partial reads or reusing deleted references", async () => {
		const first = await store.create({ name: "First" })
		const second = await store.create({ name: "Second" })
		const unlink = fs.unlink
		let deletions = 0
		const failure = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
			if (String(file).endsWith(".md") && ++deletions === 2)
				throw Object.assign(new Error("Disk unavailable"), { code: "EIO" })
			await unlink(file)
		})
		await expect(store.deleteMany(selection([first, second]))).rejects.toThrow("Disk unavailable")
		await expect(store.list()).rejects.toThrow("delete pending")
		await expect(store.readMany([first.id, second.id])).rejects.toThrow("delete pending")
		failure.mockRestore()
		await store.recoverPendingMoves()
		await store.recoverPendingMoves()
		expect((await store.list()).total).toBe(0)
		expect((await store.create({ name: "Next" })).reference).toBe("PRO-03")
	})
})
