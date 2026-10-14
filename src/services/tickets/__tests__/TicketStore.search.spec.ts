import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TicketStore } from "../TicketStore"

vi.mock("fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("fs/promises")>()
	return { ...original, readFile: vi.fn(original.readFile) }
})

describe("ticket mention search", () => {
	let home: string, workspace: string, store: TicketStore
	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ticket-search-"))
		workspace = path.join(home, "project")
		await fs.mkdir(workspace)
		store = await TicketStore.forWorkspace(workspace, home)
	})
	afterEach(async () => {
		TicketStore.disposeSearchCaches()
		vi.restoreAllMocks()
		await fs.rm(home, { recursive: true, force: true })
	})

	async function seed(count: number) {
		const directory = path.join(store.directory, "backlog")
		await fs.mkdir(directory, { recursive: true })
		for (let offset = 0; offset < count; offset += 16) {
			await Promise.all(
				Array.from({ length: Math.min(16, count - offset) }, async (_, index) => {
					const number = offset + index + 1
					const id = `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`
					await fs.writeFile(
						path.join(directory, `${id}.md`),
						[
							"---",
							"schemaVersion: 1",
							`id: ${id}`,
							`reference: PRO-${String(number).padStart(2, "0")}`,
							`name: Backend cleanup ${number}`,
							"createdAt: 2026-10-13T00:00:00.000Z",
							"updatedAt: 2026-10-13T00:00:00.000Z",
							"linkedTaskIds: []",
							"---",
							"## Description",
							"Detailed implementation context. ".repeat(128),
							"## Context",
							"Existing project behavior and constraints. ".repeat(64),
						].join("\n"),
					)
				}),
			)
		}
	}

	it("reuses unchanged search records across queries and store instances", async () => {
		await seed(64)
		const reads = vi.mocked(fs.readFile)
		reads.mockClear()
		expect(await store.search("backend")).toHaveLength(50)
		expect(reads.mock.calls.filter(([file]) => String(file).endsWith(".md"))).toHaveLength(64)
		const reopened = await TicketStore.forWorkspace(workspace, home)
		reads.mockClear()
		expect(await reopened.search("cleanup")).toHaveLength(50)
		expect(await reopened.search("pro64")).toMatchObject([{ reference: "PRO-64" }])
		expect(await reopened.search("missing")).toEqual([])
		expect(reads).not.toHaveBeenCalled()
	})
	it("does not stat every project ticket again while the search index is unchanged", async () => {
		await seed(128)
		await store.search("")
		const stats = vi.spyOn(fs, "lstat")
		expect(await store.search("backend")).toHaveLength(50)
		expect(stats.mock.calls.length).toBeLessThan(96)
		stats.mockClear()
		expect(await store.search("PRO-128")).toMatchObject([{ reference: "PRO-128" }])
		expect(stats.mock.calls.length).toBeLessThan(96)
	})

	it("finds a project ticket by its exact number without matching other titles or numbers", async () => {
		await seed(130)
		for (const query of ["1", "#1", "#001"]) {
			expect(await store.search(query)).toMatchObject([{ reference: "PRO-01" }])
			expect(await store.search(query)).toHaveLength(1)
		}
		expect(await store.search("#131")).toEqual([])
	})

	it("refreshes only edited files, including equal-size edits with restored mtime", async () => {
		await seed(3)
		const [ticket] = await store.search("PRO-01")
		const file = path.join(store.directory, "backlog", `${ticket.id}.md`)
		const original = await fs.readFile(file, "utf8")
		const timestamp = new Date("2026-10-01T00:00:00.000Z")
		await fs.utimes(file, timestamp, timestamp)
		await store.search("PRO-01")
		const stat = await fs.stat(file, { bigint: true })
		await fs.writeFile(file, original.replace("Backend cleanup 1", "Frontend update 1"))
		await fs.utimes(file, timestamp, timestamp)
		const edited = await fs.stat(file, { bigint: true })
		expect(edited.size).toBe(stat.size)
		expect(edited.mtimeNs).toBe(stat.mtimeNs)
		const reads = vi.mocked(fs.readFile)
		reads.mockClear()
		expect(await store.search("frontend")).toMatchObject([{ id: ticket.id, name: "Frontend update 1" }])
		expect(reads.mock.calls.filter(([file]) => String(file).endsWith(".md"))).toHaveLength(1)
		expect(await store.search("backend")).toHaveLength(2)
	})

	it("reflects external status moves, deletions, corruption, and repairs", async () => {
		await seed(3)
		const tickets = await store.search("")
		const active = path.join(store.directory, "in-progress")
		await fs.mkdir(active)
		const movedFile = path.join(active, `${tickets[0].id}.md`)
		await fs.rename(path.join(store.directory, "backlog", `${tickets[0].id}.md`), movedFile)
		await fs.unlink(path.join(store.directory, "backlog", `${tickets[1].id}.md`))
		const brokenFile = path.join(store.directory, "backlog", `${tickets[2].id}.md`)
		const original = await fs.readFile(brokenFile, "utf8")
		await fs.writeFile(brokenFile, "broken Markdown")
		expect(await store.search("")).toMatchObject([{ id: tickets[0].id, status: "in-progress" }])
		await fs.writeFile(brokenFile, original)
		expect(await store.search("")).toHaveLength(2)
		await fs.writeFile(movedFile, "x".repeat(100001))
		expect(await store.search("")).toMatchObject([{ id: tickets[2].id }])
	})

	it("refreshes names, references, and statuses after editor writes", async () => {
		const ticket = await store.create({ name: "Original", context: "legacy context" })
		expect(await store.search("original")).toMatchObject([{ id: ticket.id }])
		await store.update({
			id: ticket.id,
			expectedRevision: ticket.revision,
			name: "Renamed",
			status: "complete",
		})
		expect(await store.search("renamed")).toMatchObject([{ name: "Renamed", status: "complete" }])
		expect(await store.search("original")).toEqual([])
		expect(await store.search("legacy context")).toEqual([])
		expect(await store.list({ query: "legacy context" })).toMatchObject({ tickets: [{ id: ticket.id }] })
		const file = await store.markdownPath(ticket.id)
		await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("PRO-01", "PRO-99"))
		expect(await store.search("PRO-01")).toEqual([])
		expect(await store.search("pro99")).toMatchObject([{ id: ticket.id }])
		await store.delete({ id: ticket.id, expectedRevision: (await store.read(ticket.id)).revision })
		expect(await store.search("")).toEqual([])
	})

	it("ranks exact titles and title prefixes without searching full ticket contents", async () => {
		await seed(64)
		await fs.rename(path.join(store.directory, "backlog"), path.join(store.directory, "in-progress"))
		const exact = await store.create({ name: "Implementation context" })
		const prefix = await store.create({ name: "Implementation context cleanup" })
		const words = await store.create({ name: "Audit implementation and context" })
		const results = await store.search("implementation context")
		expect(results).toHaveLength(3)
		expect(results.slice(0, 3).map(({ id }) => id)).toEqual([exact.id, prefix.id, words.id])
		expect(await store.search(exact.reference!.toLowerCase().replace("-", " "))).toMatchObject([{ id: exact.id }])
	})
	it("finds exact UUIDs in this project without loading other projects", async () => {
		await seed(2)
		const [ticket] = await store.search("PRO-02")
		expect(await store.search(ticket.id)).toMatchObject([{ id: ticket.id }])
	})

	it("keeps projects isolated and returned suggestions independent of cached records", async () => {
		await seed(1)
		const suggestions = await store.search("")
		suggestions[0].name = "Mutated suggestion"
		const otherWorkspace = path.join(home, "other")
		await fs.mkdir(otherWorkspace)
		const otherStore = await TicketStore.forWorkspace(otherWorkspace, home)
		expect(await otherStore.search("")).toEqual([])
		await expect(fs.stat(path.join(otherStore.directory))).rejects.toMatchObject({ code: "ENOENT" })
		expect(await store.search("")).toMatchObject([{ name: "Backend cleanup 1" }])
	})

	it("coalesces overlapping searches without letting one canceled reader affect another", async () => {
		await seed(64)
		const reads = vi.mocked(fs.readFile)
		const originalRead = (await vi.importActual<typeof import("fs/promises")>("fs/promises")).readFile
		let started!: () => void
		let release!: () => void
		const reading = new Promise<void>((resolve) => {
			started = resolve
		})
		const barrier = new Promise<void>((resolve) => {
			release = resolve
		})
		reads.mockImplementation(async (...args) => {
			started()
			await barrier
			return originalRead(...args)
		})
		reads.mockClear()
		const controller = new AbortController()
		const cancelled = store.search("backend", controller.signal)
		const cancellation = expect(cancelled).rejects.toThrow("cancelled")
		await reading
		const active = store.search("PRO-64")
		controller.abort(new Error("cancelled"))
		try {
			await cancellation
		} finally {
			release()
		}
		try {
			expect(await active).toMatchObject([{ reference: "PRO-64" }])
			expect(reads.mock.calls.filter(([file]) => String(file).endsWith(".md"))).toHaveLength(64)
		} finally {
			reads.mockImplementation(originalRead)
		}
	})

	it("rechecks directory protections after the search cache is warm", async () => {
		await seed(1)
		await store.search("")
		const directory = path.join(store.directory, "backlog")
		await fs.rename(directory, `${directory}-original`)
		await fs.symlink(workspace, directory, process.platform === "win32" ? "junction" : "dir")
		await expect(store.search("")).rejects.toThrow("symbolic links")
		await fs.unlink(directory)
	})

	it("does not reuse or publish an older refresh after an editor mutation", async () => {
		await seed(1)
		const ticket = (await store.list()).tickets[0]
		const reads = vi.mocked(fs.readFile)
		const originalRead = (await vi.importActual<typeof import("fs/promises")>("fs/promises")).readFile
		let started!: () => void
		let release!: () => void
		let held = false
		const reading = new Promise<void>((resolve) => {
			started = resolve
		})
		const barrier = new Promise<void>((resolve) => {
			release = resolve
		})
		reads.mockImplementation(async (...args) => {
			const value = await originalRead(...args)
			if (String(args[0]).endsWith(".md") && !held) {
				held = true
				started()
				await barrier
			}
			return value
		})
		const earlier = store.search("backend")
		await reading
		try {
			await store.update({ id: ticket.id, expectedRevision: ticket.revision, name: "Renamed" })
			expect(await store.search("renamed")).toMatchObject([{ name: "Renamed" }])
		} finally {
			release()
			await earlier
			reads.mockImplementation(originalRead)
		}
		reads.mockClear()
		expect(await store.search("renamed")).toMatchObject([{ name: "Renamed" }])
		expect(reads).not.toHaveBeenCalled()
	})

	it("rejects pending move inspection even when the search cache is warm", async () => {
		await seed(1)
		await store.search("")
		await fs.writeFile(path.join(store.directory, ".move.json"), "{}")
		await expect(store.search("")).rejects.toThrow("Ticket move pending")
		expect(await fs.readFile(path.join(store.directory, ".move.json"), "utf8")).toBe("{}")
	})

	it.runIf(process.env.ALPHA_TICKET_SEARCH_BENCHMARK === "1")(
		"measures a 1,000-ticket typing workload",
		async () => {
			await seed(1000)
			const queries = ["", "backend", "backend cleanup", "PRO-500", "missing ticket"]
			const reads = vi.mocked(fs.readFile)
			const samples: number[] = []
			reads.mockClear()
			for (const query of queries) {
				const started = performance.now()
				const result = await store.search(query)
				samples.push(performance.now() - started)
				expect(result).toHaveLength(query === "missing ticket" ? 0 : query === "PRO-500" ? 1 : 50)
			}
			console.info(
				JSON.stringify({
					tickets: 1000,
					queries,
					elapsedMs: samples.map((sample) => Number(sample.toFixed(1))),
					markdownReads: reads.mock.calls.filter(([file]) => String(file).endsWith(".md")).length,
				}),
			)
			expect(reads.mock.calls.filter(([file]) => String(file).endsWith(".md"))).toHaveLength(1000)
		},
		120000,
	)
})
