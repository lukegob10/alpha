import { act, render, screen } from "@/utils/test-utils"
import type { ProviderSettings } from "@alpha-code/types"
import type { LanguageModelChatSelector } from "vscode"

import { VSCodeLM } from "../VSCodeLM"

const modelPickerProps: any[] = []
const thinkingBudgetProps: any[] = []
const selectProps: any[] = []
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

vi.mock("@src/components/ui", () => ({
	Select: (props: any) => {
		selectProps.push(props)
		return <div data-testid="context-size-select">{props.children}</div>
	},
	SelectContent: ({ children }: any) => <div>{children}</div>,
	SelectItem: ({ children, value }: any) => <div data-value={value}>{children}</div>,
	SelectTrigger: ({ children }: any) => <div>{children}</div>,
	SelectValue: () => null,
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
		selectProps.length = 0
		messageHandler = undefined
		vi.clearAllMocks()
	})

	function renderProvider(apiConfiguration: ProviderSettings = { apiProvider: "vscode-lm" }) {
		render(<VSCodeLM apiConfiguration={apiConfiguration} setApiConfigurationField={setApiConfigurationField} />)
	}

	it("deduplicates selector variants under one canonical model key", () => {
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
		expect(Object.keys(props.models)).toEqual(["copilot/gpt-5.5"])
		expect(props.labelTransform("copilot/gpt-5.5")).toBe("GPT 5.5 · High")
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

		expect(props.valueTransform("copilot/gpt-5.5")).toEqual({
			vendor: selectedModel.vendor,
			family: selectedModel.family,
			version: selectedModel.version,
			id: selectedModel.id,
		})
		expect(props.displayTransform(selectedModel)).toBe("copilot/gpt-5.5")
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
				supportsReasoningEffort: ["low", "medium", "high"],
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

	it("renders GPT-5.6 maximum reasoning and extended context controls", () => {
		const selectedModel = {
			vendor: "copilot",
			family: "gpt-5.6-terra",
			version: "gpt-5.6-terra",
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			maxInputTokens: 921_793,
		}

		renderProvider({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: selectedModel,
		})
		act(() => {
			messageHandler?.({ data: { type: "vsCodeLmModels", vsCodeLmModels: [selectedModel] } } as MessageEvent)
		})

		expect(thinkingBudgetProps.at(-1).modelInfo).toEqual(
			expect.objectContaining({
				supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
			}),
		)
		expect(screen.getByTestId("context-size-select")).toBeInTheDocument()
		expect(screen.getByText("settings:providers.vscodeLmContextSize.default")).toBeInTheDocument()
		expect(screen.getByText("settings:providers.vscodeLmContextSize.extended")).toBeInTheDocument()

		act(() => selectProps.at(-1).onValueChange("922000"))
		expect(setApiConfigurationField).toHaveBeenCalledWith("vsCodeLmContextSize", 922_000)

		act(() => selectProps.at(-1).onValueChange("272000"))
		expect(setApiConfigurationField).toHaveBeenCalledWith("vsCodeLmContextSize", 272_000)
	})

	it("renders context controls for a catalog fallback before live discovery", () => {
		const catalogModel = {
			vendor: "copilot",
			family: "gpt-5.5",
			name: "GPT-5.5",
		}

		renderProvider({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-5.5" },
		})
		act(() => {
			messageHandler?.({ data: { type: "vsCodeLmModels", vsCodeLmModels: [catalogModel] } } as MessageEvent)
		})

		expect(Object.keys(modelPickerProps.at(-1).models)).toEqual(["copilot/gpt-5.5"])
		expect(screen.getByTestId("context-size-select")).toBeInTheDocument()

		act(() => selectProps.at(-1).onValueChange("922000"))
		expect(setApiConfigurationField).toHaveBeenCalledWith("vsCodeLmContextSize", 922_000)
	})

	it("reports extended context when a live selector still advertises its standard tier", () => {
		const selectedModel = {
			vendor: "copilot",
			family: "gpt-5.5",
			version: "2026-08",
			id: "copilot-gpt-5.5",
			name: "GPT-5.5",
			maxInputTokens: 272_000,
		}

		renderProvider({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: selectedModel,
			vsCodeLmContextSize: 922_000,
		})
		act(() => {
			messageHandler?.({ data: { type: "vsCodeLmModels", vsCodeLmModels: [selectedModel] } } as MessageEvent)
		})

		expect(thinkingBudgetProps.at(-1).modelInfo.contextWindow).toBe(922_000)
		expect(selectProps.at(-1).value).toBe("922000")
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
				contextWindow: 128_000,
				supportsImages: true,
				supportsReasoningEffort: ["low", "medium", "high"],
			}),
		)
		expect(screen.getByTestId("context-size-select")).toBeInTheDocument()
	})

	it("deduplicates equivalent selectors returned by the VS Code LM API", () => {
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
		expect(Object.keys(props.models)).toEqual(["copilot/claude-opus-4.7"])
		expect(props.labelTransform(Object.keys(props.models)[0])).toBe("Claude Opus 4.7")
		expect(props.secondaryLabelTransform(Object.keys(props.models)[0])).toContain("copilot-claude-opus-4.7-alt")
	})

	it("makes every current Copilot model returned by VS Code selectable", () => {
		const currentModels = [
			["gpt-5.3-codex", "GPT-5.3-Codex"],
			["gpt-5.5", "GPT-5.5"],
			["gpt-5.6-luna", "GPT-5.6 Luna"],
			["gpt-5.6-sol", "GPT-5.6 Sol"],
			["gpt-5.6-terra", "GPT-5.6 Terra"],
			["claude-sonnet-4.6", "Claude Sonnet 4.6"],
			["claude-opus-4.6", "Claude Opus 4.6"],
			["claude-opus-4.7", "Claude Opus 4.7"],
			["claude-opus-4.8", "Claude Opus 4.8"],
			["claude-opus-5", "Claude Opus 5"],
			["gemini-3.6-flash", "Gemini 3.6 Flash"],
			["gemini-3.7-flash", "Gemini 3.7 Flash"],
			["mai-code-1.1-flash", "MAI-Code-1.1-Flash"],
			["kimi-k3", "Kimi K3"],
			["grok-4.5", "Grok 4.5"],
			["grok-4.6", "Grok 4.6"],
		] as const
		const models = currentModels.map(([family, name]) => ({
			vendor: "copilot",
			family,
			version: "2026-08",
			id: `copilot-${family}`,
			name,
		}))

		renderProvider()
		act(() => {
			messageHandler?.({ data: { type: "vsCodeLmModels", vsCodeLmModels: models } } as MessageEvent)
		})

		const props = modelPickerProps.at(-1)
		expect(Object.keys(props.models)).toHaveLength(currentModels.length)

		for (const [family, name] of currentModels) {
			const selector = `copilot/${family}`
			expect(Object.keys(props.models)).toContain(selector)
			expect(props.labelTransform(selector)).toBe(name.replaceAll("-", " "))
		}
	})

	it("maps an already configured selector variant to the canonical entry", () => {
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
		expect(Object.keys(props.models)).toEqual(["copilot/claude-opus-4.7"])
		expect(props.displayTransform(selectedModel)).toBe("copilot/claude-opus-4.7")
		expect(thinkingBudgetProps.at(-1).modelInfo).toEqual(
			expect.objectContaining({
				supportsReasoningEffort: ["low", "medium", "high"],
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
		props.onModelChange("copilot/claude-opus-4.5")

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
				supportsReasoningEffort: ["low", "medium", "high"],
			}),
		)
		expect(setApiConfigurationField).not.toHaveBeenCalledWith("vsCodeLmModelSelector", expect.anything())
	})

	it("uses the canonical model capabilities for a legacy selector with duplicate live variants", () => {
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
		expect(props.modelInfo).toEqual(
			expect.objectContaining({
				supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh"],
			}),
		)
	})
})
