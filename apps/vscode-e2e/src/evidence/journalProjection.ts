import { createHash } from "node:crypto"
import type { BigIntStats } from "node:fs"
import * as fs from "node:fs/promises"

import { rejectSymlinkComponents } from "./paths"

type TaskSourceWarning =
	| "TASK_SOURCE_LIMIT"
	| "TASK_SOURCE_CHANGED"
	| "JOURNAL_LINE_LIMIT"
	| "JOURNAL_EVENT_LIMIT"
	| "JOURNAL_MALFORMED"
	| "JOURNAL_EVENT_DROPPED"
	| "JOURNAL_SEQUENCE_INVALID"

/** Closed codes only: never publish filesystem errors or offending record contents. */
export class TaskSourceError extends Error {
	constructor(readonly warning: TaskSourceWarning) {
		super(warning)
	}
}

function bounded(value: number, maximum: number): void {
	if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error("Invalid task source limit")
}

function sameSource(left: BigIntStats, right: BigIntStats): boolean {
	return (
		right.isFile() &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	)
}

/** Hash every raw byte while retaining only a chunk and the consumer's bounded projection. */
async function visitSource(filePath: string, maxBytes: number, visit: (chunk: Buffer) => void) {
	bounded(maxBytes, 64 * 1_024 * 1_024)
	await rejectSymlinkComponents(filePath)
	const before = await fs.lstat(filePath, { bigint: true })
	if (!before.isFile()) throw new TaskSourceError("TASK_SOURCE_CHANGED")
	if (before.size > BigInt(maxBytes)) throw new TaskSourceError("TASK_SOURCE_LIMIT")
	const handle = await fs.open(filePath, "r").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") throw new TaskSourceError("TASK_SOURCE_CHANGED")
		throw error
	})
	try {
		const opened = await handle.stat({ bigint: true })
		if (!sameSource(before, opened)) throw new TaskSourceError("TASK_SOURCE_CHANGED")
		const hash = createHash("sha256")
		const buffer = Buffer.alloc(Math.min(64 * 1_024, maxBytes + 1))
		let bytes = 0
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes - bytes + 1), bytes)
			if (bytesRead === 0) break
			bytes += bytesRead
			if (bytes > maxBytes) throw new TaskSourceError("TASK_SOURCE_LIMIT")
			const chunk = buffer.subarray(0, bytesRead)
			hash.update(chunk)
			visit(chunk)
		}
		const after = await handle.stat({ bigint: true })
		await rejectSymlinkComponents(filePath)
		const named = await fs.lstat(filePath, { bigint: true })
		if (BigInt(bytes) !== opened.size || !sameSource(opened, after) || !sameSource(opened, named)) {
			throw new TaskSourceError("TASK_SOURCE_CHANGED")
		}
		return { sourceBytes: bytes, sourceSha256: hash.digest("hex") }
	} catch (error) {
		// Once observed, a disappearing transcript is unstable evidence, not a pre-provider absence.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TaskSourceError("TASK_SOURCE_CHANGED")
		throw error
	} finally {
		await handle.close()
	}
}

/** Non-JSONL task/control sources still have an explicit whole-source allocation/parse ceiling. */
export async function readTaskSource(filePath: string, maxBytes: number): Promise<Buffer> {
	const chunks: Buffer[] = []
	const source = await visitSource(filePath, maxBytes, (chunk) => chunks.push(Buffer.from(chunk)))
	return Buffer.concat(chunks, source.sourceBytes)
}

export async function projectJournalSource(
	filePath: string,
	limits: { maxSourceBytes: number; maxLineBytes: number; maxEvents: number },
	project: (raw: unknown) => unknown,
	sequencePartition: "run" | "turn" = "run",
) {
	bounded(limits.maxLineBytes, 4 * 1_024 * 1_024)
	bounded(limits.maxEvents, 10_000)
	const events: unknown[] = []
	const sequencesByPartition = new Map<string, number[]>()
	let records = 0
	let dropped = false
	let unverified = false
	let pending: Buffer = Buffer.alloc(0)
	const decode = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
	const consume = (line: Buffer) => {
		if (line.length > limits.maxLineBytes) throw new TaskSourceError("JOURNAL_LINE_LIMIT")
		if (line.at(-1) === 13) line = line.subarray(0, -1)
		if (line.length === 0) return
		// Count unknown records too; an unrecognized event cannot bypass the work bound.
		if (++records > limits.maxEvents) throw new TaskSourceError("JOURNAL_EVENT_LIMIT")
		let raw: unknown
		try {
			raw = JSON.parse(decode.decode(line))
		} catch {
			throw new TaskSourceError("JOURNAL_MALFORMED")
		}
		const value = project(raw)
		if (value === undefined) {
			dropped = true
			return
		}
		events.push(value)
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			unverified = true
			return
		}
		const projected = value as Record<string, unknown>
		const sequence = projected.sequence
		const runId = projected.runIdSha256
		const turnId = projected.turnIdSha256
		if (
			!Number.isInteger(sequence) ||
			(sequence as number) <= 0 ||
			typeof runId !== "string" ||
			(sequencePartition === "turn" && typeof turnId !== "string")
		) {
			unverified = true
			return
		}
		const partition = sequencePartition === "turn" ? `${runId}:${turnId as string}` : runId
		const partitionSequences = sequencesByPartition.get(partition) ?? []
		partitionSequences.push(sequence as number)
		sequencesByPartition.set(partition, partitionSequences)
	}
	const source = await visitSource(filePath, limits.maxSourceBytes, (chunk) => {
		const data = pending.length ? Buffer.concat([pending, chunk]) : chunk
		let start = 0
		for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
			consume(data.subarray(start, end))
			start = end + 1
		}
		if (data.length - start > limits.maxLineBytes) throw new TaskSourceError("JOURNAL_LINE_LIMIT")
		// The underlying read buffer is reused; retain only the unfinished bounded record.
		pending = Buffer.from(data.subarray(start))
	})
	if (pending.length) consume(pending)
	const sequenceInvalid = [...sequencesByPartition.values()].some((sequences) =>
		sequences.some((sequence, index) => sequence !== index + 1),
	)
	const validationStatus: JournalValidationStatus =
		dropped || sequenceInvalid
			? "incomplete"
			: unverified || sequencesByPartition.size === 0
				? "unverified"
				: "validated"
	const warnings = [
		...(dropped ? (["JOURNAL_EVENT_DROPPED"] as const) : []),
		...(sequenceInvalid ? (["JOURNAL_SEQUENCE_INVALID"] as const) : []),
		...(validationStatus === "unverified" ? (["JOURNAL_VALIDATION_UNVERIFIED"] as const) : []),
	]
	return {
		...source,
		projection: {
			events,
			captureStatus: "captured" as const,
			validationStatus,
			warnings,
			// Kept for older consumers; true now means sequence validation passed.
			complete: validationStatus === "validated",
		},
	}
}

export type JournalValidationStatus = "validated" | "unverified" | "incomplete"

export interface EvidenceJoinProjection {
	records: Array<{
		identity: Record<string, string | undefined>
		/** Present only when the two producer-local run IDs differ. */
		sourceRunIds?: { lifecycle: string[]; eventLog: string[] }
		lifecycleSequences: number[]
		eventLogSequences: number[]
		eventTypes: string[]
		identityConflicts: string[]
		status: "joined" | "partial"
	}>
	missing: string[]
}

/**
 * Join the privacy-safe projections of the canonical journal and additive
 * event log. Inputs contain only hashed identities; this helper never sees or
 * reconstructs raw task/provider content.
 */
export function joinProjectedEvidence(input: {
	lifecycle?: readonly unknown[]
	eventLog?: readonly unknown[]
}): EvidenceJoinProjection {
	const identityFields = [
		"taskIdSha256",
		"runIdSha256",
		"turnIdSha256",
		"stepIdSha256",
		"requestIdSha256",
		"attemptIdSha256",
	] as const
	const joinFields = ["taskIdSha256", "turnIdSha256", "stepIdSha256"] as const
	const groups = new Map<string, EvidenceJoinProjection["records"][number]>()
	const conflictsByGroup = new Map<string, Set<string>>()
	const runIdsByGroup = new Map<string, { lifecycle: Set<string>; eventLog: Set<string> }>()
	const missing = new Set<string>()
	const add = (source: "lifecycle" | "eventLog", value: unknown) => {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return
		const record = value as Record<string, unknown>
		for (const field of identityFields) {
			if (typeof record[field] !== "string") missing.add(`${source}:${field}`)
		}
		// The two journals create independent run IDs. Join on the shared task,
		// turn, and step IDs; retain both producer-local run IDs when they differ.
		// Request and attempt IDs are useful enrichment, but older records may omit them.
		const key = joinFields.map((field) => String(record[field] ?? "?")).join(":")
		const existing =
			groups.get(key) ??
			({
				identity: Object.fromEntries(
					identityFields.map((field) => [field, record[field] as string | undefined]),
				),
				lifecycleSequences: [],
				eventLogSequences: [],
				eventTypes: [],
				identityConflicts: [],
				status: "partial",
			} satisfies EvidenceJoinProjection["records"][number])
		const conflicts = conflictsByGroup.get(key) ?? new Set<string>()
		const hasStableIdentity = joinFields.every((field) => typeof existing.identity[field] === "string")
		const sequence = record.sequence
		if (typeof record.runIdSha256 === "string") {
			const runIds = runIdsByGroup.get(key) ?? { lifecycle: new Set<string>(), eventLog: new Set<string>() }
			runIds[source].add(record.runIdSha256)
			runIdsByGroup.set(key, runIds)
		}
		for (const field of identityFields.slice(4)) {
			const value = record[field]
			if (typeof value !== "string" || conflicts.has(field)) continue
			if (existing.identity[field] === undefined) existing.identity[field] = value
			else if (existing.identity[field] !== value) {
				delete existing.identity[field]
				conflicts.add(field)
				existing.identityConflicts.push(field)
			}
		}
		if (typeof sequence === "number" && Number.isFinite(sequence)) {
			if (source === "lifecycle") existing.lifecycleSequences.push(sequence)
			else existing.eventLogSequences.push(sequence)
		}
		const type = typeof record.type === "string" ? record.type : undefined
		if (type && !existing.eventTypes.includes(type)) existing.eventTypes.push(type)
		if (hasStableIdentity && existing.lifecycleSequences.length > 0 && existing.eventLogSequences.length > 0)
			existing.status = "joined"
		conflictsByGroup.set(key, conflicts)
		groups.set(key, existing)
	}
	input.lifecycle?.forEach((record) => add("lifecycle", record))
	input.eventLog?.forEach((record) => add("eventLog", record))
	const records = [...groups.entries()].map(([key, record]) => {
		const runIds = runIdsByGroup.get(key)
		const lifecycle = [...(runIds?.lifecycle ?? [])].sort()
		const eventLog = [...(runIds?.eventLog ?? [])].sort()
		if (lifecycle.length && eventLog.length && lifecycle.some((value) => !eventLog.includes(value))) {
			delete record.identity.runIdSha256
			record.sourceRunIds = { lifecycle, eventLog }
		}
		return record
	})
	return { records, missing: [...missing].sort() }
}
