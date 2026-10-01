import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type * as vscode from "vscode"

const { selectChatModels } = vi.hoisted(() => ({ selectChatModels: vi.fn() }))

vi.mock("vscode", () => ({
	version: "1.122.1",
	workspace: {
		onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
		getConfiguration: vi.fn(() => ({ get: vi.fn(() => 600) })),
	},
	lm: {
		selectChatModels,
		onDidChangeChatModels: vi.fn(() => ({ dispose: vi.fn() })),
	},
}))

import { VsCodeLmHandler } from "../vscode-lm"
import { resolveCodexModelPrompt } from "../../../core/prompts/codex-model-instructions"
import { getModelReservedOutputTokens } from "../../../shared/api"

// Explicitly selected review probes, never a live Copilot request. IDs are opaque
// routing identities; the model family describes the selected host capability.
// The desired instruction-family assertions expose missing adapter normalization.
const handlers: VsCodeLmHandler[] = []

function hostModel(id: string, family: string, maxInputTokens = 272_000): vscode.LanguageModelChat {
	return {
		id,
		vendor: "copilot",
		family,
		version: family,
		name: family,
		maxInputTokens,
		countTokens: vi.fn(),
		sendRequest: vi.fn(),
	} as unknown as vscode.LanguageModelChat
}

async function prepareHostModel(model: vscode.LanguageModelChat, contextSize?: number) {
	selectChatModels.mockResolvedValue([model])
	const handler = new VsCodeLmHandler({
		vsCodeLmModelSelector: { vendor: model.vendor, id: model.id },
		...(contextSize === undefined ? {} : { vsCodeLmContextSize: contextSize }),
	})
	handlers.push(handler)
	await handler.prepareModel()
	return { handler, model: handler.getModel() }
}

describe("Copilot selected identity and context convergence investigation", () => {
	beforeEach(() => selectChatModels.mockReset())
	afterEach(() => {
		for (const handler of handlers.splice(0)) handler.dispose()
	})

	it.each([
		["opaque-sol-route", "gpt-5.6-sol", "gpt-5.6"],
		["opaque-luna-route", "gpt-6-luna", "gpt-6-luna"],
	] as const)("selects the matching CLI instructions for opaque host ID %s", async (id, family, expectedPrompt) => {
		const { model } = await prepareHostModel(hostModel(id, family))
		expect(model.id).toBe(id)
		expect(model.toolIdentity?.family).toBe(family)
		expect(resolveCodexModelPrompt(model.id).promptSlug).toBe(expectedPrompt)
	})

	it.each([
		["copilot-gpt-5.6-sol", "gpt-5.6-sol", "gpt-5.6"],
		["copilot/gpt-6-luna", "gpt-6-luna", "gpt-6-luna"],
	] as const)("keeps existing recognized host suffix %s", async (id, family, expectedPrompt) => {
		const { model } = await prepareHostModel(hostModel(id, family))
		expect(resolveCodexModelPrompt(model.id).promptSlug).toBe(expectedPrompt)
	})

	it("observes fallback for an unregistered bare family without claiming an upstream alias", async () => {
		const { model } = await prepareHostModel(hostModel("gpt-5.6", "gpt-5.6"))
		expect(resolveCodexModelPrompt(model.id).isFallback).toBe(true)
		expect(resolveCodexModelPrompt(model.id).promptSlug).toBe("gpt-6-sol")
	})

	it("keeps the configured standard input window despite a larger live ceiling", async () => {
		const { model } = await prepareHostModel(hostModel("standard-route", "gpt-5.6-sol", 921_793))
		expect(model.info.contextWindow).toBe(272_000)
		expect(model.info.contextWindowIncludesOutput).toBe(false)
		expect(getModelReservedOutputTokens({ modelId: model.id, model: model.info })).toBe(0)
	})

	it("caps selected extended context to the host input budget rather than its rounded display size", async () => {
		const { model } = await prepareHostModel(hostModel("extended-route", "gpt-5.6-sol", 921_793), 922_000)
		expect(model.info.contextWindow).toBe(921_793)
	})

	it("narrows a recognized family to a smaller live input budget", async () => {
		const { model } = await prepareHostModel(hostModel("small-live-route", "gpt-5.6-sol", 123_456), 922_000)
		expect(model.info.contextWindow).toBe(123_456)
	})

	it("uses the host input budget for an unknown family instead of a static fallback", async () => {
		const { model } = await prepareHostModel(hostModel("unknown-family-route", "future-provider-family", 87_654))
		expect(model.info.contextWindow).toBe(87_654)
	})

	it("rejects a host response that does not match the selected routing identity", async () => {
		const returned = hostModel("different-route", "gpt-5.6-sol")
		selectChatModels.mockResolvedValue([returned])
		const handler = new VsCodeLmHandler({ vsCodeLmModelSelector: { vendor: "copilot", id: "requested-route" } })
		handlers.push(handler)
		await expect(handler.prepareModel()).rejects.toThrow("selected VS Code language model is not available")
		expect(returned.sendRequest).not.toHaveBeenCalled()
	})
})
