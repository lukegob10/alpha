import { render, screen } from "@/utils/test-utils"
import type { ProviderSettings } from "@alpha-code/types"

import { OpenAICodex } from "../OpenAICodex"

const modelPickerProps: any[] = []

vi.mock("../../ModelPicker", () => ({
	ModelPicker: (props: any) => {
		modelPickerProps.push(props)
		return <div data-testid="model-picker">Model Picker</div>
	},
}))

vi.mock("../OpenAICodexRateLimitDashboard", () => ({
	OpenAICodexRateLimitDashboard: () => <div data-testid="rate-limit-dashboard" />,
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
	}),
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

describe("OpenAICodex", () => {
	beforeEach(() => {
		modelPickerProps.length = 0
		vi.clearAllMocks()
	})

	it("exposes current ChatGPT subscription models with Sol as the default", () => {
		render(
			<OpenAICodex
				apiConfiguration={{ apiProvider: "openai-codex" } as ProviderSettings}
				setApiConfigurationField={vi.fn()}
			/>,
		)

		expect(screen.getByTestId("model-picker")).toBeInTheDocument()
		const props = modelPickerProps.at(-1)

		expect(props.defaultModelId).toBe("gpt-5.6-sol")
		expect(props.models).toEqual(
			expect.objectContaining({
				"gpt-5.6-sol": expect.any(Object),
				"gpt-5.6-terra": expect.any(Object),
				"gpt-5.6-luna": expect.any(Object),
				"gpt-5.5": expect.any(Object),
			}),
		)
		expect(props.models["gpt-5.3-codex"].deprecated).toBe(true)
		expect(props.models["gpt-5.2"].deprecated).toBe(true)
	})
})
