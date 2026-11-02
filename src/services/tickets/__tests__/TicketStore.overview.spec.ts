import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { ticketOverviewSchema } from "@alpha-code/types"
import { TicketStore } from "../TicketStore"

vi.mock("fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof import("fs/promises")>()) }))

describe("TicketStore observed progress", () => {
	let home: string
	let store: TicketStore
	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ticket-progress-"))
		const workspace = path.join(home, "project")
		await fs.mkdir(workspace)
		store = await TicketStore.forWorkspace(workspace, home)
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(new Date("2026-10-30T15:00:00Z"))
	})
	afterEach(async () => {
		vi.useRealTimers()
		vi.restoreAllMocks()
		await fs.rm(home, { recursive: true, force: true })
	})

	it("counts only leaf work, excludes canceled scope, and never backfills invented history", async () => {
		const parent = await store.create({ name: "Parent" })
		const done = await store.create({ name: "Done", parentId: parent.id })
		const active = await store.create({ name: "Active", parentId: parent.id })
		await store.create({ name: "Backlog" })
		const canceled = await store.create({ name: "Canceled" })
		await store.update({ id: done.id, expectedRevision: done.revision, status: "complete" })
		await store.update({ id: active.id, expectedRevision: active.revision, status: "in-progress" })
		await store.update({ id: canceled.id, expectedRevision: canceled.revision, status: "canceled" })
		vi.setSystemTime(new Date("2026-10-31T15:00:00Z"))
		const overview = await store.overview()
		expect(ticketOverviewSchema.safeParse(overview).success).toBe(true)
		expect(overview).toMatchObject({
			total: 3,
			complete: 1,
			inProgress: 1,
			backlog: 1,
			canceled: 1,
			points: [{ date: "2026-10-31", total: 3, complete: 1 }],
		})
	})

	it("updates today's observation, persists prior days through reopen/delete, and leaves gaps unobserved", async () => {
		let ticket = await store.create({ name: "Work" })
		expect((await store.overview()).points).toEqual([{ date: "2026-10-30", total: 1, complete: 0 }])
		ticket = await store.update({ id: ticket.id, expectedRevision: ticket.revision, status: "complete" })
		expect((await store.overview()).points).toEqual([{ date: "2026-10-30", total: 1, complete: 1 }])
		vi.setSystemTime(new Date("2026-11-02T12:00:00Z"))
		ticket = await store.update({ id: ticket.id, expectedRevision: ticket.revision, status: "backlog" })
		await store.delete({ id: ticket.id, expectedRevision: ticket.revision })
		const reopened = await TicketStore.forWorkspace(store.workspace, home)
		expect((await reopened.overview()).points).toEqual([
			{ date: "2026-10-30", total: 1, complete: 1 },
			{ date: "2026-11-02", total: 0, complete: 0 },
		])
	})

	it("does not rewrite unchanged observations and reports invalid Markdown", async () => {
		await store.create({ name: "Valid" })
		await store.overview()
		await fs.writeFile(path.join(store.directory, "backlog", "invalid.md"), "not a ticket")
		const rename = vi.spyOn(fs, "rename")
		expect((await store.overview()).invalidFiles).toEqual(["backlog/invalid.md"])
		expect(rename).not.toHaveBeenCalled()
	})

	it("preserves corrupt history for repair and does not block normal ticket creation", async () => {
		await store.overview()
		const file = path.join(store.directory, ".progress.json")
		await fs.writeFile(file, "corrupt history")
		await expect(store.overview()).rejects.toThrow("needs repair")
		expect(await fs.readFile(file, "utf8")).toBe("corrupt history")
		await expect(store.create({ name: "Still works" })).resolves.toMatchObject({ name: "Still works" })
	})
})
