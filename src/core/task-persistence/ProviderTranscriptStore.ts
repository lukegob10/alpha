import crypto from "crypto"
import * as fs from "fs/promises"
import * as path from "path"
import { z } from "zod"

import type { ApiMessage } from "./apiMessages"
import { atomicWriteJson, withFileLock } from "./atomicWrite"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"

const PROVIDER_TRANSCRIPT_VERSION = 1 as const
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

/** A durable, provider-facing transcript envelope. */
export interface ProviderTranscriptEnvelope {
	version: typeof PROVIDER_TRANSCRIPT_VERSION
	taskId: string
	revision: number
	digest: string
	writtenAt: number
	messages: ApiMessage[]
}

/** Receipt returned only after a transcript commit has reached disk. */
export interface ProviderTranscriptCommitReceipt {
	version: typeof PROVIDER_TRANSCRIPT_VERSION
	taskId: string
	revision: number
	digest: string
	writtenAt: number
}

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
			expectedRevision?: number
			actualRevision?: number
			expectedDigest?: string
			actualDigest?: string
		} = {},
	) {
		super(message)
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
 * The existing api_conversation_history.json file is intentionally not read,
 * rewritten, migrated, or deleted here. New writes use their own envelope so
 * a failed rollout never destroys the legacy transcript.
 */
export class ProviderTranscriptStore {
	private readonly now: () => number
	private readonly fileName: string
	private cachedEnvelope: ProviderTranscriptEnvelope | undefined

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
	 * transcript at revision zero; no legacy file is consulted as a fallback.
	 */
	async read(): Promise<ProviderTranscriptEnvelope> {
		const filePath = await this.getFilePath()
		const envelope = await withFileLock(filePath, async () => this.readFromPath(filePath))
		this.cachedEnvelope = cloneEnvelope(envelope)
		return cloneEnvelope(envelope)
	}

	async load(): Promise<ProviderTranscriptEnvelope> {
		return this.read()
	}

	async readMessages(): Promise<ApiMessage[]> {
		return (await this.read()).messages
	}

	/** Return the last successfully read/committed revision, if initialized. */
	getRevision(): number | undefined {
		return this.cachedEnvelope?.revision
	}

	getLastCommitReceipt(): ProviderTranscriptCommitReceipt | undefined {
		const envelope = this.cachedEnvelope
		return envelope ? receiptFromEnvelope(envelope) : undefined
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
		const filePath = await this.getFilePath()

		try {
			const receipt = await withFileLock(filePath, async () => {
				const current = await this.readFromPath(filePath)
				if (expected !== undefined && expected !== current.revision) {
					throw new ProviderTranscriptRevisionConflictError(this.taskId, expected, current.revision)
				}

				const persistedMessages = cloneMessages(messages)
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
			this.cachedEnvelope = {
				version: PROVIDER_TRANSCRIPT_VERSION,
				taskId: this.taskId,
				revision: receipt.revision,
				digest: receipt.digest,
				writtenAt: receipt.writtenAt,
				messages: cloneMessages(messages),
			}
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
		await this.verifyCommitReceipt(receipt)
	}

	/**
	 * Quarantine an unreadable envelope and rebuild the sidecar from the
	 * authoritative legacy transcript. This is intentionally explicit instead
	 * of making `read()` silently discard data: callers can record the repair and
	 * still keep the legacy file as the runtime source of truth.
	 */
	async repairFromAuthoritativeTranscript(messages: ApiMessage[]): Promise<ProviderTranscriptCommitReceipt> {
		validateMessages(messages, this.taskId)
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
				const expectedDigest = digestProviderTranscript(messages)
				if (current?.digest === expectedDigest) {
					return receiptFromEnvelope(current)
				}

				const envelope: ProviderTranscriptEnvelope = {
					version: PROVIDER_TRANSCRIPT_VERSION,
					taskId: this.taskId,
					revision: (current?.revision ?? 0) + 1,
					digest: expectedDigest,
					writtenAt: this.now(),
					messages: cloneMessages(messages),
				}
				await atomicWriteJson(filePath, envelope)
				return receiptFromEnvelope(envelope)
			})

			this.cachedEnvelope = {
				version: receipt.version,
				taskId: receipt.taskId,
				revision: receipt.revision,
				digest: receipt.digest,
				writtenAt: receipt.writtenAt,
				messages: cloneMessages(messages),
			}
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
	validateMessages(messages, "<digest>")
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(stableValue(messages)) ?? "undefined")
		.digest("hex")
}

export const computeProviderTranscriptDigest = digestProviderTranscript

/** Verify receipt identity against an already-read envelope without I/O. */
export function assertCommitReceipt(
	receipt: ProviderTranscriptCommitReceipt,
	envelope: ProviderTranscriptEnvelope,
): void {
	validateReceipt(receipt, envelope.taskId)
	if (receipt.revision !== envelope.revision || receipt.digest !== envelope.digest) {
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
	if (!Array.isArray(messages) || messages.some((message) => message === null || typeof message !== "object")) {
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
		receipt.version !== PROVIDER_TRANSCRIPT_VERSION ||
		receipt.taskId !== taskId ||
		!Number.isInteger(receipt.revision) ||
		receipt.revision < 1 ||
		typeof receipt.digest !== "string" ||
		!DIGEST_PATTERN.test(receipt.digest) ||
		!Number.isFinite(receipt.writtenAt)
	) {
		throw new ProviderTranscriptStoreError(
			"receipt_mismatch",
			`Invalid provider transcript commit receipt for task ${taskId}`,
			taskId,
		)
	}
}

function receiptFromEnvelope(envelope: ProviderTranscriptEnvelope): ProviderTranscriptCommitReceipt {
	return {
		version: envelope.version,
		taskId: envelope.taskId,
		revision: envelope.revision,
		digest: envelope.digest,
		writtenAt: envelope.writtenAt,
	}
}

function cloneMessages(messages: ApiMessage[]): ApiMessage[] {
	return JSON.parse(JSON.stringify(messages)) as ApiMessage[]
}

function cloneEnvelope(envelope: ProviderTranscriptEnvelope): ProviderTranscriptEnvelope {
	return { ...envelope, messages: cloneMessages(envelope.messages) }
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

function envelopeFromUnknown(value: unknown, taskId: string, filePath: string): ProviderTranscriptEnvelope {
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

async function readRawEnvelope(filePath: string, taskId: string): Promise<ProviderTranscriptEnvelope | undefined> {
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
	return envelopeFromUnknown(value, taskId, filePath)
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

function emptyEnvelope(taskId: string): ProviderTranscriptEnvelope {
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
