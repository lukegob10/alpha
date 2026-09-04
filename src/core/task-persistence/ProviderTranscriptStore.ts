import crypto from "crypto"
import type { BigIntStats } from "fs"
import * as fs from "fs/promises"
import * as path from "path"
import { z } from "zod"

import type { ApiMessage, ApiMessagesCommitReceipt } from "./apiMessages"
import { atomicWriteJson, withFileLock } from "./atomicWrite"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"

const PROVIDER_TRANSCRIPT_VERSION = 1 as const
const DIGEST_PATTERN = /^[a-f0-9]{64}$/
const MAX_TRANSCRIPT_CONFLICT_FILES = 4
// Shared across stores/Task generations. Only verified preservation clears a
// failed capture; a generic save retry must not discard observed external data.
const unpreservedTranscriptConflicts = new Map<string, ProviderTranscriptStoreError>()

/** Receipt returned only after a transcript commit has reached disk. */
interface LegacyTranscriptReceipt {
	version: 1
	taskId: string
	revision: number
	digest: string
	writtenAt: number
}

/** V2 acknowledges the exact authoritative legacy bytes, without copying history. */
export const providerTranscriptReceiptSchema = z
	.object({
		version: z.literal(2),
		taskId: z.string().min(1),
		revision: z.number().int().positive().safe(),
		digest: z.string().regex(DIGEST_PATTERN),
		writtenAt: z.number().finite().nonnegative(),
		byteLength: z.number().int().nonnegative().safe(),
		commitId: z.string().uuid(),
	})
	.strict()

type AuthoritativeReceipt = z.infer<typeof providerTranscriptReceiptSchema>
export type ProviderTranscriptCommitReceipt = LegacyTranscriptReceipt | AuthoritativeReceipt
/** Readers retain hydrated messages for both versions; only v1 embeds them on disk. */
export type ProviderTranscriptEnvelope = ProviderTranscriptCommitReceipt & { messages: ApiMessage[] }
type LegacyTranscriptEnvelope = LegacyTranscriptReceipt & { messages: ApiMessage[] }
type TranscriptRecord = LegacyTranscriptEnvelope | AuthoritativeReceipt

export const providerTranscriptEnvelopeSchema = z
	.object({
		version: z.literal(PROVIDER_TRANSCRIPT_VERSION),
		taskId: z.string().min(1),
		revision: z.number().int().nonnegative(),
		digest: z.string().regex(DIGEST_PATTERN),
		writtenAt: z.number().finite().nonnegative(),
		// ApiMessage is intentionally an open compatibility surface: providers
		// add message block fields over time. The envelope still validates that
		// the persisted value is an array before it is returned as ApiMessage[].
		messages: z.array(
			z
				.unknown()
				.refine((message) => message !== null && typeof message === "object" && !Array.isArray(message), {
					message: "Transcript entries must be message objects",
				}),
		),
	})
	.strict()

export type ProviderTranscriptStoreErrorCode =
	| "invalid_envelope"
	| "invalid_messages"
	| "task_mismatch"
	| "digest_mismatch"
	| "revision_conflict"
	| "receipt_mismatch"
	| "read_failed"
	| "write_failed"
	| "repair_failed"
	| "queue_full"

/** Typed failures for transcript integrity and compare-and-swap boundaries. */
export class ProviderTranscriptStoreError extends Error {
	readonly code: ProviderTranscriptStoreErrorCode
	readonly taskId: string
	readonly expectedRevision?: number
	readonly actualRevision?: number
	readonly expectedDigest?: string
	readonly actualDigest?: string

	constructor(
		code: ProviderTranscriptStoreErrorCode,
		message: string,
		taskId: string,
		options: {
			cause?: unknown
			expectedRevision?: number
			actualRevision?: number
			expectedDigest?: string
			actualDigest?: string
		} = {},
	) {
		super(message, { cause: options.cause })
		this.name = "ProviderTranscriptStoreError"
		this.code = code
		this.taskId = taskId
		this.expectedRevision = options.expectedRevision
		this.actualRevision = options.actualRevision
		this.expectedDigest = options.expectedDigest
		this.actualDigest = options.actualDigest
	}
}

export class ProviderTranscriptRevisionConflictError extends ProviderTranscriptStoreError {
	constructor(taskId: string, expectedRevision: number, actualRevision: number) {
		super(
			"revision_conflict",
			`Provider transcript revision conflict for task ${taskId}: expected ${expectedRevision}, found ${actualRevision}`,
			taskId,
			{ expectedRevision, actualRevision },
		)
		this.name = "ProviderTranscriptRevisionConflictError"
	}
}

export class ProviderTranscriptDigestMismatchError extends ProviderTranscriptStoreError {
	constructor(taskId: string, expectedDigest: string, actualDigest: string) {
		super("digest_mismatch", `Provider transcript digest mismatch for task ${taskId}`, taskId, {
			expectedDigest,
			actualDigest,
		})
		this.name = "ProviderTranscriptDigestMismatchError"
	}
}

export interface ProviderTranscriptStoreOptions {
	/** Injectable clock for deterministic tests. */
	now?: () => number
	/** Override the new envelope filename without changing legacy files. */
	fileName?: string
}

export type ProviderTranscriptCommitInput =
	| ApiMessage[]
	| {
			messages: ApiMessage[]
			expectedRevision?: number
	  }

/**
 * Durable provider transcript persistence.
 *
 * V1 embeds a compatibility transcript. V2 stores only an integrity receipt
 * for api_conversation_history.json, the sole Task/runtime authority. Reads
 * hydrate either version; effect assertions verify bytes without hydration.
 * This store never writes or deletes the authoritative history file.
 */
export class ProviderTranscriptStore {
	private readonly now: () => number
	private readonly fileName: string
	private cachedReceipt: ProviderTranscriptCommitReceipt | undefined

	constructor(
		private readonly taskId: string,
		private readonly globalStoragePath: string,
		options: ProviderTranscriptStoreOptions = {},
	) {
		if (!taskId || taskId.trim().length === 0) throw new Error("Provider transcript task ID cannot be blank")
		this.now = options.now ?? Date.now
		this.fileName = options.fileName ?? GlobalFileNames.providerTranscript
	}

	getTaskId(): string {
		return this.taskId
	}

	/** Resolve the durable path without touching the legacy history filename. */
	async getFilePath(): Promise<string> {
		const taskDirectory = await getTaskDirectoryPath(this.globalStoragePath, this.taskId)
		return path.join(taskDirectory, this.fileName)
	}

	/** Alias useful to callers that need to inspect the new persistence path. */
	async getPath(): Promise<string> {
		return this.getFilePath()
	}

	/**
	 * Read and verify the current envelope. A missing new file is a valid empty
	 * transcript at revision zero; v1 reads do not fall back to legacy. A v2
	 * receipt requires matching, canonical legacy bytes and hydrates that file.
	 */
	async read(): Promise<ProviderTranscriptEnvelope> {
		const filePath = await this.getFilePath()
		const envelope = await withFileLock(filePath, async () => this.readFromPath(filePath))
		this.cachedReceipt = receiptFromEnvelope(envelope)
		return envelope
	}

	async load(): Promise<ProviderTranscriptEnvelope> {
		return this.read()
	}

	async readMessages(): Promise<ApiMessage[]> {
		return (await this.read()).messages
	}

	/** Return the last successfully read/committed revision, if initialized. */
	getRevision(): number | undefined {
		return this.cachedReceipt?.revision
	}

	getLastCommitReceipt(): ProviderTranscriptCommitReceipt | undefined {
		return this.cachedReceipt ? { ...this.cachedReceipt } : undefined
	}

	/**
	 * Acknowledge a completed authoritative write. The writer's receipt names the
	 * immutable bytes it wrote, not a later unlocked read of mutable caller data.
	 * A retry of the current commitId is idempotent; optional CAS rejects stale writers.
	 */
	async commitAuthoritativeTranscript(
		legacyReceipt: ApiMessagesCommitReceipt,
		expectedRevision?: number,
	): Promise<AuthoritativeReceipt> {
		return this.writeAuthoritativeReceipt(legacyReceipt, expectedRevision, false)
	}

	/** Explicit recovery after a valid legacy save; retain corrupt sidecar evidence. */
	async repairAuthoritativeTranscript(legacyReceipt: ApiMessagesCommitReceipt): Promise<AuthoritativeReceipt> {
		return this.writeAuthoritativeReceipt(legacyReceipt, undefined, true)
	}

	private async writeAuthoritativeReceipt(
		input: ApiMessagesCommitReceipt,
		expectedRevision: number | undefined,
		repair: boolean,
	): Promise<AuthoritativeReceipt> {
		const legacyReceipt = { ...input }
		const candidate = providerTranscriptReceiptSchema.safeParse({
			version: 2,
			taskId: legacyReceipt.taskId,
			revision: 1,
			digest: legacyReceipt.digest,
			writtenAt: this.now(),
			byteLength: legacyReceipt.byteLength,
			commitId: legacyReceipt.commitId,
		})
		if (!candidate.success || legacyReceipt.taskId !== this.taskId) {
			throw new ProviderTranscriptStoreError(
				"receipt_mismatch",
				"Invalid authoritative write receipt",
				this.taskId,
			)
		}
		const filePath = await this.getFilePath()
		const legacyPath = path.join(path.dirname(filePath), GlobalFileNames.apiConversationHistory)
		if (
			typeof legacyReceipt.filePath !== "string" ||
			path.resolve(legacyReceipt.filePath) !== path.resolve(legacyPath)
		) {
			throw new ProviderTranscriptStoreError(
				"receipt_mismatch",
				"Authoritative receipt path mismatch",
				this.taskId,
			)
		}
		try {
			return await withFileLock(filePath, async () => {
				// Verify before any repair/quarantine. Missing or malformed authoritative
				// bytes must never turn into an acknowledged empty transcript.
				await verifyAuthoritativeBytes(legacyPath, candidate.data)
				let current: TranscriptRecord | undefined
				let quarantined = false
				try {
					current = await readRawRecord(filePath, this.taskId)
				} catch (error) {
					if (!repair || !isRepairableEnvelopeError(error)) throw error
					await quarantineProviderTranscript(filePath)
					quarantined = true
				}
				if (current?.version === 2 && current.commitId === legacyReceipt.commitId) {
					if (current.digest !== legacyReceipt.digest || current.byteLength !== legacyReceipt.byteLength) {
						throw new ProviderTranscriptStoreError(
							"receipt_mismatch",
							"Conflicting commit ID replay",
							this.taskId,
						)
					}
					this.cachedReceipt = current
					return Object.freeze({ ...current })
				}
				if (expectedRevision !== undefined && expectedRevision !== (current?.revision ?? 0)) {
					throw new ProviderTranscriptRevisionConflictError(
						this.taskId,
						expectedRevision,
						current?.revision ?? 0,
					)
				}
				if (!Number.isSafeInteger((current?.revision ?? 0) + 1)) {
					throw new ProviderTranscriptStoreError(
						"revision_conflict",
						"Transcript revision exhausted",
						this.taskId,
					)
				}
				const receipt: AuthoritativeReceipt = {
					...candidate.data,
					revision: (current?.revision ?? 0) + 1,
					// Repair must not revive a pre-corruption receipt at revision one,
					// even when its caller retries identical bytes and a fixed test clock.
					commitId: quarantined ? crypto.randomUUID() : candidate.data.commitId,
				}
				await atomicWriteJson(filePath, receipt, { requireAtomicReplace: true })
				this.cachedReceipt = receipt
				return Object.freeze({ ...receipt })
			})
		} catch (error) {
			if (error instanceof ProviderTranscriptStoreError) throw error
			throw new ProviderTranscriptStoreError(
				repair ? "repair_failed" : "write_failed",
				`Failed to persist authoritative transcript receipt for task ${this.taskId}`,
				this.taskId,
				{ cause: error },
			)
		}
	}

	/**
	 * Serialize commits under the transcript lock and increment the on-disk
	 * revision. Supplying expectedRevision turns the operation into a CAS.
	 */
	async commit(
		input: ProviderTranscriptCommitInput,
		expectedRevision?: number,
	): Promise<ProviderTranscriptCommitReceipt> {
		const { messages, expected } = normalizeCommitInput(input, expectedRevision)
		validateMessages(messages, this.taskId)
		const persistedMessages = cloneMessages(messages)
		const filePath = await this.getFilePath()

		try {
			const receipt = await withFileLock(filePath, async () => {
				const current = await this.readFromPath(filePath)
				if (expected !== undefined && expected !== current.revision) {
					throw new ProviderTranscriptRevisionConflictError(this.taskId, expected, current.revision)
				}

				const envelope: ProviderTranscriptEnvelope = {
					version: PROVIDER_TRANSCRIPT_VERSION,
					taskId: this.taskId,
					revision: current.revision + 1,
					digest: digestProviderTranscript(persistedMessages),
					writtenAt: this.now(),
					messages: persistedMessages,
				}
				await atomicWriteJson(filePath, envelope)
				return receiptFromEnvelope(envelope)
			})
			this.cachedReceipt = receipt
			return Object.freeze({ ...receipt })
		} catch (error) {
			if (error instanceof ProviderTranscriptStoreError) throw error
			throw new ProviderTranscriptStoreError(
				"write_failed",
				`Failed to commit provider transcript for task ${this.taskId}: ${error instanceof Error ? error.message : String(error)}`,
				this.taskId,
			)
		}
	}

	async commitWithExpectedRevision(
		messages: ApiMessage[],
		expectedRevision: number,
	): Promise<ProviderTranscriptCommitReceipt> {
		return this.commit(messages, expectedRevision)
	}

	/**
	 * Check that a receipt still denotes the exact transcript currently on disk.
	 * Hosts can call this at the boundary immediately before applying tool
	 * effects, ensuring the assistant transcript was committed first.
	 */
	async verifyCommitReceipt(receipt: ProviderTranscriptCommitReceipt): Promise<ProviderTranscriptEnvelope> {
		validateReceipt(receipt, this.taskId)
		const envelope = await this.read()
		assertCommitReceipt(receipt, envelope)
		return envelope
	}

	async assertCommitReceipt(receipt: ProviderTranscriptCommitReceipt): Promise<void> {
		validateReceipt(receipt, this.taskId)
		const filePath = await this.getFilePath()
		await withFileLock(filePath, async () => {
			const record = (await readRawRecord(filePath, this.taskId)) ?? emptyEnvelope(this.taskId)
			assertCommitReceipt(receipt, record)
			if (record.version === 2) {
				await verifyAuthoritativeBytes(
					path.join(path.dirname(filePath), GlobalFileNames.apiConversationHistory),
					record,
				)
			}
		})
	}

	/**
	 * Quarantine an unreadable envelope and rebuild the sidecar from the
	 * authoritative legacy transcript. This is intentionally explicit instead
	 * of making `read()` silently discard data: callers can record the repair and
	 * still keep the legacy file as the runtime source of truth.
	 */
	async repairFromAuthoritativeTranscript(messages: ApiMessage[]): Promise<ProviderTranscriptCommitReceipt> {
		validateMessages(messages, this.taskId)
		const persistedMessages = cloneMessages(messages)
		const filePath = await this.getFilePath()

		try {
			const receipt = await withFileLock(filePath, async () => {
				let current: ProviderTranscriptEnvelope | undefined
				try {
					current = await readRawEnvelope(filePath, this.taskId)
				} catch (error) {
					if (!isRepairableEnvelopeError(error)) throw error
					await quarantineProviderTranscript(filePath)
				}

				// Another writer may have repaired the file between the original read
				// and this lock acquisition. Preserve its receipt when it already
				// represents the authoritative transcript.
				const expectedDigest = digestProviderTranscript(persistedMessages)
				if (current?.digest === expectedDigest) {
					return receiptFromEnvelope(current)
				}

				const envelope: ProviderTranscriptEnvelope = {
					version: PROVIDER_TRANSCRIPT_VERSION,
					taskId: this.taskId,
					revision: (current?.revision ?? 0) + 1,
					digest: expectedDigest,
					writtenAt: this.now(),
					messages: persistedMessages,
				}
				await atomicWriteJson(filePath, envelope)
				return receiptFromEnvelope(envelope)
			})

			this.cachedReceipt = receipt
			await this.verifyCommitReceipt(receipt)
			return Object.freeze({ ...receipt })
		} catch (error) {
			if (error instanceof ProviderTranscriptStoreError && error.code === "repair_failed") throw error
			throw new ProviderTranscriptStoreError(
				"repair_failed",
				`Failed to repair provider transcript for task ${this.taskId}: ${error instanceof Error ? error.message : String(error)}`,
				this.taskId,
			)
		}
	}

	async hasCommitReceipt(receipt: ProviderTranscriptCommitReceipt): Promise<boolean> {
		try {
			await this.verifyCommitReceipt(receipt)
			return true
		} catch (error) {
			if (error instanceof ProviderTranscriptStoreError) return false
			throw error
		}
	}

	private async readFromPath(filePath: string): Promise<ProviderTranscriptEnvelope> {
		const existing = await readRawEnvelope(filePath, this.taskId)
		return existing ?? emptyEnvelope(this.taskId)
	}
}

/** Stable SHA-256 identity for an ApiMessage[] transcript. */
export function digestProviderTranscript(messages: ApiMessage[]): string {
	return crypto.createHash("sha256").update(serializeProviderTranscript(messages)).digest("hex")
}

/** Canonical JSON bytes shared by the writer and mutable-history effect fence. */
export function serializeProviderTranscript(messages: ApiMessage[]): string {
	validateMessages(messages, "<serialize>")
	return JSON.stringify(stableValue(messages))
}

export const computeProviderTranscriptDigest = digestProviderTranscript

/** Verify receipt identity against an already-read envelope without I/O. */
export function assertCommitReceipt(
	receipt: ProviderTranscriptCommitReceipt,
	envelope: ProviderTranscriptCommitReceipt,
): void {
	validateReceipt(receipt, envelope.taskId)
	if (
		receipt.version !== envelope.version ||
		receipt.revision !== envelope.revision ||
		receipt.digest !== envelope.digest ||
		receipt.writtenAt !== envelope.writtenAt ||
		(receipt.version === 2 &&
			(envelope.version !== 2 ||
				receipt.commitId !== envelope.commitId ||
				receipt.byteLength !== envelope.byteLength))
	) {
		throw new ProviderTranscriptStoreError(
			"receipt_mismatch",
			`Provider transcript commit receipt does not match task ${envelope.taskId} revision ${envelope.revision}`,
			envelope.taskId,
			{
				expectedRevision: receipt.revision,
				actualRevision: envelope.revision,
				expectedDigest: receipt.digest,
				actualDigest: envelope.digest,
			},
		)
	}
}

function normalizeCommitInput(
	input: ProviderTranscriptCommitInput,
	expectedRevision?: number,
): { messages: ApiMessage[]; expected: number | undefined } {
	if (Array.isArray(input)) return { messages: input, expected: expectedRevision }
	return {
		messages: input.messages,
		expected: expectedRevision ?? input.expectedRevision,
	}
}

function validateMessages(messages: unknown, taskId: string): asserts messages is ApiMessage[] {
	if (
		!Array.isArray(messages) ||
		messages.some((message) => message === null || typeof message !== "object" || Array.isArray(message))
	) {
		throw new ProviderTranscriptStoreError(
			"invalid_messages",
			`Provider transcript messages must be an array of message objects for task ${taskId}`,
			taskId,
		)
	}
}

function validateReceipt(receipt: ProviderTranscriptCommitReceipt, taskId: string): void {
	if (
		receipt === null ||
		typeof receipt !== "object" ||
		(receipt.version !== 1 && receipt.version !== 2) ||
		receipt.taskId !== taskId ||
		!Number.isInteger(receipt.revision) ||
		receipt.revision < 1 ||
		typeof receipt.digest !== "string" ||
		!DIGEST_PATTERN.test(receipt.digest) ||
		!Number.isFinite(receipt.writtenAt) ||
		(receipt.version === 2 && !providerTranscriptReceiptSchema.safeParse(receipt).success)
	) {
		throw new ProviderTranscriptStoreError(
			"receipt_mismatch",
			`Invalid provider transcript commit receipt for task ${taskId}`,
			taskId,
		)
	}
}

function receiptFromEnvelope(envelope: ProviderTranscriptCommitReceipt): ProviderTranscriptCommitReceipt {
	const common = {
		taskId: envelope.taskId,
		revision: envelope.revision,
		digest: envelope.digest,
		writtenAt: envelope.writtenAt,
	}
	return envelope.version === 2
		? { ...common, version: 2, byteLength: envelope.byteLength, commitId: envelope.commitId }
		: { ...common, version: 1 }
}

function cloneMessages(messages: ApiMessage[]): ApiMessage[] {
	return JSON.parse(JSON.stringify(messages)) as ApiMessage[]
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue)
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, stableValue(child)]),
		)
	}
	return value
}

function envelopeFromUnknown(value: unknown, taskId: string, filePath: string): LegacyTranscriptEnvelope {
	const parsed = providerTranscriptEnvelopeSchema.safeParse(value)
	if (!parsed.success) {
		throw new ProviderTranscriptStoreError(
			"invalid_envelope",
			`Invalid provider transcript envelope at ${filePath}: ${parsed.error.message}`,
			taskId,
		)
	}
	if (parsed.data.taskId !== taskId) {
		throw new ProviderTranscriptStoreError(
			"task_mismatch",
			`Provider transcript at ${filePath} belongs to task ${parsed.data.taskId}, expected ${taskId}`,
			taskId,
		)
	}

	const messages = parsed.data.messages as ApiMessage[]
	const actualDigest = digestProviderTranscript(messages)
	if (actualDigest !== parsed.data.digest) {
		throw new ProviderTranscriptDigestMismatchError(taskId, parsed.data.digest, actualDigest)
	}
	return {
		version: parsed.data.version,
		taskId: parsed.data.taskId,
		revision: parsed.data.revision,
		digest: parsed.data.digest,
		writtenAt: parsed.data.writtenAt,
		messages: cloneMessages(messages),
	}
}

async function readRawRecord(filePath: string, taskId: string): Promise<TranscriptRecord | undefined> {
	let contents: string
	try {
		contents = await fs.readFile(filePath, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw new ProviderTranscriptStoreError(
			"read_failed",
			`Failed to read provider transcript for task ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
			taskId,
		)
	}

	let value: unknown
	try {
		value = JSON.parse(contents)
	} catch (error) {
		throw new ProviderTranscriptStoreError(
			"invalid_envelope",
			`Invalid provider transcript JSON at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			taskId,
		)
	}
	if (value !== null && typeof value === "object" && "version" in value && value.version === 2) {
		const parsed = providerTranscriptReceiptSchema.safeParse(value)
		if (!parsed.success) {
			throw new ProviderTranscriptStoreError(
				"invalid_envelope",
				"Invalid authoritative transcript receipt",
				taskId,
			)
		}
		if (parsed.data.taskId !== taskId) {
			throw new ProviderTranscriptStoreError("task_mismatch", "Authoritative transcript task mismatch", taskId)
		}
		return parsed.data
	}
	return envelopeFromUnknown(value, taskId, filePath)
}

async function readRawEnvelope(filePath: string, taskId: string): Promise<ProviderTranscriptEnvelope | undefined> {
	const record = await readRawRecord(filePath, taskId)
	if (!record) return undefined
	if (record.version === 1) return record
	const receipt = record
	const legacyPath = path.join(path.dirname(filePath), GlobalFileNames.apiConversationHistory)
	return withFileLock(legacyPath, async () => {
		let contents: Buffer
		try {
			const handle = await fs.open(legacyPath, "r")
			try {
				const before = await handle.stat({ bigint: true })
				contents = await fs.readFile(legacyPath)
				const observedDigest = crypto.createHash("sha256").update(contents).digest("hex")
				try {
					assertAuthoritativeDigest(receipt, observedDigest, contents.byteLength)
					await assertUnchangedAuthoritativeSource(legacyPath, handle, before, taskId)
				} catch (error) {
					if (error instanceof ProviderTranscriptStoreError) {
						await preserveTranscriptConflict(legacyPath, handle, before, observedDigest, error)
					}
					throw error
				}
			} finally {
				await handle.close()
			}
		} catch (error) {
			if (error instanceof ProviderTranscriptStoreError) throw error
			throw new ProviderTranscriptStoreError("read_failed", "Unable to read authoritative transcript", taskId)
		}
		let messages: unknown
		try {
			messages = JSON.parse(contents.toString("utf8"))
		} catch {
			throw new ProviderTranscriptStoreError("invalid_messages", "Invalid authoritative transcript JSON", taskId)
		}
		validateMessages(messages, taskId)
		// A loaded v2 file must bind both its raw bytes and the canonical history
		// digest used by Task. Unknown provider fields remain part of that digest.
		const canonicalDigest = digestProviderTranscript(messages)
		if (canonicalDigest !== receipt.digest) {
			throw new ProviderTranscriptDigestMismatchError(taskId, receipt.digest, canonicalDigest)
		}
		return { ...receipt, messages }
	})
}

function assertAuthoritativeDigest(receipt: AuthoritativeReceipt, digest: string, byteLength: number): void {
	if (receipt.digest !== digest || receipt.byteLength !== byteLength) {
		throw new ProviderTranscriptDigestMismatchError(receipt.taskId, receipt.digest, digest)
	}
}

/** Always read the bytes: timestamps, inode identity and cached receipts are not integrity evidence. */
async function verifyAuthoritativeBytes(filePath: string, receipt: AuthoritativeReceipt): Promise<void> {
	try {
		await withFileLock(filePath, async () => {
			const handle = await fs.open(filePath, "r")
			try {
				const before = await handle.stat({ bigint: true })
				let observedDigest: string | undefined
				try {
					if (before.size !== BigInt(receipt.byteLength)) {
						throw new ProviderTranscriptStoreError(
							"digest_mismatch",
							"Authoritative transcript length changed",
							receipt.taskId,
						)
					}
					const hash = crypto.createHash("sha256")
					const buffer = Buffer.allocUnsafe(64 * 1024)
					let byteLength = 0
					for (;;) {
						const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
						if (bytesRead === 0) break
						byteLength += bytesRead
						if (byteLength > receipt.byteLength) {
							throw new ProviderTranscriptStoreError(
								"digest_mismatch",
								"Authoritative transcript grew during verification",
								receipt.taskId,
							)
						}
						hash.update(buffer.subarray(0, bytesRead))
					}
					observedDigest = hash.digest("hex")
					assertAuthoritativeDigest(receipt, observedDigest, byteLength)
					await assertUnchangedAuthoritativeSource(filePath, handle, before, receipt.taskId)
				} catch (error) {
					if (
						error instanceof ProviderTranscriptStoreError &&
						(error.code === "digest_mismatch" || error.code === "receipt_mismatch")
					) {
						await preserveTranscriptConflict(filePath, handle, before, observedDigest, error)
					}
					throw error
				}
			} finally {
				await handle.close()
			}
		})
	} catch (error) {
		if (error instanceof ProviderTranscriptStoreError) throw error
		throw new ProviderTranscriptStoreError(
			"read_failed",
			"Unable to verify authoritative transcript",
			receipt.taskId,
		)
	}
}

function transcriptConflictKey(filePath: string): string {
	const absolutePath = path.resolve(filePath)
	return process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath
}

/** Must be checked while holding the authoritative history lock. */
export function assertAuthoritativeTranscriptReplacementAllowed(filePath: string): void {
	const failure = unpreservedTranscriptConflicts.get(transcriptConflictKey(filePath))
	if (failure) throw failure
}

/** An absence precondition must distinguish ENOENT from unreadable/present data. */
export async function assertAuthoritativeTranscriptMissing(filePath: string, taskId: string): Promise<void> {
	try {
		await fs.lstat(filePath)
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return
		throw new ProviderTranscriptStoreError("read_failed", "Unable to validate fallback migration", taskId, {
			cause,
		})
	}
	throw new ProviderTranscriptStoreError(
		"read_failed",
		"Authoritative transcript appeared during fallback migration; reload required",
		taskId,
	)
}

/** Old fallback data cannot replace a missing v2 authority, even during cold load. */
export async function withLegacyTranscriptMigration<T>(
	legacyPath: string,
	taskId: string,
	operation: () => Promise<T>,
): Promise<T> {
	const sidecarPath = path.join(path.dirname(legacyPath), GlobalFileNames.providerTranscript)
	return withFileLock(sidecarPath, async () => {
		const record = await readRawRecord(sidecarPath, taskId)
		if (record?.version === 2) {
			throw new ProviderTranscriptStoreError(
				"read_failed",
				"Missing authoritative transcript cannot be replaced by an older fallback",
				taskId,
			)
		}
		// The migration's legacy lock nests inside this sidecar lock, matching all
		// v2 readers. The writer rechecks absence before replacing anything.
		// Another reader may have waited while migration removed Claude history;
		// its now-missing fallback must not be mistaken for an empty transcript.
		await withFileLock(legacyPath, () => assertAuthoritativeTranscriptMissing(legacyPath, taskId))
		return operation()
	})
}

async function assertUnchangedAuthoritativeSource(
	filePath: string,
	handle: fs.FileHandle,
	before: BigIntStats,
	taskId: string,
): Promise<void> {
	const after = await handle.stat({ bigint: true })
	const current = await fs.stat(filePath, { bigint: true })
	// Stats supplement a byte digest; they are never a substitute for reading.
	for (const stat of [after, current]) {
		if (!sameFileSnapshot(stat, before)) {
			throw new ProviderTranscriptStoreError(
				"receipt_mismatch",
				"Authoritative transcript changed during verification",
				taskId,
			)
		}
	}
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	)
}

/** Read a fixed observed extent, with bounded memory and explicit offsets. */
async function hashTranscriptExtent(handle: fs.FileHandle, byteLength: number, copy?: fs.FileHandle): Promise<string> {
	const hash = crypto.createHash("sha256")
	const buffer = Buffer.allocUnsafe(64 * 1024)
	let position = 0
	while (position < byteLength) {
		const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, byteLength - position), position)
		if (bytesRead === 0) throw new Error("Transcript changed during conflict preservation")
		const bytes = buffer.subarray(0, bytesRead)
		hash.update(bytes)
		if (copy) await copy.writeFile(bytes)
		position += bytesRead
	}
	return hash.digest("hex")
}

/**
 * Keep detected external bytes as recovery-only evidence before a later terminal
 * result save can replace the legacy authority. This exceptional path performs
 * extra I/O; healthy fences do not. The caller holds sidecar then legacy locks.
 */
async function preserveTranscriptConflict(
	filePath: string,
	source: fs.FileHandle,
	before: BigIntStats,
	observedDigest: string | undefined,
	conflict: ProviderTranscriptStoreError,
): Promise<void> {
	const key = transcriptConflictKey(filePath)
	const failure = new ProviderTranscriptStoreError(
		"repair_failed",
		"External transcript conflict could not be preserved; history replacement is blocked",
		conflict.taskId,
		{ cause: conflict },
	)
	// Latch before the first await so even an already-admitted writer cannot
	// erase the evidence when this lock is released after a capture failure.
	unpreservedTranscriptConflicts.set(key, failure)
	try {
		await assertUnchangedAuthoritativeSource(filePath, source, before, conflict.taskId)
		const byteLength = Number(before.size)
		if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error("Transcript conflict is too large")
		const digest = observedDigest ?? (await hashTranscriptExtent(source, byteLength))
		const prefix = `${path.basename(filePath)}.conflict_`
		const evidencePath = `${filePath}.conflict_${digest}.json`
		const entries = await fs.readdir(path.dirname(filePath))
		const existing = entries.includes(path.basename(evidencePath))
		if (!existing && entries.filter((entry) => entry.startsWith(prefix)).length >= MAX_TRANSCRIPT_CONFLICT_FILES) {
			throw new Error("Transcript conflict evidence capacity reached")
		}
		// Hash-addressed repeats are verified, never overwritten or assumed valid.
		if (existing && !(await fs.lstat(evidencePath)).isFile()) {
			throw new Error("Transcript conflict evidence must be a regular file")
		}
		// Windows cannot sync a read-only handle; r+ never truncates existing data.
		const evidence = await fs.open(evidencePath, existing ? "r+" : "wx+")
		let verifiedEvidence: BigIntStats
		try {
			if (!existing && (await hashTranscriptExtent(source, byteLength, evidence)) !== digest) {
				throw new Error("Transcript changed during conflict copy")
			}
			verifiedEvidence = await evidence.stat({ bigint: true })
			if (
				verifiedEvidence.size !== before.size ||
				(await hashTranscriptExtent(evidence, byteLength)) !== digest
			) {
				throw new Error("Transcript conflict evidence does not match observed bytes")
			}
			await evidence.sync()
			if (!sameFileSnapshot(await evidence.stat({ bigint: true }), verifiedEvidence)) {
				throw new Error("Transcript conflict evidence changed during verification")
			}
		} finally {
			await evidence.close()
		}
		const namedEvidence = await fs.lstat(evidencePath, { bigint: true })
		if (!namedEvidence.isFile() || !sameFileSnapshot(namedEvidence, verifiedEvidence)) {
			throw new Error("Transcript conflict evidence path changed during verification")
		}
		await assertUnchangedAuthoritativeSource(filePath, source, before, conflict.taskId)
		unpreservedTranscriptConflicts.delete(key)
	} catch (cause) {
		// Keep even partial copies: they consume capacity and cannot authorize a
		// replacement unless a later full verification succeeds. Never rotate or
		// delete external-history evidence to make recovery appear successful.
		throw new ProviderTranscriptStoreError("repair_failed", failure.message, conflict.taskId, { cause })
	}
}

function isRepairableEnvelopeError(error: unknown): boolean {
	return (
		error instanceof ProviderTranscriptStoreError &&
		(error.code === "invalid_envelope" ||
			error.code === "invalid_messages" ||
			error.code === "task_mismatch" ||
			error.code === "digest_mismatch")
	)
}

async function quarantineProviderTranscript(filePath: string): Promise<void> {
	try {
		const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
		await fs.rename(filePath, `${filePath}.corrupt_${suffix}`)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return
		throw error
	}
}

function emptyEnvelope(taskId: string): LegacyTranscriptEnvelope {
	const messages: ApiMessage[] = []
	return {
		version: PROVIDER_TRANSCRIPT_VERSION,
		taskId,
		revision: 0,
		digest: digestProviderTranscript(messages),
		writtenAt: 0,
		messages,
	}
}
