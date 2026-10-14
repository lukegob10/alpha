// cd src && npx vitest run core/task-persistence/__tests__/apiMessages.spec.ts

import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"

import { readApiMessages, saveApiMessages, type ApiMessage } from "../apiMessages"
import { ProviderTranscriptStoreError } from "../ProviderTranscriptStore"

let tmpBaseDir: string

beforeEach(async () => {
	tmpBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-test-api-"))
})

describe("apiMessages.readApiMessages", () => {
	it("rejects invalid JSON without replacing the API history", async () => {
		const taskId = "task-corrupt-api"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "api_conversation_history.json")
		await fs.writeFile(filePath, "<<<corrupt data>>>", "utf8")

		const read = readApiMessages({
			taskId,
			globalStoragePath: tmpBaseDir,
		})

		await expect(read).rejects.toMatchObject({ code: "invalid_messages" })
		expect(await fs.readFile(filePath, "utf8")).toBe("<<<corrupt data>>>")
	})

	it("rejects invalid fallback JSON and retains the legacy file", async () => {
		const taskId = "task-corrupt-fallback"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })

		// Only write the old fallback file (claude_messages.json), NOT the new one
		const oldPath = path.join(taskDir, "claude_messages.json")
		await fs.writeFile(oldPath, "not json at all {[!", "utf8")

		const read = readApiMessages({
			taskId,
			globalStoragePath: tmpBaseDir,
		})

		await expect(read).rejects.toBeInstanceOf(ProviderTranscriptStoreError)

		// The corrupted fallback file should NOT be deleted
		const stillExists = await fs
			.access(oldPath)
			.then(() => true)
			.catch(() => false)
		expect(stillExists).toBe(true)
	})

	it("rejects a non-array API history", async () => {
		const taskId = "task-non-array-api"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "api_conversation_history.json")
		await fs.writeFile(filePath, JSON.stringify("hello"), "utf8")

		const read = readApiMessages({
			taskId,
			globalStoragePath: tmpBaseDir,
		})

		await expect(read).rejects.toMatchObject({ code: "invalid_messages" })
	})

	it("rejects a non-array fallback without migrating it", async () => {
		const taskId = "task-non-array-fallback"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })

		// Only write the old fallback file, NOT the new one
		const oldPath = path.join(taskDir, "claude_messages.json")
		await fs.writeFile(oldPath, JSON.stringify({ key: "value" }), "utf8")

		const read = readApiMessages({
			taskId,
			globalStoragePath: tmpBaseDir,
		})

		await expect(read).rejects.toMatchObject({ code: "invalid_messages" })
		expect(await fs.readFile(oldPath, "utf8")).toBe(JSON.stringify({ key: "value" }))
	})

	it.each([
		["unknown role", [{ role: "tool", content: "orphan" }]],
		["missing content", [{ role: "assistant" }]],
		["untyped content block", [{ role: "user", content: [{}] }]],
		["invalid reasoning record", [{ type: "reasoning", encrypted_content: 7 }]],
		[
			"invalid embedded encrypted reasoning",
			[{ role: "assistant", content: [{ type: "reasoning", encrypted_content: 7 }] }],
		],
		[
			"invalid thinking signature",
			[{ role: "assistant", content: [{ type: "thinking", thinking: "Keep the block.", signature: 7 }] }],
		],
		[
			"invalid thought signature",
			[{ role: "assistant", content: [{ type: "thoughtSignature", thoughtSignature: { opaque: true } }] }],
		],
		[
			"missing tool input",
			[{ role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read_file" }] }],
		],
	])("rejects %s in persisted API history", async (_case, messages) => {
		const taskId = "task-malformed-api"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "api_conversation_history.json")
		const contents = JSON.stringify(messages)
		await fs.writeFile(filePath, contents, "utf8")

		await expect(readApiMessages({ taskId, globalStoragePath: tmpBaseDir })).rejects.toMatchObject({
			code: "invalid_messages",
		})
		expect(await fs.readFile(filePath, "utf8")).toBe(contents)
	})

	it("round-trips ordered reasoning blocks and opaque provider metadata", async () => {
		const taskId = "task-reasoning-continuity"
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "reasoning", encrypted_content: "encrypted-1", id: "rs-1", summary: [] },
					{ type: "reasoning", encrypted_content: "encrypted-2", id: "rs-2", summary: [] },
					{ type: "thinking", thinking: "First block.", signature: "first-signature" },
					{ type: "thinking", thinking: "Second block.", signature: "second-signature" },
					{ type: "redacted_thinking", data: "opaque-redacted" },
					{ type: "thoughtSignature", thoughtSignature: "gemini-signature" },
					{ type: "future_provider_block", opaque: { state: [1, 2] } },
					{ type: "text", text: "Answer." },
				],
				reasoning_details: [{ type: "future_provider_reasoning", opaque: { state: [1, 2] } }],
				reasoning_content: "interleaved reasoning",
				provider_state: { opaque: [1, 2] },
			},
		] as unknown as ApiMessage[]

		await saveApiMessages({ taskId, globalStoragePath: tmpBaseDir, messages })

		expect(await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })).toEqual(messages)
	})

	it.each(["tool_use_id", "tool_call_id"] as const)(
		"round-trips freeform patch input and its failed %s terminal result without changing either payload",
		async (resultIdField) => {
			const taskId = "task-freeform-patch-continuity"
			const patch =
				'*** Begin Patch\n*** Add File: quoted-path.txt\n+const path = "C:\\workspace\\file.txt"\n*** End Patch'
			const messages = [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "legacy-patch-call", name: "apply_patch", input: patch }],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							[resultIdField]: "legacy-patch-call",
							content: "Patch rejected: the file changed after capture.",
							is_error: true,
						},
					],
				},
			] as unknown as ApiMessage[]
			const before = structuredClone(messages)

			await saveApiMessages({ taskId, globalStoragePath: tmpBaseDir, messages })
			const restored = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })

			expect(restored).toEqual(before)
			expect(messages).toEqual(before)
		},
	)

	it("rejects a malformed continuity rewrite before replacing valid history", async () => {
		const taskId = "task-invalid-reasoning-rewrite"
		await saveApiMessages({
			taskId,
			globalStoragePath: tmpBaseDir,
			messages: [{ role: "assistant", content: "Keep the saved answer." }],
		})
		const filePath = path.join(tmpBaseDir, "tasks", taskId, "api_conversation_history.json")
		const contents = await fs.readFile(filePath, "utf8")
		const malformed = [
			{ role: "assistant", content: [{ type: "reasoning", encrypted_content: 7 }] },
		] as unknown as ApiMessage[]

		await expect(
			saveApiMessages({ taskId, globalStoragePath: tmpBaseDir, messages: malformed }),
		).rejects.toMatchObject({ code: "invalid_messages" })
		expect(await fs.readFile(filePath, "utf8")).toBe(contents)
	})

	it.each([
		{ type: "tool_use", id: "first", tool_call_id: "other", name: "read_file", input: {} },
		{ type: "tool_result", tool_use_id: "first", tool_call_id: "other", content: "Error: denied", is_error: true },
	])("rejects conflicting tool aliases without replacing the last valid transcript (%j)", async (block) => {
		const taskId = "task-conflicting-tool-aliases"
		await saveApiMessages({
			taskId,
			globalStoragePath: tmpBaseDir,
			messages: [{ role: "assistant", content: "Preserve this answer." }],
		})
		const filePath = path.join(tmpBaseDir, "tasks", taskId, "api_conversation_history.json")
		const beforeBytes = await fs.readFile(filePath)
		await expect(
			saveApiMessages({
				taskId,
				globalStoragePath: tmpBaseDir,
				messages: [{ role: "user", content: [block] }] as unknown as ApiMessage[],
			}),
		).rejects.toMatchObject({ code: "invalid_messages" })
		expect(await fs.readFile(filePath)).toEqual(beforeBytes)
	})

	it("preserves valid completion-hook provenance in persisted API history", async () => {
		const taskId = "task-hook-provenance"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "api_conversation_history.json")
		const messages = [
			{
				role: "user",
				content: "Recheck the result.",
				hook_prompt: {
					event: "Stop",
					fragments: [{ hook_run_id: "hook-run-1", text: "Recheck the result." }],
				},
			},
		]
		await fs.writeFile(filePath, JSON.stringify(messages), "utf8")

		expect(await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })).toEqual(messages)
	})

	it.each([
		["event", { event: "Unknown", fragments: [{ hook_run_id: "run-1", text: "Check again." }] }],
		["fragments", { event: "Stop", fragments: [] }],
		["run ID", { event: "Stop", fragments: [{ hook_run_id: "", text: "Check again." }] }],
		["text", { event: "Stop", fragments: [{ hook_run_id: "run-1", text: "  " }] }],
	])("rejects malformed completion-hook provenance (%s)", async (_case, hook_prompt) => {
		const taskId = "task-malformed-hook-provenance"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const filePath = path.join(taskDir, "api_conversation_history.json")
		const messages = [{ role: "user", content: "Recheck the result.", hook_prompt }]
		const contents = JSON.stringify(messages)
		await fs.writeFile(filePath, contents, "utf8")

		await expect(readApiMessages({ taskId, globalStoragePath: tmpBaseDir })).rejects.toMatchObject({
			code: "invalid_messages",
		})
		expect(await fs.readFile(filePath, "utf8")).toBe(contents)
	})

	it("migrates valid fallback history before removing the legacy file", async () => {
		const taskId = "task-valid-fallback"
		const taskDir = path.join(tmpBaseDir, "tasks", taskId)
		await fs.mkdir(taskDir, { recursive: true })
		const oldPath = path.join(taskDir, "claude_messages.json")
		const newPath = path.join(taskDir, "api_conversation_history.json")
		const messages = [
			{ role: "user", content: [{ type: "text", text: "keep me" }] },
			{ role: "assistant", content: [{ type: "text", text: "kept" }] },
		]
		await fs.writeFile(oldPath, JSON.stringify(messages), "utf8")

		const firstRead = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })
		const secondRead = await readApiMessages({ taskId, globalStoragePath: tmpBaseDir })

		expect(firstRead).toEqual(messages)
		expect(secondRead).toEqual(messages)
		expect(JSON.parse(await fs.readFile(newPath, "utf8"))).toEqual(messages)
		await expect(fs.access(oldPath)).rejects.toMatchObject({ code: "ENOENT" })
	})
})
