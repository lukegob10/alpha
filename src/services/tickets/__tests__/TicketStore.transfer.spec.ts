import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import type { TicketTransferEntry } from "@alpha-code/types"
import { TicketStore } from "../TicketStore"

vi.mock("fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof import("fs/promises")>()) }))

describe("TicketStore portable transfers", () => {
	let home: string
	let source: TicketStore
	let target: TicketStore
	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ticket-transfer-"))
		const first = path.join(home, "source-project")
		const second = path.join(home, "target-project")
		await fs.mkdir(first)
		await fs.mkdir(second)
		source = await TicketStore.forWorkspace(first, home)
		target = await TicketStore.forWorkspace(second, home)
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(home, { recursive: true, force: true })
	})

	it("exports selected descendants with portable status, preserves custom notes, and excludes conversations", async () => {
		const parent = await source.create({ name: "Parent" })
		let child = await source.create({ name: "Child", parentId: parent.id })
		child = await source.update(
			{ id: child.id, expectedRevision: child.revision, status: "complete" },
			undefined,
			"private-task",
		)
		await source.create({ name: "Unrelated" })
		const file = await source.markdownPath(child.id)
		await fs.appendFile(file, "## Extra notes\nKeep this section.\n")
		const entries = await source.exportTickets({ ids: [parent.id] })
		expect(entries).toHaveLength(2)
		expect(entries.find((entry) => entry.path.endsWith(`${child.id}.md`))).toMatchObject({ status: "complete" })
		expect(entries.find((entry) => entry.path.endsWith(`${child.id}.md`))?.markdown).toContain("status: complete")
		expect(entries.find((entry) => entry.path.endsWith(`${child.id}.md`))?.markdown).toContain("Keep this section.")
		expect(entries.every((entry) => !entry.markdown.includes("private-task"))).toBe(true)
		expect(await source.exportTickets({ ids: [parent.id], includeDescendants: false })).toHaveLength(1)
	})

	it("exports all filtered matches instead of just the current page", async () => {
		await source.create({ name: "Match A", type: "bug" })
		await source.create({ name: "Match B", type: "bug" })
		await source.create({ name: "Other", type: "feature" })
		const entries = await source.exportTickets({
			filter: { type: "bug", limit: 1, offset: 1 },
			includeDescendants: false,
		})
		expect(entries).toHaveLength(2)
		expect(entries.every((entry) => entry.markdown.includes("type: bug"))).toBe(true)
	})

	it("imports copies with fresh identities and references, remapped parents, and backlog statuses", async () => {
		const parent = await source.create({ name: "Parent" })
		let child = await source.create({ name: "Child", parentId: parent.id, priority: "high" })
		child = await source.update({ id: child.id, expectedRevision: child.revision, status: "complete" })
		const entries = await source.exportTickets({})
		const plan = await target.previewImport(entries)
		expect(plan.preview.tickets.every((ticket) => ticket.disposition === "new")).toBe(true)
		expect(await target.importTickets(plan, { mode: "copy", resetStatus: true })).toEqual({
			imported: 2,
			skipped: 0,
		})
		const imported = (await target.list()).tickets
		const importedParent = imported.find((ticket) => ticket.name === "Parent")!
		const importedChild = imported.find((ticket) => ticket.name === "Child")!
		expect(imported.map((ticket) => ticket.id)).not.toContain(parent.id)
		expect(imported.map((ticket) => ticket.id)).not.toContain(child.id)
		expect(imported.every((ticket) => ticket.reference?.startsWith("TP-") && ticket.status === "backlog")).toBe(
			true,
		)
		expect(importedChild.parentId).toBe(importedParent.id)
		expect(await target.read(importedChild.id)).toMatchObject({ priority: "high", linkedTaskIds: [] })
		const repeat = await target.previewImport(entries)
		expect(repeat.preview.tickets.every((ticket) => ticket.disposition === "new")).toBe(true)
		expect(repeat.preview.warnings.join(" ")).toContain("imported copies")
	})

	it("updates matching identities only, retains local conversations, and skips unchanged reimports", async () => {
		const original = await source.create({ name: "Original", description: "Requirements" })
		let plan = await target.previewImport(await source.exportTickets({}))
		await target.importTickets(plan, { mode: "update", resetStatus: false })
		let imported = await target.read(original.id)
		imported = await target.update(
			{ id: imported.id, expectedRevision: imported.revision },
			undefined,
			"local-conversation",
		)
		plan = await target.previewImport(await source.exportTickets({}))
		expect(plan.preview.tickets[0].disposition).toBe("duplicate")
		expect(await target.importTickets(plan, { mode: "update", resetStatus: false })).toEqual({
			imported: 0,
			skipped: 1,
		})
		await source.update({
			id: original.id,
			expectedRevision: original.revision,
			description: "Changed requirements",
			status: "in-progress",
		})
		plan = await target.previewImport(await source.exportTickets({}))
		expect(plan.preview.tickets[0]).toMatchObject({
			disposition: "conflict",
			changes: expect.arrayContaining([
				{ field: "description", before: "Requirements", after: "Changed requirements" },
			]),
		})
		expect(await target.importTickets(plan, { mode: "update", resetStatus: false })).toEqual({
			imported: 1,
			skipped: 0,
		})
		expect(await target.read(original.id)).toMatchObject({
			description: "Changed requirements",
			status: "in-progress",
			linkedTaskIds: ["local-conversation"],
			reference: imported.reference,
		})
	})

	it("detaches an absent external parent and retains standalone status when requested", async () => {
		const parent = await source.create({ name: "Outside parent" })
		let child = await source.create({ name: "Child", parentId: parent.id })
		child = await source.update({ id: child.id, expectedRevision: child.revision, status: "complete" })
		const plan = await target.previewImport(await source.exportTickets({ ids: [child.id] }))
		expect(plan.preview.warnings.join(" ")).toContain("parent is outside")
		await target.importTickets(plan, { mode: "copy", resetStatus: false })
		const ticket = await target.read((await target.list()).tickets[0].id)
		expect(ticket).toMatchObject({ status: "complete" })
		expect(ticket.parentId).toBeUndefined()
	})

	it("rejects stale previews before writing any ticket in the batch", async () => {
		const first = await source.create({ name: "First" })
		await source.create({ name: "Second" })
		const seed = await source.previewImport(await source.exportTickets({}))
		await source.update({ id: first.id, expectedRevision: first.revision, name: "External change" })
		await expect(source.importTickets(seed, { mode: "update", resetStatus: false })).rejects.toThrow(
			"changed since",
		)
		expect((await source.list()).total).toBe(2)
		expect((await source.read(first.id)).name).toBe("External change")
		await expect(fs.stat(path.join(source.directory, ".import.json"))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("rejects malformed, duplicate, oversized, cyclic and path-traversing entries before creating storage", async () => {
		const ticket = await source.create({ name: "Ticket" })
		const [entry] = await source.exportTickets({})
		const bad: TicketTransferEntry[][] = [
			[{ ...entry, markdown: "# Arbitrary document" }],
			[entry, entry],
			[{ ...entry, markdown: entry.markdown + "x".repeat(100000) }],
			[
				{
					...entry,
					markdown: entry.markdown.replace("schemaVersion: 1", `schemaVersion: 1\nparentId: ${ticket.id}`),
				},
			],
			[{ ...entry, path: "../outside.md" }],
			[{ ...entry, path: "C:/outside.md" }],
		]
		for (const entries of bad) await expect(target.previewImport(entries)).rejects.toThrow()
		await expect(fs.stat(target.directory)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("retains and recovers a durable batch after a failed write without exposing partial provider reads", async () => {
		const first = await source.create({ name: "First" })
		const second = await source.create({ name: "Second" })
		const plan = await target.previewImport(await source.exportTickets({}))
		const actualRename = fs.rename
		const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(to).endsWith(`${first.id}.md`))
				throw Object.assign(new Error("disk unavailable"), { code: "EIO" })
			return actualRename(from, to)
		})
		await expect(target.importTickets(plan, { mode: "update", resetStatus: false })).rejects.toThrow(
			"disk unavailable",
		)
		expect(await fs.readFile(path.join(target.directory, ".import.json"), "utf8")).toContain(second.id)
		await expect(target.list()).rejects.toThrow("import pending")
		rename.mockRestore()
		await target.recoverPendingMoves()
		expect((await target.list()).total).toBe(2)
		expect((await target.read(first.id)).name).toBe("First")
		await expect(fs.stat(path.join(target.directory, ".import.json"))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("preserves external edits when recovery encounters a conflict", async () => {
		const original = await source.create({ name: "Original" })
		await target.importTickets(await target.previewImport(await source.exportTickets({})), {
			mode: "update",
			resetStatus: false,
		})
		await source.update({ id: original.id, expectedRevision: original.revision, name: "Incoming" })
		const plan = await target.previewImport(await source.exportTickets({}))
		const actualRename = fs.rename
		const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (String(to).endsWith(`${original.id}.md`))
				throw Object.assign(new Error("disk unavailable"), { code: "EIO" })
			return actualRename(from, to)
		})
		await expect(target.importTickets(plan, { mode: "update", resetStatus: false })).rejects.toThrow(
			"disk unavailable",
		)
		rename.mockRestore()
		const file = path.join(target.directory, "backlog", `${original.id}.md`)
		const external = (await fs.readFile(file, "utf8")).replace("Original", "External edit")
		await fs.writeFile(file, external)
		await expect(target.recoverPendingMoves()).rejects.toThrow("external edit")
		expect(await fs.readFile(file, "utf8")).toBe(external)
	})

	it("honors cancellation before durable import intent", async () => {
		await source.create({ name: "Ticket" })
		const plan = await target.previewImport(await source.exportTickets({}))
		const abort = new AbortController()
		abort.abort(new Error("cancel import"))
		await expect(target.importTickets(plan, { mode: "copy", resetStatus: true }, abort.signal)).rejects.toThrow(
			"cancel import",
		)
		await expect(fs.stat(target.directory)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("cancels before durable intent when cancellation arrives during reference reservation", async () => {
		await source.create({ name: "First" })
		await source.create({ name: "Second" })
		const plan = await target.previewImport(await source.exportTickets({}))
		const abort = new AbortController()
		const actualRename = fs.rename
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			await actualRename(from, to)
			if (String(to).endsWith(".sequence.json")) abort.abort(new Error("cancel during reservation"))
		})
		await expect(target.importTickets(plan, { mode: "update", resetStatus: false }, abort.signal)).rejects.toThrow(
			"cancel during reservation",
		)
		expect((await target.list()).total).toBe(0)
		await expect(fs.stat(path.join(target.directory, ".import.json"))).rejects.toMatchObject({ code: "ENOENT" })
		expect(await fs.readFile(path.join(target.directory, ".sequence.json"), "utf8")).toContain('"nextNumber":3')
	})

	it("finishes a durable batch when cancellation arrives after its commit barrier", async () => {
		await source.create({ name: "First" })
		await source.create({ name: "Second" })
		const plan = await target.previewImport(await source.exportTickets({}))
		const abort = new AbortController()
		const actualRename = fs.rename
		vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
			await actualRename(from, to)
			if (String(to).endsWith(".import.json")) abort.abort(new Error("cancel after commit"))
		})
		await expect(target.importTickets(plan, { mode: "update", resetStatus: false }, abort.signal)).resolves.toEqual(
			{ imported: 2, skipped: 0 },
		)
		expect((await target.list()).total).toBe(2)
		await expect(fs.stat(path.join(target.directory, ".import.json"))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("bounds preview differences and rejects an entry path whose identity disagrees with its Markdown", async () => {
		const ticket = await source.create({ name: "Ticket", description: "Before" })
		await target.importTickets(await target.previewImport(await source.exportTickets({})), {
			mode: "update",
			resetStatus: false,
		})
		await source.update({ id: ticket.id, expectedRevision: ticket.revision, description: "x".repeat(3000) })
		const entries = await source.exportTickets({})
		const plan = await target.previewImport(entries)
		expect(plan.preview.tickets[0].changes?.[0].after).toHaveLength(2000)
		expect(plan.preview.tickets[0].changes?.[0].after.endsWith("…")).toBe(true)
		await expect(
			target.previewImport([{ ...entries[0], path: "complete/00000000-0000-4000-8000-000000000000.md" }]),
		).rejects.toThrow("identity")
	})
})
