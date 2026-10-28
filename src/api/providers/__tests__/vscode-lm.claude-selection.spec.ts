import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type * as vscode from "vscode"

const { selectChatModels, modelChanges } = vi.hoisted(() => ({
	selectChatModels: vi.fn<(selector: vscode.LanguageModelChatSelector) => Promise<vscode.LanguageModelChat[]>>(),
	modelChanges: new Set<() => void>(),
}))

vi.mock("vscode", () => ({
	version: "1.138.0",
	workspace: {
		onDidChangeConfiguration: vi.fn(() => ({ dispose() {} })),
		getConfiguration: vi.fn(() => ({ get: () => 600 })),
	},
	lm: {
		selectChatModels,
		onDidChangeChatModels: (listener: () => void) => {
			modelChanges.add(listener)
			return { dispose: () => modelChanges.delete(listener) }
		},
	},
}))

import { VsCodeLmHandler } from "../vscode-lm"

// Routing ids and versions are fixture identities, not a claim of live account availability.
function claudeModel(overrides: Partial<vscode.LanguageModelChat> = {}): vscode.LanguageModelChat {
	return {
		id: "opaque-claude-route",
		vendor: "copilot",
		family: "claude-sonnet-4.6",
		version: "fixture-standard",
		name: "Claude Sonnet fixture",
		maxInputTokens: 200_000,
		countTokens: vi.fn(async () => 1),
		sendRequest: vi.fn(),
		...overrides,
	}
}

function selector(model: vscode.LanguageModelChat): vscode.LanguageModelChatSelector {
	return { id: model.id, vendor: model.vendor, family: model.family, version: model.version }
}

const handlers: VsCodeLmHandler[] = []
function handlerFor(model: vscode.LanguageModelChat): VsCodeLmHandler {
	const handler = new VsCodeLmHandler({ vsCodeLmModelSelector: selector(model) })
	handlers.push(handler)
	return handler
}

function refreshModels() {
	for (const listener of modelChanges) listener()
}

beforeEach(() => {
	selectChatModels.mockReset()
})

afterEach(() => {
	refreshModels()
	for (const handler of handlers.splice(0)) handler.dispose()
	vi.restoreAllMocks()
})

describe("Claude Copilot routing identity", () => {
	it("selects the exact Copilot route when other vendors expose the same Claude id", async () => {
		const selected = claudeModel()
		const otherVendor = claudeModel({ vendor: "copilotid" })
		const otherClaude = claudeModel({ family: "claude-opus-4.6" })
		selectChatModels.mockResolvedValue([otherVendor, otherClaude, selected])
		const handler = handlerFor(selected)

		await handler.initializeClient()

		expect(selectChatModels).toHaveBeenCalledExactlyOnceWith(selector(selected))
		expect(handler.getModel()).toMatchObject({
			id: selected.id,
			instructionModelId: selected.family,
			toolIdentity: { provider: "vscode-lm", vendor: "copilot", family: selected.family, id: selected.id },
		})
		expect(otherVendor.sendRequest).not.toHaveBeenCalled()
		expect(otherClaude.sendRequest).not.toHaveBeenCalled()
	})

	it.each([
		{ vendor: "copilotid" },
		{ family: "claude-opus-4.6" },
		{ version: "fixture-extended" },
		{ id: "another-opaque-claude-route" },
	])("keeps concurrent Claude clients separate for selector difference %j", async (difference) => {
		const first = claudeModel()
		const second = claudeModel({ ...difference, name: "Separate Claude fixture" })
		selectChatModels.mockResolvedValue([first, second])
		const firstHandler = handlerFor(first)
		const secondHandler = handlerFor(second)

		await Promise.all([firstHandler.initializeClient(), secondHandler.initializeClient()])

		expect(selectChatModels).toHaveBeenCalledTimes(2)
		expect(selectChatModels).toHaveBeenCalledWith(selector(first))
		expect(selectChatModels).toHaveBeenCalledWith(selector(second))
		expect(firstHandler.getModel().info.description).toContain(first.name)
		expect(secondHandler.getModel().info.description).toContain(second.name)
		expect(firstHandler.getModel().toolIdentity).toMatchObject({
			id: first.id,
			vendor: first.vendor,
			family: first.family,
		})
		expect(secondHandler.getModel().toolIdentity).toMatchObject({
			id: second.id,
			vendor: second.vendor,
			family: second.family,
		})
	})

	it("rejects a removed Claude route after catalog invalidation without selecting another available model", async () => {
		const selected = claudeModel()
		const otherClaude = claudeModel({ id: "other-claude-route", family: "claude-opus-4.6" })
		const otherProviderModel = claudeModel({ id: "gpt-route", family: "gpt-5.6-sol" })
		let releaseSelection!: (models: vscode.LanguageModelChat[]) => void
		const staleSelection = new Promise<vscode.LanguageModelChat[]>((resolve) => {
			releaseSelection = resolve
		})
		selectChatModels.mockReturnValueOnce(staleSelection).mockResolvedValue([otherClaude, otherProviderModel])
		const handler = handlerFor(selected)
		vi.spyOn(console, "error").mockImplementation(() => undefined)

		const initializing = handler.initializeClient()
		expect(selectChatModels).toHaveBeenCalledExactlyOnceWith(selector(selected))
		refreshModels()
		releaseSelection([selected])

		await expect(initializing).rejects.toThrow("The selected VS Code language model is not available")
		expect(selectChatModels.mock.calls.map(([selection]) => selection)).toEqual([
			selector(selected),
			selector(selected),
		])
		expect(selected.sendRequest).not.toHaveBeenCalled()
		expect(otherClaude.sendRequest).not.toHaveBeenCalled()
		expect(otherProviderModel.sendRequest).not.toHaveBeenCalled()
	})
})
