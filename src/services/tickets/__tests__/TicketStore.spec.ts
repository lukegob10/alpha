import { beforeEach, afterEach, describe, expect, it } from "vitest"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { TicketStore } from "../TicketStore"

describe("TicketStore", () => {
	let home: string, workspace: string, store: TicketStore
	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-tickets-"))
		workspace = path.join(home, "project")
		await fs.mkdir(workspace)
		store = await TicketStore.forWorkspace(workspace, home)
	})
	afterEach(async () => {
		await fs.rm(home, { recursive: true, force: true })
	})

	it("does not create profile storage during inspection", async () => {
		expect(await store.list()).toMatchObject({ tickets: [], total: 0 })
		await expect(store.readMany(["PRO-01", "../escape"])).resolves.toEqual([
			{ error: expect.any(Error) },
			{ error: expect.any(Error) },
		])
		await expect(fs.stat(path.join(home, ".alpha"))).rejects.toMatchObject({ code: "ENOENT" })
	})
	it("reads mixed locator batches in order with independent errors and no cache across edits", async () => {
		const first = await store.create({ name: "First" })
		const second = await store.create({ name: "Second" })
		await expect(store.readMany([second.id, "PRO-99", "../escape", "pro1"])).resolves.toEqual([
			{ ticket: second },
			{ error: expect.any(Error) },
			{ error: expect.any(Error) },
			{ ticket: first },
		])
		const updated = await store.update({
			id: first.id,
			expectedRevision: first.revision,
			description: "External update",
		})
		await expect(store.readMany(["PRO-01", second.id])).resolves.toEqual([{ ticket: updated }, { ticket: second }])
	})
	it("retains duplicate reference and ID protections when reading an attachment batch", async () => {
		const first = await store.create({ name: "First" })
		const second = await store.create({ name: "Second" })
		const secondFile = await store.markdownPath(second.id)
		const secondMarkdown = await fs.readFile(secondFile, "utf8")
		await fs.writeFile(secondFile, secondMarkdown.replace("PRO-02", "PRO-01"))
		const ambiguous = await store.readMany(["PRO-01", first.id])
		expect(ambiguous[0]).toMatchObject({ error: { message: "Duplicate ticket reference; repair Markdown files" } })
		expect(ambiguous[1]).toEqual({ ticket: first })
		await fs.writeFile(secondFile, secondMarkdown)
		const firstFile = await store.markdownPath(first.id)
		await fs.mkdir(path.join(store.directory, "in-progress"))
		await fs.writeFile(
			path.join(store.directory, "in-progress", `${first.id}.md`),
			(await fs.readFile(firstFile, "utf8")).replace("PRO-01", "PRO-77"),
		)
		const duplicates = await store.readMany(["PRO-01", second.id])
		expect(duplicates[0]).toMatchObject({ error: { message: "Duplicate ticket ID; repair Markdown files" } })
		expect(duplicates[1]).toEqual({ ticket: second })
	})
	it("persists classification through edits, status moves, reload, and explicit removal", async () => {
		const created = await store.create({ name: "Classified", type: "bug", priority: "high" })
		const markdown = await fs.readFile(await store.markdownPath(created.id), "utf8")
		expect(markdown).toContain("type: bug")
		expect(markdown).toContain("priority: high")
		const moved = await store.update({ id: created.id, expectedRevision: created.revision, status: "in-progress" })
		const reopened = await TicketStore.forWorkspace(workspace, home)
		expect((await reopened.read(created.id)).type).toBe("bug")
		expect((await reopened.read(created.id)).priority).toBe("high")
		const changed = await reopened.update({
			id: moved.id,
			expectedRevision: moved.revision,
			type: "improvement",
			priority: "medium",
		})
		expect(changed).toMatchObject({ type: "improvement", priority: "medium" })
		await expect(store.update({ id: moved.id, expectedRevision: moved.revision, type: "feature" })).rejects.toThrow(
			"changed",
		)
		const cleared = await store.update({
			id: changed.id,
			expectedRevision: changed.revision,
			type: null,
			priority: null,
		})
		expect((await reopened.read(cleared.id)).type).toBeNull()
		expect((await reopened.read(cleared.id)).priority).toBeNull()
		expect((await store.list({ type: null })).tickets).toEqual([
			expect.objectContaining({ id: cleared.id, type: null, priority: null }),
		])
	})
	it.each(["testing", "performance", "ux"] as const)(
		"persists the %s ticket type and priority in list summaries",
		async (type) => {
			const created = await store.create({ name: `Classified ${type}`, type, priority: "low" })
			const reopened = await TicketStore.forWorkspace(workspace, home)
			expect(await reopened.read(created.id)).toMatchObject({ type, priority: "low" })
			expect(await reopened.list({ type })).toMatchObject({
				total: 1,
				tickets: [expect.objectContaining({ id: created.id, type, priority: "low" })],
			})
		},
	)
	it.each(["high", "medium", "low"] as const)("round-trips the %s ticket priority", async (priority) => {
		const created = await store.create({ name: `Priority ${priority}`, priority })
		expect((await store.read(created.id)).priority).toBe(priority)
		expect((await store.list()).tickets).toEqual([expect.objectContaining({ id: created.id, priority })])
	})
	it("keeps legacy tickets untagged without rewriting them during inspection", async () => {
		const created = await store.create({ name: "Legacy" })
		const file = await store.markdownPath(created.id)
		const before = await fs.readFile(file, "utf8")
		expect((await store.read(created.id)).type).toBeUndefined()
		expect((await store.read(created.id)).priority).toBeUndefined()
		expect((await store.list({ type: null })).tickets[0].id).toBe(created.id)
		expect((await store.list()).tickets[0]).not.toHaveProperty("priority")
		expect(await fs.readFile(file, "utf8")).toBe(before)
		await store.update({ id: created.id, expectedRevision: created.revision, name: "Renamed" })
		expect((await store.read(created.id)).type).toBeUndefined()
		expect((await store.read(created.id)).priority).toBeUndefined()
	})
	it("filters classifications before pagination and combines them with search and status", async () => {
		const bug = await store.create({ name: "Search bug", type: "bug" })
		const active = await store.create({ name: "Search feature", type: "feature" })
		await store.update({ id: active.id, expectedRevision: active.revision, status: "in-progress" })
		await store.create({ name: "Other feature", type: "feature" })
		await store.create({ name: "Search improvement", type: "improvement" })
		expect(await store.list({ type: "feature", limit: 1, offset: 0 })).toMatchObject({
			total: 2,
			tickets: [{ id: active.id, type: "feature" }],
		})
		expect((await store.list({ type: "feature", limit: 1, offset: 1 })).tickets).toHaveLength(1)
		expect(await store.list({ type: "bug", query: "Search", status: "backlog" })).toMatchObject({
			total: 1,
			tickets: [{ id: bug.id, type: "bug" }],
		})
		expect((await store.list({ type: "bug", status: "in-progress" })).total).toBe(0)
		expect((await store.list()).total).toBe(4)
	})
	it("orders active tickets before backlog and completed tickets across pages", async () => {
		const active = await store.create({ name: "Active" })
		await store.update({ id: active.id, expectedRevision: active.revision, status: "in-progress" })
		const backlog = await store.create({ name: "Backlog" })
		const complete = await store.create({ name: "Complete" })
		await store.update({
			id: complete.id,
			expectedRevision: complete.revision,
			status: "complete",
			implementationSummary: "Done",
		})
		expect((await store.list({ limit: 1, offset: 0 })).tickets[0]?.id).toBe(active.id)
		expect((await store.list({ limit: 1, offset: 1 })).tickets[0]?.id).toBe(backlog.id)
		expect((await store.list({ limit: 1, offset: 2 })).tickets[0]?.id).toBe(complete.id)
	})
	it("returns a ticket's parent and every direct child with uncapped relationship counts", async () => {
		const parent = await store.create({ name: "Parent", priority: "high" })
		const activeChild = await store.create({ name: "Active child", parentId: parent.id, priority: "low" })
		const active = await store.update({
			id: activeChild.id,
			expectedRevision: activeChild.revision,
			status: "in-progress",
		})
		const backlogChild = await store.create({ name: "Backlog child", parentId: parent.id })
		const completedChild = await store.create({ name: "Completed child", parentId: parent.id })
		const completed = await store.update({
			id: completedChild.id,
			expectedRevision: completedChild.revision,
			status: "complete",
		})
		const grandchild = await store.create({ name: "Grandchild", parentId: backlogChild.id })

		const parentRelations = await store.relations(parent.id)
		expect(parentRelations.parent).toBeUndefined()
		expect(parentRelations.children.map(({ id }) => id)).toEqual([active.id, backlogChild.id, completed.id])
		expect(parentRelations.children[1]).toMatchObject({
			id: backlogChild.id,
			childCount: 1,
			completedChildCount: 0,
		})

		const childRelations = await store.relations(backlogChild.id)
		expect(childRelations.parent).toMatchObject({
			id: parent.id,
			priority: "high",
			childCount: 3,
			completedChildCount: 1,
		})
		expect(childRelations.children.map(({ id }) => id)).toEqual([grandchild.id])
		expect(childRelations.children[0]).toMatchObject({ childCount: 0, completedChildCount: 0 })
	})

	it("allocates permanent project references across concurrent writers and deletion", async () => {
		workspace = path.join(home, "project-manager-v2")
		await fs.mkdir(workspace)
		store = await TicketStore.forWorkspace(workspace, home)
		const second = await TicketStore.forWorkspace(workspace, home)
		const tickets = await Promise.all([store.create({ name: "First" }), second.create({ name: "Second" })])
		expect(tickets.map((ticket) => ticket.reference).sort()).toEqual(["PM-01", "PM-02"])
		const first = await store.read("pm1")
		const renamed = await store.update({
			id: "PM-01",
			expectedRevision: first.revision,
			name: "Renamed",
			status: "in-progress",
		})
		expect(renamed).toMatchObject({ id: first.id, reference: "PM-01", name: "Renamed" })
		expect(await second.read("PM number 1")).toMatchObject({ id: first.id, reference: "PM-01" })
		const highest = await store.read("PM-02")
		await fs.unlink(await store.markdownPath(highest.id))
		expect((await second.create({ name: "Third" })).reference).toBe("PM-03")
	})

	it("backfills legacy references once without changing dates or Markdown contents", async () => {
		const created = await store.create({ name: "Legacy", description: "Keep **formatting**" })
		const file = await store.markdownPath(created.id)
		const legacy = (await fs.readFile(file, "utf8")).replace(/^reference:.*\n/m, "")
		await fs.writeFile(file, legacy)
		await fs.unlink(path.join(store.directory, ".sequence.json"))
		expect((await store.read(created.id)).reference).toBeUndefined()
		expect(await fs.readFile(file, "utf8")).toBe(legacy)
		await store.prepareReferences()
		const migrated = await store.read("PRO-01")
		expect(migrated).toMatchObject({ id: created.id, createdAt: created.createdAt, updatedAt: created.updatedAt })
		expect((await fs.readFile(file, "utf8")).replace(/^reference:.*\n/m, "")).toBe(legacy)
		await store.prepareReferences()
		expect((await store.read(created.id)).revision).toBe(migrated.revision)
		await expect(
			store.update({ id: created.id, expectedRevision: created.revision, name: "Stale" }),
		).rejects.toThrow("changed")
	})

	it("finds shorthand and unordered title words, and rejects ambiguous references", async () => {
		const first = await store.create({ name: "Clean up backend and improve performance" })
		expect(await store.list({ query: "backend performance cleanup" })).toMatchObject({
			total: 1,
			tickets: [expect.objectContaining({ id: first.id, reference: "PRO-01" })],
		})
		expect((await store.list({ query: "pro1" })).tickets[0].id).toBe(first.id)
		await expect(store.read("OTHER-01")).rejects.toThrow()
		const second = await store.create({ name: "Other" })
		const file = await store.markdownPath(second.id)
		await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("PRO-02", "PRO-01"))
		await expect(store.read("PRO-01")).rejects.toThrow("Duplicate ticket reference")
		await expect(store.create({ name: "Do not allocate during conflict" })).rejects.toThrow(
			"Duplicate ticket reference",
		)
	})

	it("narrows reference searches while typing and combines references with title words", async () => {
		workspace = path.join(home, "project-manager-v2")
		await fs.mkdir(workspace)
		store = await TicketStore.forWorkspace(workspace, home)
		const first = await store.create({ name: "Backend cleanup" })
		const second = await store.create({ name: "Improve search" })
		for (const query of ["PM", "pm-", "PM-0"])
			expect((await store.list({ query })).tickets.map((ticket) => ticket.id).sort()).toEqual(
				[first.id, second.id].sort(),
			)
		for (const query of ["PM-01", "pm1", "PM backend", "01 cleanup"])
			expect((await store.list({ query })).tickets.map((ticket) => ticket.id)).toEqual([first.id])
		expect((await store.list({ query: "PM-99" })).total).toBe(0)
	})

	it("detects a manual status-folder move as a revision change", async () => {
		const ticket = await store.create({ name: "Move manually" })
		const source = await store.markdownPath(ticket.id)
		await fs.mkdir(path.join(store.directory, "in-progress"))
		await fs.rename(source, path.join(store.directory, "in-progress", `${ticket.id}.md`))
		await expect(
			store.update({ id: ticket.id, expectedRevision: ticket.revision, status: "backlog" }),
		).rejects.toThrow("changed")
		expect((await store.read(ticket.id)).status).toBe("in-progress")
	})

	it("round trips Markdown and permits direct completion without a summary", async () => {
		const created = await store.create({
			name: "Fix retry",
			description: "Details\n\nMore details",
			context: "Context",
			successCriteria: "- [ ] Tests pass",
		})
		expect(created).toMatchObject({
			status: "backlog",
			description: "Details\n\nMore details",
			context: "Context",
			successCriteria: "- [ ] Tests pass",
		})
		const complete = await store.update({ id: created.id, expectedRevision: created.revision, status: "complete" })
		expect(complete.completedAt).toBeTruthy()
		expect(complete.implementationSummary).toBe("")
		await expect((await TicketStore.forWorkspace(workspace, home)).read(complete.id)).resolves.toMatchObject({
			status: "complete",
			implementationSummary: "",
		})
		expect(await fs.readdir(path.join(store.directory, "backlog"))).toEqual([])
		const documented = await store.update({
			id: complete.id,
			expectedRevision: complete.revision,
			implementationSummary: "Fixed retry. Tests pass.",
		})
		const reopened = await store.update({
			id: created.id,
			expectedRevision: documented.revision,
			status: "in-progress",
		})
		expect(reopened.completedAt).toBeUndefined()
		expect(reopened.implementationSummary).toBe(documented.implementationSummary)
	})

	it("keeps cancellation distinct from completion and allows reopening", async () => {
		const created = await store.create({ name: "May be canceled" })
		const canceled = await store.update({ id: created.id, expectedRevision: created.revision, status: "canceled" })
		expect(canceled).toMatchObject({ status: "canceled", implementationSummary: "" })
		expect(canceled.completedAt).toBeUndefined()
		expect(await store.markdownPath(canceled.id)).toContain(`${path.sep}canceled${path.sep}`)
		expect((await store.list({ status: "canceled" })).tickets).toEqual([
			expect.objectContaining({ id: canceled.id, revision: canceled.revision }),
		])
		await expect(
			store.update({ id: canceled.id, expectedRevision: created.revision, status: "in-progress" }),
		).rejects.toThrow("changed")
		const reopened = await store.update({
			id: canceled.id,
			expectedRevision: canceled.revision,
			status: "in-progress",
		})
		expect(reopened.status).toBe("in-progress")
		expect(reopened.completedAt).toBeUndefined()
		const complete = await store.update({
			id: reopened.id,
			expectedRevision: reopened.revision,
			status: "complete",
			implementationSummary: "Completed before cancellation",
		})
		const laterCanceled = await store.update({
			id: complete.id,
			expectedRevision: complete.revision,
			status: "canceled",
		})
		expect(laterCanceled.completedAt).toBeUndefined()
	})

	it("persists a ticket hierarchy and exposes parent and revision in list summaries", async () => {
		const parent = await store.create({ name: "Parent" })
		const child = await store.create({ name: "Child", parentId: parent.id })
		const grandchild = await store.create({ name: "Grandchild", parentId: child.id })
		const reopened = await TicketStore.forWorkspace(workspace, home)
		expect(await reopened.read(child.id)).toMatchObject({ parentId: parent.id })
		expect((await reopened.list()).tickets).toContainEqual(
			expect.objectContaining({ id: child.id, parentId: parent.id, revision: child.revision }),
		)
		expect((await reopened.read(grandchild.id)).parentId).toBe(child.id)
		const detached = await reopened.update({ id: child.id, expectedRevision: child.revision, parentId: null })
		expect(detached.parentId).toBeUndefined()
		expect(await fs.readFile(await reopened.markdownPath(child.id), "utf8")).not.toContain("parentId:")
		await expect(
			store.update({ id: child.id, expectedRevision: child.revision, parentId: parent.id }),
		).rejects.toThrow("changed")
	})
	it("counts all direct children before status filtering and pagination", async () => {
		const parent = await store.create({ name: "Parent aggregate" })
		const child = await store.create({ name: "Child complete", parentId: parent.id })
		const complete = await store.update({ id: child.id, expectedRevision: child.revision, status: "complete" })
		await store.create({ name: "Child backlog", parentId: parent.id })
		await store.create({ name: "Unrelated ticket" })
		const parentPage = await store.list({ query: "Parent aggregate", status: "backlog", limit: 1 })
		expect(parentPage).toMatchObject({
			total: 1,
			tickets: [{ id: parent.id, childCount: 2, completedChildCount: 1 }],
		})
		const pages = await Promise.all([0, 1, 2, 3].map((offset) => store.list({ limit: 1, offset })))
		expect(pages.find((page) => page.tickets[0]?.id === parent.id)?.tickets[0]).toMatchObject({
			childCount: 2,
			completedChildCount: 1,
		})
		const reopened = await store.update({
			id: child.id,
			expectedRevision: complete.revision,
			status: "in-progress",
		})
		expect(reopened.status).toBe("in-progress")
		expect((await store.list({ query: "Parent aggregate" })).tickets[0]).toMatchObject({
			childCount: 2,
			completedChildCount: 0,
		})
	})

	it("rejects missing parents, self-parenting, and hierarchy cycles without altering tickets", async () => {
		const first = await store.create({ name: "First" })
		const second = await store.create({ name: "Second", parentId: first.id })
		const third = await store.create({ name: "Third", parentId: second.id })
		const unknown = "ad309f14-0a52-41b0-b16e-91e8f0d6aeaf"
		await expect(store.create({ name: "Orphan", parentId: unknown })).rejects.toThrow("Parent ticket not found")
		await expect(
			store.update({ id: first.id, expectedRevision: first.revision, parentId: unknown }),
		).rejects.toThrow("Parent ticket not found")
		await expect(
			store.update({ id: first.id, expectedRevision: first.revision, parentId: first.id }),
		).rejects.toThrow("own parent")
		await expect(
			store.update({ id: first.id, expectedRevision: first.revision, parentId: third.id }),
		).rejects.toThrow("descendant")
		expect((await store.read(first.id)).parentId).toBeUndefined()
		expect((await store.read(second.id)).parentId).toBe(first.id)
	})

	it("preserves external metadata and sections and rejects stale saves", async () => {
		const created = await store.create({ name: "Original" })
		const file = await store.markdownPath(created.id)
		const external =
			(await fs.readFile(file, "utf8")).replace("schemaVersion: 1", "schemaVersion: 1\nowner: person") +
			"## Notes\nKeep me\n"
		await fs.writeFile(file, external)
		await expect(
			store.update({ id: created.id, expectedRevision: created.revision, name: "Overwrite" }),
		).rejects.toThrow("changed")
		const fresh = await store.read(created.id)
		await store.update({ id: fresh.id, expectedRevision: fresh.revision, name: "Renamed" })
		const saved = await fs.readFile(file, "utf8")
		expect(saved).toContain("owner: person")
		expect(saved).toContain("## Notes\nKeep me")
	})

	it("preserves fenced Markdown headings and rejects ambiguous section edits before writing", async () => {
		const description = "Example:\n```md\n## Context\nNot a section\n```"
		const ticket = await store.create({ name: "Markdown", description })
		expect(ticket.description).toBe(description)
		await expect(
			store.update({
				id: ticket.id,
				expectedRevision: ticket.revision,
				description: "## Different section\nText",
			}),
		).rejects.toThrow("level-three")
		expect((await store.read(ticket.id)).description).toBe(description)
	})

	it("serializes two store instances and rejects the stale writer", async () => {
		const ticket = await store.create({ name: "Concurrent" })
		const second = await TicketStore.forWorkspace(workspace, home)
		const results = await Promise.allSettled([
			store.update({ id: ticket.id, expectedRevision: ticket.revision, name: "One" }),
			second.update({ id: ticket.id, expectedRevision: ticket.revision, name: "Two" }),
		])
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
		expect(results.filter((r) => r.status === "rejected")).toHaveLength(1)
	})

	it("isolates equal project names, pages results, and reports malformed files", async () => {
		const otherRoot = path.join(home, "other", "project")
		await fs.mkdir(otherRoot, { recursive: true })
		expect((await TicketStore.forWorkspace(otherRoot, home)).projectId).not.toBe(store.projectId)
		await store.create({ name: "Needle" })
		await store.create({ name: "Another" })
		await fs.writeFile(path.join(store.directory, "backlog", "bad.md"), "broken")
		expect(await store.list({ query: "needle" })).toMatchObject({ total: 1, invalidFiles: ["backlog/bad.md"] })
		expect((await store.list({ limit: 1 })).tickets).toHaveLength(1)
	})

	it("rejects traversal, symlink escapes, and cancelled writes", async () => {
		await expect(store.read("../escape")).rejects.toThrow()
		const controller = new AbortController()
		controller.abort()
		await expect(store.create({ name: "Cancelled" }, controller.signal)).rejects.toThrow()
		const ticket = await store.create({ name: "Safe" })
		const directory = path.join(store.directory, "complete")
		await fs.symlink(workspace, directory, process.platform === "win32" ? "junction" : "dir")
		await expect(
			store.update({
				id: ticket.id,
				expectedRevision: ticket.revision,
				status: "complete",
				implementationSummary: "Done",
			}),
		).rejects.toThrow("symbolic")
	})

	it("recovers a durable move intent without losing ticket content", async () => {
		const ticket = await store.create({ name: "Move" })
		const file = await store.markdownPath(ticket.id)
		const text = await fs.readFile(file, "utf8")
		await fs.writeFile(
			path.join(store.directory, ".move.json"),
			JSON.stringify({ id: ticket.id, from: "backlog", to: "in-progress", revision: ticket.revision, text }),
		)
		await expect(store.read(ticket.id)).rejects.toThrow("move pending")
		await expect(store.readMany([ticket.id, "PRO-01"])).rejects.toThrow("move pending")
		await store.recoverPendingMoves()
		expect((await store.read(ticket.id)).status).toBe("in-progress")
		await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" })
	})
})
