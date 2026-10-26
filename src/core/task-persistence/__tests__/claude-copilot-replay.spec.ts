import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { convertToVsCodeLmMessages } from "../../../api/transform/vscode-lm-format"
import { AgentResponseAccumulator } from "../../agent/AgentResponseAccumulator"
import { readApiMessages, saveApiMessages, type ApiMessage } from "../apiMessages"
import { buildCanonicalAssistantHistoryContent } from "../canonicalAssistantHistory"
import { ProviderTranscriptStore } from "../ProviderTranscriptStore"

vi.mock("vscode", async (importOriginal) => {
	const original = await importOriginal<typeof import("vscode")>()
	class LanguageModelTextPart {
		constructor(public value: string) {}
	}
	class LanguageModelThinkingPart {
		constructor(
			public value: string | string[],
			public id?: string,
			public metadata?: Record<string, unknown>,
		) {}
	}
	class LanguageModelToolCallPart {
		constructor(
			public callId: string,
			public name: string,
			public input: object,
		) {}
	}
	class LanguageModelToolResultPart {
		constructor(
			public callId: string,
			public content: LanguageModelTextPart[],
		) {}
	}
	return {
		...original,
		LanguageModelTextPart,
		LanguageModelThinkingPart,
		LanguageModelToolCallPart,
		LanguageModelToolResultPart,
		LanguageModelChatMessage: {
			User: (content: unknown) => ({ role: "user", content }),
			Assistant: (content: unknown) => ({ role: "assistant", content }),
		},
	}
})

describe("Claude Copilot durable tool-step replay", () => {
	let storagePath: string
	const taskId = "claude-copilot-replay"

	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-claude-replay-"))
	})

	afterEach(async () => {
		await fs.rm(storagePath, { recursive: true, force: true })
	})

	it("replays a cold authoritative commit with encrypted thinking and exactly paired tool receipts", async () => {
		const provenance = { modelId: "claude-sonnet-4.5", modelVendor: "copilot", modelVersion: "1" }
		const thinking = {
			value: ["Inspecting the file.", "Checking the requested change."],
			id: "claude-thinking-1",
			metadata: {
				encrypted_content: "synthetic-opaque+/=\r\n",
				vscode_thinking_origin_api: "messages",
			},
			...provenance,
		}
		const completion = {
			value: "",
			id: "",
			metadata: { vscode_reasoning_done: true, vscode_thinking_origin_api: "messages" },
			...provenance,
		}
		const accumulator = new AgentResponseAccumulator()
		await accumulator.add({ type: "reasoning", text: thinking.value.join("\n"), vscodeLmThinking: thinking })
		await accumulator.add({ type: "text", text: "Checking the file before changing it." })
		await accumulator.add({
			type: "tool_call",
			id: "claude-read-1",
			name: "exec_command",
			arguments: '{"cmd":"node inspect.cjs"}',
		})
		await accumulator.add({
			type: "tool_call",
			id: "claude-patch-1",
			name: "apply_patch",
			arguments: '{"patch":"*** Begin Patch\\n*** End Patch"}',
		})
		await accumulator.add({ type: "reasoning", text: "", vscodeLmThinking: completion })
		const response = await accumulator.finish()
		const history: ApiMessage[] = [
			{ role: "user", content: "Inspect the fixture, then apply the requested change." },
			{
				role: "assistant",
				content: buildCanonicalAssistantHistoryContent(response),
				agentResponseItems: response.items,
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "claude-read-1", content: "Fixture inspected." },
					{
						type: "tool_result",
						tool_use_id: "claude-patch-1",
						content: "Error: cancelled before the patch was applied.",
						is_error: true,
					},
				],
			},
		]
		const expectedHistory = structuredClone(history)
		const authority = await saveApiMessages({ taskId, globalStoragePath: storagePath, messages: history })
		const commit = await new ProviderTranscriptStore(taskId, storagePath).commitAuthoritativeTranscript(authority)
		const beforeBytes = await fs.readFile(authority.filePath)

		// Both readers are fresh: replay must use the committed file, not the accumulator or an in-memory cache.
		const restored = await readApiMessages({ taskId, globalStoragePath: storagePath })
		const coldStore = new ProviderTranscriptStore(taskId, storagePath)
		expect((await coldStore.read()).messages).toEqual(expectedHistory)
		expect(restored).toEqual(expectedHistory)
		const request = convertToVsCodeLmMessages(restored)
		expect(request[1].content).toEqual([
			{ value: thinking.value, id: thinking.id, metadata: thinking.metadata },
			{ value: "Checking the file before changing it." },
			{ callId: "claude-read-1", name: "exec_command", input: { cmd: "node inspect.cjs" } },
			{ callId: "claude-patch-1", name: "apply_patch", input: { patch: "*** Begin Patch\n*** End Patch" } },
			{ value: "", id: completion.id, metadata: completion.metadata },
		])
		expect(request[2].content).toEqual([
			{ callId: "claude-read-1", content: [{ value: "Fixture inspected." }] },
			{
				callId: "claude-patch-1",
				content: [{ value: "Error: cancelled before the patch was applied." }],
			},
		])
		expect(restored).toEqual(expectedHistory)
		expect(history).toEqual(expectedHistory)
		expect(await fs.readFile(authority.filePath)).toEqual(beforeBytes)
		expect(await coldStore.hasCommitReceipt(commit)).toBe(true)
	})
})
