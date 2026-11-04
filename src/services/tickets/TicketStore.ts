import * as fs from "fs/promises"
import { watch, type FSWatcher } from "node:fs"
import path from "path"
import os from "os"
import { createHash, randomUUID } from "crypto"
import { parseDocument, stringify } from "yaml"
import { z } from "zod"
import {
	createTicketSchema,
	deleteTicketSchema,
	deleteTicketsSchema,
	updateTicketSchema,
	listTicketsSchema,
	ticketExportInputSchema,
	ticketSchema,
	ticketStatusSchema,
	ticketStatusOrder,
	ticketIdSchema,
	ticketLocatorSchema,
	normalizeTicketReference,
	normalizeTicketNumberQuery,
	type CreateTicket,
	type DeleteTicket,
	type DeleteTickets,
	type UpdateTicket,
	type Ticket,
	type TicketList,
	type TicketRelations,
	type TicketSummary,
	type TicketStatus,
	type TicketSearchResponse,
	type TicketOverview,
	type TicketExportInput,
	type TicketTransferEntry,
	type TicketImportPreviewItem,
} from "@alpha-code/types"
import { atomicWriteText, withFileLock } from "../../core/task-persistence/atomicWrite"
import { observeTicketProgress, ticketProgressHistorySchema, type TicketProgressHistory } from "./TicketProgress"

const headings = {
	description: "Description",
	context: "Context",
	successCriteria: "Success criteria",
	implementationSummary: "Implementation summary",
} as const
const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const revisionOf = (status: TicketStatus, text: string) => digest(`${status}\0${text}`)
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
const checkCancelled = (signal?: AbortSignal) => signal?.throwIfAborted()
export type TicketReadResult = { ticket: Ticket } | { error: unknown }
export type TicketImportPlan = {
	projectId: string
	entries: TicketTransferEntry[]
	expectedRevisions: Record<string, string | undefined>
	preview: { tickets: TicketImportPreviewItem[]; warnings: string[] }
}
const maxTransferTickets = 1000
const maxTransferBytes = 16 * 1024 * 1024
const transferEntrySchema = z
	.object({ path: z.string().min(1).max(300), markdown: z.string().max(100000), status: ticketStatusSchema })
	.strict()
const importJournalSchema = z
	.object({
		version: z.literal(1),
		operations: z
			.array(
				z
					.object({
						id: ticketIdSchema,
						status: ticketStatusSchema,
						fromStatus: ticketStatusSchema.optional(),
						expectedRevision: z
							.string()
							.regex(/^[a-f0-9]{64}$/)
							.optional(),
						text: z.string().max(100000),
					})
					.strict()
					.refine((operation) => !!operation.fromStatus === !!operation.expectedRevision),
			)
			.min(1)
			.max(maxTransferTickets),
	})
	.strict()
type ImportOperation = z.infer<typeof importJournalSchema>["operations"][number]
const deleteJournalSchema = z
	.object({
		version: z.literal(1),
		tickets: z
			.array(
				z
					.object({
						id: ticketIdSchema,
						status: ticketStatusSchema,
						revision: z.string().regex(/^[a-f0-9]{64}$/),
					})
					.strict(),
			)
			.min(1)
			.max(1000)
			.refine((tickets) => new Set(tickets.map((ticket) => ticket.id.toLowerCase())).size === tickets.length),
	})
	.strict()
type TicketChildCounts = { childCount: number; completedChildCount: number }
function countChildren(tickets: Ticket[]): Map<string, TicketChildCounts> {
	const counts = new Map<string, TicketChildCounts>()
	for (const ticket of tickets) {
		if (!ticket.parentId) continue
		const childCounts = counts.get(ticket.parentId) ?? { childCount: 0, completedChildCount: 0 }
		childCounts.childCount++
		if (ticket.status === "complete") childCounts.completedChildCount++
		counts.set(ticket.parentId, childCounts)
	}
	return counts
}
function compareTickets(
	a: Pick<Ticket, "id" | "status" | "updatedAt">,
	b: Pick<Ticket, "id" | "status" | "updatedAt">,
): number {
	return (
		ticketStatusOrder.indexOf(a.status) - ticketStatusOrder.indexOf(b.status) ||
		b.updatedAt.localeCompare(a.updatedAt) ||
		a.id.localeCompare(b.id)
	)
}
const normalizeSearchText = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")
type TicketSearchEntry = {
	signature: string
	ticket: TicketSearchResponse["tickets"][number]
	name: string
	text: string
	bytes: number
}
type TicketSearchCache = {
	files: Map<string, TicketSearchEntry>
	metadata?: Map<string, string>
	checking?: Promise<void>
	changed: Set<string>
	directories?: string
	bytes: number
	generation: number
	refreshing?: Promise<TicketSearchEntry[]>
	entries?: TicketSearchEntry[]
	watcher?: FSWatcher
	identity?: string
}
const maxSearchProjects = 4
const maxSearchFiles = 10000
const maxSearchBytes = 16 * 1024 * 1024
const searchConcurrency = 16
function summarizeTicket(ticket: Ticket, childCounts: Map<string, TicketChildCounts>): TicketSummary {
	return {
		id: ticket.id,
		reference: ticket.reference,
		parentId: ticket.parentId,
		name: ticket.name,
		status: ticket.status,
		type: ticket.type,
		...(ticket.priority !== undefined ? { priority: ticket.priority } : {}),
		updatedAt: ticket.updatedAt,
		revision: ticket.revision,
		...(childCounts.get(ticket.id) ?? { childCount: 0, completedChildCount: 0 }),
	}
}
const sequenceSchema = z
	.object({
		version: z.literal(1),
		prefix: z.string().regex(/^[A-Z]{2,4}$/),
		nextNumber: z.number().int().min(1).max(9999999999),
	})
	.strict()

function projectPrefix(workspace: string): string {
	const words = path
		.basename(workspace)
		.replace(/([a-z])([A-Z])/g, "$1-$2")
		.split(/[^a-zA-Z0-9]+/)
		.filter((word) => /[a-z]/i.test(word) && !/^v?\d+$/i.test(word))
	const prefix =
		words.length > 1
			? words
					.slice(0, 3)
					.map((word) => word[0])
					.join("")
			: words[0]?.slice(0, 3)
	return prefix && /^[a-z]{2,4}$/i.test(prefix) ? prefix.toUpperCase() : "AT"
}

function sections(body: string) {
	const starts: { title: string; start: number; content: number }[] = []
	let fence: string | undefined
	for (const match of body.matchAll(/^.*(?:\r?\n|$)/gm)) {
		const line = match[0].trimEnd()
		const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
		if (marker) {
			if (!fence) fence = marker
			else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
			continue
		}
		if (!fence && line.startsWith("## "))
			starts.push({ title: line.slice(3), start: match.index!, content: match.index! + match[0].length })
	}
	return starts.map((section, index) => ({ ...section, end: starts[index + 1]?.start ?? body.length }))
}

/** Markdown is authoritative. Every cooperating writer holds the project transaction lock. */
export class TicketStore {
	private static readonly preparing = new Map<string, Promise<void>>()
	private static readonly searches = new Map<string, TicketSearchCache>()
	static disposeSearchCaches(): void {
		for (const cache of TicketStore.searches.values()) {
			cache.watcher?.close()
			cache.watcher = undefined
			cache.entries = undefined
			cache.generation++
		}
		TicketStore.searches.clear()
	}
	private constructor(
		readonly directory: string,
		readonly projectId: string,
		readonly workspace: string,
	) {}

	static async forWorkspace(workspace: string, home = os.homedir(), signal?: AbortSignal): Promise<TicketStore> {
		checkCancelled(signal)
		const canonical = await fs.realpath(workspace)
		checkCancelled(signal)
		const key = process.platform === "win32" ? canonical.toLowerCase() : canonical
		const name =
			path
				.basename(canonical)
				.replace(/[^a-zA-Z0-9_-]/g, "-")
				.slice(0, 80) || "project"
		const id = `${name}-${digest(key).slice(0, 12)}`
		const store = new TicketStore(path.join(await fs.realpath(home), ".alpha", "tickets", id), id, canonical)
		checkCancelled(signal)
		// Join editor-owned migration if it is in flight; opening a store never starts a write.
		const preparation = TicketStore.preparing.get(store.directory)
		if (preparation) await TicketStore.joinPending(preparation, signal)
		checkCancelled(signal)
		return store
	}

	private static async joinPending<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
		if (!signal) return pending
		checkCancelled(signal)
		return new Promise<T>((resolve, reject) => {
			const detach = () => signal.removeEventListener("abort", cancel)
			const cancel = () => {
				detach()
				reject(signal.reason)
			}
			signal.addEventListener("abort", cancel, { once: true })
			if (signal.aborted) cancel()
			// Cancel this reader without interrupting work shared with other readers.
			pending.then(
				(value) => {
					detach()
					resolve(value)
				},
				(error) => {
					detach()
					reject(error)
				},
			)
		})
	}

	static async initializeWorkspace(workspace: string, signal?: AbortSignal): Promise<void> {
		const store = await TicketStore.forWorkspace(workspace, undefined, signal)
		const preparation = store.prepareReferences(signal)
		TicketStore.preparing.set(store.directory, preparation)
		try {
			await preparation
		} finally {
			if (TicketStore.preparing.get(store.directory) === preparation)
				TicketStore.preparing.delete(store.directory)
		}
	}

	private async safe(file: string): Promise<void> {
		const relative = path.relative(this.directory, file)
		if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Invalid ticket path")
		// Check every ancestor, including .alpha, before creating or opening files.
		let current = path.resolve(file)
		while (current !== path.dirname(current)) {
			try {
				if ((await fs.lstat(current)).isSymbolicLink())
					throw new Error("Ticket paths cannot contain symbolic links")
			} catch (error) {
				if (!missing(error)) throw error
			}
			current = path.dirname(current)
		}
	}

	private async transaction<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		await this.safe(this.directory)
		checkCancelled(signal)
		await fs.mkdir(this.directory, { recursive: true })
		return withFileLock(path.join(this.directory, ".transaction"), async () => {
			checkCancelled(signal)
			// A search begun after a mutation must not join its earlier inspection.
			const invalidateRefresh = () => {
				const directory = process.platform === "win32" ? this.directory.toLowerCase() : this.directory
				const cache = TicketStore.searches.get(directory)
				if (cache) {
					cache.generation++
					cache.refreshing = undefined
					cache.entries = undefined
				}
			}
			invalidateRefresh()
			try {
				await this.recover()
				return await run()
			} finally {
				invalidateRefresh()
			}
		})
	}

	/** Inspection never creates profile files or commits an interrupted mutation. */
	private async inspect<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		await this.safe(this.directory)
		checkCancelled(signal)
		const checkPending = async () => {
			for (const [journal, operation] of [
				[".move.json", "move"],
				[".import.json", "import"],
				[".delete.json", "delete"],
			] as const) {
				try {
					await fs.lstat(path.join(this.directory, journal))
				} catch (error) {
					if (missing(error)) continue
					throw error
				}
				throw new Error(`Ticket ${operation} pending; open the ticket editor to recover it before reading`)
			}
		}
		await checkPending()
		const result = await run()
		checkCancelled(signal)
		await checkPending()
		return result
	}

	async recoverPendingMoves(): Promise<void> {
		await this.safe(this.directory)
		try {
			await fs.stat(this.directory)
		} catch (error) {
			if (missing(error)) return
			throw error
		}
		await this.transaction(async () => undefined)
	}

	/** Explicit storage migration, called by the editor lifecycle, never by inspection tools. */
	async prepareReferences(signal?: AbortSignal): Promise<void> {
		await this.safe(this.directory)
		try {
			await fs.stat(this.directory)
		} catch (error) {
			if (missing(error)) return
			throw error
		}
		await this.transaction(async () => {
			const { tickets } = await this.scan(signal)
			if (!tickets.length) return
			const sequence = await this.sequence(tickets)
			for (const ticket of tickets.sort(
				(a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
			)) {
				if (ticket.reference) continue
				checkCancelled(signal)
				const old = await this.locate(ticket.id)
				if (old.ticket.revision !== ticket.revision)
					throw new Error("Ticket changed during reference migration; reload")
				const reference = await this.reserveReference(sequence)
				const text = old.raw.replace(/^(---\r?\n)/, `$1reference: ${reference}\n`)
				if (Buffer.byteLength(text, "utf8") > 100000)
					throw new Error("Ticket exceeds 100 KB after adding its reference")
				if (revisionOf(ticket.status, await this.raw(old.file)) !== ticket.revision)
					throw new Error("Ticket changed during reference migration; reload")
				checkCancelled(signal)
				await atomicWriteText(old.file, text, { requireAtomicReplace: true })
			}
		}, signal)
	}

	private async sequence(tickets: Ticket[]): Promise<z.infer<typeof sequenceSchema>> {
		const file = path.join(this.directory, ".sequence.json")
		let sequence = { version: 1 as const, prefix: projectPrefix(this.workspace), nextNumber: 1 }
		try {
			sequence = sequenceSchema.parse(JSON.parse(await this.raw(file)))
		} catch (error) {
			if (!missing(error)) throw error
		}
		const references = new Set<string>()
		const ids = new Set<string>()
		for (const ticket of tickets) {
			if (ids.has(ticket.id)) throw new Error("Duplicate ticket ID; repair Markdown files")
			ids.add(ticket.id)
			if (!ticket.reference) continue
			const reference = normalizeTicketReference(ticket.reference)!
			if (references.has(reference)) throw new Error("Duplicate ticket reference; repair Markdown files")
			references.add(reference)
			const [prefix, number] = reference.split("-")
			if (prefix !== sequence.prefix) throw new Error("Ticket reference does not match the project prefix")
			sequence.nextNumber = Math.max(sequence.nextNumber, Number(number) + 1)
		}
		return sequenceSchema.parse(sequence)
	}

	private async reserveReference(sequence: z.infer<typeof sequenceSchema>): Promise<string> {
		const reference = `${sequence.prefix}-${String(sequence.nextNumber).padStart(2, "0")}`
		sequence.nextNumber++
		const file = path.join(this.directory, ".sequence.json")
		await this.safe(file)
		// Reserve before writing Markdown: interrupted writes leave gaps, never reused numbers.
		await atomicWriteText(file, JSON.stringify(sequenceSchema.parse(sequence)), { requireAtomicReplace: true })
		return reference
	}

	private file(id: string, status: TicketStatus): string {
		const parsed = ticketSchema.shape.id.parse(id)
		return path.join(this.directory, ticketStatusSchema.parse(status), `${parsed}.md`)
	}

	private async raw(file: string): Promise<string> {
		await this.safe(file)
		if ((await fs.stat(file)).size > 100000) throw new Error("Ticket exceeds 100 KB")
		return fs.readFile(file, "utf8")
	}

	private parse(
		raw: string,
		status: TicketStatus,
	): { ticket: Ticket; metadata: Record<string, unknown>; body: string } {
		const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
		if (!match) throw new Error("Ticket requires YAML frontmatter")
		const document = parseDocument(match[1], { uniqueKeys: true })
		if (document.errors.length) throw new Error("Invalid ticket metadata")
		const metadata: Record<string, unknown> = document.toJS({ maxAliasCount: 0 })
		const body = match[2]
		const ranges = sections(body)
		const fields = Object.fromEntries(
			Object.entries(headings).map(([key, title]) => {
				const matches = ranges.filter((range) => range.title === title)
				if (matches.length > 1) throw new Error("Duplicate ticket section")
				const section = matches[0]
				return [key, section ? body.slice(section.content, section.end).trimEnd() : ""]
			}),
		)
		const ticket = ticketSchema.parse({ ...metadata, ...fields, status, revision: revisionOf(status, raw) })
		return { ticket, metadata, body }
	}

	private serialize(ticket: Ticket, metadata: Record<string, unknown> = {}, body = ""): string {
		for (const [key, title] of Object.entries(headings)) {
			const content = ticket[key as keyof typeof headings]
			const section = sections(body).find((range) => range.title === title)
			const replacement = `## ${title}\n${content}\n\n`
			body = section
				? body.slice(0, section.start) + replacement + body.slice(section.end)
				: `${body}${replacement}`
		}
		const {
			revision: _revision,
			status: _status,
			description: _description,
			context: _context,
			successCriteria: _criteria,
			implementationSummary: _summary,
			...meta
		} = ticket
		const merged: Record<string, unknown> = { ...metadata, ...meta }
		delete merged.completedAt
		delete merged.parentId
		delete merged.status
		delete merged.revision
		if (ticket.completedAt) merged.completedAt = ticket.completedAt
		if (ticket.parentId) merged.parentId = ticket.parentId
		const text = `---\n${stringify(merged)}---\n${body}`
		if (Buffer.byteLength(text, "utf8") > 100000) throw new Error("Ticket exceeds 100 KB")
		const parsed = this.parse(text, ticket.status).ticket
		for (const key of Object.keys(headings) as (keyof typeof headings)[]) {
			if (parsed[key] !== ticket[key].trimEnd())
				throw new Error("Use level-three headings inside ticket sections; level-two headings separate sections")
		}
		return text
	}

	private async locate(id: string) {
		const found: { file: string; raw: string; ticket: Ticket; metadata: Record<string, unknown>; body: string }[] =
			[]
		for (const status of ticketStatusSchema.options) {
			const file = this.file(id, status)
			try {
				const raw = await this.raw(file)
				const parsed = this.parse(raw, status)
				if (parsed.ticket.id !== id) throw new Error("Ticket ID does not match filename")
				found.push({ file, raw, ...parsed })
			} catch (error) {
				if (!missing(error)) throw error
			}
		}
		if (found.length !== 1)
			throw new Error(found.length ? "Duplicate ticket ID; repair Markdown files" : "Ticket not found")
		return found[0]
	}

	async read(id: string, signal?: AbortSignal): Promise<Ticket> {
		const [result] = await this.readMany([id], signal)
		if ("error" in result) throw result.error
		return result.ticket
	}
	/** Resolve one attachment batch without rescanning the project for every reference. */
	async readMany(locators: readonly string[], signal?: AbortSignal): Promise<TicketReadResult[]> {
		return this.inspect(async () => {
			let referenceTickets: Promise<Ticket[]> | undefined
			const results: TicketReadResult[] = []
			for (const locator of locators) {
				checkCancelled(signal)
				try {
					const normalizedLocator = ticketLocatorSchema.parse(locator)
					const id = await this.resolveId(
						normalizedLocator,
						signal,
						() => (referenceTickets ??= this.scan(signal).then(({ tickets }) => tickets)),
					)
					// The reference scan is only an index for this batch. Re-read the
					// selected UUID so fresh content and duplicate-ID checks stay authoritative.
					const ticket = (await this.locate(id)).ticket
					const expectedReference = ticketIdSchema.safeParse(normalizedLocator).success
						? undefined
						: normalizeTicketReference(normalizedLocator)
					if (expectedReference && normalizeTicketReference(ticket.reference ?? "") !== expectedReference)
						throw new Error("Ticket reference changed during attachment loading; reload")
					results.push({ ticket })
				} catch (error) {
					checkCancelled(signal)
					results.push({ error })
				}
			}
			return results
		}, signal)
	}
	async relations(id: string, signal?: AbortSignal): Promise<TicketRelations> {
		const ticketId = ticketIdSchema.parse(id)
		return this.inspect(async () => {
			const { tickets } = await this.scan(signal)
			const ticket = tickets.find((item) => item.id === ticketId)
			if (!ticket) throw new Error("Ticket not found")
			const childCounts = countChildren(tickets)
			const parent = ticket.parentId ? tickets.find((item) => item.id === ticket.parentId) : undefined
			const children = tickets.filter((item) => item.parentId === ticketId).sort(compareTickets)
			return {
				...(parent ? { parent: summarizeTicket(parent, childCounts) } : {}),
				children: children.map((child) => summarizeTicket(child, childCounts)),
			}
		}, signal)
	}
	async markdownPath(id: string): Promise<string> {
		return this.inspect(async () => (await this.locate(id)).file)
	}

	private async scan(signal?: AbortSignal): Promise<{
		tickets: Ticket[]
		invalidFiles: string[]
		importedFrom: Map<string, string[]>
	}> {
		const tickets: Ticket[] = [],
			invalidFiles: string[] = []
		const importedFrom = new Map<string, string[]>()
		for (const status of ticketStatusSchema.options) {
			const directory = path.join(this.directory, status)
			await this.safe(directory)
			let names: string[]
			try {
				names = await fs.readdir(directory)
			} catch (error) {
				if (!missing(error)) throw error
				continue
			}
			for (const name of names.filter((name) => name.endsWith(".md"))) {
				checkCancelled(signal)
				try {
					const { ticket, metadata } = this.parse(await this.raw(path.join(directory, name)), status)
					if (`${ticket.id}.md` !== name) throw new Error("Invalid filename")
					tickets.push(ticket)
					const origin = ticketIdSchema.safeParse(metadata.importedFrom)
					if (origin.success) {
						const copies = importedFrom.get(origin.data) ?? []
						copies.push(ticket.id)
						importedFrom.set(origin.data, copies)
					}
				} catch {
					invalidFiles.push(`${status}/${name}`)
				}
			}
		}
		return { tickets, invalidFiles, importedFrom }
	}

	private async resolveId(
		value: string,
		signal?: AbortSignal,
		referenceTickets?: () => Promise<Ticket[]>,
	): Promise<string> {
		const locator = ticketLocatorSchema.parse(value)
		if (ticketIdSchema.safeParse(locator).success) return locator
		const reference = normalizeTicketReference(locator)
		const tickets = referenceTickets ? await referenceTickets() : (await this.scan(signal)).tickets
		const matches = tickets.filter(
			(ticket) => ticket.reference && normalizeTicketReference(ticket.reference) === reference,
		)
		if (matches.length > 1) throw new Error("Duplicate ticket reference; repair Markdown files")
		if (!matches.length) throw new Error("Alpha ticket not found in this project; use list_tickets to search")
		return matches[0].id
	}

	private validateParent(tickets: Ticket[], ticketId: string, parentId?: string): void {
		if (!parentId) return
		const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]))
		const visited = new Set<string>([ticketId])
		let current: string | undefined = parentId
		while (current) {
			if (visited.has(current)) throw new Error("A ticket cannot be its own parent or descendant")
			visited.add(current)
			const parent: Ticket | undefined = byId.get(current)
			if (!parent) throw new Error("Parent ticket not found in this project")
			current = parent.parentId
		}
	}

	async list(input: unknown = {}, signal?: AbortSignal): Promise<TicketList> {
		const filter = listTicketsSchema.parse(input)
		return this.inspect(async () => {
			const { tickets, invalidFiles } = await this.scan(signal)
			const childCounts = countChildren(tickets)
			const reference = filter.query && normalizeTicketReference(filter.query)
			const terms = filter.query?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
			const matches = tickets
				.filter(
					(ticket) =>
						(!filter.status || ticket.status === filter.status) &&
						(filter.type === undefined || (ticket.type ?? null) === filter.type) &&
						(reference
							? ticket.reference === reference
							: terms.every((term) =>
									`${ticket.reference ?? ""}\n${ticket.name}\n${ticket.description}\n${ticket.context}`
										.toLowerCase()
										.replace(/[^\p{L}\p{N}]/gu, "")
										.includes(term),
								)),
				)
				.sort(compareTickets)
			return {
				tickets: matches
					.slice(filter.offset, filter.offset + filter.limit)
					.map((ticket) => summarizeTicket(ticket, childCounts)),
				total: matches.length,
				invalidFiles: invalidFiles.slice(0, 100),
			}
		}, signal)
	}

	/** The editor explicitly records observations; ordinary reads remain side-effect free. */
	async overview(signal?: AbortSignal): Promise<TicketOverview> {
		return this.transaction(async () => {
			const file = path.join(this.directory, ".progress.json")
			await this.safe(file)
			let previous: string | undefined
			let history: TicketProgressHistory | undefined
			try {
				if ((await fs.stat(file)).size > 512000)
					throw new Error("Ticket progress history exceeds its size limit")
				previous = await fs.readFile(file, "utf8")
				history = ticketProgressHistorySchema.parse(JSON.parse(previous))
			} catch (error) {
				if (!missing(error)) throw new Error("Ticket progress history needs repair", { cause: error })
			}
			const { tickets, invalidFiles } = await this.scan(signal)
			this.uniqueTickets(tickets)
			const observation = observeTicketProgress(
				tickets,
				invalidFiles,
				history,
				new Date().toISOString().slice(0, 10),
			)
			const next = JSON.stringify(observation.history)
			checkCancelled(signal)
			if (next !== previous) await atomicWriteText(file, next, { requireAtomicReplace: true })
			return observation.overview
		}, signal)
	}

	async exportTickets(input: TicketExportInput, signal?: AbortSignal): Promise<TicketTransferEntry[]> {
		const options = ticketExportInputSchema.parse(input)
		return this.inspect(async () => {
			const { tickets, invalidFiles } = await this.scan(signal)
			if (invalidFiles.length) throw new Error("Repair invalid ticket Markdown files before exporting")
			const byId = this.uniqueTickets(tickets)
			let selected: Set<string>
			if (options.ids) {
				selected = new Set(options.ids)
				if ([...selected].some((id) => !byId.has(id)))
					throw new Error("An export ticket no longer exists; reload")
			} else if (options.filter) {
				const filter = options.filter
				const reference = filter.query && normalizeTicketReference(filter.query)
				const terms = filter.query?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
				selected = new Set(
					tickets
						.filter(
							(ticket) =>
								(!filter.status || ticket.status === filter.status) &&
								(filter.type === undefined || (ticket.type ?? null) === filter.type) &&
								(reference
									? ticket.reference === reference
									: terms.every((term) =>
											`${ticket.reference ?? ""}\n${ticket.name}\n${ticket.description}\n${ticket.context}`
												.toLowerCase()
												.replace(/[^\p{L}\p{N}]/gu, "")
												.includes(term),
										)),
						)
						.map((ticket) => ticket.id),
				)
			} else selected = new Set(byId.keys())
			if (options.includeDescendants) {
				const children = new Map<string, string[]>()
				for (const ticket of tickets) {
					if (!ticket.parentId) continue
					const list = children.get(ticket.parentId) ?? []
					list.push(ticket.id)
					children.set(ticket.parentId, list)
				}
				for (const id of selected) for (const child of children.get(id) ?? []) selected.add(child)
			}
			if (!selected.size) throw new Error("No tickets selected for export")
			if (selected.size > maxTransferTickets) throw new Error("Export at most 1000 tickets at a time")
			const entries: TicketTransferEntry[] = []
			for (const ticket of tickets.filter((ticket) => selected.has(ticket.id)).sort(compareTickets)) {
				checkCancelled(signal)
				const current = await this.locate(ticket.id)
				if (current.ticket.revision !== ticket.revision)
					throw new Error("Ticket changed during export; try again")
				const markdown = this.serialize(
					{ ...current.ticket, linkedTaskIds: [] },
					current.metadata,
					current.body,
				)
				// Status ordinarily lives in the containing folder. Also carry it in standalone exported Markdown.
				entries.push({
					path: `${ticket.status}/${ticket.id}.md`,
					status: ticket.status,
					markdown: markdown.replace(/^(---\r?\n)/, `$1status: ${ticket.status}\n`),
				})
			}
			this.validateTransferEntries(entries)
			return entries
		}, signal)
	}

	private uniqueTickets(tickets: Ticket[]): Map<string, Ticket> {
		const result = new Map<string, Ticket>()
		for (const ticket of tickets) {
			if (result.has(ticket.id)) throw new Error("Duplicate ticket ID; repair Markdown files")
			result.set(ticket.id, ticket)
		}
		return result
	}

	private validateTransferEntries(input: TicketTransferEntry[]): TicketTransferEntry[] {
		const entries = z.array(transferEntrySchema).min(1).max(maxTransferTickets).parse(input)
		let bytes = 0
		for (const entry of entries) {
			if (
				entry.path.includes("\\") ||
				entry.path.split("/").some((part) => !part || part === "." || part === "..") ||
				path.isAbsolute(entry.path) ||
				/^[a-z]:/i.test(entry.path) ||
				!entry.path.endsWith(".md")
			)
				throw new Error("Invalid imported Markdown path")
			const size = Buffer.byteLength(entry.markdown, "utf8")
			if (size > 100000) throw new Error("Ticket exceeds 100 KB")
			bytes += size
		}
		if (bytes > maxTransferBytes) throw new Error("Ticket transfer exceeds 16 MiB")
		return entries
	}

	private async parseTransferEntries(entries: TicketTransferEntry[], signal?: AbortSignal) {
		const parsed: (TicketTransferEntry & ReturnType<TicketStore["parse"]>)[] = []
		for (const entry of this.validateTransferEntries(entries)) {
			checkCancelled(signal)
			const source = this.parse(entry.markdown, entry.status)
			if (entry.path !== `${entry.status}/${source.ticket.id}.md`)
				throw new Error("Imported ticket identity does not match its path")
			parsed.push({ ...entry, ...source })
			// Large batches must give cancellation and extension-host events a chance between YAML parses.
			if (parsed.length % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
		}
		checkCancelled(signal)
		return parsed
	}

	private comparableTicket(ticket: Ticket, metadata: Record<string, unknown>, body: string): string {
		return (
			this.serialize(
				{
					...ticket,
					reference: undefined,
					createdAt: "2000-01-01T00:00:00.000Z",
					updatedAt: "2000-01-01T00:00:00.000Z",
					completedAt: undefined,
					linkedTaskIds: [],
				},
				metadata,
				body,
			).replace(/\r\n/g, "\n") + `\0${ticket.status}`
		)
	}

	async previewImport(entries: TicketTransferEntry[], signal?: AbortSignal): Promise<TicketImportPlan> {
		const incoming = await this.parseTransferEntries(entries, signal)
		const sources = incoming.map(({ path, markdown, status }) => ({ path, markdown, status }))
		return this.inspect(async () => {
			const { tickets, invalidFiles, importedFrom } = await this.scan(signal)
			if (invalidFiles.length) throw new Error("Repair invalid ticket Markdown files before importing")
			const local = this.uniqueTickets(tickets)
			const byId = this.uniqueTickets(incoming.map((source) => source.ticket))
			const candidateParents = incoming.map(({ ticket }) => ({
				...ticket,
				parentId: ticket.parentId && byId.has(ticket.parentId) ? ticket.parentId : undefined,
			}))
			for (const ticket of candidateParents) this.validateParent(candidateParents, ticket.id, ticket.parentId)
			const preview: TicketImportPlan["preview"] = { tickets: [], warnings: [] }
			const expectedRevisions: TicketImportPlan["expectedRevisions"] = {}
			for (const source of incoming) {
				checkCancelled(signal)
				const ticket = source.ticket
				const existing = local.get(ticket.id)
				expectedRevisions[ticket.id] = existing?.revision
				let disposition: TicketImportPreviewItem["disposition"] = "new"
				let changes: TicketImportPreviewItem["changes"]
				if (existing) {
					const current = await this.locate(existing.id)
					if (current.ticket.revision !== existing.revision)
						throw new Error("Ticket changed during preview; reload")
					disposition =
						this.comparableTicket(current.ticket, current.metadata, current.body) ===
						this.comparableTicket(ticket, source.metadata, source.body)
							? "duplicate"
							: "conflict"
					if (disposition === "conflict") {
						const excerpt = (value: unknown) => {
							const text = value === undefined || value === null ? "" : String(value)
							return text.length > 2000 ? `${text.slice(0, 1999)}…` : text
						}
						changes = (
							[
								"name",
								"type",
								"priority",
								"description",
								"context",
								"successCriteria",
								"implementationSummary",
								"status",
								"parentId",
							] as const
						)
							.filter((field) => (current.ticket[field] ?? "") !== (ticket[field] ?? ""))
							.map((field) => ({
								field,
								before: excerpt(current.ticket[field]),
								after: excerpt(ticket[field]),
							}))
						if (!changes.length)
							preview.warnings.push(
								`${ticket.reference ?? ticket.name}: additional Markdown metadata or notes differ from the local ticket.`,
							)
					}
				}
				if (!existing && importedFrom.has(ticket.id)) {
					preview.warnings.push(
						`${ticket.reference ?? ticket.name}: imported copies of this ticket already exist. Importing copies again creates additional tickets.`,
					)
				}
				preview.tickets.push({
					id: ticket.id,
					reference: ticket.reference,
					name: ticket.name,
					status: ticket.status,
					disposition,
					...(changes ? { changes } : {}),
				})
				if (ticket.parentId && !byId.has(ticket.parentId))
					preview.warnings.push(
						`${ticket.reference ?? ticket.name}: its parent is outside this import. Copies will be detached; updates keep the link only if the parent exists locally.`,
					)
			}
			if (preview.warnings.length > 1000)
				preview.warnings = [...preview.warnings.slice(0, 999), "Additional import warnings were omitted."]
			return { projectId: this.projectId, entries: sources, expectedRevisions, preview }
		}, signal)
	}

	async importTickets(
		plan: TicketImportPlan,
		options: { mode: "copy" | "update"; resetStatus: boolean },
		signal?: AbortSignal,
	): Promise<{ imported: number; skipped: number }> {
		if (plan.projectId !== this.projectId) throw new Error("Import preview belongs to another project")
		z.object({ mode: z.enum(["copy", "update"]), resetStatus: z.boolean() })
			.strict()
			.parse(options)
		const sources = await this.parseTransferEntries(plan.entries, signal)
		this.uniqueTickets(sources.map((source) => source.ticket))
		return this.transaction(async () => {
			const { tickets, invalidFiles } = await this.scan(signal)
			if (invalidFiles.length) throw new Error("Repair invalid ticket Markdown files before importing")
			const local = this.uniqueTickets(tickets)
			for (const source of sources) {
				if (local.get(source.ticket.id)?.revision !== plan.expectedRevisions[source.ticket.id])
					throw new Error("Tickets changed since the import preview; preview again before importing")
			}
			const sequence = await this.sequence(tickets)
			const mappedIds = new Map(
				sources.map(({ ticket }) => [ticket.id, options.mode === "copy" ? randomUUID() : ticket.id]),
			)
			const now = new Date().toISOString()
			const operations: ImportOperation[] = []
			const changed: Ticket[] = []
			let skipped = 0
			for (const source of sources) {
				checkCancelled(signal)
				const existing = options.mode === "update" ? local.get(source.ticket.id) : undefined
				const old = existing && (await this.locate(existing.id))
				if (old && old.ticket.revision !== existing.revision)
					throw new Error("Ticket changed during import; preview again")
				const status = options.resetStatus ? "backlog" : source.ticket.status
				if (
					old &&
					status === old.ticket.status &&
					this.comparableTicket(old.ticket, old.metadata, old.body) ===
						this.comparableTicket(source.ticket, source.metadata, source.body)
				) {
					skipped++
					continue
				}
				const reference =
					existing?.reference ?? `${sequence.prefix}-${String(sequence.nextNumber++).padStart(2, "0")}`
				const parentId = source.ticket.parentId
					? (mappedIds.get(source.ticket.parentId) ??
						(options.mode === "update" && local.has(source.ticket.parentId)
							? source.ticket.parentId
							: undefined))
					: undefined
				const ticket: Ticket = {
					...source.ticket,
					id: mappedIds.get(source.ticket.id)!,
					reference,
					parentId,
					status,
					createdAt: existing?.createdAt ?? (options.mode === "copy" ? now : source.ticket.createdAt),
					updatedAt: now,
					completedAt:
						status === "complete"
							? (existing?.completedAt ??
								(options.mode === "copy" ? now : source.ticket.completedAt) ??
								now)
							: undefined,
					linkedTaskIds: existing?.linkedTaskIds ?? [],
					revision: "",
				}
				const metadata = { ...old?.metadata, ...source.metadata }
				if (options.mode === "copy") metadata.importedFrom = source.ticket.id
				else if (!ticketIdSchema.safeParse(metadata.importedFrom).success) delete metadata.importedFrom
				const text = this.serialize(ticket, metadata, source.body)
				operations.push({
					id: ticket.id,
					status: ticket.status,
					fromStatus: existing?.status,
					expectedRevision: existing?.revision,
					text,
				})
				changed.push(ticket)
			}
			if (!operations.length) return { imported: 0, skipped }
			const changedIds = new Set(changed.map((ticket) => ticket.id))
			const candidates = [...tickets.filter((ticket) => !changedIds.has(ticket.id)), ...changed]
			for (const ticket of changed) this.validateParent(candidates, ticket.id, ticket.parentId)
			const journal = path.join(this.directory, ".import.json")
			const sequenceFile = path.join(this.directory, ".sequence.json")
			await this.safe(journal)
			await this.safe(sequenceFile)
			const journalText = JSON.stringify(importJournalSchema.parse({ version: 1, operations }))
			if (
				operations.reduce((size, operation) => size + Buffer.byteLength(operation.text, "utf8"), 0) >
				maxTransferBytes
			)
				throw new Error("Ticket import exceeds 16 MiB")
			if (Buffer.byteLength(journalText, "utf8") > maxTransferBytes * 2)
				throw new Error("Serialized ticket import exceeds its size limit")
			checkCancelled(signal)
			// Reserve the complete batch before its durable intent. Failed commits leave gaps, never reused references.
			await atomicWriteText(sequenceFile, JSON.stringify(sequenceSchema.parse(sequence)), {
				requireAtomicReplace: true,
			})
			checkCancelled(signal)
			await atomicWriteText(journal, journalText, { requireAtomicReplace: true })
			// A durable batch is a commit barrier: finish or leave its recoverable intent, rather than cancelling half way.
			await this.recoverImport()
			return { imported: operations.length, skipped }
		}, signal)
	}

	/** Chat suggestions reuse parsed search records; selected attachments still read authoritative Markdown. */
	async search(query: string, signal?: AbortSignal): Promise<TicketSearchResponse["tickets"]> {
		listTicketsSchema.shape.query.parse(query)
		return this.inspect(async () => {
			const directory = process.platform === "win32" ? this.directory.toLowerCase() : this.directory
			const cache: TicketSearchCache = TicketStore.searches.get(directory) ?? {
				files: new Map(),
				changed: new Set(),
				bytes: 0,
				generation: 0,
			}
			TicketStore.searches.delete(directory)
			TicketStore.searches.set(directory, cache)
			if (TicketStore.searches.size > maxSearchProjects) {
				const oldest = TicketStore.searches.keys().next().value!
				TicketStore.searches.get(oldest)?.watcher?.close()
				const retired = TicketStore.searches.get(oldest)
				if (retired) {
					retired.watcher = undefined
					retired.generation++
				}
				TicketStore.searches.delete(oldest)
			}
			// Recheck scope on every lookup; only per-ticket inspection is shared between queries.
			for (const status of ticketStatusSchema.options) await this.safe(path.join(this.directory, status))
			await this.watchSearch(cache)
			await this.checkSearchDirectories(cache)
			let entries: TicketSearchEntry[]
			for (;;) {
				checkCancelled(signal)
				if (!cache.refreshing) await TicketStore.joinPending(this.checkSearchChanges(cache), signal)
				const generation = cache.generation
				if (!cache.entries && !cache.refreshing) {
					const refresh = this.refreshSearch(cache, generation)
					cache.refreshing = refresh
					const settled = () => {
						if (cache.refreshing === refresh) cache.refreshing = undefined
					}
					void refresh.then(settled, settled)
				}
				entries = cache.entries ?? (await TicketStore.joinPending(cache.refreshing!, signal))
				if (cache.generation === generation) break
			}
			checkCancelled(signal)
			const reference = normalizeTicketReference(query)
			const id = ticketIdSchema.safeParse(query.trim())
			const number = normalizeTicketNumberQuery(query)
			const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
			const compactQuery = normalizeSearchText(query)
			return entries
				.flatMap((entry) => {
					if (
						id.success
							? entry.ticket.id !== id.data
							: reference
								? entry.ticket.reference !== reference
								: number !== undefined
									? Number(entry.ticket.reference?.split("-")[1]) !== number
									: !terms.every((term) => entry.text.includes(term))
					)
						return []
					let rank = 3
					if (!compactQuery || entry.name === compactQuery) rank = 0
					else if (
						normalizeSearchText(entry.ticket.reference ?? "").startsWith(compactQuery) ||
						entry.name.startsWith(compactQuery)
					)
						rank = 1
					else if (terms.every((term) => entry.name.includes(term))) rank = 2
					return [{ ticket: entry.ticket, rank }]
				})
				.sort((a, b) => a.rank - b.rank || compareTickets(a.ticket, b.ticket))
				.slice(0, 50)
				.map(({ ticket }) => ({ ...ticket }))
		}, signal)
	}

	private async watchSearch(cache: TicketSearchCache): Promise<void> {
		try {
			const stat = await fs.lstat(this.directory, { bigint: true })
			const directory = process.platform === "win32" ? this.directory.toLowerCase() : this.directory
			if (TicketStore.searches.get(directory) !== cache) return
			const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
			if (cache.identity !== identity) {
				cache.watcher?.close()
				cache.watcher = undefined
				cache.entries = undefined
				cache.refreshing = undefined
				cache.files.clear()
				cache.metadata = undefined
				cache.changed.clear()
				cache.directories = undefined
				cache.bytes = 0
				cache.generation++
				cache.identity = identity
			}
			if (cache.watcher) return
			const watcher = watch(this.directory, { recursive: true, persistent: false }, (_event, filename) => {
				if (cache.watcher !== watcher) return
				if (!filename) {
					watcher.close()
					cache.watcher = undefined
					cache.generation++
					cache.entries = undefined
					cache.refreshing = undefined
					return
				}
				const relative = String(filename)
				const parts = relative.split(/[\\/]/)
				if (parts.length !== 2 || !ticketStatusSchema.safeParse(parts[0]).success || !parts[1].endsWith(".md"))
					return
				if (cache.changed.size < maxSearchFiles) cache.changed.add(path.join(this.directory, ...parts))
				else {
					watcher.close()
					cache.watcher = undefined
					cache.generation++
					cache.entries = undefined
					cache.refreshing = undefined
				}
			})
			cache.watcher = watcher
			watcher.on("error", () => {
				watcher.close()
				if (cache.watcher !== watcher) return
				cache.watcher = undefined
				cache.entries = undefined
				cache.refreshing = undefined
				cache.generation++
			})
		} catch {
			// Unsupported/missing watchers retain the original per-query inspection path.
			cache.watcher?.close()
			cache.watcher = undefined
			cache.entries = undefined
		}
	}

	private async checkSearchDirectories(cache: TicketSearchCache): Promise<void> {
		const signatures = await Promise.all(
			ticketStatusSchema.options.map(async (status) => {
				try {
					const stat = await fs.lstat(path.join(this.directory, status), { bigint: true })
					return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.mtimeNs}`
				} catch (error) {
					if (!missing(error)) throw error
					return "missing"
				}
			}),
		)
		const signature = signatures.join("/")
		if (cache.directories !== undefined && cache.directories !== signature) {
			cache.generation++
			cache.entries = undefined
			cache.refreshing = undefined
		}
		cache.directories = signature
	}

	private checkSearchChanges(cache: TicketSearchCache): Promise<void> {
		if (cache.checking) return cache.checking
		const generation = cache.generation
		const changed = [...cache.changed]
		cache.changed.clear()
		// Watchers also report reads/access changes. Only content or identity changes invalidate the index.
		const check = (async () => {
			for (let offset = 0; offset < changed.length; offset += searchConcurrency) {
				await Promise.all(
					changed.slice(offset, offset + searchConcurrency).map(async (file) => {
						let signature: string | undefined
						try {
							signature = this.searchSignature(await fs.lstat(file, { bigint: true }))
						} catch (error) {
							if (!missing(error)) signature = "unreadable"
						}
						if (cache.generation === generation && cache.metadata?.get(file) !== signature) {
							cache.generation++
							cache.entries = undefined
							cache.refreshing = undefined
						}
					}),
				)
			}
		})()
		cache.checking = check
		const settled = () => {
			if (cache.checking === check) cache.checking = undefined
		}
		void check.then(settled, settled)
		return check
	}

	private searchSignature(stat: import("node:fs").BigIntStats): string {
		return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mode}:${stat.mtimeNs}:${stat.ctimeNs}`
	}

	private async refreshSearch(cache: TicketSearchCache, generation: number): Promise<TicketSearchEntry[]> {
		if (cache.generation === generation) cache.metadata = undefined
		const metadata = new Map<string, string>()
		let metadataBytes = 0
		const files: { file: string; name: string; status: TicketStatus }[] = []
		for (const status of ticketStatusSchema.options) {
			const directory = path.join(this.directory, status)
			await this.safe(directory)
			try {
				for (const name of await fs.readdir(directory)) {
					if (name.endsWith(".md")) files.push({ file: path.join(directory, name), name, status })
				}
			} catch (error) {
				if (!missing(error)) throw error
			}
		}
		const present = new Set(files.map(({ file }) => file))
		for (const [file, entry] of cache.files) {
			if (cache.generation === generation && !present.has(file)) {
				cache.files.delete(file)
				cache.bytes -= entry.bytes
			}
		}
		const entries: TicketSearchEntry[] = []
		for (let offset = 0; offset < files.length; offset += searchConcurrency) {
			const batch = await Promise.all(
				files.slice(offset, offset + searchConcurrency).map(async ({ file, name, status }) => {
					try {
						// Revalidate every file, including symlinks, replacements, and edits that restore mtime.
						const stat = await fs.lstat(file, { bigint: true })
						const signature = this.searchSignature(stat)
						if (metadata.size < maxSearchFiles) {
							metadata.set(file, signature)
							metadataBytes += 64 + 2 * (file.length + signature.length)
						}
						if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100000n) {
							this.discardSearchEntry(cache, file, generation)
							return undefined
						}
						const cached = cache.files.get(file)
						if (cached?.signature === signature) return cached
						const ticket = this.parse(await this.raw(file), status).ticket
						if (`${ticket.id}.md` !== name) throw new Error("Invalid filename")
						const entry: TicketSearchEntry = {
							signature,
							ticket: {
								id: ticket.id,
								reference: ticket.reference,
								parentId: ticket.parentId,
								name: ticket.name,
								status: ticket.status,
								type: ticket.type,
								priority: ticket.priority,
								updatedAt: ticket.updatedAt,
							},
							name: normalizeSearchText(ticket.name),
							text: normalizeSearchText(`${ticket.reference ?? ""}\n${ticket.name}`),
							bytes: 256,
						}
						entry.bytes += 2 * (entry.name.length + entry.text.length + JSON.stringify(entry.ticket).length)
						if (cache.generation === generation) {
							const previous = cache.files.get(file)
							if (previous) {
								cache.files.delete(file)
								cache.bytes -= previous.bytes
							}
							if (cache.files.size < maxSearchFiles && cache.bytes + entry.bytes <= maxSearchBytes) {
								cache.files.set(file, entry)
								cache.bytes += entry.bytes
							}
						}
						return entry
					} catch {
						this.discardSearchEntry(cache, file, generation)
						return undefined
					}
				}),
			)
			for (const entry of batch) if (entry) entries.push(entry)
		}
		if (
			cache.generation === generation &&
			cache.watcher &&
			files.length <= maxSearchFiles &&
			cache.bytes + metadataBytes <= maxSearchBytes &&
			cache.files.size === entries.length
		) {
			cache.metadata = metadata
			await this.checkSearchChanges(cache)
			if (cache.generation !== generation) return entries
			cache.entries = entries
		}
		return entries
	}

	private discardSearchEntry(cache: TicketSearchCache, file: string, generation: number): void {
		if (cache.generation !== generation) return
		const entry = cache.files.get(file)
		if (!entry) return
		cache.files.delete(file)
		cache.bytes -= entry.bytes
	}

	async create(input: CreateTicket, signal?: AbortSignal): Promise<Ticket> {
		const fields = createTicketSchema.parse(input)
		return this.transaction(async () => {
			const { tickets } = await this.scan(signal)
			const sequence = await this.sequence(tickets)
			const now = new Date().toISOString()
			const ticket: Ticket = {
				schemaVersion: 1,
				id: randomUUID(),
				status: "backlog",
				createdAt: now,
				updatedAt: now,
				linkedTaskIds: [],
				revision: "",
				description: "",
				context: "",
				successCriteria: "",
				implementationSummary: "",
				...fields,
			}
			this.validateParent(tickets, ticket.id, ticket.parentId)
			ticket.reference = await this.reserveReference(sequence)
			const file = this.file(ticket.id, ticket.status)
			await this.safe(file)
			checkCancelled(signal)
			await atomicWriteText(file, this.serialize(ticket), { requireAtomicReplace: true })
			return (await this.locate(ticket.id)).ticket
		}, signal)
	}

	async update(input: UpdateTicket, signal?: AbortSignal, linkedTaskId?: string): Promise<Ticket> {
		const patch = updateTicketSchema.parse(input)
		return this.transaction(async () => {
			const old = await this.locate(await this.resolveId(patch.id, signal))
			if (old.ticket.revision !== patch.expectedRevision)
				throw new Error("Ticket changed; reload before saving. Your draft has not been saved.")
			const { expectedRevision: _expected, id: _id, parentId, ...fields } = patch
			const now = new Date().toISOString()
			const ticket = ticketSchema.parse({
				...old.ticket,
				...fields,
				parentId: parentId === null ? undefined : (parentId ?? old.ticket.parentId),
				updatedAt: now,
				linkedTaskIds: linkedTaskId
					? [...new Set([...old.ticket.linkedTaskIds, linkedTaskId])]
					: old.ticket.linkedTaskIds,
			})
			const { tickets } = await this.scan(signal)
			const sequence = await this.sequence(tickets)
			this.validateParent(tickets, ticket.id, ticket.parentId)
			if (!ticket.reference) ticket.reference = await this.reserveReference(sequence)
			ticket.completedAt = ticket.status === "complete" ? (old.ticket.completedAt ?? now) : undefined
			const target = this.file(ticket.id, ticket.status)
			await this.safe(target)
			const text = this.serialize(ticket, old.metadata, old.body)
			checkCancelled(signal)
			if (revisionOf(old.ticket.status, await this.raw(old.file)) !== patch.expectedRevision)
				throw new Error("Ticket changed; reload before saving")
			if (target === old.file) await atomicWriteText(target, text, { requireAtomicReplace: true })
			else {
				// A durable intent lets the next transaction finish a move after a crash.
				await atomicWriteText(
					path.join(this.directory, ".move.json"),
					JSON.stringify({
						id: ticket.id,
						from: old.ticket.status,
						to: ticket.status,
						revision: old.ticket.revision,
						text,
					}),
					{ requireAtomicReplace: true },
				)
				await this.recover()
			}
			return (await this.locate(ticket.id)).ticket
		}, signal)
	}

	async delete(input: DeleteTicket, signal?: AbortSignal): Promise<Ticket> {
		const request = deleteTicketSchema.parse(input)
		return this.transaction(async () => {
			const old = await this.locate(await this.resolveId(request.id, signal))
			if (old.ticket.revision !== request.expectedRevision)
				throw new Error("Ticket changed; reload before deleting. The ticket has not been deleted.")
			const { tickets } = await this.scan(signal)
			const sequence = await this.sequence(tickets)
			if (tickets.some((ticket) => ticket.parentId === old.ticket.id))
				throw new Error("Detach or delete child tickets before deleting their parent")
			const sequenceFile = path.join(this.directory, ".sequence.json")
			await this.safe(sequenceFile)
			checkCancelled(signal)
			// Preserve the high-water mark even when imported tickets had no sequence file.
			await atomicWriteText(sequenceFile, JSON.stringify(sequence), { requireAtomicReplace: true })
			const current = await this.locate(old.ticket.id)
			if (current.ticket.revision !== request.expectedRevision || current.file !== old.file)
				throw new Error("Ticket changed; reload before deleting. The ticket has not been deleted.")
			checkCancelled(signal)
			await fs.unlink(current.file)
			return current.ticket
		}, signal)
	}

	/** Explicit UUID/revision selection keeps a bulk request bounded to its reviewed snapshot. */
	async deleteMany(input: DeleteTickets, signal?: AbortSignal): Promise<Ticket[]> {
		const request = deleteTicketsSchema.parse(input)
		return this.transaction(async () => {
			const { tickets, invalidFiles } = await this.scan(signal)
			if (invalidFiles.length) throw new Error("Repair invalid ticket Markdown files before deleting tickets")
			const byId = this.uniqueTickets(tickets)
			const selected = new Set(request.tickets.map((ticket) => ticket.id))
			const originals = request.tickets.map(({ id, expectedRevision }) => {
				const ticket = byId.get(id)
				if (!ticket || ticket.revision !== expectedRevision)
					throw new Error("Tickets changed; list them again before deleting. No tickets have been deleted.")
				return ticket
			})
			this.assertDeleteClosure(tickets, selected)
			const ordered = this.orderDeletionTargets(originals)
			const sequence = await this.sequence(tickets)
			const journal = path.join(this.directory, ".delete.json")
			const sequenceFile = path.join(this.directory, ".sequence.json")
			await this.safe(journal)
			await this.safe(sequenceFile)
			const intent = deleteJournalSchema.parse({
				version: 1,
				tickets: ordered.map(({ id, status, revision }) => ({ id, status, revision })),
			})
			checkCancelled(signal)
			// Reserve the high-water mark once; cancellation can leave gaps but never reuse references.
			await atomicWriteText(sequenceFile, JSON.stringify(sequence), { requireAtomicReplace: true })
			checkCancelled(signal)
			await atomicWriteText(journal, JSON.stringify(intent), { requireAtomicReplace: true })
			// Once durable, finish the batch or retain a replayable intent; never report a partial success.
			await this.recoverDelete()
			return originals
		}, signal)
	}

	private assertDeleteClosure(tickets: Ticket[], selected: Set<string>): void {
		if (tickets.some((ticket) => ticket.parentId && selected.has(ticket.parentId) && !selected.has(ticket.id)))
			throw new Error("Detach or delete child tickets before deleting their parent")
	}

	private orderDeletionTargets(tickets: Ticket[]): Ticket[] {
		const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]))
		const depths = new Map<string, number>()
		for (const ticket of tickets) {
			const chain: string[] = []
			const visited = new Set<string>()
			let current: string | undefined = ticket.id
			while (current && byId.has(current) && !depths.has(current)) {
				if (visited.has(current)) throw new Error("Repair cyclic ticket parent links before deleting tickets")
				visited.add(current)
				chain.push(current)
				current = byId.get(current)?.parentId
			}
			let depth = current ? (depths.get(current) ?? -1) : -1
			for (let index = chain.length - 1; index >= 0; index--) depths.set(chain[index], ++depth)
		}
		return [...tickets].sort(
			(left, right) => depths.get(right.id)! - depths.get(left.id)! || left.id.localeCompare(right.id),
		)
	}

	private async recover(): Promise<void> {
		await this.recoverMove()
		await this.recoverImport()
		await this.recoverDelete()
	}

	private async recoverDelete(): Promise<void> {
		const journal = path.join(this.directory, ".delete.json")
		let raw: string
		try {
			await this.safe(journal)
			if ((await fs.stat(journal)).size > 256 * 1024)
				throw new Error("Ticket deletion journal exceeds its size limit")
			raw = await fs.readFile(journal, "utf8")
		} catch (error) {
			if (missing(error)) return
			throw error
		}
		const intent = deleteJournalSchema.parse(JSON.parse(raw))
		const selected = new Set(intent.tickets.map((ticket) => ticket.id))
		const expected = new Map(intent.tickets.map((ticket) => [ticket.id, ticket]))
		const { tickets, invalidFiles } = await this.scan()
		if (invalidFiles.length) throw new Error("Repair invalid ticket Markdown files before recovering a deletion")
		const byId = this.uniqueTickets(tickets)
		const remaining: Ticket[] = []
		for (const ticket of intent.tickets) {
			const current = byId.get(ticket.id)
			if (!current) continue // An earlier attempt may already have unlinked this exact record.
			if (current.status !== ticket.status || current.revision !== ticket.revision)
				throw new Error("Ticket deletion conflicts with an external edit; repair the deletion journal")
			remaining.push(current)
		}
		this.assertDeleteClosure(tickets, selected)
		// Preflight every target again before any unlink. One stale member must preserve the entire remaining batch.
		for (const ticket of remaining) {
			const current = (await this.locate(ticket.id)).ticket
			if (current.status !== ticket.status || current.revision !== ticket.revision)
				throw new Error("Ticket deletion conflicts with an external edit; repair the deletion journal")
		}
		let expectedFiles = new Set<string>()
		let unselectedVersions = new Map<string, string>()
		const removed = new Set<string>()
		const rememberContext = async (currentTickets: Ticket[]) => {
			expectedFiles = new Set(currentTickets.map((ticket) => path.join(ticket.status, `${ticket.id}.md`)))
			unselectedVersions = new Map()
			for (const ticket of currentTickets) {
				if (selected.has(ticket.id)) continue
				const file = this.file(ticket.id, ticket.status)
				await this.safe(file)
				unselectedVersions.set(file, this.searchSignature(await fs.lstat(file, { bigint: true })))
			}
		}
		await rememberContext(tickets)
		const checkContext = async () => {
			const currentFiles = new Set<string>()
			for (const status of ticketStatusSchema.options) {
				const directory = path.join(this.directory, status)
				await this.safe(directory)
				try {
					for (const name of await fs.readdir(directory))
						if (name.endsWith(".md")) currentFiles.add(path.join(status, name))
				} catch (error) {
					if (!missing(error)) throw error
				}
			}
			let changed =
				currentFiles.size !== expectedFiles.size || [...currentFiles].some((file) => !expectedFiles.has(file))
			if (!changed) {
				for (const [file, version] of unselectedVersions) {
					await this.safe(file)
					try {
						if (this.searchSignature(await fs.lstat(file, { bigint: true })) !== version) changed = true
					} catch (error) {
						if (!missing(error)) throw error
						changed = true
					}
					if (changed) break
				}
			}
			if (!changed) return
			const snapshot = await this.scan()
			if (snapshot.invalidFiles.length)
				throw new Error("Repair invalid ticket Markdown files before recovering a deletion")
			this.uniqueTickets(snapshot.tickets)
			for (const ticket of snapshot.tickets) {
				const original = expected.get(ticket.id)
				if (
					original &&
					(removed.has(ticket.id) ||
						ticket.status !== original.status ||
						ticket.revision !== original.revision)
				)
					throw new Error("Ticket deletion conflicts with an external edit; repair the deletion journal")
			}
			this.assertDeleteClosure(snapshot.tickets, selected)
			await rememberContext(snapshot.tickets)
		}
		for (const ticket of this.orderDeletionTargets(remaining)) {
			const current = await this.locate(ticket.id)
			const original = expected.get(ticket.id)!
			// Detect new children and reparented outside records without reparsing an unchanged project per ticket.
			await checkContext()
			if (
				current.ticket.status !== original.status ||
				revisionOf(original.status, await this.raw(current.file)) !== original.revision
			)
				throw new Error("Ticket deletion conflicts with an external edit; repair the deletion journal")
			await fs.unlink(current.file)
			removed.add(ticket.id)
			expectedFiles.delete(path.join(ticket.status, `${ticket.id}.md`))
		}
		const final = await this.scan()
		if (final.invalidFiles.length || final.tickets.some((ticket) => selected.has(ticket.id)))
			throw new Error("Ticket deletion conflicts with an external replacement; repair the deletion journal")
		this.assertDeleteClosure(final.tickets, selected)
		await fs.unlink(journal)
	}

	private async recoverImport(): Promise<void> {
		const journal = path.join(this.directory, ".import.json")
		let text: string
		try {
			await this.safe(journal)
			if ((await fs.stat(journal)).size > maxTransferBytes * 2)
				throw new Error("Ticket import journal exceeds its size limit")
			text = await fs.readFile(journal, "utf8")
		} catch (error) {
			if (missing(error)) return
			throw error
		}
		const intent = importJournalSchema.parse(JSON.parse(text))
		const ids = new Set<string>()
		let totalBytes = 0
		const incoming = intent.operations.map((operation) => {
			if (ids.has(operation.id)) throw new Error("Duplicate ticket ID in import journal")
			ids.add(operation.id)
			const bytes = Buffer.byteLength(operation.text, "utf8")
			if (bytes > 100000) throw new Error("Ticket exceeds 100 KB")
			totalBytes += bytes
			const ticket = this.parse(operation.text, operation.status).ticket
			if (ticket.id !== operation.id) throw new Error("Invalid ticket import ID")
			return ticket
		})
		if (totalBytes > maxTransferBytes) throw new Error("Ticket import exceeds 16 MiB")
		const readOptional = async (file: string): Promise<string | undefined> => {
			try {
				return await this.raw(file)
			} catch (error) {
				if (missing(error)) return undefined
				throw error
			}
		}
		const inspectOperation = async (operation: ImportOperation) => {
			const target = this.file(operation.id, operation.status)
			const source = operation.fromStatus ? this.file(operation.id, operation.fromStatus) : undefined
			await this.safe(target)
			const targetText = await readOptional(target)
			const sourceText = source === target ? targetText : source ? await readOptional(source) : undefined
			const targetMatches = targetText === operation.text
			const sourceMatches =
				sourceText !== undefined &&
				operation.fromStatus &&
				revisionOf(operation.fromStatus, sourceText) === operation.expectedRevision
			if (
				(targetText !== undefined && !targetMatches && !(source === target && sourceMatches)) ||
				(sourceText !== undefined && !sourceMatches && !(source === target && targetMatches)) ||
				(source && sourceText === undefined && !targetMatches)
			)
				throw new Error("Ticket import conflicts with an external edit; repair the import journal")
			for (const status of ticketStatusSchema.options) {
				const file = this.file(operation.id, status)
				if (file !== source && file !== target && (await readOptional(file)) !== undefined)
					throw new Error("Duplicate ticket ID conflicts with the import journal")
			}
			return { source, sourceText, target, targetMatches }
		}
		// Validate the complete durable intent and all stale-context guards before the first write.
		const { tickets, invalidFiles } = await this.scan()
		if (invalidFiles.length) throw new Error("Repair invalid ticket Markdown files before recovering an import")
		const candidates = [...tickets.filter((ticket) => !ids.has(ticket.id)), ...incoming]
		this.uniqueTickets(candidates)
		await this.sequence(candidates)
		for (const ticket of incoming) this.validateParent(candidates, ticket.id, ticket.parentId)
		for (const operation of intent.operations) await inspectOperation(operation)
		for (const operation of intent.operations) {
			const current = await inspectOperation(operation)
			if (!current.targetMatches)
				await atomicWriteText(current.target, operation.text, { requireAtomicReplace: true })
			if (current.source && current.source !== current.target && current.sourceText !== undefined) {
				if ((await this.raw(current.source)) !== current.sourceText)
					throw new Error("Ticket import source changed; repair the import journal")
				await fs.unlink(current.source)
			}
		}
		await fs.unlink(journal)
	}

	private async recoverMove(): Promise<void> {
		const journal = path.join(this.directory, ".move.json")
		let raw: string
		try {
			await this.safe(journal)
			if ((await fs.stat(journal)).size > 700000) throw new Error("Ticket move journal exceeds limit")
			raw = await fs.readFile(journal, "utf8")
		} catch (error) {
			if (missing(error)) return
			throw error
		}
		const intent = JSON.parse(raw) as {
			id: string
			from: TicketStatus
			to: TicketStatus
			revision: string
			text: string
		}
		const source = this.file(intent.id, intent.from),
			target = this.file(intent.id, intent.to)
		if (source === target || typeof intent.text !== "string") throw new Error("Invalid ticket move journal")
		if (Buffer.byteLength(intent.text, "utf8") > 100000) throw new Error("Ticket exceeds 100 KB")
		if (this.parse(intent.text, intent.to).ticket.id !== intent.id) throw new Error("Invalid ticket move ID")
		await this.safe(source)
		await this.safe(target)
		let sourceText: string | undefined, targetText: string | undefined
		try {
			sourceText = await this.raw(source)
		} catch (error) {
			if (!missing(error)) throw error
		}
		try {
			targetText = await this.raw(target)
		} catch (error) {
			if (!missing(error)) throw error
		}
		if (
			(sourceText !== undefined && revisionOf(intent.from, sourceText) !== intent.revision) ||
			(targetText !== undefined && targetText !== intent.text)
		)
			throw new Error("Ticket move conflicts with an external edit; repair the move journal")
		if (targetText === undefined) await atomicWriteText(target, intent.text, { requireAtomicReplace: true })
		if (sourceText !== undefined) await fs.unlink(source)
		await fs.unlink(journal)
	}
}
