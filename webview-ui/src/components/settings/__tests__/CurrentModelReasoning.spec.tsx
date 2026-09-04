import { useState } from "react"

import type { ProviderSettings } from "@alpha-code/types"

import { fireEvent, render, screen } from "@/utils/test-utils"

import { ThinkingBudget } from "../ThinkingBudget"
import { getStaticModelsForProvider } from "../utils/providerModelConfig"

vi.mock("@/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: (configuration: ProviderSettings) => ({ id: configuration.apiModelId }),
}))

describe.each([
	{
		provider: "openai-native",
		modelId: "gpt-6-astra",
		efforts: ["low", "medium", "high", "xhigh", "max"],
	},
	{
		provider: "gemini",
		modelId: "gemini-3.8-flash",
		efforts: ["low", "medium", "high"],
	},
] as const)("$modelId reasoning in $provider settings", ({ provider, modelId, efforts }) => {
	it("shows the supported levels, initializes Medium, and saves each selection to the edit buffer", async () => {
		const models = getStaticModelsForProvider(provider)
		const modelInfo = models[modelId]
		expect(modelInfo).toBeDefined()
		const setField = vi.fn()

		function SettingsHarness() {
			const [configuration, setConfiguration] = useState<ProviderSettings>({
				apiProvider: provider,
				apiModelId: modelId,
			})
			return (
				<ThinkingBudget
					apiConfiguration={configuration}
					modelInfo={modelInfo}
					setApiConfigurationField={(field, value, isUserAction) => {
						setField(field, value, isUserAction)
						setConfiguration((previous) => ({ ...previous, [field]: value }))
					}}
				/>
			)
		}

		render(<SettingsHarness />)
		expect(setField).toHaveBeenCalledWith("reasoningEffort", "medium", false)
		expect(setField).toHaveBeenCalledWith("enableReasoningEffort", true, false)

		for (const [index, effort] of efforts.entries()) {
			fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" })
			const options = await screen.findAllByRole("option")
			expect(options).toHaveLength(efforts.length)
			fireEvent.click(options[index])
			expect(setField).toHaveBeenCalledWith("reasoningEffort", effort, undefined)
			expect(setField).toHaveBeenCalledWith("enableReasoningEffort", true, undefined)
		}
	})
})
