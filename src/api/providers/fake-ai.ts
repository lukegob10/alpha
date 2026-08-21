import { Anthropic } from "@anthropic-ai/sdk"

import type { ModelInfo } from "@alpha-code/types"

import type { ApiHandler, SingleCompletionHandler, ApiHandlerCreateMessageMetadata } from "../index"
import type { ApiHandlerOptions } from "../../shared/api"
import { ApiStream } from "../transform/stream"

interface FakeAI {
	/**
	 * The unique identifier for the FakeAI instance.
	 * It is used to lookup the original FakeAI object in the fakeAiMap
	 * when the fakeAI object is read from the VSCode global state.
	 */
	readonly id: string

	/**
	 * A function set by the FakeAIHandler on the FakeAI instance, that removes
	 * the FakeAI instance from the fakeAIMap when the FakeAI instance is
	 * no longer needed.
	 */
	removeFromCache?: () => void

	createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream
	getModel(): { id: string; info: ModelInfo }
	countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number>
	completePrompt(prompt: string): Promise<string>
}

/**
 * API providers configuration is stored in the VSCode global state.
 * Therefore, when a new task is created, the FakeAI object in the configuration
 * is a new object not related to the original one, but with the same ID.
 *
 * We use the ID to lookup the original FakeAI object in the mapping.
 */
let fakeAiMap: Map<string, FakeAI> = new Map()

const isFakeAIImplementation = (value: unknown): value is FakeAI => {
	if (!value || typeof value !== "object") return false
	const candidate = value as Partial<FakeAI>
	return (
		typeof candidate.id === "string" &&
		typeof candidate.createMessage === "function" &&
		typeof candidate.getModel === "function" &&
		typeof candidate.countTokens === "function" &&
		typeof candidate.completePrompt === "function"
	)
}

export class FakeAIHandler implements ApiHandler, SingleCompletionHandler {
	private ai: FakeAI

	constructor(options: ApiHandlerOptions) {
		const optionsFakeAi = options.fakeAi as Partial<FakeAI> | undefined
		const id = optionsFakeAi?.id
		if (typeof id !== "string" || id.length === 0) {
			throw new Error("Fake AI is not set")
		}

		if (isFakeAIImplementation(optionsFakeAi)) {
			optionsFakeAi.removeFromCache = () => {
				if (fakeAiMap.get(id) === optionsFakeAi) fakeAiMap.delete(id)
			}
			fakeAiMap.set(id, optionsFakeAi)
			this.ai = optionsFakeAi
			return
		}

		const cachedFakeAi = fakeAiMap.get(id)
		if (!cachedFakeAi) {
			throw new Error(`Fake AI implementation ${id} is not registered in this extension host`)
		}
		this.ai = cachedFakeAi
	}

	async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		yield* this.ai.createMessage(systemPrompt, messages, metadata)
	}

	getModel(): { id: string; info: ModelInfo } {
		return this.ai.getModel()
	}

	countTokens(content: Array<Anthropic.Messages.ContentBlockParam>): Promise<number> {
		return this.ai.countTokens(content)
	}

	completePrompt(prompt: string): Promise<string> {
		return this.ai.completePrompt(prompt)
	}
}
