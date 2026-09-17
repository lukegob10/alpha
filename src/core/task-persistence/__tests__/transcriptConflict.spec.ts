import { createHash } from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { saveApiMessages, type ApiMessage, type ApiMessagesCommitReceipt } from "../apiMessages"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import { ProviderTranscriptStore, type ProviderTranscriptCommitReceipt } from "../ProviderTranscriptStore"

const fsFaults = vi.hoisted(() => ({
	evidenceSyncTarget: undefined as string | undefined,
	evidenceSyncMessage: "",
	evidenceSyncInjected: false,
	evidenceTraceTarget: undefined as string | undefined,
	evidenceOpenFlags: [] as string[],
	deferredEvidenceTarget: undefined as string | undefined,
	deferredEvidenceMessage: "",
	deferredEvidenceStarted: undefined as (() => void) | undefined,
	deferredEvidenceGate: undefined as Promise<void> | undefined,
	deferredEvidenceRelease: undefined as (() => void) | undefined,
	mutationTarget: undefined as string | undefined,
	mutationBytes: undefined as Buffer | undefined,
	mutationInjected: false,
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return {
		...actual,
		open: (async (filePath, flags, mode) => {
			const handle = await actual.open(filePath, flags, mode)
			const normalizedPath = normalizePath(filePath)

			if (fsFaults.evidenceTraceTarget && samePath(normalizedPath, fsFaults.evidenceTraceTarget)) {
				fsFaults.evidenceOpenFlags.push(String(flags))
			}

			if (fsFaults.evidenceSyncTarget && samePath(normalizedPath, fsFaults.evidenceSyncTarget)) {
				const originalSync = handle.sync.bind(handle)
				handle.sync = async () => {
					if (!fsFaults.evidenceSyncInjected) {
						fsFaults.evidenceSyncInjected = true
						throw new Error(fsFaults.evidenceSyncMessage)
					}
					return originalSync()
				}
			}

			if (fsFaults.deferredEvidenceTarget && samePath(normalizedPath, fsFaults.deferredEvidenceTarget)) {
				fsFaults.deferredEvidenceStarted?.()
				if (fsFaults.deferredEvidenceGate) await fsFaults.deferredEvidenceGate
				await handle.close()
				throw new Error(fsFaults.deferredEvidenceMessage)
			}

			if (fsFaults.mutationTarget && samePath(normalizedPath, fsFaults.mutationTarget) && flags === "r") {
				const originalRead = handle.read.bind(handle)
				handle.read = (async (
					buffer: NodeJS.TypedArray | DataView,
					offset: number,
					length: number,
					position: number | null,
				) => {
					const result = await originalRead(buffer, offset, length, position)
					if (
						!fsFaults.mutationInjected &&
						typeof position === "number" &&
						fsFaults.mutationBytes !== undefined
					) {
						fsFaults.mutationInjected = true
						await actual.writeFile(normalizedPath, fsFaults.mutationBytes)
					}
					return result
				}) as typeof handle.read
			}

			return handle
		}) as typeof actual.open,
	}
})

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: async (globalStoragePath: string, taskId: string) => {
		const taskDirectory = path.join(globalStoragePath, "tasks", taskId)
		await fs.mkdir(taskDirectory, { recursive: true })
		return taskDirectory
	},
}))

const taskId = "transcript-conflict-task"
let storagePath: string

type V2Receipt = Extract<ProviderTranscriptCommitReceipt, { version: 2 }>

type ReceiptFixture = {
	legacyReceipt: ApiMessagesCommitReceipt
	store: ProviderTranscriptStore
	commitReceipt: V2Receipt
	legacyPath: string
	sidecarPath: string
}

beforeEach(async () => {
	storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-transcript-conflict-"))
})

afterEach(async () => {
	resetFsFaults()
	await fs.rm(storagePath, { recursive: true, force: true })
})

describe("transcript conflict preservation", () => {
	it("preserves exact same-size evidence before a later save replaces active legacy bytes", async () => {
		const fixture = await createReceiptFixture()
		const originalBytes = await fs.readFile(fixture.legacyPath)
		const conflictBytes = mutateByte(originalBytes, 0x01)

		const evidencePath = await preserveConflict(fixture, conflictBytes)
		expect(await fs.readFile(evidencePath)).toEqual(conflictBytes)

		const replacementMessages = simpleMessages("replacement-after-same-size-conflict")
		const replacementReceipt = await saveApiMessages({
			messages: replacementMessages,
			taskId,
			globalStoragePath: storagePath,
		})
		expect(await fs.readFile(replacementReceipt.filePath, "utf8")).toBe(canonicalJson(replacementMessages))
		expect(await fs.readFile(evidencePath)).toEqual(conflictBytes)
	})

	it("preserves exact length-mismatch evidence before a later save replaces active legacy bytes", async () => {
		const fixture = await createReceiptFixture()
		const originalBytes = await fs.readFile(fixture.legacyPath)
		const conflictBytes = Buffer.concat([originalBytes, Buffer.from("external-length-change")])

		const evidencePath = await preserveConflict(fixture, conflictBytes)
		expect(await fs.readFile(evidencePath)).toEqual(conflictBytes)

		const replacementMessages = simpleMessages("replacement-after-length-conflict")
		const replacementReceipt = await saveApiMessages({
			messages: replacementMessages,
			taskId,
			globalStoragePath: storagePath,
		})
		expect(await fs.readFile(replacementReceipt.filePath, "utf8")).toBe(canonicalJson(replacementMessages))
		expect(await fs.readFile(evidencePath)).toEqual(conflictBytes)
	})

	it("reuses one hash-addressed archive on an identical conflict and opens it r+", async () => {
		const fixture = await createReceiptFixture()
		const originalBytes = await fs.readFile(fixture.legacyPath)
		const conflictBytes = mutateByte(originalBytes, 0x02)
		const evidencePath = conflictPath(fixture.legacyPath, conflictBytes)
		fsFaults.evidenceTraceTarget = evidencePath

		await preserveConflict(fixture, conflictBytes)
		await preserveConflict(fixture, conflictBytes)

		const evidenceFlags = [...fsFaults.evidenceOpenFlags]
		fsFaults.evidenceTraceTarget = undefined
		expect(evidenceFlags).toEqual(["wx+", "r+"])
		expect(await conflictEntries(fixture.legacyPath)).toEqual([path.basename(evidencePath)])
		expect(await fs.readFile(evidencePath)).toEqual(conflictBytes)
	})

	it("rejects a fifth archive at the four-file cap without overwriting or deleting evidence", async () => {
		const fixture = await createReceiptFixture()
		const originalBytes = await fs.readFile(fixture.legacyPath)
		const archived = new Map<string, Buffer>()

		for (let index = 0; index < 4; index += 1) {
			const conflictBytes = Buffer.concat([Buffer.from(`external-conflict-${index}:`), originalBytes])
			const evidencePath = await preserveConflict(fixture, conflictBytes)
			archived.set(evidencePath, conflictBytes)
		}

		const namesBeforeFifth = await conflictEntries(fixture.legacyPath)
		expect(namesBeforeFifth).toHaveLength(4)
		const sidecarBeforeFifth = await fs.readFile(fixture.sidecarPath)
		const fifthConflict = Buffer.concat([Buffer.from("external-conflict-fifth:"), originalBytes])
		await fs.writeFile(fixture.legacyPath, fifthConflict)

		await expect(fixture.store.assertCommitReceipt(fixture.commitReceipt)).rejects.toMatchObject({
			code: "repair_failed",
		})
		expect(await conflictEntries(fixture.legacyPath)).toEqual(namesBeforeFifth)
		for (const [evidencePath, bytes] of archived) {
			expect(await fs.readFile(evidencePath)).toEqual(bytes)
		}

		const blockedReplacement = simpleMessages("blocked-by-archive-cap")
		await expect(
			saveApiMessages({ messages: blockedReplacement, taskId, globalStoragePath: storagePath }),
		).rejects.toMatchObject({ code: "repair_failed" })
		expect(await fs.readFile(fixture.legacyPath)).toEqual(fifthConflict)
		expect(await fs.readFile(fixture.sidecarPath)).toEqual(sidecarBeforeFifth)
	})

	it("latches repair_failed after evidence sync failure until a verifier retry succeeds", async () => {
		const fixture = await createReceiptFixture()
		const originalBytes = await fs.readFile(fixture.legacyPath)
		const conflictBytes = mutateByte(originalBytes, 0x03)
		const evidencePath = conflictPath(fixture.legacyPath, conflictBytes)
		await fs.writeFile(fixture.legacyPath, conflictBytes)
		const fault = failNextEvidenceSync(evidencePath, "injected evidence sync failure")

		await expect(fixture.store.assertCommitReceipt(fixture.commitReceipt)).rejects.toMatchObject({
			code: "repair_failed",
		})
		expect(fault.wasInjected()).toBe(true)
		fault.restore()
		expect(await fs.readFile(evidencePath)).toEqual(conflictBytes)

		const blockedReplacement = simpleMessages("blocked-during-evidence-sync-failure")
		await expect(
			saveApiMessages({ messages: blockedReplacement, taskId, globalStoragePath: storagePath }),
		).rejects.toMatchObject({ code: "repair_failed" })
		expect(await fs.readFile(fixture.legacyPath)).toEqual(conflictBytes)

		await expect(fixture.store.assertCommitReceipt(fixture.commitReceipt)).rejects.toMatchObject({
			code: "digest_mismatch",
		})
		const replacementReceipt = await saveApiMessages({
			messages: blockedReplacement,
			taskId,
			globalStoragePath: storagePath,
		})
		expect(await fs.readFile(replacementReceipt.filePath, "utf8")).toBe(canonicalJson(blockedReplacement))
		expect(await fs.readFile(evidencePath)).toEqual(conflictBytes)
	})

	it("refuses a corrupt existing archive and blocks replacement without rewriting it", async () => {
		const fixture = await createReceiptFixture()
		const originalBytes = await fs.readFile(fixture.legacyPath)
		const conflictBytes = mutateByte(originalBytes, 0x04)
		const evidencePath = conflictPath(fixture.legacyPath, conflictBytes)
		const corruptEvidence = mutateByte(conflictBytes, 0x20)
		await fs.writeFile(fixture.legacyPath, conflictBytes)
		await fs.writeFile(evidencePath, corruptEvidence)

		await expect(fixture.store.assertCommitReceipt(fixture.commitReceipt)).rejects.toMatchObject({
			code: "repair_failed",
		})
		expect(await fs.readFile(evidencePath)).toEqual(corruptEvidence)
		await expect(
			saveApiMessages({
				messages: simpleMessages("blocked-by-corrupt-evidence"),
				taskId,
				globalStoragePath: storagePath,
			}),
		).rejects.toMatchObject({ code: "repair_failed" })
		expect(await fs.readFile(fixture.legacyPath)).toEqual(conflictBytes)
	})

	it("keeps an already-queued legacy writer blocked when deferred evidence preservation fails", async () => {
		const fixture = await createReceiptFixture()
		const originalBytes = await fs.readFile(fixture.legacyPath)
		const conflictBytes = mutateByte(originalBytes, 0x05)
		const evidencePath = conflictPath(fixture.legacyPath, conflictBytes)
		await fs.writeFile(fixture.legacyPath, conflictBytes)
		const deferred = deferEvidenceOpen(evidencePath, "deferred evidence open failure")

		const verification = fixture.store.assertCommitReceipt(fixture.commitReceipt)
		await deferred.started
		const replacementMessages = simpleMessages("writer-waiting-on-legacy-lock")
		const replacement = saveApiMessages({
			messages: replacementMessages,
			taskId,
			globalStoragePath: storagePath,
		})
		deferred.release()

		const results = await Promise.allSettled([verification, replacement])
		deferred.clear()
		expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "repair_failed" } })
		expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "repair_failed" } })
		expect(await fs.readFile(fixture.legacyPath)).toEqual(conflictBytes)
		expect(await conflictEntries(fixture.legacyPath)).toEqual([path.basename(evidencePath)])
	})

	it("retains complete evidence and the replacement guard when the source changes during copying", async () => {
		const fixture = await createReceiptFixture()
		const originalBytes = await fs.readFile(fixture.legacyPath)
		const conflictBytes = mutateByte(originalBytes, 0x06)
		const changedDuringCopy = mutateByte(originalBytes, 0x07)
		const evidencePath = conflictPath(fixture.legacyPath, conflictBytes)
		await fs.writeFile(fixture.legacyPath, conflictBytes)
		const mutation = mutateSourceDuringCopy(fixture.legacyPath, changedDuringCopy)

		await expect(fixture.store.assertCommitReceipt(fixture.commitReceipt)).rejects.toMatchObject({
			code: "repair_failed",
		})
		expect(mutation.wasInjected()).toBe(true)
		mutation.restore()
		expect(await fs.readFile(evidencePath)).toEqual(conflictBytes)
		expect(await fs.readFile(fixture.legacyPath)).toEqual(changedDuringCopy)
		await expect(
			saveApiMessages({
				messages: simpleMessages("blocked-by-source-change"),
				taskId,
				globalStoragePath: storagePath,
			}),
		).rejects.toMatchObject({ code: "repair_failed" })
		expect(await fs.readFile(fixture.legacyPath)).toEqual(changedDuringCopy)
	})
})

async function createReceiptFixture(): Promise<ReceiptFixture> {
	const legacyReceipt = await saveApiMessages({
		messages: simpleMessages("authoritative-transcript"),
		taskId,
		globalStoragePath: storagePath,
	})
	const store = new ProviderTranscriptStore(taskId, storagePath, { now: () => 1_700_001_000 })
	const commitReceipt = asV2Receipt(await store.commitAuthoritativeTranscript(legacyReceipt))
	return {
		legacyReceipt,
		store,
		commitReceipt,
		legacyPath: legacyReceipt.filePath,
		sidecarPath: await store.getFilePath(),
	}
}

async function preserveConflict(fixture: ReceiptFixture, conflictBytes: Buffer): Promise<string> {
	const evidencePath = conflictPath(fixture.legacyPath, conflictBytes)
	await fs.writeFile(fixture.legacyPath, conflictBytes)
	await expect(fixture.store.assertCommitReceipt(fixture.commitReceipt)).rejects.toMatchObject({
		code: "digest_mismatch",
	})
	expect(await fs.readFile(evidencePath)).toEqual(conflictBytes)
	return evidencePath
}

function asV2Receipt(receipt: ProviderTranscriptCommitReceipt): V2Receipt {
	if (receipt.version !== 2) throw new Error(`Expected v2 provider transcript receipt, got v${receipt.version}`)
	return receipt
}

function conflictPath(legacyPath: string, bytes: Uint8Array): string {
	return `${legacyPath}.conflict_${sha256(bytes)}.json`
}

async function conflictEntries(legacyPath: string): Promise<string[]> {
	const prefix = `${path.basename(legacyPath)}.conflict_`
	const entries = await fs.readdir(path.dirname(legacyPath))
	return entries.filter((entry) => entry.startsWith(prefix)).sort()
}

function mutateByte(bytes: Uint8Array, delta: number): Buffer {
	const mutated = Buffer.from(bytes)
	if (mutated.length === 0) throw new Error("Cannot mutate an empty transcript")
	mutated[0] = (mutated[0] + delta) % 256
	return mutated
}

function failNextEvidenceSync(
	targetPath: string,
	message: string,
): { wasInjected: () => boolean; restore: () => void } {
	fsFaults.evidenceSyncTarget = path.resolve(targetPath)
	fsFaults.evidenceSyncMessage = message
	fsFaults.evidenceSyncInjected = false
	return {
		wasInjected: () => fsFaults.evidenceSyncInjected,
		restore: () => {
			fsFaults.evidenceSyncTarget = undefined
			fsFaults.evidenceSyncMessage = ""
		},
	}
}

function deferEvidenceOpen(
	targetPath: string,
	message: string,
): { started: Promise<void>; release: () => void; clear: () => void } {
	let resolveStarted!: () => void
	let resolveGate!: () => void
	const started = new Promise<void>((resolve) => {
		resolveStarted = resolve
	})
	const gate = new Promise<void>((resolve) => {
		resolveGate = resolve
	})
	fsFaults.deferredEvidenceTarget = path.resolve(targetPath)
	fsFaults.deferredEvidenceMessage = message
	fsFaults.deferredEvidenceStarted = resolveStarted
	fsFaults.deferredEvidenceGate = gate
	fsFaults.deferredEvidenceRelease = resolveGate
	return {
		started,
		release: () => fsFaults.deferredEvidenceRelease?.(),
		clear: () => {
			fsFaults.deferredEvidenceTarget = undefined
			fsFaults.deferredEvidenceMessage = ""
			fsFaults.deferredEvidenceStarted = undefined
			fsFaults.deferredEvidenceGate = undefined
			fsFaults.deferredEvidenceRelease = undefined
		},
	}
}

function mutateSourceDuringCopy(
	targetPath: string,
	bytes: Buffer,
): { wasInjected: () => boolean; restore: () => void } {
	fsFaults.mutationTarget = path.resolve(targetPath)
	fsFaults.mutationBytes = bytes
	fsFaults.mutationInjected = false
	return {
		wasInjected: () => fsFaults.mutationInjected,
		restore: () => {
			fsFaults.mutationTarget = undefined
			fsFaults.mutationBytes = undefined
		},
	}
}

function resetFsFaults(): void {
	fsFaults.evidenceSyncTarget = undefined
	fsFaults.evidenceSyncMessage = ""
	fsFaults.evidenceSyncInjected = false
	fsFaults.evidenceTraceTarget = undefined
	fsFaults.evidenceOpenFlags.length = 0
	fsFaults.deferredEvidenceTarget = undefined
	fsFaults.deferredEvidenceMessage = ""
	fsFaults.deferredEvidenceStarted = undefined
	fsFaults.deferredEvidenceGate = undefined
	fsFaults.deferredEvidenceRelease = undefined
	fsFaults.mutationTarget = undefined
	fsFaults.mutationBytes = undefined
	fsFaults.mutationInjected = false
}

function normalizePath(value: unknown): string {
	if (value instanceof URL) return path.resolve(value.pathname)
	if (typeof value === "string" || Buffer.isBuffer(value)) return path.resolve(value.toString())
	throw new Error(`Unsupported file path: ${String(value)}`)
}

function samePath(left: string, right: string): boolean {
	return path.resolve(left) === path.resolve(right)
}

function simpleMessages(text: string): ApiMessage[] {
	return [{ role: "user", content: text }]
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue)
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonicalValue(child)]),
		)
	}
	return value
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex")
}
