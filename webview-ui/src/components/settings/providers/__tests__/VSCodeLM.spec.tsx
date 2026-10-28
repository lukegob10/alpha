import type { ComponentProps, ReactNode } from "react"
import type { ProviderSettings } from "@alpha-code/types"
import { getVscodeLlmCatalogModels, getVscodeLlmModelId, vscodeLlmDefaultModelId } from "@alpha-code/types"

import { act, render, screen } from "@/utils/test-utils"
import type { ModelPicker } from "../../ModelPicker"
import type { ThinkingBudget } from "../../ThinkingBudget"
import { VSCodeLM } from "../VSCodeLM"
import { vscode } from "@src/utils/vscode"

type PickerProps = ComponentProps<typeof ModelPicker>
type ThinkingProps = ComponentProps<typeof ThinkingBudget>
type TestSelectProps = { children: ReactNode; value?: string; onValueChange: (value: string) => void }

const modelPickerProps: PickerProps[] = []
const thinkingBudgetProps: ThinkingProps[] = []
const selectProps: TestSelectProps[] = []

vi.mock("../../ModelPicker", () => ({
	ModelPicker: (props: PickerProps) => {
		modelPickerProps.push(props)
		return <div data-testid="model-picker">Model Picker</div>
	},
}))

vi.mock("../../ThinkingBudget", () => ({
	ThinkingBudget: (props: ThinkingProps) => {
		thinkingBudgetProps.push(props)
		return <div data-testid="thinking-budget">Thinking Budget</div>
	},
}))

vi.mock("@src/components/ui", () => ({
	Select: (props: TestSelectProps) => {
		selectProps.push(props)
		return <div data-testid="context-size-select">{props.children}</div>
	},
	SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
		<div data-value={value}>{children}</div>
	),
	SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	SelectValue: () => null,
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

function picker(): PickerProps {
	const props = modelPickerProps.at(-1)
	if (!props) throw new Error("Model picker was not rendered")
	return props
}

function thinking(): ThinkingProps {
	const props = thinkingBudgetProps.at(-1)
	if (!props) throw new Error("Thinking settings were not rendered")
	return props
}

describe("VSCodeLM supported model setup", () => {
	const setApiConfigurationField = vi.fn()

	beforeEach(() => {
		modelPickerProps.length = 0
		thinkingBudgetProps.length = 0
		selectProps.length = 0
		vi.clearAllMocks()
	})

	function renderProvider(apiConfiguration: ProviderSettings = { apiProvider: "vscode-lm" }) {
		return render(
			<VSCodeLM apiConfiguration={apiConfiguration} setApiConfigurationField={setApiConfigurationField} />,
		)
	}

	it("renders the supported catalog immediately without waiting for discovery", () => {
		renderProvider()

		expect(screen.getByTestId("model-picker")).toBeInTheDocument()
		expect(picker().models?.["gpt-6.1-sol"]).toMatchObject({
			supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
		})
		expect(picker().defaultModelId).toBe(vscodeLlmDefaultModelId)
		expect(picker().allowCustomModel).toBe(false)
		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(screen.queryByText("settings:providers.vscodeLmLoading")).not.toBeInTheDocument()
		expect(screen.queryByTestId("refresh-vscode-lm-models")).not.toBeInTheDocument()
	})

	it("offers the bundled supported models without retired catalog entries", () => {
		renderProvider()

		expect(Object.keys(picker().models ?? {})).toEqual(getVscodeLlmCatalogModels().map(getVscodeLlmModelId))
		expect(picker().models).not.toHaveProperty("claude-mythos-5")
		expect(picker().models).not.toHaveProperty("gpt-4o")
	})

	it("stores a canonical family without inventing a host ID or version", () => {
		renderProvider()

		expect(picker().valueTransform?.("gpt-6.1-sol")).toEqual({
			vendor: "copilot",
			family: "gpt-6.1-sol",
		})
		expect(picker().valueTransform?.("not-a-supported-model")).toBeUndefined()
		expect(picker().labelTransform?.("gpt-6.1-sol")).toBe("GPT-6.1 Sol")
	})

	it("retains a saved exact routing identity while displaying its known model", () => {
		const selector = {
			vendor: "copilot",
			family: "gpt-6.1-sol",
			version: "saved-version",
			id: "opaque-saved-id",
		}
		renderProvider({ apiProvider: "vscode-lm", vsCodeLmModelSelector: selector })

		expect(picker().displayTransform?.(selector)).toBe("gpt-6.1-sol")
		expect(picker().apiConfiguration.vsCodeLmModelSelector).toBe(selector)
		expect(picker().errorMessage).toBeUndefined()
		expect(thinking().modelInfo?.supportsReasoningEffort).toEqual(["low", "medium", "high", "xhigh", "max"])
		expect(setApiConfigurationField).not.toHaveBeenCalled()
	})

	it("ignores old discovery messages instead of replacing the supported choices", () => {
		renderProvider({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-6.1-sol" },
		})
		const models = picker().models
		const info = thinking().modelInfo

		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "vsCodeLmModels", vsCodeLmModels: [] } }))
		})

		expect(picker().models).toBe(models)
		expect(thinking().modelInfo).toBe(info)
		expect(setApiConfigurationField).not.toHaveBeenCalled()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("uses a decorated saved exact ID for display metadata without replacing its opaque family", () => {
		const selector = {
			vendor: "copilot",
			family: "opaque-family",
			id: "copilot-gpt-6.1-sol-standard",
			version: "2026",
		}
		renderProvider({ apiProvider: "vscode-lm", vsCodeLmModelSelector: selector })

		expect(picker().displayTransform?.(selector)).toBe("gpt-6.1-sol")
		expect(picker().apiConfiguration.vsCodeLmModelSelector).toBe(selector)
		expect(picker().errorMessage).toBeUndefined()
		expect(thinking().modelInfo?.supportsReasoningEffort).toEqual(["low", "medium", "high", "xhigh", "max"])
		expect(setApiConfigurationField).not.toHaveBeenCalled()
	})

	it.each([
		{ vendor: "copilot", family: "unknown-saved-model", id: "saved-route" },
		{ vendor: "copilot", family: "gpt-6.1-sol-mini", id: "saved-route" },
		{ vendor: "copilot", family: "gpt-6.1-sol-mini", id: "copilot-gpt-6.1-sol-standard" },
		{ vendor: "copilot", family: "gpt-5.5", id: "copilot-gpt-5.5-standard" },
		{ vendor: "copilot", family: "gpt-4o" },
		{ vendor: "another-provider", family: "gpt-6.1-sol", id: "saved-route" },
	])("preserves an unsupported saved selector for explicit replacement: %j", (selector) => {
		renderProvider({ apiProvider: "vscode-lm", vsCodeLmModelSelector: selector })

		expect(picker().displayTransform?.(selector)).toBeTruthy()
		expect(picker().apiConfiguration.vsCodeLmModelSelector).toBe(selector)
		expect(picker().errorMessage).toBe("settings:providers.vscodeLmUnavailable")
		expect(thinking().modelInfo).toBeUndefined()
		expect(setApiConfigurationField).not.toHaveBeenCalled()
	})

	it.each([
		["gpt-6.1-sol", ["low", "medium", "high", "xhigh", "max"], undefined],
		["gpt-6-astra", ["low", "medium", "high", "xhigh", "max"], undefined],
		["claude-opus-5.5", ["low", "medium", "high", "xhigh", "max"], "medium"],
		["claude-sonnet-5.5", ["low", "medium", "high", "xhigh", "max"], undefined],
	] as const)(
		"projects %s reasoning metadata without moving effort into profile settings",
		(family, efforts, defaultEffort) => {
			renderProvider({ apiProvider: "vscode-lm", vsCodeLmModelSelector: { vendor: "copilot", family } })

			expect(thinking().modelInfo?.supportsReasoningEffort).toEqual(efforts)
			expect(thinking().modelInfo?.reasoningEffort).toBe(defaultEffort)
			expect(thinking().showReasoningEffort).toBe(false)
			expect(setApiConfigurationField).not.toHaveBeenCalled()
		},
	)

	it.each([
		["claude-opus-5.5", 200_000, 936_000],
		["claude-sonnet-5.5", 200_000, 936_000],
		["gpt-6-astra", 272_000, 1_050_000],
	] as const)("offers the defined context tiers for %s before contacting VS Code", (family, standard, extended) => {
		const view = renderProvider({ apiProvider: "vscode-lm", vsCodeLmModelSelector: { vendor: "copilot", family } })

		expect(thinking().modelInfo?.contextWindow).toBe(standard)
		expect(screen.getByTestId("context-size-select")).toBeInTheDocument()
		expect(selectProps.at(-1)?.value).toBe(standard.toString())
		act(() => selectProps.at(-1)?.onValueChange(extended.toString()))
		expect(setApiConfigurationField).toHaveBeenCalledWith("vsCodeLmContextSize", extended)

		view.rerender(
			<VSCodeLM
				apiConfiguration={{
					apiProvider: "vscode-lm",
					vsCodeLmModelSelector: { vendor: "copilot", family },
					vsCodeLmContextSize: extended,
				}}
				setApiConfigurationField={setApiConfigurationField}
			/>,
		)
		expect(thinking().modelInfo?.contextWindow).toBe(extended)
		expect(selectProps.at(-1)?.value).toBe(extended.toString())
	})

	it("keeps models with one context window free of a context switch", () => {
		renderProvider({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-6.1-sol" },
			vsCodeLmContextSize: 1_050_000,
		})

		expect(thinking().modelInfo?.contextWindow).toBe(922_000)
		expect(screen.queryByTestId("context-size-select")).not.toBeInTheDocument()
	})

	it("does not treat stale saved host metadata as a fresh capability lookup", () => {
		const selector = { vendor: "copilot", family: "claude-opus-5.5", id: "saved-route", maxInputTokens: 128_000 }
		renderProvider({ apiProvider: "vscode-lm", vsCodeLmModelSelector: selector })

		expect(thinking().modelInfo?.contextWindow).toBe(200_000)
		expect(screen.getByTestId("context-size-select")).toBeInTheDocument()
		expect(setApiConfigurationField).not.toHaveBeenCalled()
	})

	it("does not rewrite legacy profile reasoning when a saved model is retired", () => {
		renderProvider({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: { vendor: "copilot", family: "claude-opus-4.5", id: "saved-legacy-route" },
			enableReasoningEffort: true,
			reasoningEffort: "high",
		})

		expect(picker().errorMessage).toBe("settings:providers.vscodeLmUnavailable")
		expect(thinking().apiConfiguration.reasoningEffort).toBe("high")
		expect(setApiConfigurationField).not.toHaveBeenCalled()
	})

	it.each([
		["claude-sonnet-5.5", "disable"],
		["claude-opus-5.5", "none"],
		["gpt-6.1-sol", "none"],
	] as const)("clears unsupported %s profile effort %s only on model change", (family, effort) => {
		renderProvider({ apiProvider: "vscode-lm", enableReasoningEffort: false, reasoningEffort: effort })
		expect(setApiConfigurationField).not.toHaveBeenCalled()

		picker().onModelChange?.(family)

		expect(setApiConfigurationField).toHaveBeenCalledWith("reasoningEffort", undefined)
	})

	it("preserves a compatible profile effort and context size when changing models", () => {
		renderProvider({
			apiProvider: "vscode-lm",
			enableReasoningEffort: true,
			reasoningEffort: "high",
			vsCodeLmContextSize: 936_000,
		})

		picker().onModelChange?.("claude-opus-5.5")

		expect(setApiConfigurationField).not.toHaveBeenCalled()
	})

	it("clears a context size unsupported by the explicitly selected model", () => {
		renderProvider({ apiProvider: "vscode-lm", vsCodeLmContextSize: 936_000 })

		picker().onModelChange?.("gpt-6.1-sol")

		expect(setApiConfigurationField).toHaveBeenCalledWith("vsCodeLmContextSize", undefined)
	})

	it("updates model metadata when the settings edit buffer changes", () => {
		const view = renderProvider({
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-6.1-sol" },
		})
		view.rerender(
			<VSCodeLM
				apiConfiguration={{
					apiProvider: "vscode-lm",
					vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-6-astra" },
				}}
				setApiConfigurationField={setApiConfigurationField}
			/>,
		)

		expect(thinking().modelInfo).toMatchObject({ name: "GPT 6 Astra", contextWindow: 272_000 })
		expect(thinking().modelInfo?.supportsReasoningEffort).toEqual(["low", "medium", "high", "xhigh", "max"])
		expect(setApiConfigurationField).not.toHaveBeenCalled()
	})
})
