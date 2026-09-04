import { createHash, randomUUID } from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { readApiMessages, saveApiMessages, type ApiMessage, type ApiMessagesCommitReceipt } from "../apiMessages"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import {
	ProviderTranscriptStore,
	digestProviderTranscript,
	providerTranscriptReceiptSchema,
	type ProviderTranscriptCommitReceipt,
} from "../ProviderTranscriptStore"

const fsFaults = vi.hoisted(() => ({
	syncTarget: undefined as string | undefined,
	syncMessage: "",
	syncInjected: false,
	renameTarget: undefined as string | undefined,
	renameMessage: "",
	renameInjected: false,
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return {
		...actual,
		open: (async (filePath, flags, mode) => {
			const handle = await actual.open(filePath, flags, mode)
			if (fsFaults.syncTarget && isAtomicTempPath(filePath, fsFaults.syncTarget)) {
				const originalSync = handle.sync.bind(handle)
				handle.sync = async () => {
					if (!fsFaults.syncInjected) {
						fsFaults.syncInjected = true
						throw new Error(fsFaults.syncMessage)
					}
					return originalSync()
				}
			}
			return handle
		}) as typeof actual.open,
		rename: (async (source, destination) => {
			if (
				fsFaults.renameTarget &&
				!fsFaults.renameInjected &&
				isAtomicTempPath(source, fsFaults.renameTarget) &&
				samePath(destination, fsFaults.renameTarget)
			) {
				fsFaults.renameInjected = true
				const error = new Error(fsFaults.renameMessage) as NodeJS.ErrnoException
				error.code = "EPERM"
				throw error
			}
			return actual.rename(source, destination)
		}) as typeof actual.rename,
	}
})

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: async (globalStoragePath: string, taskId: string) => {
		const taskDirectory = path.join(globalStoragePath, "tasks", taskId)
		await fs.mkdir(taskDirectory, { recursive: true })
		return taskDirectory
	},
}))

const taskId = "incremental-receipt-task"

type V2Receipt = Extract<ProviderTranscriptCommitReceipt, { version: 2 }>

let storagePath: string

beforeEach(async () => {
	storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-incremental-transcript-"))
})

afterEach(async () => {
	vi.restoreAllMocks()
	resetFsFaults()
	await fs.rm(storagePath, { recursive: true, force: true })
})

describe("incremental transcript receipts", () => {
	it("persists canonical legacy bytes and binds a compact v2 sidecar while preserving reasoning metadata", async () => {
		const messages: ApiMessage[] = [
			{
				ts: 1_700_000_000,
				role: "assistant",
				content: [{ text: "answer", type: "text" }],
				reasoning_content: "private reasoning",
				reasoning_details: [
					{
						data: {
							z: 2,
							a: 1,
							"~tail": "tail",
							"a-key": "lower",
							"A-key": "upper",
							_meta: "meta",
						},
						type: "reasoning.encrypted",
					},
				],
				summary: [{ text: "summary", type: "summary_text" }],
				encrypted_content: "encrypted reasoning",
			},
			{
				content: [
					{
						input: { z: 2, a: 1 },
						name: "read_file",
						type: "tool_use",
						id: "tool-1",
					},
				],
				role: "assistant",
				id: "assistant-1",
			},
		]
		const legacyReceipt = await saveLegacy(messages)
		const expectedBytes = canonicalJson(messages)
		const legacyBytes = await fs.readFile(legacyReceipt.filePath)
		const legacyText = legacyBytes.toString("utf8")

		expect(legacyReceipt).toMatchObject({
			taskId,
			filePath: path.resolve(legacyReceipt.filePath),
			digest: sha256(legacyBytes),
			byteLength: legacyBytes.byteLength,
		})
		expect(legacyText).toBe(expectedBytes)
		expect(legacyText.endsWith("\n")).toBe(false)
		expect(legacyText).toContain(
			'"data":{"_meta":"meta","~tail":"tail","a":1,"a-key":"lower","A-key":"upper","z":2}',
		)
		expect(legacyReceipt.byteLength).toBe(Buffer.byteLength(expectedBytes, "utf8"))
		expect(legacyReceipt.digest).toBe(digestProviderTranscript(messages))
		expect(await readApiMessages({ taskId, globalStoragePath: storagePath })).toEqual(messages)

		const store = new ProviderTranscriptStore(taskId, storagePath, { now: () => 1_700_000_123 })
		const commitReceipt = asV2Receipt(await store.commitAuthoritativeTranscript(legacyReceipt))
		const sidecarPath = await store.getFilePath()
		const sidecarText = await fs.readFile(sidecarPath, "utf8")
		const sidecar = JSON.parse(sidecarText) as Record<string, unknown>

		expect(sidecar).toEqual({
			version: 2,
			taskId,
			revision: 1,
			digest: legacyReceipt.digest,
			writtenAt: 1_700_000_123,
			byteLength: legacyReceipt.byteLength,
			commitId: legacyReceipt.commitId,
		})
		expect(sidecar).not.toHaveProperty("messages")
		expect(commitReceipt).toEqual(sidecar)

		const envelope = await store.read()
		expect(envelope).toMatchObject(sidecar)
		expect(envelope.messages).toEqual(messages)
		expect((await store.verifyCommitReceipt(commitReceipt)).messages).toEqual(messages)
		await expect(store.assertCommitReceipt(commitReceipt)).resolves.toBeUndefined()
	})

	it("keeps legacy history readable without a provider checkpoint", async () => {
		const messages = simpleMessages("checkpoint-free")
		const legacyReceipt = await saveLegacy(messages)
		const sidecarPath = path.join(path.dirname(legacyReceipt.filePath), GlobalFileNames.providerTranscript)

		expect(await readApiMessages({ taskId, globalStoragePath: storagePath })).toEqual(messages)
		await expect(fs.access(sidecarPath)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("moves a v1 full envelope to a v2 compact sidecar without losing the legacy-authoritative transcript", async () => {
		const messages = simpleMessages("v1-compatible")
		const legacyReceipt = await saveLegacy(messages)
		const store = new ProviderTranscriptStore(taskId, storagePath, { now: () => 1_700_000_200 })

		const v1Receipt = await store.commit(messages)
		expect(v1Receipt.version).toBe(1)
		expect((await store.read()).messages).toEqual(messages)

		const v2Receipt = asV2Receipt(await store.commitAuthoritativeTranscript(legacyReceipt))
		expect(v2Receipt.version).toBe(2)
		expect(v2Receipt.digest).toBe(legacyReceipt.digest)
		expect((await readSidecar(store)).version).toBe(2)
		expect((await store.read()).messages).toEqual(messages)
	})

	it("rejects an interrupted legacy replacement instead of accepting an unmatched sidecar", async () => {
		const messages = simpleMessages("durable")
		const legacyReceipt = await saveLegacy(messages)
		const store = new ProviderTranscriptStore(taskId, storagePath)
		const commitReceipt = asV2Receipt(await store.commitAuthoritativeTranscript(legacyReceipt))
		const originalBytes = await fs.readFile(legacyReceipt.filePath)

		await fs.writeFile(legacyReceipt.filePath, originalBytes.subarray(0, Math.max(1, originalBytes.byteLength - 3)))

		await expect(store.assertCommitReceipt(commitReceipt)).rejects.toMatchObject({
			code: "digest_mismatch",
		})
		await expect(store.verifyCommitReceipt(commitReceipt)).rejects.toMatchObject({
			code: "digest_mismatch",
		})
		expect(JSON.parse(await fs.readFile(await store.getFilePath(), "utf8"))).toEqual(commitReceipt)
	})

	it("detects same-size external tampering even after the legacy mtime is restored", async () => {
		const originalMessages = simpleMessages("one")
		const tamperedMessages = simpleMessages("two")
		const legacyReceipt = await saveLegacy(originalMessages)
		const store = new ProviderTranscriptStore(taskId, storagePath)
		const commitReceipt = asV2Receipt(await store.commitAuthoritativeTranscript(legacyReceipt))
		const originalStat = await fs.stat(legacyReceipt.filePath)
		const tamperedBytes = Buffer.from(canonicalJson(tamperedMessages), "utf8")

		expect(tamperedBytes.byteLength).toBe(originalStat.size)
		await fs.writeFile(legacyReceipt.filePath, tamperedBytes)
		await fs.utimes(legacyReceipt.filePath, originalStat.atime, originalStat.mtime)
		const restoredStat = await fs.stat(legacyReceipt.filePath)
		expect(restoredStat.size).toBe(originalStat.size)
		// Filesystems commonly round timestamps to millisecond precision; the
		// digest assertion below is the integrity check, not timestamp identity.
		expect(restoredStat.mtimeMs).toBeCloseTo(originalStat.mtimeMs, 0)

		await expect(store.assertCommitReceipt(commitReceipt)).rejects.toMatchObject({
			code: "digest_mismatch",
		})
	})

	it("replays an exact receipt idempotently and rejects stale receipts across a same-digest ABA cycle", async () => {
		const firstMessages = simpleMessages("A")
		const firstLegacyReceipt = await saveLegacy(firstMessages)
		const store = new ProviderTranscriptStore(taskId, storagePath, { now: () => 1_700_000_300 })
		const firstCommit = asV2Receipt(await store.commitAuthoritativeTranscript(firstLegacyReceipt))
		const sidecarPath = await store.getFilePath()
		const firstSidecarText = await fs.readFile(sidecarPath, "utf8")

		const replay = asV2Receipt(await store.commitAuthoritativeTranscript(firstLegacyReceipt))
		expect(replay).toEqual(firstCommit)
		expect(await fs.readFile(sidecarPath, "utf8")).toBe(firstSidecarText)

		const secondLegacyReceipt = await saveLegacy(simpleMessages("B"))
		const secondCommit = asV2Receipt(await store.commitAuthoritativeTranscript(secondLegacyReceipt))
		await expect(store.assertCommitReceipt(firstCommit)).rejects.toMatchObject({
			code: "receipt_mismatch",
		})

		const replayedMessagesReceipt = await saveLegacy(firstMessages)
		expect(replayedMessagesReceipt.digest).toBe(firstLegacyReceipt.digest)
		expect(replayedMessagesReceipt.commitId).not.toBe(firstLegacyReceipt.commitId)
		const abaCommit = asV2Receipt(await store.commitAuthoritativeTranscript(replayedMessagesReceipt))
		expect(abaCommit.revision).toBeGreaterThan(secondCommit.revision)
		expect(abaCommit.digest).toBe(firstCommit.digest)
		await expect(store.assertCommitReceipt(firstCommit)).rejects.toMatchObject({
			code: "receipt_mismatch",
		})
		await expect(store.assertCommitReceipt(abaCommit)).resolves.toBeUndefined()
	})

	it("allows one concurrent CAS writer and reports a revision conflict for the other", async () => {
		const firstReceipt = await saveLegacy(simpleMessages("shared"))
		const secondReceipt = await saveLegacy(simpleMessages("shared"))
		expect(secondReceipt.digest).toBe(firstReceipt.digest)
		expect(secondReceipt.commitId).not.toBe(firstReceipt.commitId)

		const storeA = new ProviderTranscriptStore(taskId, storagePath, { now: () => 1_700_000_401 })
		const storeB = new ProviderTranscriptStore(taskId, storagePath, { now: () => 1_700_000_402 })
		const results = await Promise.allSettled([
			storeA.commitAuthoritativeTranscript(firstReceipt, 0),
			storeB.commitAuthoritativeTranscript(secondReceipt, 0),
		])
		const fulfilled = results.filter(
			(result): result is PromiseFulfilledResult<V2Receipt> => result.status === "fulfilled",
		)
		const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")

		expect(fulfilled).toHaveLength(1)
		expect(rejected).toHaveLength(1)
		expect(rejected[0].reason).toMatchObject({ code: "revision_conflict" })
		expect((await readSidecar(storeA)).revision).toBe(1)
		expect((await readSidecar(storeA)).commitId).toBe(fulfilled[0].value.commitId)
	})

	it("requires explicit repair for corrupt v2 metadata and quarantines the damaged sidecar", async () => {
		const messages = simpleMessages("repair-me")
		const legacyReceipt = await saveLegacy(messages)
		const store = new ProviderTranscriptStore(taskId, storagePath, { now: () => 1_700_000_500 })
		const initialCommit = asV2Receipt(await store.commitAuthoritativeTranscript(legacyReceipt))
		const sidecarPath = await store.getFilePath()

		await fs.writeFile(sidecarPath, "{ interrupted sidecar", "utf8")
		await expect(store.commitAuthoritativeTranscript(legacyReceipt)).rejects.toMatchObject({
			code: "invalid_envelope",
		})

		const repaired = asV2Receipt(await store.repairAuthoritativeTranscript(legacyReceipt))
		expect(repaired.version).toBe(2)
		expect(repaired.digest).toBe(initialCommit.digest)
		expect(repaired.commitId).not.toBe(initialCommit.commitId)
		await expect(store.assertCommitReceipt(initialCommit)).rejects.toMatchObject({
			code: "receipt_mismatch",
		})
		expect((await store.read()).messages).toEqual(messages)
		const files = await fs.readdir(path.dirname(sidecarPath))
		expect(files.some((file) => file.startsWith(`${GlobalFileNames.providerTranscript}.corrupt_`))).toBe(true)
	})

	it("retains the previous legacy snapshot when its temp-file sync fails", async () => {
		const originalMessages = simpleMessages("legacy-before-sync-failure")
		const replacementMessages = simpleMessages("legacy-after-sync-failure")
		const originalReceipt = await saveLegacy(originalMessages)
		const originalBytes = await fs.readFile(originalReceipt.filePath)
		const fault = failNextTempSync(originalReceipt.filePath, "injected legacy sync failure")

		try {
			await expect(
				saveApiMessages({ messages: replacementMessages, taskId, globalStoragePath: storagePath }),
			).rejects.toThrow("injected legacy sync failure")
			expect(fault.wasInjected()).toBe(true)
		} finally {
			fault.restore()
		}

		expect(await fs.readFile(originalReceipt.filePath)).toEqual(originalBytes)
		expect(await atomicTempFiles(originalReceipt.filePath)).toEqual([])
		expect(await readApiMessages({ taskId, globalStoragePath: storagePath })).toEqual(originalMessages)
	})

	it("retains the previous legacy snapshot and cleans the temp file on strict EPERM rename failure", async () => {
		const originalMessages = simpleMessages("legacy-before-rename-failure")
		const replacementMessages = simpleMessages("legacy-after-rename-failure")
		const originalReceipt = await saveLegacy(originalMessages)
		const originalBytes = await fs.readFile(originalReceipt.filePath)
		const fault = failNextTempRename(originalReceipt.filePath, "injected legacy rename failure")

		try {
			await expect(
				saveApiMessages({ messages: replacementMessages, taskId, globalStoragePath: storagePath }),
			).rejects.toMatchObject({ code: "EPERM" })
			expect(fault.wasInjected()).toBe(true)
		} finally {
			fault.restore()
		}

		expect(await fs.readFile(originalReceipt.filePath)).toEqual(originalBytes)
		expect(await atomicTempFiles(originalReceipt.filePath)).toEqual([])
		expect(await readApiMessages({ taskId, globalStoragePath: storagePath })).toEqual(originalMessages)
	})

	it("leaves a stale sidecar after a sync failure and repairs it on retry/reload", async () => {
		await assertSidecarRetryAfterFault(failNextTempSync)
	})

	it("leaves a stale sidecar after a strict rename failure and repairs it on retry/reload", async () => {
		await assertSidecarRetryAfterFault(failNextTempRename)
	})

	it("snapshots caller message graphs before asynchronous legacy and v1 writes", async () => {
		const legacyInput: ApiMessage[] = [
			{ role: "user", content: [{ type: "text", text: "legacy-before-mutation" }] },
		]
		const expectedLegacy = structuredClone(legacyInput)
		const savePromise = saveApiMessages({ messages: legacyInput, taskId, globalStoragePath: storagePath })
		mutateFirstText(legacyInput, "legacy-after-mutation")
		const legacyReceipt = await savePromise
		expect(JSON.parse(await fs.readFile(legacyReceipt.filePath, "utf8"))).toEqual(expectedLegacy)

		const store = new ProviderTranscriptStore(taskId, storagePath)
		const commitInput: ApiMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "commit-before-mutation" }] },
		]
		const expectedCommit = structuredClone(commitInput)
		const commitPromise = store.commit(commitInput)
		mutateFirstText(commitInput, "commit-after-mutation")
		await commitPromise
		expect((await store.read()).messages).toEqual(expectedCommit)
	})

	it("rejects an out-of-order legacy receipt after a different payload is durably written", async () => {
		const firstReceipt = await saveLegacy(simpleMessages("first-payload"))
		const secondMessages = simpleMessages("second-payload")
		const secondReceipt = await saveLegacy(secondMessages)
		const store = new ProviderTranscriptStore(taskId, storagePath)

		await expect(store.commitAuthoritativeTranscript(firstReceipt)).rejects.toMatchObject({
			code: "digest_mismatch",
		})
		await expect(fs.access(await store.getFilePath())).rejects.toMatchObject({ code: "ENOENT" })
		const current = asV2Receipt(await store.commitAuthoritativeTranscript(secondReceipt))
		expect(current.digest).toBe(secondReceipt.digest)
	})

	it("rejects a max-safe revision before writing new sidecar metadata", async () => {
		const legacyReceipt = await saveLegacy(simpleMessages("max-safe-revision"))
		const store = new ProviderTranscriptStore(taskId, storagePath)
		const sidecarPath = await store.getFilePath()
		const maxRevisionRecord = {
			version: 2 as const,
			taskId,
			revision: Number.MAX_SAFE_INTEGER,
			digest: legacyReceipt.digest,
			writtenAt: 1_700_000_600,
			byteLength: legacyReceipt.byteLength,
			commitId: randomUUID(),
		}
		await fs.writeFile(sidecarPath, `${JSON.stringify(maxRevisionRecord)}\n`, "utf8")
		const before = await fs.readFile(sidecarPath)

		await expect(store.commitAuthoritativeTranscript(legacyReceipt)).rejects.toMatchObject({
			code: "revision_conflict",
		})
		expect(await fs.readFile(sidecarPath)).toEqual(before)
		expect(await atomicTempFiles(sidecarPath)).toEqual([])
	})

	it("rejects cross-task and cross-path receipts without creating a sidecar", async () => {
		const messages = simpleMessages("receipt-boundary")
		const otherTaskId = `${taskId}-other`
		const otherReceipt = await saveApiMessages({ messages, taskId: otherTaskId, globalStoragePath: storagePath })
		const store = new ProviderTranscriptStore(taskId, storagePath)

		await expect(store.commitAuthoritativeTranscript(otherReceipt)).rejects.toMatchObject({
			code: "receipt_mismatch",
		})

		const ownReceipt = await saveLegacy(messages)
		const wrongPathReceipt: ApiMessagesCommitReceipt = {
			...ownReceipt,
			filePath: path.join(path.dirname(ownReceipt.filePath), "not-the-authoritative-history.json"),
		}
		await expect(store.commitAuthoritativeTranscript(wrongPathReceipt)).rejects.toMatchObject({
			code: "receipt_mismatch",
		})
		await expect(fs.access(await store.getFilePath())).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("does not let explicit repair overwrite good metadata when legacy JSON is invalid or missing", async () => {
		const messages = simpleMessages("repair-boundary")
		const legacyReceipt = await saveLegacy(messages)
		const store = new ProviderTranscriptStore(taskId, storagePath)
		const committed = asV2Receipt(await store.commitAuthoritativeTranscript(legacyReceipt))
		const sidecarPath = await store.getFilePath()
		const goodSidecar = await fs.readFile(sidecarPath)
		const goodLegacy = await fs.readFile(legacyReceipt.filePath)

		await fs.writeFile(legacyReceipt.filePath, "{ invalid legacy json", "utf8")
		await expect(store.repairAuthoritativeTranscript(legacyReceipt)).rejects.toMatchObject({
			code: "digest_mismatch",
		})
		expect(await fs.readFile(sidecarPath)).toEqual(goodSidecar)

		await fs.writeFile(legacyReceipt.filePath, goodLegacy)
		await fs.unlink(legacyReceipt.filePath)
		await expect(store.repairAuthoritativeTranscript(legacyReceipt)).rejects.toMatchObject({
			code: "read_failed",
		})
		expect(await fs.readFile(sidecarPath)).toEqual(goodSidecar)
		await expect(store.assertCommitReceipt(committed)).rejects.toMatchObject({ code: "read_failed" })
	})
})

async function saveLegacy(messages: ApiMessage[]): Promise<ApiMessagesCommitReceipt> {
	return saveApiMessages({
		messages,
		taskId,
		globalStoragePath: storagePath,
	})
}

function asV2Receipt(receipt: ProviderTranscriptCommitReceipt): V2Receipt {
	if (receipt.version !== 2) throw new Error(`Expected v2 provider transcript receipt, got v${receipt.version}`)
	return receipt
}

async function readSidecar(store: ProviderTranscriptStore): Promise<V2Receipt> {
	return providerTranscriptReceiptSchema.parse(JSON.parse(await fs.readFile(await store.getFilePath(), "utf8")))
}

type FaultControl = {
	wasInjected: () => boolean
	restore: () => void
}

type TempFaultInjector = (targetPath: string, message: string) => FaultControl

async function assertSidecarRetryAfterFault(injectFault: TempFaultInjector): Promise<void> {
	const originalMessages = simpleMessages("sidecar-before-failure")
	const replacementMessages = simpleMessages("sidecar-after-failure")
	const originalReceipt = await saveLegacy(originalMessages)
	const store = new ProviderTranscriptStore(taskId, storagePath, { now: () => 1_700_000_700 })
	const originalCommit = asV2Receipt(await store.commitAuthoritativeTranscript(originalReceipt))
	const replacementReceipt = await saveLegacy(replacementMessages)
	const sidecarPath = await store.getFilePath()
	const originalSidecar = await fs.readFile(sidecarPath)
	const fault = injectFault(sidecarPath, "injected sidecar replacement failure")

	try {
		await expect(store.commitAuthoritativeTranscript(replacementReceipt)).rejects.toMatchObject({
			code: "write_failed",
		})
		expect(fault.wasInjected()).toBe(true)
	} finally {
		fault.restore()
	}

	expect(await fs.readFile(sidecarPath)).toEqual(originalSidecar)
	expect(await atomicTempFiles(sidecarPath)).toEqual([])
	await expect(store.assertCommitReceipt(originalCommit)).rejects.toMatchObject({ code: "digest_mismatch" })

	const retry = asV2Receipt(await store.commitAuthoritativeTranscript(replacementReceipt))
	expect(retry.revision).toBeGreaterThan(originalCommit.revision)
	const restarted = new ProviderTranscriptStore(taskId, storagePath)
	expect((await restarted.read()).messages).toEqual(replacementMessages)
}

function failNextTempSync(targetPath: string, message: string): FaultControl {
	fsFaults.syncTarget = path.resolve(targetPath)
	fsFaults.syncMessage = message
	fsFaults.syncInjected = false
	return {
		wasInjected: () => fsFaults.syncInjected,
		restore: () => {
			fsFaults.syncTarget = undefined
			fsFaults.syncMessage = ""
			fsFaults.syncInjected = false
		},
	}
}

function failNextTempRename(targetPath: string, message: string): FaultControl {
	fsFaults.renameTarget = path.resolve(targetPath)
	fsFaults.renameMessage = message
	fsFaults.renameInjected = false
	return {
		wasInjected: () => fsFaults.renameInjected,
		restore: () => {
			fsFaults.renameTarget = undefined
			fsFaults.renameMessage = ""
			fsFaults.renameInjected = false
		},
	}
}

function resetFsFaults(): void {
	fsFaults.syncTarget = undefined
	fsFaults.syncMessage = ""
	fsFaults.syncInjected = false
	fsFaults.renameTarget = undefined
	fsFaults.renameMessage = ""
	fsFaults.renameInjected = false
}

function isAtomicTempPath(candidate: unknown, targetPath: string): boolean {
	if (typeof candidate !== "string" && !Buffer.isBuffer(candidate) && !(candidate instanceof URL)) return false
	const candidatePath = candidate instanceof URL ? candidate.pathname : candidate.toString()
	const target = path.resolve(targetPath)
	const tempPrefix = path.join(path.dirname(target), `.${path.basename(target)}.new_`)
	return path.resolve(candidatePath).startsWith(tempPrefix)
}

function samePath(left: unknown, right: string): boolean {
	if (typeof left !== "string" && !Buffer.isBuffer(left) && !(left instanceof URL)) return false
	const leftPath = left instanceof URL ? left.pathname : left.toString()
	return path.resolve(leftPath) === path.resolve(right)
}

async function atomicTempFiles(targetPath: string): Promise<string[]> {
	const prefix = `.${path.basename(targetPath)}.new_`
	const entries = await fs.readdir(path.dirname(targetPath))
	return entries.filter((entry) => entry.startsWith(prefix))
}

function mutateFirstText(messages: ApiMessage[], text: string): void {
	const content = messages[0]?.content
	if (!Array.isArray(content)) throw new Error("Expected a message content block array")
	const block = content[0]
	if (block === null || typeof block !== "object" || !("text" in block)) {
		throw new Error("Expected a text content block")
	}
	const textBlock = block as { text?: string }
	textBlock.text = text
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
