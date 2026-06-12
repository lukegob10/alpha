import { act, render, screen } from "@/utils/test-utils"
import type { ProviderSettings } from "@alpha-code/types"
import type { LanguageModelChatSelector } from "vscode"

import { VSCodeLM } from "../VSCodeLM"

const modelPickerProps: any[] = []
const thinkingBudgetProps: any[] = []
let messageHandler: ((event: MessageEvent) => void) | undefined

vi.mock("../../ModelPicker", () => ({
	ModelPicker: (props: any) => {
		modelPickerProps.push(props)
		return <div data-testid="model-picker">Model Picker</div>
	},
}))

vi.mock("../../ThinkingBudget", () => ({
	ThinkingBudget: (props: any) => {
		thinkingBudgetProps.push(props)
		return <div data-testid="thinking-budget">Thinking Budget</div>
	},
}))

vi.mock("react-use", () => ({
	useEvent: (_eventName: string, handler: (event: MessageEvent) => void) => {
		messageHandler = handler
	},
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

describe("VSCodeLM", () => {
	const setApiConfigurationField = vi.fn()

	beforeEach(() => {
		modelPickerProps.length = 0
		thinkingBudgetProps.length = 0
		messageHandler = undefined
		vi.clearAllMocks()
	})

	function renderProvider(apiConfiguration: ProviderSettings = { apiProvider: "vscode-lm" }) {
		render(<VSCodeLM apiConfiguration={apiConfiguration} setApiConfigurationField={setApiConfigurationField} />)
	}

	it("keys models by full selector so reasoning variants do not collide", () => {
		renderProvider()

		const models: LanguageModelChatSelector[] = [
			{
				vendor: "copilot",
				family: "gpt-5.5",
				version: "low",
				id: "copilot-gpt-5.5-low",
				name: "GPT-5.5",
			},
			{
				vendor: "copilot",
				family: "gpt-5.5",
				version: "high",
				id: "copilot-gpt-5.5-high",
				name: "GPT-5.5",
			},
		] as any

		act(() => {
			messageHandler?.({ data: { type: "vsCodeLmModels", vsCodeLmModels: models } } as MessageEvent)
		})

		const props = modelPickerProps.at(-1)
		expect(props.models).toEqual(
			expect.objectContaining({
				"copilot/gpt-5.5/low/copilot-gpt-5.5-low": expect.any(Object),
				"copilot/gpt-5.5/high/copilot-gpt-5.5-high": expect.any(Object),
			}),
		)
		expect(props.labelTransform("copilot/gpt-5.5/high/copilot-gpt-5.5-high")).toBe("GPT 5.5 · High")
	})

	it("stores the exact selector for a selected reasoning variant", () => {
		const selectedModel = {
			vendor: "copilot",
			family: "gpt-5.5",
			version: "high",
			id: "copilot-gpt-5.5-high",
			name: "GPT-5.5",
		}

		renderProvider()
		act(() => {
			messageHandler?.({ data: { type: "vsCodeLmModels", vsCodeLmModels: [selectedModel] } } as MessageEvent)
		})

		const props = modelPickerProps.at(-1)

		expect(props.valueTransform("copilot/gpt-5.5/high/copilot-gpt-5.5-high")).toEqual(selectedModel)
		expect(props.displayTransform(selectedModel)).toBe("copilot/gpt-5.5/high/copilot-gpt-5.5-high")
		expect(screen.getByTestId("model-picker")).toBeInTheDocument()
	})

	it("renders reasoning effort settings for the selected VS Code LM model", () => {
		const selectedModel = {
			vendor: "copilot",
			family: "gpt-5-mini",
			version: "2026-05-01",
			id: "copilot-gpt-5-mini",
			name: "GPT-5 mini",
			maxInputTokens: 128_000,
		}

		renderProvider({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: selectedModel,
		})
		act(() => {
			messageHandler?.({ data: { type: "vsCodeLmModels", vsCodeLmModels: [selectedModel] } } as MessageEvent)
		})

		const props = thinkingBudgetProps.at(-1)
		expect(screen.getByTestId("thinking-budget")).toBeInTheDocument()
		expect(props.modelInfo).toEqual(
			expect.objectContaining({
				contextWindow: 128_000,
				supportsReasoningEffort: ["none", "low", "medium", "high"],
			}),
		)
	})

	it("renders all Copilot GPT-5.5 reasoning efforts including extra high", () => {
		const selectedModel = {
			vendor: "copilot",
			family: "gpt-5.5",
			version: "2026-06-01",
			id: "copilot-gpt-5.5",
			name: "GPT-5.5",
			maxInputTokens: 128_000,
		}

		renderProvider({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: selectedModel,
		})
		act(() => {
			messageHandler?.({ data: { type: "vsCodeLmModels", vsCodeLmModels: [selectedModel] } } as MessageEvent)
		})

		const props = thinkingBudgetProps.at(-1)
		expect(props.modelInfo).toEqual(
			expect.objectContaining({
				supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh"],
			}),
		)
	})

	it("renders Copilot GPT-5.3 Codex reasoning efforts including extra high", () => {
		const selectedModel = {
			vendor: "copilot",
			family: "gpt-5.3-codex",
			version: "2026-06-01",
			id: "copilot-gpt-5.3-codex",
			name: "GPT-5.3-Codex",
			maxInputTokens: 128_000,
		}

		renderProvider({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: selectedModel,
		})
		act(() => {
			messageHandler?.({ data: { type: "vsCodeLmModels", vsCodeLmModels: [selectedModel] } } as MessageEvent)
		})

		const props = thinkingBudgetProps.at(-1)
		expect(props.modelInfo).toEqual(
			expect.objectContaining({
				supportsReasoningEffort: ["low", "medium", "high", "xhigh"],
			}),
		)
	})

	it("renders reasoning effort settings for Copilot Claude Opus 4.7", () => {
		const selectedModel = {
			vendor: "copilot",
			family: "claude-opus-4.7",
			version: "2026-06-01",
			id: "copilot-claude-opus-4.7",
			name: "Claude Opus 4.7",
			maxInputTokens: 1_000_000,
		}

		renderProvider({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: selectedModel,
		})
		act(() => {
			messageHandler?.({ data: { type: "vsCodeLmModels", vsCodeLmModels: [selectedModel] } } as MessageEvent)
		})

		const props = thinkingBudgetProps.at(-1)
		expect(props.modelInfo).toEqual(
			expect.objectContaining({
				contextWindow: 1_000_000,
				supportsImages: true,
				supportsReasoningEffort: ["none", "low", "medium", "high"],
			}),
		)
	})

	it("deduplicates equivalent Copilot Claude model selectors", () => {
		const models = [
			{
				vendor: "copilot",
				family: "claude-opus-4.7",
				version: "2026-06-01",
				id: "copilot-claude-opus-4.7",
				name: "Claude Opus 4.7",
			},
			{
				vendor: "copilot",
				family: "claude-opus-4.7",
				version: "2026-06-02",
				id: "copilot-claude-opus-4.7-alt",
				name: "Claude Opus 4.7",
			},
		]

		renderProvider()
		act(() => {
			messageHandler?.({ data: { type: "vsCodeLmModels", vsCodeLmModels: models } } as MessageEvent)
		})

		const props = modelPickerProps.at(-1)
		expect(Object.keys(props.models)).toHaveLength(1)
		expect(props.labelTransform(Object.keys(props.models)[0])).toBe("Claude Opus 4.7")
		expect(props.secondaryLabelTransform(Object.keys(props.models)[0])).toBeUndefined()
	})

	it("keeps the selected duplicate selector visible when it was already configured", () => {
		const selectedModel = {
			vendor: "copilot",
			family: "claude-opus-4.7",
			version: "2026-06-02",
			id: "copilot-claude-opus-4.7-alt",
			name: "Claude Opus 4.7",
		}
		const models = [
			{
				vendor: "copilot",
				family: "claude-opus-4.7",
				version: "2026-06-01",
				id: "copilot-claude-opus-4.7",
				name: "Claude Opus 4.7",
			},
			selectedModel,
		]

		renderProvider({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: selectedModel,
		})
		act(() => {
			messageHandler?.({ data: { type: "vsCodeLmModels", vsCodeLmModels: models } } as MessageEvent)
		})

		const props = modelPickerProps.at(-1)
		expect(Object.keys(props.models)).toEqual(["copilot/claude-opus-4.7/2026-06-02/copilot-claude-opus-4.7-alt"])
		expect(thinkingBudgetProps.at(-1).modelInfo).toEqual(
			expect.objectContaining({
				supportsReasoningEffort: ["none", "low", "medium", "high"],
			}),
		)
	})

	it("clears stale reasoning settings when switching to a non-reasoning model", () => {
		const models = [
			{
				vendor: "copilot",
				family: "claude-opus-4.5",
				version: "2026-06-01",
				id: "copilot-claude-opus-4.5",
				name: "Claude Opus 4.5",
			},
		]

		renderProvider({
			apiProvider: "vscode-lm",
			enableReasoningEffort: true,
			reasoningEffort: "high",
		})
		act(() => {
			messageHandler?.({ data: { type: "vsCodeLmModels", vsCodeLmModels: models } } as MessageEvent)
		})

		const props = modelPickerProps.at(-1)
		props.onModelChange("copilot/claude-opus-4.5/2026-06-01/copilot-claude-opus-4.5")

		expect(setApiConfigurationField).toHaveBeenCalledWith("enableReasoningEffort", false)
		expect(setApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", undefined)
	})

	it("matches exact static model ids before prefix matches", () => {
		const selectedModel = {
			vendor: "copilot",
			family: "gpt-5.4-mini",
			version: "2026-05-01",
			id: "copilot-gpt-5.4-mini",
			name: "GPT-5.4 mini",
			maxInputTokens: 128_000,
		}

		renderProvider({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: selectedModel,
		})
		act(() => {
			messageHandler?.({ data: { type: "vsCodeLmModels", vsCodeLmModels: [selectedModel] } } as MessageEvent)
		})

		const props = thinkingBudgetProps.at(-1)
		expect(props.modelInfo).toEqual(
			expect.objectContaining({
				description: expect.stringContaining("GPT-5.4 mini"),
			}),
		)
		expect(props.modelInfo.name).toBe("GPT-5.4 mini")
		expect(props.modelInfo.family).toBe("gpt-5.4-mini")
	})

	it("uses live model capabilities for legacy vendor/family selectors when there is one match", () => {
		const liveModel = {
			vendor: "copilot",
			family: "gpt-5-mini",
			version: "2026-05-01",
			id: "copilot-gpt-5-mini",
			name: "GPT-5 mini",
			maxInputTokens: 128_000,
		}

		renderProvider({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: {
				vendor: "copilot",
				family: "gpt-5-mini",
			},
		})
		act(() => {
			messageHandler?.({ data: { type: "vsCodeLmModels", vsCodeLmModels: [liveModel] } } as MessageEvent)
		})

		const props = thinkingBudgetProps.at(-1)
		expect(props.modelInfo).toEqual(
			expect.objectContaining({
				supportsReasoningEffort: ["none", "low", "medium", "high"],
			}),
		)
		expect(setApiConfigurationField).not.toHaveBeenCalledWith("vsCodeLmModelSelector", expect.anything())
	})

	it("does not infer reasoning settings from ambiguous legacy selectors", () => {
		const models = [
			{
				vendor: "copilot",
				family: "gpt-5.5",
				version: "low",
				id: "copilot-gpt-5.5-low",
				name: "GPT-5.5",
			},
			{
				vendor: "copilot",
				family: "gpt-5.5",
				version: "high",
				id: "copilot-gpt-5.5-high",
				name: "GPT-5.5",
			},
		]

		renderProvider({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: {
				vendor: "copilot",
				family: "gpt-5.5",
			},
		})
		act(() => {
			messageHandler?.({ data: { type: "vsCodeLmModels", vsCodeLmModels: models } } as MessageEvent)
		})

		const props = thinkingBudgetProps.at(-1)
		expect(props.modelInfo).toBeUndefined()
	})
})
