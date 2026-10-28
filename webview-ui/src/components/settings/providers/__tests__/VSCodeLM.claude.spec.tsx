import type { LanguageModelChatSelector } from "vscode"
import type { ProviderSettings } from "@alpha-code/types"

import { act, fireEvent, render, screen } from "@/utils/test-utils"
import { VSCodeLM } from "../VSCodeLM"
import { vscode } from "@src/utils/vscode"

vi.mock("../../ThinkingBudget", () => ({ ThinkingBudget: () => null }))
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const claude = {
	vendor: "copilot",
	family: "claude-opus-5.5",
	version: "saved-route-version",
	id: "opaque-saved-claude-route",
}

function renderProvider(selector?: LanguageModelChatSelector) {
	const update = vi.fn()
	const configuration: ProviderSettings = {
		apiProvider: "vscode-lm",
		vsCodeLmModelSelector: selector,
		enableReasoningEffort: false,
		reasoningEffort: "high",
	}
	render(<VSCodeLM apiConfiguration={configuration} setApiConfigurationField={update} />)
	return update
}

describe("VSCodeLM saved selection with the real picker", () => {
	beforeEach(() => vi.clearAllMocks())

	it("keeps an exact saved Claude route untouched while showing its catalog model immediately", () => {
		const original = structuredClone(claude)
		const update = renderProvider(claude)

		expect(screen.getByTestId("model-picker-button")).toHaveTextContent("Claude Opus 5.5")
		expect(screen.getByText("settings:modelInfo.contextWindow")).toBeInTheDocument()
		expect(update).not.toHaveBeenCalled()
		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(claude).toEqual(original)

		act(() => {
			window.dispatchEvent(new MessageEvent("message", { data: { type: "vsCodeLmModels", vsCodeLmModels: [] } }))
		})
		expect(screen.getByTestId("model-picker-button")).toHaveTextContent("Claude Opus 5.5")
		expect(update).not.toHaveBeenCalled()
	})

	it("keeps a historical decorated exact ID usable in settings despite an opaque family", () => {
		const selector = {
			vendor: "copilot",
			family: "opaque-family",
			id: "copilot-gpt-6.1-sol-standard",
			version: "2026",
		}
		const update = renderProvider(selector)

		expect(screen.getByTestId("model-picker-button")).toHaveTextContent("GPT-6.1 Sol")
		expect(screen.queryByText("settings:providers.vscodeLmUnavailable")).not.toBeInTheDocument()
		expect(update).not.toHaveBeenCalled()
	})

	it.each([
		{ vendor: "copilot", family: "removed-model", id: "removed-route" },
		{ vendor: "copilot", family: "gpt-4o", id: "retired-route" },
		{ vendor: "copilot", family: "gpt-5.5", id: "saved-retired-route" },
		{ vendor: "another-provider", family: claude.family, id: "another-route" },
	])("does not initialize over unsupported saved selection %j", (selector) => {
		const update = renderProvider(selector)

		expect(screen.getByTestId("model-picker-button")).not.toHaveTextContent("settings:modelPicker.selectModel")
		expect(screen.getByText("settings:providers.vscodeLmUnavailable")).toBeInTheDocument()
		expect(update).not.toHaveBeenCalled()
	})

	it("does not show base-model capabilities for an unsupported saved variant", () => {
		const selector = { vendor: "copilot", family: "gpt-6.1-sol-mini", id: "saved-unsupported-route" }
		const original = structuredClone(selector)
		const update = renderProvider(selector)

		expect(screen.getByTestId("model-picker-button")).toHaveTextContent("gpt-6.1-sol-mini")
		expect(screen.getByText("settings:providers.vscodeLmUnavailable")).toBeInTheDocument()
		expect(screen.queryByText("settings:modelInfo.contextWindow")).not.toBeInTheDocument()
		expect(screen.queryByText("settings:modelInfo.supportsImages")).not.toBeInTheDocument()
		expect(update).not.toHaveBeenCalled()
		expect(selector).toEqual(original)
	})

	it("initializes an empty profile from the bundled default without discovery", () => {
		const update = renderProvider()

		expect(update).toHaveBeenCalledWith(
			"vsCodeLmModelSelector",
			{ vendor: "copilot", family: "gpt-6.1-sol" },
			false,
		)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("only replaces an exact saved route after an explicit supported model selection", () => {
		const update = renderProvider(claude)
		expect(update).not.toHaveBeenCalled()

		fireEvent.click(screen.getByTestId("model-picker-button"))
		fireEvent.click(screen.getByTestId("model-option-gpt-6.1-sol"))

		expect(update).toHaveBeenCalledWith("vsCodeLmModelSelector", { vendor: "copilot", family: "gpt-6.1-sol" })
		expect(update).not.toHaveBeenCalledWith("reasoningEffort", undefined)
		expect(claude.id).toBe("opaque-saved-claude-route")
	})

	it("can explicitly select the same catalog model to replace a saved exact route", () => {
		const update = renderProvider(claude)

		fireEvent.click(screen.getByTestId("model-picker-button"))
		fireEvent.click(screen.getByTestId("model-option-claude-opus-5.5"))

		expect(update).toHaveBeenCalledWith("vsCodeLmModelSelector", { vendor: "copilot", family: claude.family })
		expect(claude.id).toBe("opaque-saved-claude-route")
	})

	it("allows an unsupported saved route to be replaced with a supported Claude model", () => {
		const update = renderProvider({ vendor: "copilot", family: "removed-model", id: "removed-route" })

		fireEvent.click(screen.getByTestId("model-picker-button"))
		fireEvent.click(screen.getByTestId("model-option-claude-opus-5.5"))

		expect(update).toHaveBeenCalledWith("vsCodeLmModelSelector", { vendor: "copilot", family: claude.family })
	})
})
