import crypto from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { readApiMessages } from "../apiMessages"
import { ProviderTranscriptStore } from "../ProviderTranscriptStore"
import { recoverApiMessages } from "../recoverApiMessages"

vi.mock("fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("fs/promises")>()
	return { ...original, lstat: vi.fn(original.lstat) }
})

let directory: string
const taskId = "recovery"
let filePath: string

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-explicit-recovery-"))
	await fs.mkdir(path.join(directory, "tasks", taskId), { recursive: true })
	filePath = path.join(directory, "tasks", taskId, "api_conversation_history.json")
})

afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true })
})

async function recover(source: string, discardMessageIndexes = [1]) {
	await fs.writeFile(filePath, source)
	return recoverApiMessages({
		taskId,
		globalStoragePath: directory,
		expectedDigest: crypto.createHash("sha256").update(source).digest("hex"),
		discardMessageIndexes,
	})
}

it("requires explicit recovery, preserves exact original bytes, tool pairs and opaque provider state", async () => {
	const retained = [
		{ role: "user", content: "Inspect this file" },
		{
			role: "assistant",
			provider_state_scope: { provider: "anthropic", modelId: "model" },
			content: [
				{ type: "thinking", thinking: "reasoning", signature: "opaque-signature" },
				{ type: "tool_use", id: "call", name: "read_file", input: { path: "a" } },
			],
		},
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "file content" }] },
	]
	const source = JSON.stringify([
		retained[0],
		{ role: "unsupported", content: "invalid record" },
		...retained.slice(1),
	])
	await fs.writeFile(filePath, source)
	await expect(readApiMessages({ taskId, globalStoragePath: directory })).rejects.toMatchObject({
		code: "invalid_messages",
	})
	const result = await recover(source)
	expect(await fs.readFile(result.archivePath, "utf8")).toBe(source)
	expect(result.messages).toEqual(retained)
	expect(await readApiMessages({ taskId, globalStoragePath: directory })).toEqual(retained)
	const store = new ProviderTranscriptStore(taskId, directory)
	await store.repairAuthoritativeTranscript(result.receipt)
	expect((await store.read()).messages).toEqual(retained)
})

it.each([
	["truncated JSON", '[{"role":"user","content":"hello"},'],
	[
		"valid record deletion",
		JSON.stringify([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "ok" },
		]),
	],
	["empty candidate", JSON.stringify([{ role: "unknown" }])],
	[
		"incomplete tool call",
		JSON.stringify([
			{ role: "assistant", content: [{ type: "tool_use", id: "call", name: "write_file", input: {} }] },
			{ role: "unknown" },
		]),
	],
	[
		"discarded transaction evidence",
		JSON.stringify([
			{ role: "user", content: "hello" },
			{ role: "unknown", content: [{ type: "tool_result", tool_use_id: "call" }] },
		]),
	],
	[
		"discarded provenance",
		JSON.stringify([
			{ role: "user", content: "hello" },
			{ role: "unknown", provider_state_scope: { provider: "x", modelId: "y" } },
		]),
	],
	[
		"orphaned result",
		JSON.stringify([
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call", content: "x" }] },
			{ role: "unknown" },
		]),
	],
])("retains the original and does not publish a candidate for %s", async (_label, source) => {
	await expect(recover(source, _label === "empty candidate" ? [0] : [1])).rejects.toMatchObject({
		code: "invalid_messages",
	})
	expect(await fs.readFile(filePath, "utf8")).toBe(source)
	expect(await fs.readdir(path.dirname(filePath))).toEqual([path.basename(filePath)])
})

it("refuses a conflicting archive without replacing original history or archive evidence", async () => {
	const source = JSON.stringify([{ role: "user", content: "hello" }, null])
	const digest = crypto.createHash("sha256").update(source).digest("hex")
	const archivePath = path.join(path.dirname(filePath), `api_conversation_history.recovery-${digest}.json`)
	await fs.writeFile(archivePath, "previous evidence")
	await expect(recover(source)).rejects.toThrow("Recovery archive verification failed")
	expect(await fs.readFile(filePath, "utf8")).toBe(source)
	expect(await fs.readFile(archivePath, "utf8")).toBe("previous evidence")
})

it("refuses a planted archive symlink that would follow replacement of the authoritative file", async () => {
	const source = JSON.stringify([{ role: "user", content: "hello" }, null])
	const digest = crypto.createHash("sha256").update(source).digest("hex")
	const archivePath = path.join(path.dirname(filePath), `api_conversation_history.recovery-${digest}.json`)
	await fs.writeFile(filePath, source)
	// Mock only the planted directory entry: Windows may require administrator rights for real symlinks.
	const entry = await fs.lstat(filePath, { bigint: true })
	const lstat = vi
		.mocked(fs.lstat)
		.mockResolvedValueOnce(Object.assign(entry, { isFile: () => false, isSymbolicLink: () => true }))
	await fs.writeFile(archivePath, source)
	try {
		await expect(recover(source)).rejects.toThrow("Recovery archive must be an independent regular file")
		expect(await fs.readFile(filePath, "utf8")).toBe(source)
	} finally {
		lstat.mockRestore()
	}
})

it("rejects stale inspection without touching concurrent edits", async () => {
	await fs.writeFile(filePath, "concurrent edit")
	await expect(
		recoverApiMessages({
			taskId,
			globalStoragePath: directory,
			expectedDigest: "0".repeat(64),
			discardMessageIndexes: [1],
		}),
	).rejects.toMatchObject({ code: "digest_mismatch" })
	expect(await fs.readFile(filePath, "utf8")).toBe("concurrent edit")
})
