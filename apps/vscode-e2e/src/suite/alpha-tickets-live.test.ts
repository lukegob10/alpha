import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"
import { ticketSchema, type Ticket, type TicketList } from "@alpha-code/types"

import { record, runLiveCase } from "./live-file-tool-support"
import { assertOwnedTestRoot } from "../testProfile"

interface TicketStoreReader {
	workspace: string
	directory: string
	list(input?: { limit?: number }): Promise<TicketList>
	read(id: string): Promise<Ticket>
}

interface TicketPanel {
	projects: Map<string, TicketStoreReader>
	panel?: vscode.WebviewPanel
	open(): Promise<void>
	receive(message: { type: "ticketsReady" }): Promise<void>
}

suite("Live Copilot Alpha Tickets", function () {
	this.timeout(230_000)

	suiteSetup(function () {
		if (process.env.ALPHA_E2E_PROVIDER_MODE !== "live-copilot") this.skip()
		const expectedVersion = process.env.ALPHA_E2E_EXPECTED_VSCODE_VERSION
		if (expectedVersion) assert.equal(vscode.version, expectedVersion)
	})

	test("uses the eager list_tickets tool and persists its result", async () => {
		await runLiveCase(
			"alpha-tickets-live",
			["list_tickets"],
			{},
			"Call list_tickets exactly once with status in-progress. Report the returned total and finish.",
			async (calls, _messages, _workspace, answer) => {
				const lists = calls.filter((call) => call.name === "list_tickets")
				assert.equal(lists.length, 1, "The real model must use the Alpha Tickets tool once")
				assert.equal(lists[0]!.input.status, "in-progress")
				assert.equal(lists[0]!.isError, false)
				const output = record(JSON.parse(lists[0]!.result))
				assert.equal(output.status, "success")
				const result = record(output.result)
				assert.ok(Array.isArray(result.tickets))
				assert.equal(typeof result.total, "number")
				assert.match(answer, new RegExp(String(result.total)))
			},
			{
				requestLimit: 6,
				scope: "Use Alpha Tickets only. Do not inspect files, execute commands, create or edit Tickets, or delegate.",
			},
		)
	})

	test("creates 15 persisted tickets with a natural request for mixed statuses", async function () {
		this.timeout(340_000)
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		const isolatedHome = process.env.ALPHA_E2E_USER_HOME
		assert.ok(workspace)
		assert.ok(isolatedHome, "Ticket mutations require a launcher-owned isolated user home")
		await assertOwnedTestRoot(workspace)
		assert.equal(await fs.realpath(os.homedir()), await fs.realpath(isolatedHome))
		assert.equal(path.relative(workspace, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ""), "")
		const internals = globalThis.api as unknown as { context: { subscriptions: unknown[] } }
		const panel = internals.context.subscriptions.find((entry): entry is TicketPanel => {
			if (!entry || typeof entry !== "object") return false
			const candidate = entry as Partial<TicketPanel>
			return (
				candidate.projects instanceof Map &&
				typeof candidate.open === "function" &&
				typeof candidate.receive === "function"
			)
		})
		assert.ok(panel, "The activated Ticket panel must expose its production project store")
		try {
			await panel.open()
			await panel.receive({ type: "ticketsReady" })
			const store = [...panel.projects.values()].find(
				(candidate) => path.relative(workspace, candidate.workspace) === "",
			)
			assert.ok(store)
			assert.equal(
				path.dirname(path.resolve(store.directory)),
				path.join(await fs.realpath(isolatedHome), ".alpha", "tickets"),
				"The native Ticket engine must write only to the isolated home",
			)
			const before = await store.list({ limit: 100 })
			assert.equal(before.total, 0, "This live fixture must start without existing tickets")
			assert.deepEqual(before.invalidFiles, [])
			const beforeIds = new Set(before.tickets.map(({ id }) => id))
			await runLiveCase(
				"alpha-tickets-create-live",
				[
					"list_tickets",
					"read_ticket",
					"create_ticket",
					"update_ticket",
					"delete_ticket",
					"delete_tickets",
					"update_plan",
				],
				{},
				"Create 15 Alpha Tickets so I can test something. Make a mix of complete, backlog, and in-progress tickets across dates. The information does not matter and does not have to be related to this project. A mix of ticket types is good.",
				async () => {
					// Read through the native engine rather than trusting tool receipts or the assistant's summary.
					const after = await store.list({ limit: 100 })
					const created = after.tickets.filter(({ id }) => !beforeIds.has(id))
					const persisted: Ticket[] = []
					for (const { id } of created) persisted.push(ticketSchema.parse(await store.read(id)))
					await fs.writeFile(
						path.join(process.env.ALPHA_E2E_ARTIFACTS_DIR!, "alpha-tickets-create-live.persisted.json"),
						JSON.stringify(
							{
								schemaVersion: 1,
								beforeIds: [...beforeIds],
								total: after.total,
								invalidFiles: after.invalidFiles,
								tickets: persisted.map(
									({ id, reference, status, revision, createdAt, updatedAt, completedAt }) => ({
										id,
										reference,
										status,
										revision,
										createdAt,
										updatedAt,
										completedAt,
									}),
								),
							},
							null,
							2,
						),
						{ flag: "wx" },
					)
					assert.deepEqual(after.invalidFiles, [], "All created ticket files must remain readable")
					assert.equal(after.total - before.total, 15)
					assert.equal(
						new Set(persisted.map(({ id }) => id)).size,
						15,
						"Persist 15 new native Ticket identities",
					)
					for (const status of ["backlog", "in-progress", "complete"] as const)
						assert.ok(
							persisted.some((ticket) => ticket.status === status),
							`Persist at least one ${status} ticket`,
						)
				},
				{ scope: "", requestLimit: 40, timeoutMs: 300_000 },
			)
		} finally {
			panel.panel?.dispose()
		}
	})
})
