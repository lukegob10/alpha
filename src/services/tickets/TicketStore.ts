import * as fs from "fs/promises"
import path from "path"
import os from "os"
import { createHash, randomUUID } from "crypto"
import { parseDocument, stringify } from "yaml"
import { z } from "zod"
import {
	createTicketSchema,
	deleteTicketSchema,
	updateTicketSchema,
	listTicketsSchema,
	ticketSchema,
	ticketStatusSchema,
	ticketStatusOrder,
	ticketIdSchema,
	ticketLocatorSchema,
	normalizeTicketReference,
	type CreateTicket,
	type DeleteTicket,
	type UpdateTicket,
	type Ticket,
	type TicketList,
	type TicketStatus,
} from "@alpha-code/types"
import { atomicWriteText, withFileLock } from "../../core/task-persistence/atomicWrite"

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
	private constructor(
		readonly directory: string,
		readonly projectId: string,
		readonly workspace: string,
	) {}

	static async forWorkspace(workspace: string, home = os.homedir()): Promise<TicketStore> {
		const canonical = await fs.realpath(workspace)
		const key = process.platform === "win32" ? canonical.toLowerCase() : canonical
		const name =
			path
				.basename(canonical)
				.replace(/[^a-zA-Z0-9_-]/g, "-")
				.slice(0, 80) || "project"
		const id = `${name}-${digest(key).slice(0, 12)}`
		const store = new TicketStore(path.join(await fs.realpath(home), ".alpha", "tickets", id), id, canonical)
		// Join editor-owned migration if it is in flight; opening a store never starts a write.
		await TicketStore.preparing.get(store.directory)
		return store
	}

	static async initializeWorkspace(workspace: string, signal?: AbortSignal): Promise<void> {
		const store = await TicketStore.forWorkspace(workspace)
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
			await this.recover()
			return run()
		})
	}

	/** Inspection never creates profile files or commits an interrupted mutation. */
	private async inspect<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		await this.safe(this.directory)
		checkCancelled(signal)
		const checkPending = async () => {
			try {
				await fs.lstat(path.join(this.directory, ".move.json"))
			} catch (error) {
				if (missing(error)) return
				throw error
			}
			throw new Error("Ticket move pending; open the ticket editor to recover it before reading")
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
		if (ticket.status === "complete" && !ticket.implementationSummary.trim())
			throw new Error("Complete tickets require an implementation summary")
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
		delete merged.status
		delete merged.revision
		if (ticket.completedAt) merged.completedAt = ticket.completedAt
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
		return this.inspect(async () => (await this.locate(await this.resolveId(id, signal))).ticket, signal)
	}
	async markdownPath(id: string): Promise<string> {
		return this.inspect(async () => (await this.locate(id)).file)
	}

	private async scan(signal?: AbortSignal): Promise<{ tickets: Ticket[]; invalidFiles: string[] }> {
		const tickets: Ticket[] = [],
			invalidFiles: string[] = []
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
					const ticket = this.parse(await this.raw(path.join(directory, name)), status).ticket
					if (`${ticket.id}.md` !== name) throw new Error("Invalid filename")
					tickets.push(ticket)
				} catch {
					invalidFiles.push(`${status}/${name}`)
				}
			}
		}
		return { tickets, invalidFiles }
	}

	private async resolveId(value: string, signal?: AbortSignal): Promise<string> {
		const locator = ticketLocatorSchema.parse(value)
		if (ticketIdSchema.safeParse(locator).success) return locator
		const reference = normalizeTicketReference(locator)
		const { tickets } = await this.scan(signal)
		const matches = tickets.filter(
			(ticket) => ticket.reference && normalizeTicketReference(ticket.reference) === reference,
		)
		if (matches.length > 1) throw new Error("Duplicate ticket reference; repair Markdown files")
		if (!matches.length) throw new Error("Alpha ticket not found in this project; use list_tickets to search")
		return matches[0].id
	}

	async list(input: unknown = {}, signal?: AbortSignal): Promise<TicketList> {
		const filter = listTicketsSchema.parse(input)
		return this.inspect(async () => {
			const { tickets, invalidFiles } = await this.scan(signal)
			const reference = filter.query && normalizeTicketReference(filter.query)
			const terms = filter.query?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
			const matches = tickets
				.filter(
					(ticket) =>
						(!filter.status || ticket.status === filter.status) &&
						(reference
							? ticket.reference === reference
							: terms.every((term) =>
									`${ticket.reference ?? ""}\n${ticket.name}\n${ticket.description}\n${ticket.context}`
										.toLowerCase()
										.replace(/[^\p{L}\p{N}]/gu, "")
										.includes(term),
								)),
				)
				.sort(
					(a, b) =>
						ticketStatusOrder.indexOf(a.status) - ticketStatusOrder.indexOf(b.status) ||
						b.updatedAt.localeCompare(a.updatedAt) ||
						a.id.localeCompare(b.id),
				)
			return {
				tickets: matches
					.slice(filter.offset, filter.offset + filter.limit)
					.map(({ id, reference, name, status, updatedAt }) => ({ id, reference, name, status, updatedAt })),
				total: matches.length,
				invalidFiles: invalidFiles.slice(0, 100),
			}
		}, signal)
	}

	async create(input: CreateTicket, signal?: AbortSignal): Promise<Ticket> {
		const fields = createTicketSchema.parse(input)
		return this.transaction(async () => {
			const sequence = await this.sequence((await this.scan(signal)).tickets)
			const now = new Date().toISOString()
			const ticket: Ticket = {
				schemaVersion: 1,
				id: randomUUID(),
				reference: await this.reserveReference(sequence),
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
			const { expectedRevision: _expected, id: _id, ...fields } = patch
			const now = new Date().toISOString()
			const ticket = ticketSchema.parse({
				...old.ticket,
				...fields,
				updatedAt: now,
				linkedTaskIds: linkedTaskId
					? [...new Set([...old.ticket.linkedTaskIds, linkedTaskId])]
					: old.ticket.linkedTaskIds,
			})
			const sequence = await this.sequence((await this.scan(signal)).tickets)
			if (!ticket.reference) ticket.reference = await this.reserveReference(sequence)
			if (ticket.status === "complete" && !ticket.implementationSummary.trim())
				throw new Error("Add an implementation summary before completing the ticket")
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
			const sequence = await this.sequence((await this.scan(signal)).tickets)
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

	private async recover(): Promise<void> {
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
