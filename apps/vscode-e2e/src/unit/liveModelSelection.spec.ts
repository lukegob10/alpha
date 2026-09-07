import assert from "node:assert/strict"
import test from "node:test"

import type { LanguageModelChat } from "vscode"
import type { RooCodeAPI } from "@alpha-code/types"

import {
	buildLiveCopilotConfiguration,
	configureLiveCopilot,
	readAuthMetadata,
	sanitizeLiveCopilotModelMetadata,
	selectExactCopilotModel,
	validateExactCopilotModelSelection,
	validateRequestedReasoningEffort,
	type AlphaVscodeLmModelInfo,
} from "../liveModelSelection"

const gpt55 = {
	vendor: "copilot",
	family: "gpt-5.5",
	version: "2026-06-01",
	id: "copilot-gpt-5.5",
	name: "GPT-5.5",
} as const

test("cold discovery activates the installed Copilot provider before reading its catalog", async () => {
	let active = false
	let activations = 0
	let configurations = 0
	const vscode = {
		extensions: {
			getExtension: (id: string) => {
				assert.equal(id, "GitHub.copilot-chat")
				return {
					get isActive() {
						return active
					},
					activate: async () => {
						activations++
						active = true
					},
				}
			},
		},
		lm: {
			onDidChangeChatModels: () => ({ dispose() {} }),
			selectChatModels: async () => (active ? [gpt55] : []),
		},
	} as unknown as typeof import("vscode")
	const api = {
		getConfiguration: () => ({}),
		setConfiguration: async () => configurations++,
	} as unknown as RooCodeAPI
	const result = await configureLiveCopilot(
		api,
		{ modelId: gpt55.id },
		{ loadVsCode: async () => vscode, canSendRequest: () => true },
	)
	assert.equal(result.ready, true)
	assert.equal(activations, 1)
	assert.equal(configurations, 1)
})

test("cancelled setup cannot discover, probe, or configure the provider", async () => {
	const cancellation = new AbortController()
	cancellation.abort()
	const api = {
		getConfiguration: () => assert.fail("cancelled setup cannot inspect provider configuration"),
		setConfiguration: () => assert.fail("cancelled setup cannot change provider configuration"),
	} as unknown as RooCodeAPI
	await assert.rejects(
		configureLiveCopilot(api, { modelId: gpt55.id, setup: true }, { signal: cancellation.signal }),
		{ name: "AbortError" },
	)
})

test("selectExactCopilotModel requires the exact Copilot vendor and id", () => {
	const models = [
		{ ...gpt55, vendor: "other-provider" },
		{ ...gpt55, id: "copilot-gpt-5.5-preview", name: "GPT-5.5 Preview" },
		gpt55,
	]

	assert.deepEqual(selectExactCopilotModel(models, { modelId: gpt55.id }), gpt55)
	assert.equal(selectExactCopilotModel(models, { modelId: "GPT-5.5" }), undefined)
	assert.equal(
		selectExactCopilotModel(models, { modelId: "copilot-gpt-5.5-preview", modelFamily: "gpt-5.5" }),
		models[1],
	)
})

test("selection rejects a family mismatch and duplicate exact identities", () => {
	assert.deepEqual(validateExactCopilotModelSelection([gpt55], { modelId: gpt55.id, modelFamily: "gpt-5.4" }), {
		ok: false,
		status: "not-found",
		code: "model-family-mismatch",
	})

	assert.deepEqual(
		validateExactCopilotModelSelection([gpt55, { ...gpt55, version: "second" }], { modelId: gpt55.id }),
		{ ok: false, status: "ambiguous", code: "model-selection-ambiguous" },
	)
})

test("reasoning validation follows Alpha capabilities and refuses unknown models", () => {
	const supported: AlphaVscodeLmModelInfo = { supportsReasoningEffort: ["low", "medium", "high"] }
	assert.equal(validateRequestedReasoningEffort(gpt55, "high", supported).status, "supported")
	assert.equal(validateRequestedReasoningEffort(gpt55, "xhigh", supported).status, "unsupported")
	assert.equal(
		validateRequestedReasoningEffort({ ...gpt55, family: "future-copilot-family" }, "high").status,
		"unknown",
	)
	assert.equal(validateRequestedReasoningEffort(gpt55, "disable").status, "disabled")
})

test("readAuthMetadata reports the injected ExtensionContext access state", () => {
	const model = {} as LanguageModelChat

	assert.deepEqual(readAuthMetadata({ canSendRequest: () => true }, model), {
		status: "available",
		canSendRequest: true,
		probe: { method: "none", status: "not-run" },
	})
	assert.deepEqual(readAuthMetadata({ canSendRequest: () => false }, model), {
		status: "required",
		canSendRequest: false,
		probe: { method: "none", status: "not-run" },
	})
	assert.deepEqual(readAuthMetadata({ canSendRequest: () => undefined }, model), {
		status: "unknown",
		probe: { method: "none", status: "not-run" },
	})
})

test("sanitizeLiveCopilotModelMetadata keeps bounded safe fields only", () => {
	const model = { ...gpt55, maxInputTokens: Number.MAX_VALUE, prompt: "must not be persisted" }
	const safe = sanitizeLiveCopilotModelMetadata(model)

	assert.deepEqual(safe, { ...gpt55, maxInputTokens: Number.MAX_SAFE_INTEGER })
	assert.equal("prompt" in safe, false)
})

test("configuration uses only the existing Alpha provider and selector fields", () => {
	const configuration = buildLiveCopilotConfiguration(
		{ apiProvider: "openrouter", openRouterApiKey: "not persisted here" },
		{ vendor: "copilot", id: gpt55.id, family: gpt55.family },
		{
			status: "supported",
			requested: "high",
			appliedEffort: "high",
			supportedEfforts: ["low", "medium", "high"],
		},
	)

	assert.deepEqual(configuration, {
		apiProvider: "vscode-lm",
		openRouterApiKey: "not persisted here",
		vsCodeLmModelSelector: { vendor: "copilot", id: gpt55.id, family: gpt55.family },
		enableReasoningEffort: true,
		reasoningEffort: "high",
	})
})
