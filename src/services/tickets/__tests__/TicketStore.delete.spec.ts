import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs/promises"
import { createHash } from "crypto"
import os from "os"
import path from "path"
import * as atomicWrite from "../../../core/task-persistence/atomicWrite"
import { TicketStore } from "../TicketStore"

describe("TicketStore deletion", () => {
	let home: string, workspace: string, store: TicketStore
	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ticket-delete-"))
		workspace = path.join(home, "project")
		await fs.mkdir(workspace)
		store = await TicketStore.forWorkspace(workspace, home)
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(home, { recursive: true, force: true })
	})

	it.each(["backlog", "in-progress", "complete"] as const)("deletes only the selected %s ticket", async (status) => {
		const created = await store.create({ name: "Delete this ticket", description: "Snapshot content" })
		const ticket = await store.update({
			id: created.id,
			expectedRevision: created.revision,
			status,
			implementationSummary: "Completed work",
		})
		const retained = await store.create({ name: "Keep this ticket" })
		const file = await store.markdownPath(ticket.id)
		expect(await store.delete({ id: ticket.reference!, expectedRevision: ticket.revision })).toEqual(ticket)
		await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" })
		await expect(store.read(ticket.id)).rejects.toThrow("not found")
		expect(await store.read(retained.id)).toEqual(retained)
		expect((await store.list()).tickets.map(({ id }) => id)).toEqual([retained.id])
		await expect(store.delete({ id: ticket.id, expectedRevision: ticket.revision })).rejects.toThrow("not found")
	})

	it.each([false, true])(
		"never reuses a deleted reference when sequence metadata is missing: %s",
		async (missingSequence) => {
			const ticket = await store.create({ name: "First" })
			const sequence = path.join(store.directory, ".sequence.json")
			if (missingSequence) await fs.unlink(sequence)
			await store.delete({ id: ticket.id, expectedRevision: ticket.revision })
			expect(JSON.parse(await fs.readFile(sequence, "utf8")).nextNumber).toBe(2)
			const reopened = await TicketStore.forWorkspace(workspace, home)
			expect((await reopened.create({ name: "Second" })).reference).toBe("PRO-02")
		},
	)

	it("preserves external Markdown edits and manual status moves", async () => {
		const ticket = await store.create({ name: "External changes" })
		const file = await store.markdownPath(ticket.id)
		const external = `${await fs.readFile(file, "utf8")}## Notes\nKeep this edit\n`
		await fs.writeFile(file, external)
		await expect(store.delete({ id: ticket.id, expectedRevision: ticket.revision })).rejects.toThrow("changed")
		expect(await fs.readFile(file, "utf8")).toBe(external)
		const fresh = await store.read(ticket.id)
		await fs.mkdir(path.join(store.directory, "in-progress"))
		const moved = path.join(store.directory, "in-progress", `${ticket.id}.md`)
		await fs.rename(file, moved)
		await expect(store.delete({ id: fresh.id, expectedRevision: fresh.revision })).rejects.toThrow("changed")
		expect(await fs.readFile(moved, "utf8")).toBe(external)
	})

	it.each(["edit", "cancel"])("revalidates immediately before removal after a concurrent %s", async (action) => {
		const ticket = await store.create({ name: "Final revision check" })
		const file = await store.markdownPath(ticket.id)
		const original = await fs.readFile(file, "utf8")
		const external = `${original}## Notes\nA concurrent edit\n`
		const controller = new AbortController()
		const write = atomicWrite.atomicWriteText
		vi.spyOn(atomicWrite, "atomicWriteText").mockImplementation(async (target, text, options) => {
			await write(target, text, options)
			if (target === path.join(store.directory, ".sequence.json")) {
				if (action === "edit") await fs.writeFile(file, external)
				else controller.abort()
			}
		})
		await expect(
			store.delete({ id: ticket.id, expectedRevision: ticket.revision }, controller.signal),
		).rejects.toThrow()
		expect(await fs.readFile(file, "utf8")).toBe(action === "edit" ? external : original)
	})

	it("rejects duplicate IDs and references without removing either copy", async () => {
		const ticket = await store.create({ name: "Original" })
		const file = await store.markdownPath(ticket.id)
		const copy = path.join(store.directory, "in-progress", `${ticket.id}.md`)
		await fs.mkdir(path.dirname(copy))
		await fs.copyFile(file, copy)
		await expect(store.delete({ id: ticket.id, expectedRevision: ticket.revision })).rejects.toThrow(
			"Duplicate ticket ID",
		)
		expect(await fs.readFile(copy, "utf8")).toBe(await fs.readFile(file, "utf8"))
		await fs.unlink(copy)
		const other = await store.create({ name: "Other" })
		const otherFile = await store.markdownPath(other.id)
		await fs.writeFile(
			otherFile,
			(await fs.readFile(otherFile, "utf8")).replace(other.reference!, ticket.reference!),
		)
		await expect(store.delete({ id: ticket.reference!, expectedRevision: ticket.revision })).rejects.toThrow(
			"Duplicate ticket reference",
		)
		await expect(store.delete({ id: ticket.id, expectedRevision: ticket.revision })).rejects.toThrow(
			"Duplicate ticket reference",
		)
		expect(await store.read(ticket.id)).toEqual(ticket)
	})

	it("rejects traversal and other project identities without deleting local tickets", async () => {
		const local = await store.create({ name: "Local" })
		const otherWorkspace = path.join(home, "other")
		await fs.mkdir(otherWorkspace)
		const other = await TicketStore.forWorkspace(otherWorkspace, home)
		const remote = await other.create({ name: "Other project" })
		for (const id of ["../escape", remote.id, remote.reference!])
			await expect(store.delete({ id, expectedRevision: remote.revision })).rejects.toThrow()
		expect(await store.read(local.id)).toEqual(local)
		expect(await other.read(remote.id)).toEqual(remote)
	})

	it("rejects symlinked status directories", async () => {
		const ticket = await store.create({ name: "Protected by path checks" })
		await fs.symlink(
			workspace,
			path.join(store.directory, "complete"),
			process.platform === "win32" ? "junction" : "dir",
		)
		await expect(store.delete({ id: ticket.id, expectedRevision: ticket.revision })).rejects.toThrow("symbolic")
		expect(await fs.stat(path.join(store.directory, "backlog", `${ticket.id}.md`))).toBeDefined()
	})

	it("cancels while waiting for the project transaction without removing the ticket", async () => {
		const ticket = await store.create({ name: "Keep after cancellation" })
		const controller = new AbortController()
		let release!: () => void
		let locked!: () => void
		const acquired = new Promise<void>((resolve) => (locked = resolve))
		const blocker = atomicWrite.withFileLock(path.join(store.directory, ".transaction"), async () => {
			locked()
			await new Promise<void>((resolve) => (release = resolve))
		})
		await acquired
		const deletion = store.delete({ id: ticket.id, expectedRevision: ticket.revision }, controller.signal)
		const rejected = expect(deletion).rejects.toThrow()
		controller.abort()
		release()
		await blocker
		await rejected
		expect(await store.read(ticket.id)).toEqual(ticket)
	})

	it("serializes concurrent deletion and update without recreating the ticket", async () => {
		const ticket = await store.create({ name: "Concurrent" })
		const second = await TicketStore.forWorkspace(workspace, home)
		const results = await Promise.allSettled([
			store.delete({ id: ticket.id, expectedRevision: ticket.revision }),
			second.update({ id: ticket.id, expectedRevision: ticket.revision, name: "Updated" }),
		])
		expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1)
		if (results[0].status === "fulfilled") await expect(store.read(ticket.id)).rejects.toThrow("not found")
		else expect((await store.read(ticket.id)).name).toBe("Updated")
	})

	it("recovers pending moves before deletion and never restores the removed ticket", async () => {
		const ticket = await store.create({ name: "Pending move" })
		const source = await store.markdownPath(ticket.id)
		const text = await fs.readFile(source, "utf8")
		const journal = path.join(store.directory, ".move.json")
		await fs.writeFile(
			journal,
			JSON.stringify({ id: ticket.id, from: "backlog", to: "in-progress", revision: ticket.revision, text }),
		)
		const expectedRevision = createHash("sha256").update(`in-progress\0${text}`).digest("hex")
		expect(await store.delete({ id: ticket.id, expectedRevision })).toMatchObject({
			id: ticket.id,
			status: "in-progress",
			revision: expectedRevision,
		})
		await expect(fs.stat(journal)).rejects.toMatchObject({ code: "ENOENT" })
		await store.recoverPendingMoves()
		expect((await store.list()).tickets).toEqual([])
	})
})
