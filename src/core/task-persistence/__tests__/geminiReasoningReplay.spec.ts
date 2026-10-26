import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { Anthropic } from "@anthropic-ai/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AgentResponseAccumulator } from "../../agent/AgentResponseAccumulator"
import { Task } from "../../task/Task"
import type { ApiMessage } from "../apiMessages"
import { buildCanonicalAssistantHistoryContent } from "../canonicalAssistantHistory"
import { ProviderTranscriptStore } from "../ProviderTranscriptStore"
import {
	getEffectiveApiHistory,
	getLogicalStepStarts,
	hasToolCallResultIntegrity,
	selectRecentTail,
} from "../../condense"
import { BaseProvider } from "../../../api/providers/base-provider"
import type { ApiStream } from "../../../api/transform/stream"
import { convertAnthropicMessagesToGemini } from "../../../api/transform/gemini-format"

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: async (globalStoragePath: string, taskId: string) => {
		const taskDirectory = path.join(globalStoragePath, taskId)
		await fs.mkdir(taskDirectory, { recursive: true })
		return taskDirectory
	},
}))

const modelId = "gemini-4-argon"
const geminiResponse = {
	modelId,
	parts: [
		{ text: "Checking.", thoughtSignature: "text-signature+/=\r\n" },
		{ text: "Private summary.", thought: true, thoughtSignature: "thought-signature" },
		{
			functionCall: { id: "call-1", name: "read_file", args: { path: "a.ts" } },
			thoughtSignature: "call-signature",
		},
	],
}

interface TaskHistoryBridge {
	apiConversationHistory: ApiMessage[]
	addToApiConversationHistory(message: Anthropic.MessageParam, reasoning?: string): Promise<boolean>
	buildCleanConversationHistory(messages: ApiMessage[]): Anthropic.MessageParam[]
}

function taskHistoryBridge(provider = "gemini"): TaskHistoryBridge {
	const configuration = { apiProvider: provider, apiModelId: modelId }
	return Object.assign(Object.create(Task.prototype), {
		api: {
			getModel: () => ({ id: modelId, info: { contextWindow: 1_048_576, supportsPromptCache: true } }),
			getThoughtSignature: () => "legacy-last-signature",
		},
		apiConfiguration: configuration,
		effectiveApiConfiguration: configuration,
		apiConversationHistory: [],
		saveApiConversationHistory: vi.fn(async () => true),
		settleAllPersistedWaitAgentResultClaims: vi.fn(async () => undefined),
	}) as TaskHistoryBridge
}

class TokenCountProvider extends BaseProvider {
	async *createMessage(): ApiStream {
		yield { type: "text", text: "Unused summary fixture." }
	}
	getModel() {
		return { id: modelId, info: { contextWindow: 1_048_576, supportsPromptCache: true } }
	}
	override async countTokens(content: Anthropic.ContentBlockParam[]) {
		return Math.ceil(JSON.stringify(content).length / 4)
	}
}

async function toolTurn(task = taskHistoryBridge()): Promise<TaskHistoryBridge> {
	const accumulator = new AgentResponseAccumulator()
	await accumulator.add({ type: "text", text: "Checking." })
	await accumulator.add({ type: "reasoning", text: "Private summary." })
	await accumulator.add({ type: "tool_call", id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' })
	await accumulator.add({ type: "reasoning", text: "", geminiResponse })
	const response = await accumulator.finish()
	expect(
		await task.addToApiConversationHistory(
			{ role: "assistant", content: buildCanonicalAssistantHistoryContent(response) },
			response.reasoning,
		),
	).toBe(true)
	await task.addToApiConversationHistory({
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "call-1", content: "File contents." }],
	})
	return task
}

describe("Gemini reasoning reload and compaction", () => {
	const temporaryDirectories: string[] = []
	afterEach(async () => {
		for (const directory of temporaryDirectories.splice(0)) {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("persists one canonical replay unit and reloads exact provider parts with the tool result", async () => {
		const task = await toolTurn()
		const content = task.apiConversationHistory[0].content
		expect(content).toEqual([
			{ type: "text", text: "Checking." },
			{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
			{ type: "gemini_response", geminiResponse },
		])
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-replay-"))
		temporaryDirectories.push(directory)
		await new ProviderTranscriptStore("gemini-replay", directory).commit(task.apiConversationHistory)
		const reloaded = await new ProviderTranscriptStore("gemini-replay", directory).readMessages()
		expect(reloaded).toEqual(task.apiConversationHistory)
		const request = convertAnthropicMessagesToGemini(task.buildCleanConversationHistory(reloaded), { modelId })
		expect(request[0]).toEqual({ role: "model", parts: geminiResponse.parts })
		expect(request[1].parts).toEqual([
			{
				functionResponse: {
					id: "call-1",
					name: "read_file",
					response: { name: "read_file", content: "File contents." },
				},
			},
		])
	})

	it("retains exact Gemini state with its complete tool transaction at a safe compaction boundary", async () => {
		const task = await toolTurn()
		const messages: ApiMessage[] = [
			{ role: "user", content: "Original task" },
			{ role: "assistant", content: "Earlier work. ".repeat(2_000), condenseParent: "summary" },
			{ role: "user", content: "Inspect a.ts" },
			...task.apiConversationHistory,
		]
		expect(hasToolCallResultIntegrity(messages)).toBe(true)
		expect(getLogicalStepStarts(messages)).toEqual([0, 2])
		const selection = await selectRecentTail(messages, new TokenCountProvider(), 1_000)
		expect(selection.startIndex).toBe(2)
		const compacted: ApiMessage[] = [
			...messages.slice(0, 2),
			{ role: "assistant", content: "Earlier work summarized.", isSummary: true, condenseId: "summary" },
			...messages.slice(selection.startIndex),
		]
		const effective = getEffectiveApiHistory(compacted)
		expect(effective.at(-2)?.content).toEqual(task.apiConversationHistory[0].content)
		expect(hasToolCallResultIntegrity(effective)).toBe(true)
		const request = convertAnthropicMessagesToGemini(task.buildCleanConversationHistory(effective), { modelId })
		expect(request.find((message) => message.parts?.some((part) => part.functionCall))?.parts).toEqual(
			geminiResponse.parts,
		)
	})

	it("keeps opaque Gemini replay out of other provider requests without rewriting saved history", async () => {
		const task = await toolTurn()
		const saved = structuredClone(task.apiConversationHistory)
		const otherProvider = taskHistoryBridge("openai")
		expect(otherProvider.buildCleanConversationHistory(saved)[0].content).toEqual([
			{ type: "text", text: "Checking." },
			{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
		])
		expect(saved).toEqual(task.apiConversationHistory)
	})
})
