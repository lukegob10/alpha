import type { ComponentProps } from "react"
import type { LanguageModelChatSelector } from "vscode"
import type { ProviderSettings } from "@alpha-code/types"

import { act, render } from "@/utils/test-utils"
import type { ModelPicker } from "../../ModelPicker"
import type { ThinkingBudget } from "../../ThinkingBudget"
import { VSCodeLM } from "../VSCodeLM"

let picker: ComponentProps<typeof ModelPicker> | undefined
let thinking: ComponentProps<typeof ThinkingBudget> | undefined

vi.mock("../../ModelPicker", () => ({
	ModelPicker: (props: ComponentProps<typeof ModelPicker>) => {
		picker = props
		return null
	},
}))

vi.mock("../../ThinkingBudget", () => ({
	ThinkingBudget: (props: ComponentProps<typeof ThinkingBudget>) => {
		thinking = props
		return null
	},
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

const claude = {
	vendor: "copilot",
	family: "claude-opus-5.5",
	version: "route-v2",
	id: "opaque-claude-route-v2",
	name: "Claude Opus",
	maxInputTokens: 128_000,
}

function loadModels(selector: LanguageModelChatSelector, models = [claude]) {
	const setApiConfigurationField = vi.fn()
	const apiConfiguration: ProviderSettings = {
		apiProvider: "vscode-lm",
		vsCodeLmModelSelector: selector,
		enableReasoningEffort: false,
		reasoningEffort: "high",
	}
	render(<VSCodeLM apiConfiguration={apiConfiguration} setApiConfigurationField={setApiConfigurationField} />)
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "vsCodeLmModels", vsCodeLmModels: models } }))
	})
	return setApiConfigurationField
}

describe("VSCodeLM Claude Copilot identity", () => {
	beforeEach(() => {
		picker = undefined
		thinking = undefined
	})

	it.each([
		{ vendor: "copilot", family: claude.family, id: "removed-claude-route" },
		{ vendor: "copilot", family: claude.family, version: "removed-version" },
		{ vendor: "another-provider", family: claude.family },
	])("does not display a replacement for unavailable saved selector %j", (selector) => {
		const update = loadModels(selector)

		expect(picker?.errorMessage).toBe("settings:providers.vscodeLmUnavailable")
		expect(thinking?.modelInfo).toBeUndefined()
		expect(update).not.toHaveBeenCalled()
	})

	it.each([claude.family, "claude-opus-5-5"])(
		"keeps unambiguous legacy Claude family %s readable without rewriting it",
		(family) => {
			const selector = { vendor: "copilot", family }
			const update = loadModels(selector)

			expect(picker?.errorMessage).toBeUndefined()
			expect(picker?.displayTransform?.(selector)).toBe(`copilot/${claude.id}`)
			expect(thinking?.modelInfo?.contextWindow).toBe(128_000)
			expect(thinking?.apiConfiguration.enableReasoningEffort).toBe(false)
			expect(thinking?.apiConfiguration.reasoningEffort).toBe("high")
			expect(update).not.toHaveBeenCalled()
		},
	)

	it("requires explicit selection when a legacy Claude family has multiple live routes", () => {
		loadModels({ vendor: "copilot", family: "claude-opus-5-5" }, [claude, { ...claude, id: "second-claude-route" }])

		expect(picker?.errorMessage).toBe("settings:providers.vscodeLmUnavailable")
		expect(thinking?.modelInfo).toBeUndefined()
	})

	it("returns only exact host identity when the user explicitly chooses a Claude route", () => {
		loadModels({ vendor: "copilot", family: claude.family })

		expect(picker?.valueTransform?.(`copilot/${claude.id}`)).toEqual({
			vendor: claude.vendor,
			family: claude.family,
			version: claude.version,
			id: claude.id,
		})
	})
})
