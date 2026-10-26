import assert from "node:assert/strict"
import test from "node:test"

import type { AlphaCodeAPI, AlphaCodeSettings, ModelProbeResult } from "@alpha-code/types"
import type { LanguageModelChat } from "vscode"

import { configureLiveCopilot, type CopilotModelMetadata } from "../liveModelSelection"
import { runLiveCopilotPreflight } from "../suite/liveCopilot"

function claude(family: string) {
	return {
		vendor: "copilot",
		family,
		id: `provider-owned/${family}:route-a`,
		name: family.replaceAll("-", " "),
		version: "fixture-version",
	}
}

const sonnet = claude("claude-sonnet-4.6")
const opus = claude("claude-opus-4.6")
const haiku = claude("claude-haiku-4.5")
const gpt = { vendor: "copilot", family: "gpt-5.5", id: "copilot-gpt-5.5", name: sonnet.name }

function fixture(models: readonly CopilotModelMetadata[], completionModelId?: string) {
	const original: AlphaCodeSettings = {
		apiProvider: "vscode-lm",
		vsCodeLmModelSelector: { vendor: "copilot", id: gpt.id, family: gpt.family },
		enableReasoningEffort: true,
		reasoningEffort: "high",
	}
	const configurations: AlphaCodeSettings[] = []
	const authorizedModels: LanguageModelChat[] = []
	let probes = 0
	let disposed = 0
	const vscode = {
		extensions: { getExtension: () => ({ isActive: true }) },
		lm: {
			onDidChangeChatModels: () => ({ dispose: () => disposed++ }),
			selectChatModels: async (selector: object) => {
				assert.deepEqual(selector, { vendor: "copilot" })
				return models
			},
		},
	} as unknown as typeof import("vscode")
	const api = {
		getConfiguration: () => configurations.at(-1) ?? original,
		setConfiguration: async (configuration: AlphaCodeSettings) => configurations.push(configuration),
		probeModel: async (): Promise<ModelProbeResult> => {
			probes++
			return {
				status: "completed",
				requests: 1,
				modelId: completionModelId ?? configurations.at(-1)?.vsCodeLmModelSelector?.id ?? "",
				firstTextMs: 1,
				wallMs: 2,
				usage: null,
				failureCode: null,
			}
		},
	} as unknown as AlphaCodeAPI
	return {
		api,
		configurations,
		authorizedModels,
		dependencies: {
			loadVsCode: async () => vscode,
			canSendRequest: (model: LanguageModelChat) => {
				authorizedModels.push(model)
				return true
			},
		},
		state: () => ({ probes, disposed }),
	}
}

for (const model of [sonnet, opus, haiku]) {
	test(`${model.family} readiness probes the selected opaque Copilot route with retained thinking disabled`, async () => {
		const host = fixture([gpt, { ...model, vendor: "anthropic" }, { ...model, id: `${model.id}-preview` }, model])
		const result = await runLiveCopilotPreflight(
			host.api,
			{ modelId: model.id, modelFamily: model.family },
			host.dependencies,
		)
		assert.equal(result.ready, true)
		assert.equal(result.discovery.selectedModel?.id, model.id)
		assert.equal(result.discovery.selectedModel?.family, model.family)
		assert.equal(result.discovery.selectedModel?.vendor, "copilot")
		assert.deepEqual(host.authorizedModels, [model])
		assert.deepEqual(host.configurations, [
			{
				apiProvider: "vscode-lm",
				vsCodeLmModelSelector: { vendor: "copilot", id: model.id, family: model.family },
				enableReasoningEffort: false,
				reasoningEffort: "disable",
			},
		])
		assert.equal(result.configuration.reasoningEffort, "disable")
		assert.deepEqual(host.state(), { probes: 1, disposed: 1 })
	})
}

for (const replacement of [
	{ name: "another Claude family", model: { ...opus, name: sonnet.name } },
	{ name: "another provider with the requested Claude ID", model: { ...sonnet, vendor: "anthropic" } },
	{ name: "a Claude preview route", model: { ...sonnet, id: `${sonnet.id}-preview` } },
]) {
	test(`unavailable Sonnet never falls back to ${replacement.name} or a relabelled GPT`, async () => {
		const host = fixture([gpt, replacement.model])
		const result = await runLiveCopilotPreflight(host.api, { modelId: sonnet.id, setup: true }, host.dependencies)
		assert.equal(result.ready, false)
		assert.equal(result.error?.code, "model-unavailable")
		assert.equal(result.discovery.selectedModel, undefined)
		assert.equal(result.configuration.status, "not-attempted")
		assert.deepEqual(host.authorizedModels, [])
		assert.deepEqual(host.configurations, [])
		assert.deepEqual(host.state(), { probes: 0, disposed: 1 })
	})
}

test("duplicate exact Claude routes fail before authorization, profile edits, or completion requests", async () => {
	const host = fixture([sonnet, { ...sonnet, version: "another-provider-build" }, gpt])
	const result = await configureLiveCopilot(host.api, { modelId: sonnet.id }, host.dependencies)
	assert.equal(result.ready, false)
	assert.equal(result.error?.code, "model-selection-ambiguous")
	assert.equal(result.discovery.status, "ambiguous")
	assert.deepEqual(host.authorizedModels, [])
	assert.deepEqual(host.configurations, [])
	assert.deepEqual(host.state(), { probes: 0, disposed: 1 })
})

test("Sonnet effort is validated from its family before live access, not a GPT-like opaque ID", async () => {
	const model = { ...sonnet, id: "opaque/gpt-5.5-route" }
	const supported = fixture([model])
	const ready = await configureLiveCopilot(
		supported.api,
		{ modelId: model.id, reasoningEffort: "high" },
		supported.dependencies,
	)
	assert.equal(ready.ready, true)
	assert.equal(ready.reasoning.status, "supported")
	assert.equal(supported.configurations[0]?.enableReasoningEffort, true)
	assert.equal(supported.configurations[0]?.reasoningEffort, "high")

	const unsupported = fixture([model])
	const blocked = await configureLiveCopilot(
		unsupported.api,
		{ modelId: model.id, reasoningEffort: "xhigh" },
		unsupported.dependencies,
	)
	assert.equal(blocked.ready, false)
	assert.equal(blocked.error?.code, "effort-unavailable")
	assert.deepEqual(unsupported.authorizedModels, [])
	assert.deepEqual(unsupported.configurations, [])
})

for (const completionModelId of [gpt.id, opus.id]) {
	test(`a successful completion from ${completionModelId} cannot establish requested Sonnet readiness`, async () => {
		const host = fixture([sonnet, opus, gpt], completionModelId)
		const result = await runLiveCopilotPreflight(host.api, { modelId: sonnet.id, setup: true }, host.dependencies)
		assert.equal(result.ready, false)
		assert.equal(result.error?.code, "completion-unavailable")
		assert.equal(result.discovery.selectedModel?.id, sonnet.id)
		assert.equal(host.configurations[0]?.vsCodeLmModelSelector?.id, sonnet.id)
		assert.deepEqual(host.state(), { probes: 1, disposed: 1 })
	})
}
