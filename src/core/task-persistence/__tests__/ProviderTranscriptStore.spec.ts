import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import crypto from "crypto"

import type { ApiMessage } from "../apiMessages"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import { buildOpenAiResponsesInput } from "../../../api/providers/openai-responses"

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: async (globalStoragePath: string, taskId: string) => {
		const taskDirectory = path.join(globalStoragePath, taskId)
		await fs.mkdir(taskDirectory, { recursive: true })
		return taskDirectory
	},
}))

import {
	ProviderTranscriptDigestMismatchError,
	ProviderTranscriptRevisionConflictError,
	ProviderTranscriptStore,
	digestProviderTranscript,
} from "../ProviderTranscriptStore"

const taskId = "transcript-task"
const messages = (text: string): ApiMessage[] => [{ role: "user", content: text }]

describe("ProviderTranscriptStore", () => {
	let storagePath: string

	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "provider-transcript-"))
	})

	afterEach(async () => {
		await fs.rm(storagePath, { recursive: true, force: true })
	})

	it("writes a versioned envelope and verifies its digest on read", async () => {
		const store = new ProviderTranscriptStore(taskId, storagePath, { now: () => 123 })
		const receipt = await store.commit(messages("hello"))
		const envelope = await store.read()

		expect(envelope).toMatchObject({
			version: 1,
			taskId,
			revision: 1,
			writtenAt: 123,
			messages: messages("hello"),
		})
		expect(envelope.digest).toBe(digestProviderTranscript(messages("hello")))
		expect(receipt).toMatchObject({ taskId, revision: 1, digest: envelope.digest })
	})

	it("does not migrate or delete the legacy API history file", async () => {
		const taskDirectory = path.join(storagePath, taskId)
		await fs.mkdir(taskDirectory, { recursive: true })
		const legacyPath = path.join(taskDirectory, GlobalFileNames.apiConversationHistory)
		const legacyContents = JSON.stringify(messages("legacy"))
		await fs.writeFile(legacyPath, legacyContents, "utf8")

		await new ProviderTranscriptStore(taskId, storagePath).commit(messages("new"))

		expect(await fs.readFile(legacyPath, "utf8")).toBe(legacyContents)
		expect(await fs.access(path.join(taskDirectory, GlobalFileNames.providerTranscript))).toBeUndefined()
	})

	it("rejects a digest mismatch instead of returning tampered messages", async () => {
		const store = new ProviderTranscriptStore(taskId, storagePath)
		await store.commit(messages("original"))
		const filePath = await store.getFilePath()
		const envelope = JSON.parse(await fs.readFile(filePath, "utf8"))
		envelope.messages = messages("tampered")
		await fs.writeFile(filePath, JSON.stringify(envelope), "utf8")

		await expect(store.read()).rejects.toBeInstanceOf(ProviderTranscriptDigestMismatchError)
	})

	it("rejects a digest-valid envelope with malformed provider messages", async () => {
		const store = new ProviderTranscriptStore(taskId, storagePath)
		await store.commit(messages("original"))
		const filePath = await store.getFilePath()
		const envelope = JSON.parse(await fs.readFile(filePath, "utf8"))
		envelope.messages = [
			{ role: "assistant", content: [{ type: "tool_use", id: 7, name: "read_file", input: {} }] },
		]
		envelope.digest = crypto
			.createHash("sha256")
			.update('{"content":[{"id":7,"input":{},"name":"read_file","type":"tool_use"}],"role":"assistant"}')
			.digest("hex")
		await fs.writeFile(filePath, JSON.stringify(envelope), "utf8")

		await expect(store.read()).rejects.toMatchObject({ code: "invalid_messages" })
	})

	it("retains legacy tool-call aliases, provider metadata, and reasoning records", async () => {
		const store = new ProviderTranscriptStore(taskId, storagePath)
		const history = [
			{ role: "user", content: "request" },
			{
				role: "assistant",
				content: [
					{ type: "tool_call", tool_call_id: "call-1", function: { name: "read_file", arguments: "{}" } },
				],
				provider_state: { opaque: true },
			},
			{ role: "user", content: [{ type: "tool_result", tool_call_id: "call-1", content: null }] },
			{ type: "reasoning", encrypted_content: "opaque", summary: [], id: "reasoning-1" },
		] as unknown as ApiMessage[]
		await store.commit(history)
		expect((await store.read()).messages).toEqual(history)
	})

	it("accepts an incomplete call boundary and freeform tool input for recovery", async () => {
		const store = new ProviderTranscriptStore(taskId, storagePath)
		const history = [
			{ role: "user", content: "request" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call-1", name: "apply_patch", input: "*** Begin Patch" }],
			},
		] as ApiMessage[]
		await store.commit(history)
		expect((await store.read()).messages).toEqual(history)
	})

	it("keeps verified persisted bytes and digest intact when projecting a hydrated legacy patch transaction", async () => {
		const store = new ProviderTranscriptStore(taskId, storagePath)
		const patch =
			'*** Begin Patch\r\n*** Add File: file.txt\r\n+const path = "C:\\work\\file.txt"\r\n*** End Patch\n'
		const history = [
			{ type: "reasoning", encrypted_content: "synthetic-encrypted", summary: [], id: "reasoning-1" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "patch-call", name: "apply_patch", input: patch }],
				provider_state: { opaque: [1, 2] },
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_call_id: "patch-call",
						content: "Error: cancelled",
						is_error: true,
						status: "cancelled",
					},
				],
			},
		] as unknown as ApiMessage[]
		const receipt = await store.commit(history)
		const filePath = await store.getFilePath()
		const beforeBytes = await fs.readFile(filePath)
		const hydrated = await store.read()
		const beforeMessages = structuredClone(hydrated.messages)

		expect(buildOpenAiResponsesInput("", [], hydrated.messages, false)).toContainEqual({
			type: "custom_tool_call",
			call_id: "patch-call",
			name: "apply_patch",
			input: patch,
		})
		expect(buildOpenAiResponsesInput("", [], hydrated.messages, false)).toContainEqual({
			type: "custom_tool_call_output",
			call_id: "patch-call",
			output: "Error: cancelled",
		})
		expect(hydrated.messages).toEqual(beforeMessages)
		expect(hydrated.messages).toEqual(history)
		expect(await fs.readFile(filePath)).toEqual(beforeBytes)
		expect(await store.hasCommitReceipt(receipt)).toBe(true)
		expect((await store.read()).digest).toBe(digestProviderTranscript(history))
	})

	it("quarantines a corrupt envelope and rebuilds it from the authoritative transcript", async () => {
		const store = new ProviderTranscriptStore(taskId, storagePath, { now: () => 456 })
		const filePath = await store.getFilePath()
		await fs.writeFile(filePath, "{not-json", "utf8")

		await expect(store.read()).rejects.toMatchObject({ code: "invalid_envelope" })
		const receipt = await store.repairFromAuthoritativeTranscript(messages("recovered"))

		expect(receipt).toMatchObject({ taskId, revision: 1, writtenAt: 456 })
		expect((await store.read()).messages).toEqual(messages("recovered"))
		const files = await fs.readdir(path.dirname(filePath))
		expect(files.some((file) => file.startsWith(`${GlobalFileNames.providerTranscript}.corrupt_`))).toBe(true)
	})

	it("repairs a digest mismatch without losing the legacy-authoritative snapshot", async () => {
		const store = new ProviderTranscriptStore(taskId, storagePath)
		await store.commit(messages("old"))
		const filePath = await store.getFilePath()
		const envelope = JSON.parse(await fs.readFile(filePath, "utf8"))
		envelope.messages = messages("tampered")
		await fs.writeFile(filePath, JSON.stringify(envelope), "utf8")

		const receipt = await store.repairFromAuthoritativeTranscript(messages("legacy-authority"))
		expect(receipt.revision).toBe(1)
		expect((await store.read()).messages).toEqual(messages("legacy-authority"))
	})

	it("supports compare-and-swap revisions and returns receipts only after commit", async () => {
		const store = new ProviderTranscriptStore(taskId, storagePath)
		const first = await store.commit(messages("one"))
		await expect(store.commit(messages("stale"), 0)).rejects.toBeInstanceOf(ProviderTranscriptRevisionConflictError)
		const second = await store.commit(messages("two"), first.revision)

		expect(second.revision).toBe(2)
		await expect(store.verifyCommitReceipt(first)).rejects.toMatchObject({ code: "receipt_mismatch" })
		expect(await store.hasCommitReceipt(second)).toBe(true)
	})

	it("serializes concurrent commits into unique revisions", async () => {
		const storeA = new ProviderTranscriptStore(taskId, storagePath)
		const storeB = new ProviderTranscriptStore(taskId, storagePath)
		const [first, second] = await Promise.all([storeA.commit(messages("a")), storeB.commit(messages("b"))])

		expect(new Set([first.revision, second.revision])).toEqual(new Set([1, 2]))
		const envelope = await storeA.read()
		expect(envelope.revision).toBe(2)
	})
})
