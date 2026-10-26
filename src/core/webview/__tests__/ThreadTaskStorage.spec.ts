import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { saveApiMessages, type ApiMessage } from "../../task-persistence/apiMessages"
import { digestProviderTranscript, ProviderTranscriptStore } from "../../task-persistence/ProviderTranscriptStore"
import { readThreadApiMessages } from "../ThreadTaskStorage"

describe("readThreadApiMessages", () => {
	let storagePath: string
	let directory: string
	const taskId = "saved-thread"
	const messages: ApiMessage[] = [
		{ role: "user", content: "Original request" },
		{ role: "assistant", content: "Original answer", phase: "final_answer" },
	]

	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-thread-history-"))
		directory = path.join(storagePath, "tasks", taskId)
		await fs.mkdir(directory, { recursive: true })
	})

	afterEach(async () => {
		await fs.rm(storagePath, { recursive: true, force: true })
	})

	it.each([false, true])(
		"rejects missing v2 authoritative bytes with a stale Claude fallback: %s",
		async (fallback) => {
			const receipt = await saveApiMessages({ taskId, globalStoragePath: storagePath, messages })
			await new ProviderTranscriptStore(taskId, storagePath).commitAuthoritativeTranscript(receipt)
			const sidecar = path.join(directory, "provider_transcript.json")
			const sidecarBefore = await fs.readFile(sidecar, "utf8")
			await fs.unlink(path.join(directory, "api_conversation_history.json"))
			const legacyPath = path.join(directory, "claude_messages.json")
			const stale = JSON.stringify([{ role: "user", content: "Stale prefix" }])
			if (fallback) await fs.writeFile(legacyPath, stale)
			const filesBefore = await fs.readdir(directory)

			await expect(readThreadApiMessages(taskId, storagePath)).rejects.toThrow(/authoritative.*missing/i)

			expect(await fs.readFile(sidecar, "utf8")).toBe(sidecarBefore)
			expect(await fs.readdir(directory)).toEqual(filesBefore)
			if (fallback) expect(await fs.readFile(legacyPath, "utf8")).toBe(stale)
		},
	)

	it("retains canonical authority when old Claude history also exists", async () => {
		const receipt = await saveApiMessages({ taskId, globalStoragePath: storagePath, messages })
		await new ProviderTranscriptStore(taskId, storagePath).commitAuthoritativeTranscript(receipt)
		await fs.writeFile(
			path.join(directory, "claude_messages.json"),
			JSON.stringify([{ role: "user", content: "Stale prefix" }]),
		)

		await expect(readThreadApiMessages(taskId, storagePath)).resolves.toEqual(messages)
	})

	it.each(["claude", "v1"] as const)("reads %s fallback without migrating its source", async (source) => {
		const file = path.join(directory, source === "claude" ? "claude_messages.json" : "provider_transcript.json")
		const contents = JSON.stringify(
			source === "claude"
				? messages
				: {
						version: 1,
						taskId,
						revision: 1,
						digest: digestProviderTranscript(messages),
						writtenAt: 1,
						messages,
					},
		)
		await fs.writeFile(file, contents)

		await expect(readThreadApiMessages(taskId, storagePath)).resolves.toEqual(messages)

		expect(await fs.readFile(file, "utf8")).toBe(contents)
		expect(await fs.readdir(directory)).toEqual([path.basename(file)])
	})

	it("skips oversized background evidence before reading or parsing it", async () => {
		const file = path.join(directory, "api_conversation_history.json")
		const backgroundLimit = 8 * 1024 * 1024
		const largeMessages: ApiMessage[] = [{ role: "user", content: "x".repeat(backgroundLimit) }]
		await fs.writeFile(file, JSON.stringify(largeMessages))
		const open = vi.spyOn(fs, "open")
		await expect(
			readThreadApiMessages(taskId, storagePath, undefined, { maxBytes: backgroundLimit }),
		).rejects.toThrow(/supported read size/i)
		expect(open).not.toHaveBeenCalled()
		open.mockRestore()
		const unbounded = await readThreadApiMessages(taskId, storagePath)
		expect(unbounded).toHaveLength(1)
		expect(unbounded[0].content).toHaveLength(backgroundLimit)
	})

	it.each(["api_conversation_history.json", "claude_messages.json"])(
		"reads bounded %s evidence without changing the source",
		async (filename) => {
			const file = path.join(directory, filename)
			const contents = JSON.stringify(messages)
			await fs.writeFile(file, contents)
			await expect(readThreadApiMessages(taskId, storagePath, undefined, { maxBytes: 1024 })).resolves.toEqual(
				messages,
			)
			expect(await fs.readFile(file, "utf8")).toBe(contents)
			expect(await fs.readdir(directory)).toEqual([filename])
		},
	)

	it("rejects an invalid v2 identity instead of serving a stale fallback", async () => {
		const receipt = await saveApiMessages({ taskId, globalStoragePath: storagePath, messages })
		const store = new ProviderTranscriptStore(taskId, storagePath)
		const committed = await store.commitAuthoritativeTranscript(receipt)
		await fs.unlink(path.join(directory, "api_conversation_history.json"))
		await fs.writeFile(
			path.join(directory, "provider_transcript.json"),
			JSON.stringify({ ...committed, taskId: "other" }),
		)
		await fs.writeFile(path.join(directory, "claude_messages.json"), JSON.stringify(messages))

		await expect(readThreadApiMessages(taskId, storagePath)).rejects.toThrow(/authoritative.*invalid/i)
	})
})
