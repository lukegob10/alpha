import { describe, expect, it } from "vitest"
import {
	ticketExportInputSchema,
	ticketImportPreviewSchema,
	ticketOverviewSchema,
	ticketRequestSchema,
} from "../ticket.js"

const id = "a97392fe-59bf-4f80-8a10-51b2cb62a38f"
const request = (operation: unknown) => ({ type: "ticketRequest", requestId: "1", project: "project", operation })

describe("ticket transfer wire contracts", () => {
	it("accepts bounded bulk selection and filtered export with descendant defaults", () => {
		expect(ticketExportInputSchema.parse({ ids: [id] })).toEqual({ ids: [id], includeDescendants: true })
		expect(ticketExportInputSchema.parse({ filter: { query: "sharing" } })).toMatchObject({
			filter: { query: "sharing", offset: 0, limit: 50 },
		})
		expect(ticketExportInputSchema.safeParse({ ids: [id], filter: {} }).success).toBe(false)
		expect(ticketExportInputSchema.safeParse({ ids: [] }).success).toBe(false)
		expect(ticketExportInputSchema.safeParse({ ids: Array(1001).fill(id) }).success).toBe(false)
	})
	it("requires a host-issued preview token and explicit import choices", () => {
		expect(ticketRequestSchema.safeParse(request({ action: "previewImport" })).success).toBe(true)
		expect(
			ticketRequestSchema.safeParse(request({ action: "import", token: id, mode: "copy", resetStatus: true }))
				.success,
		).toBe(true)
		for (const operation of [
			{ action: "import", token: "../tickets", mode: "copy", resetStatus: true },
			{ action: "import", token: id, mode: "overwrite", resetStatus: false },
			{ action: "import", token: id, mode: "update" },
		])
			expect(ticketRequestSchema.safeParse(request(operation)).success).toBe(false)
	})
	it("bounds previews and field differences", () => {
		const preview = {
			kind: "importPreview",
			token: id,
			warnings: [],
			tickets: [
				{
					id,
					name: "Sharing",
					status: "backlog",
					disposition: "conflict",
					changes: [{ field: "name", before: "Before", after: "After" }],
				},
			],
		}
		expect(ticketImportPreviewSchema.safeParse(preview).success).toBe(true)
		expect(ticketImportPreviewSchema.safeParse({ ...preview, tickets: [] }).success).toBe(false)
		expect(
			ticketImportPreviewSchema.safeParse({
				...preview,
				tickets: [
					{ ...preview.tickets[0], changes: [{ field: "name", before: "x".repeat(2001), after: "After" }] },
				],
			}).success,
		).toBe(false)
	})
	it("rejects inconsistent counts, invented dates, and unordered observations", () => {
		const overview = {
			total: 3,
			complete: 1,
			inProgress: 1,
			backlog: 1,
			canceled: 2,
			invalidFiles: [],
			points: [{ date: "2026-10-31", total: 3, complete: 1 }],
		}
		expect(ticketOverviewSchema.safeParse(overview).success).toBe(true)
		expect(ticketOverviewSchema.safeParse({ ...overview, total: 4 }).success).toBe(false)
		for (const points of [
			[{ date: "2026-02-30", total: 3, complete: 1 }],
			[{ date: "2026-10-31", total: 3, complete: 4 }],
			[...overview.points, ...overview.points],
			[...overview.points, { date: "2026-10-30", total: 3, complete: 1 }],
		])
			expect(ticketOverviewSchema.safeParse({ ...overview, points }).success).toBe(false)
	})
})
