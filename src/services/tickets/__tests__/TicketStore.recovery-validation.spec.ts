import fs from "fs/promises"
import os from "os"
import path from "path"

import { TicketStore } from "../TicketStore"

describe("TicketStore recovery input validation", () => {
	let home: string
	let store: TicketStore

	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ticket-recovery-"))
		const workspace = path.join(home, "project")
		await fs.mkdir(workspace)
		store = await TicketStore.forWorkspace(workspace, home)
	})

	afterEach(async () => {
		await fs.rm(home, { recursive: true, force: true })
	})

	it("rejects oversized recovery content before replacing the readable source", async () => {
		const ticket = await store.create({ name: "Preserve source" })
		const source = await store.markdownPath(ticket.id)
		const original = await fs.readFile(source, "utf8")
		const journal = path.join(store.directory, ".move.json")
		const text = `${original}\n## Imported notes\n${"🙂".repeat(25000)}`
		expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(100000)
		await fs.writeFile(
			journal,
			JSON.stringify({
				id: ticket.id,
				from: ticket.status,
				to: "in-progress",
				revision: ticket.revision,
				text,
			}),
		)

		await expect(store.recoverPendingMoves()).rejects.toThrow("Ticket exceeds 100 KB")
		expect(await fs.readFile(source, "utf8")).toBe(original)
		await expect(fs.stat(path.join(store.directory, "in-progress", `${ticket.id}.md`))).rejects.toMatchObject({
			code: "ENOENT",
		})
		expect(await fs.readFile(journal, "utf8")).toContain("Imported notes")
	})
})
