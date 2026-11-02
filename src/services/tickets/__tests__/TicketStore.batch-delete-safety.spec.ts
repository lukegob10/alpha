import { randomUUID } from "crypto"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DeleteTickets, Ticket } from "@alpha-code/types"
import { TicketStore } from "../TicketStore"

vi.mock("fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof import("fs/promises")>()) }))

describe("TicketStore batch deletion safety", () => {
	let home: string
	let store: TicketStore
	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ticket-delete-safety-"))
		const workspace = path.join(home, "project")
		await fs.mkdir(workspace)
		store = await TicketStore.forWorkspace(workspace, home)
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		TicketStore.disposeSearchCaches()
		await fs.rm(home, { recursive: true, force: true })
	})

	const selection = (tickets: Pick<Ticket, "id" | "revision">[]): DeleteTickets => ({
		tickets: tickets.map(({ id, revision }) => ({ id, expectedRevision: revision })),
	})
	const journal = () => path.join(store.directory, ".delete.json")

	it("preserves all 17 files when a single captured revision is stale", async () => {
		const tickets: Ticket[] = []
		for (let index = 0; index < 17; index++) tickets.push(await store.create({ name: `Ticket ${index + 1}` }))
		const files = await Promise.all(tickets.map((ticket) => store.markdownPath(ticket.id)))
		await fs.appendFile(files[9], "## External notes\nDo not erase this edit.\n")
		const before = await Promise.all(files.map((file) => fs.readFile(file, "utf8")))

		await expect(store.deleteMany(selection(tickets))).rejects.toThrow("changed")

		expect(await Promise.all(files.map((file) => fs.readFile(file, "utf8")))).toEqual(before)
		expect((await store.list({ limit: 100 })).total).toBe(17)
		await expect(fs.stat(journal())).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("rejects a parent selection when another child was added after the preview", async () => {
		const parent = await store.create({ name: "Parent" })
		const child = await store.create({ name: "Original child", parentId: parent.id })
		const captured = selection([parent, child])
		await store.create({ name: "New child", parentId: parent.id })

		await expect(store.deleteMany(captured)).rejects.toThrow("child")

		expect((await store.list()).total).toBe(3)
		await expect(fs.stat(journal())).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("preflights every surviving target during recovery and preserves an external edit", async () => {
		const tickets = [
			await store.create({ name: "First" }),
			await store.create({ name: "Second" }),
			await store.create({ name: "Third" }),
		]
		const files = await Promise.all(tickets.map((ticket) => store.markdownPath(ticket.id)))
		const actualUnlink = fs.unlink
		let deleted: string | undefined
		const unlink = vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
			if (String(file).endsWith(".md")) {
				if (deleted) throw Object.assign(new Error("Interrupted filesystem deletion"), { code: "EIO" })
				await actualUnlink(file)
				deleted = String(file)
				return
			}
			await actualUnlink(file)
		})
		await expect(store.deleteMany(selection(tickets))).rejects.toThrow("Interrupted filesystem deletion")
		expect(deleted).toBeDefined()
		unlink.mockRestore()
		const remaining = files.filter((file) => file !== deleted)
		await fs.appendFile(remaining[1], "## External notes\nPreserve the updated recovery target.\n")
		const before = await Promise.all(remaining.map((file) => fs.readFile(file, "utf8")))

		await expect(store.list()).rejects.toThrow("delete pending")
		await expect(store.read(tickets[0].id)).rejects.toThrow("delete pending")
		await expect(store.recoverPendingMoves()).rejects.toThrow("external edit")

		expect(await Promise.all(remaining.map((file) => fs.readFile(file, "utf8")))).toEqual(before)
		await expect(fs.stat(journal())).resolves.toBeDefined()
	})

	it("preserves a parent when an external child appears between selected deletions", async () => {
		const parent = await store.create({ name: "Parent" })
		const child = await store.create({ name: "Original child", parentId: parent.id })
		const parentFile = await store.markdownPath(parent.id)
		const childFile = await store.markdownPath(child.id)
		const parentBefore = await fs.readFile(parentFile, "utf8")
		const newId = randomUUID()
		const newFile = path.join(path.dirname(childFile), `${newId}.md`)
		const newMarkdown = (await fs.readFile(childFile, "utf8"))
			.replace(/^id: .+$/m, `id: ${newId}`)
			.replace(/^reference: .+\r?\n/m, "")
			.replace(/^name: .+$/m, "name: Newly added external child")
		const actualUnlink = fs.unlink
		let inserted = false
		vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
			await actualUnlink(file)
			if (String(file) === childFile) {
				await fs.writeFile(newFile, newMarkdown)
				inserted = true
			}
		})

		await expect(store.deleteMany(selection([parent, child]))).rejects.toThrow("child")

		expect(inserted).toBe(true)
		expect(await fs.readFile(parentFile, "utf8")).toBe(parentBefore)
		expect(await fs.readFile(newFile, "utf8")).toBe(newMarkdown)
		await expect(fs.stat(journal())).resolves.toBeDefined()
		await expect(store.recoverPendingMoves()).rejects.toThrow("child")
		expect(await fs.readFile(parentFile, "utf8")).toBe(parentBefore)
	})

	it("detects an outside ticket reparented between deletions even when its size and mtime are restored", async () => {
		const parent = await store.create({ name: "Selected parent" })
		const child = await store.create({ name: "Selected child", parentId: parent.id })
		const outsideParent = await store.create({ name: "Outside parent" })
		const outside = await store.create({ name: "Outside child", parentId: outsideParent.id })
		const parentFile = await store.markdownPath(parent.id)
		const childFile = await store.markdownPath(child.id)
		const outsideFile = await store.markdownPath(outside.id)
		const parentBefore = await fs.readFile(parentFile, "utf8")
		const outsideBefore = await fs.readFile(outsideFile, "utf8")
		const outsideAfter = outsideBefore.replace(/^parentId: .+$/m, `parentId: ${parent.id}`)
		const preservedTime = new Date("2024-01-01T00:00:00.000Z")
		await fs.utimes(outsideFile, preservedTime, preservedTime)
		const outsideStat = await fs.stat(outsideFile)
		expect(outsideAfter.length).toBe(outsideBefore.length)
		const actualUnlink = fs.unlink
		vi.spyOn(fs, "unlink").mockImplementation(async (file) => {
			await actualUnlink(file)
			if (String(file) === childFile) {
				await fs.writeFile(outsideFile, outsideAfter)
				await fs.utimes(outsideFile, outsideStat.atime, outsideStat.mtime)
			}
		})

		await expect(store.deleteMany(selection([parent, child]))).rejects.toThrow("child")

		expect(await fs.readFile(parentFile, "utf8")).toBe(parentBefore)
		expect(await fs.readFile(outsideFile, "utf8")).toBe(outsideAfter)
		const afterStat = await fs.stat(outsideFile)
		expect(afterStat.size).toBe(outsideStat.size)
		expect(afterStat.mtimeMs).toBe(outsideStat.mtimeMs)
		await expect(fs.stat(journal())).resolves.toBeDefined()
	})

	it("rejects invalid or duplicate identities before creating ticket storage", async () => {
		const id = randomUUID()
		const item = { id, expectedRevision: "a".repeat(64) }
		const invalid: unknown[] = [
			{ tickets: [{ ...item, id: "../outside" }] },
			{ tickets: [{ ...item, id: "C:/outside.md" }] },
			{ tickets: [{ ...item, id: "PRJ-1" }] },
			{ tickets: [item, { ...item, id: id.toUpperCase() }] },
			{ tickets: [item], all: true },
			{ tickets: [{ ...item, path: "../outside.md" }] },
		]
		for (const input of invalid) await expect(store.deleteMany(input as DeleteTickets)).rejects.toThrow()
		await expect(fs.stat(store.directory)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("rejects a path-traversing recovery intent and preserves files outside the ticket project", async () => {
		const ticket = await store.create({ name: "Unselected ticket" })
		const outside = path.join(home, "outside.md")
		await fs.writeFile(outside, "External data must survive recovery")
		await fs.writeFile(
			journal(),
			JSON.stringify({
				version: 1,
				tickets: [{ id: "../../outside", status: "backlog", revision: ticket.revision }],
			}),
		)
		const file = path.join(store.directory, ticket.status, `${ticket.id}.md`)
		const before = await fs.readFile(file, "utf8")

		await expect(store.recoverPendingMoves()).rejects.toThrow()

		expect(await fs.readFile(outside, "utf8")).toBe("External data must survive recovery")
		expect(await fs.readFile(file, "utf8")).toBe(before)
		await expect(fs.stat(journal())).resolves.toBeDefined()
	})

	it("rejects a status-directory junction without deleting its external target", async () => {
		const ticket = await store.create({ name: "Must be preserved" })
		const file = await store.markdownPath(ticket.id)
		const before = await fs.readFile(file, "utf8")
		const statusDirectory = path.dirname(file)
		const outside = path.join(home, "outside-tickets")
		await fs.rename(statusDirectory, outside)
		await fs.symlink(outside, statusDirectory, process.platform === "win32" ? "junction" : "dir")
		try {
			await expect(store.deleteMany(selection([ticket]))).rejects.toThrow("symbolic links")
			expect(await fs.readFile(path.join(outside, path.basename(file)), "utf8")).toBe(before)
			await expect(fs.stat(journal())).rejects.toMatchObject({ code: "ENOENT" })
		} finally {
			await fs.unlink(statusDirectory)
		}
	})
})
