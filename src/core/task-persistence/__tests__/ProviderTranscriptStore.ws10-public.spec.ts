import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiMessage } from "../apiMessages"
import { buildOpenAiResponsesInput } from "../../../api/providers/openai-responses"
import type { ApiHandler } from "../../../api"
import { maybeRemoveImageBlocks } from "../../../api/transform/image-cleaning"

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: async (globalStoragePath: string, taskId: string) => {
		const taskDirectory = path.join(globalStoragePath, taskId)
		await fs.mkdir(taskDirectory, { recursive: true })
		return taskDirectory
	},
}))

import { ProviderTranscriptStore, digestProviderTranscript } from "../ProviderTranscriptStore"

const taskId = "transcript-ws10-media"

describe("ProviderTranscriptStore WS10 media projection", () => {
	let storagePath: string

	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "provider-transcript-"))
	})

	afterEach(async () => {
		await fs.rm(storagePath, { recursive: true, force: true })
	})

	it("round-trips paired media for model projections without rewriting history", async () => {
		const store = new ProviderTranscriptStore(taskId, storagePath, { now: () => 456 })
		const terminalReceipt = {
			type: "tool_result",
			tool_use_id: "persisted-media-call",
			is_error: true,
			status: "cancelled",
			metadata: { source: "mcp", sequence: 2 },
			content: [
				{ type: "text", text: "First caption" },
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "Zmlyc3Q=" } },
				{ type: "text", text: "Second caption" },
				{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "c2Vjb25k" } },
			],
		}
		const history = [
			{
				role: "assistant",
				messageId: "persisted-assistant-message",
				provider_state: { opaque: [1, 2] },
				content: [{ type: "tool_use", id: "persisted-media-call", name: "mcp__images__read", input: {} }],
			},
			{ role: "user", ts: 123, content: [terminalReceipt] },
		] as unknown as ApiMessage[]
		const beforeHistory = structuredClone(history)
		const commitReceipt = await store.commit(history)
		const filePath = await store.getFilePath()
		const beforeBytes = await fs.readFile(filePath)
		const hydrated = await store.read()
		const beforeHydrated = structuredClone(hydrated.messages)
		const handler = (supportsImages: boolean): ApiHandler => ({
			getModel: vi.fn().mockReturnValue({ id: "projection-model", info: { supportsImages } }),
			createMessage: vi.fn(),
			countTokens: vi.fn(),
		})

		const textOnly = maybeRemoveImageBlocks(hydrated.messages, handler(false))
		const supported = maybeRemoveImageBlocks(hydrated.messages, handler(true))
		expect(textOnly[1]).toEqual({
			role: "user",
			ts: 123,
			content: [
				{
					...terminalReceipt,
					content: [
						{ type: "text", text: "First caption" },
						{ type: "text", text: "[Referenced image in conversation]" },
						{ type: "text", text: "Second caption" },
						{ type: "text", text: "[Referenced image in conversation]" },
					],
				},
			],
		})
		expect(supported).toEqual(history)
		const textRequest = buildOpenAiResponsesInput("", [], textOnly, false)
		expect(textRequest).toContainEqual({
			type: "function_call_output",
			call_id: "persisted-media-call",
			output: "First caption\n[Referenced image in conversation]\nSecond caption\n[Referenced image in conversation]",
		})
		expect(JSON.stringify(textRequest)).not.toContain("input_image")
		expect(JSON.stringify(textRequest)).not.toContain("Zmlyc3Q=")
		expect(JSON.stringify(textRequest)).not.toContain("c2Vjb25k")
		const supportedRequest = buildOpenAiResponsesInput("", [], supported, false)
		expect(JSON.stringify(supportedRequest)).toContain("data:image/png;base64,Zmlyc3Q=")
		expect(JSON.stringify(supportedRequest)).toContain("data:image/jpeg;base64,c2Vjb25k")
		expect(hydrated.messages).toEqual(beforeHydrated)
		expect(history).toEqual(beforeHistory)
		expect(await fs.readFile(filePath)).toEqual(beforeBytes)
		expect(await store.hasCommitReceipt(commitReceipt)).toBe(true)
		expect((await store.read()).digest).toBe(digestProviderTranscript(history))
	})
})
