import type { Anthropic } from "@anthropic-ai/sdk"
import type { ResponseCreateParamsBase } from "openai/resources/responses/responses"

import type { ApiHandlerOptions } from "../../shared/api"
import type { ApiHandlerCreateMessageMetadata, ApiHandlerSingleCompletionMetadata } from "../index"
import {
	createApiStreamOutcome,
	createLinkedAbortController,
	isApiStreamAbortError,
	type ApiStream,
} from "../transform/stream"
import { ChatGptAuthService } from "../../services/chatgpt/ChatGptAuthService"
import { OpenAiNativeHandler } from "./openai-native"

const TOOL_NAMESPACE = "alpha"

function requestError(error: unknown): unknown {
	if (!(error instanceof Error)) return error
	const source = error as Error & { code?: string; status?: number }
	const permanent =
		source.status === 400 ||
		source.status === 401 ||
		source.status === 403 ||
		[
			"subscription_sharing_user_not_eligible",
			"subscription_sharing_usage_limit_exceeded",
			"subscription_sharing_unsupported_capability",
			"subscription_sharing_route_not_supported",
			"subscription_sharing_invalid_user",
			"chatpass_v2_scope_not_authorized",
			"chatpass_v2_invalid_authorization_context",
		].includes(source.code ?? "")
	return permanent ? Object.assign(error, { retryable: false }) : error
}

/** The persisted provider ID is retained; all inference uses the official public SIWC route. */
export class OpenAiCodexHandler extends OpenAiNativeHandler {
	protected override readonly providerId: string = "openai-codex"
	protected override readonly providerName: string = "ChatGPT"

	constructor(options: ApiHandlerOptions) {
		// The shared native adapter supplies the curated catalog and Responses
		// normalization. This placeholder is replaced before every request; no
		// profile credential or first-party Codex token can authenticate this route.
		super({
			apiModelId: options.apiModelId,
			enableReasoningEffort: options.enableReasoningEffort,
			reasoningEffort: options.reasoningEffort,
			verbosity: options.verbosity,
			enableResponsesReasoningSummary: options.enableResponsesReasoningSummary,
			includeMaxTokens: false,
			openAiNativeApiKey: "managed-chatgpt-oauth",
		})
		// ChatGPT account/workspace selection comes from OAuth, independently of
		// API-project routing inherited from the SDK's environment defaults.
		this.client = this.client.withOptions({ organization: null, project: null })
	}

	protected override preserveResponsesReasoningIds(): boolean {
		return true
	}

	protected override customizeResponsesRequest<T extends ResponseCreateParamsBase>(request: T): T {
		// SIWC preview requirements, retrieved 2026-10-28:
		// https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
		const input = Array.isArray(request.input)
			? request.input.map((item) => {
					if ("role" in item && item.role === "system") return { ...item, role: "developer" as const }
					if (item.type === "function_call" || item.type === "custom_tool_call") {
						return { ...item, namespace: TOOL_NAMESPACE }
					}
					return item
				})
			: request.input
		const choice = request.tool_choice
		const toolChoice =
			typeof choice === "object" && (choice.type === "function" || choice.type === "custom")
				? { ...choice, namespace: TOOL_NAMESPACE }
				: choice
		// The installed SDK predates the public namespace tool wire shape.
		// Its streamed function/custom call items use the shared native parser.
		const tools = request.tools?.length
			? [
					{
						type: "namespace",
						name: TOOL_NAMESPACE,
						description: "Alpha Code workspace tools.",
						tools: request.tools,
					},
				]
			: request.tools
		return {
			model: request.model,
			input,
			store: false,
			...(tools !== undefined ? { tools } : {}),
			...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
			...(request.parallel_tool_calls !== undefined ? { parallel_tool_calls: request.parallel_tool_calls } : {}),
			...(request.reasoning !== undefined ? { reasoning: request.reasoning } : {}),
			...(request.include !== undefined ? { include: request.include } : {}),
			...(request.text !== undefined ? { text: request.text } : {}),
		} as T
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const control = createLinkedAbortController(metadata)
		let started = false
		try {
			control.signal.throwIfAborted()
			const authorized = await ChatGptAuthService.getInstance().authorizeRequest(control.signal)
			const signal = AbortSignal.any([control.signal, authorized.signal])
			signal.throwIfAborted()
			this.client.apiKey = authorized.accessToken
			started = true
			yield* super.createMessage(systemPrompt, messages, { taskId: "", ...metadata, signal, store: false })
		} catch (error) {
			if (!started) {
				yield createApiStreamOutcome({
					status: isApiStreamAbortError(error, control.signal) ? "cancelled" : "failed",
					semanticOutputObserved: false,
				})
			}
			throw requestError(error)
		} finally {
			control.controller.abort()
			control.dispose()
		}
	}

	override async completePrompt(prompt: string, metadata?: ApiHandlerSingleCompletionMetadata): Promise<string> {
		// SIWC requires streaming even for auxiliary completions. A separate
		// adapter keeps auxiliary output out of the active task's reasoning state.
		const handler = new OpenAiCodexHandler(this.options)
		let text = ""
		let completed = false
		for await (const chunk of handler.createMessage("", [{ role: "user", content: prompt }], {
			taskId: "auxiliary-completion",
			signal: metadata?.signal,
		})) {
			if (chunk.type === "text") text += chunk.text
			if (chunk.type === "tool_call" || chunk.type === "tool_call_start" || chunk.type === "tool_call_partial") {
				throw new Error("ChatGPT returned an unexpected tool call for an auxiliary completion.")
			}
			if (chunk.type === "outcome")
				completed = chunk.status === "completed" && chunk.terminal && !chunk.requiresContinuation
		}
		metadata?.signal?.throwIfAborted()
		if (!completed || !text.trim())
			throw new Error("ChatGPT did not complete the auxiliary response. Please try again.")
		return text
	}
}
