import { render, screen } from "@/utils/test-utils"

import type { ProviderSettings } from "@alpha-code/types"

import { Anthropic } from "../Anthropic"
import { Gemini } from "../Gemini"
import { OpenAI } from "../OpenAI"
import { OpenRouter } from "../OpenRouter"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, type, value, onInput, ...props }: any) => (
		<div>
			{children}
			<input
				{...props}
				data-testid={type === "url" ? "custom-base-url" : undefined}
				type={type}
				value={value}
				onChange={onInput}
			/>
		</div>
	),
}))

vi.mock("vscrui", () => ({
	Checkbox: ({ children, checked, onChange }: any) => (
		<label>
			<input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
			{children}
		</label>
	),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/components/common/VSCodeButtonLink", () => ({
	VSCodeButtonLink: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => undefined,
}))

vi.mock("@src/components/settings/ModelPicker", () => ({
	ModelPicker: () => null,
}))

vi.mock("../OpenRouterBalanceDisplay", () => ({
	OpenRouterBalanceDisplay: () => null,
}))

const assertDisclosureTracksProfile = (
	renderProvider: (configuration: ProviderSettings) => React.ReactNode,
	populatedConfiguration: ProviderSettings,
) => {
	const { rerender } = render(<>{renderProvider(populatedConfiguration)}</>)

	expect(screen.getByTestId("custom-base-url")).toBeInTheDocument()

	rerender(<>{renderProvider({})}</>)
	expect(screen.queryByTestId("custom-base-url")).not.toBeInTheDocument()

	rerender(<>{renderProvider(populatedConfiguration)}</>)
	expect(screen.getByTestId("custom-base-url")).toBeInTheDocument()
}

describe("provider disclosure state", () => {
	const setApiConfigurationField = vi.fn()

	beforeEach(() => vi.clearAllMocks())

	it("tracks Anthropic profile changes", () => {
		assertDisclosureTracksProfile(
			(apiConfiguration) => (
				<Anthropic apiConfiguration={apiConfiguration} setApiConfigurationField={setApiConfigurationField} />
			),
			{ anthropicBaseUrl: "https://anthropic.example" },
		)
	})

	it("tracks Gemini profile changes", () => {
		assertDisclosureTracksProfile(
			(apiConfiguration) => (
				<Gemini apiConfiguration={apiConfiguration} setApiConfigurationField={setApiConfigurationField} />
			),
			{ googleGeminiBaseUrl: "https://gemini.example" },
		)
	})

	it("tracks OpenAI profile changes", () => {
		assertDisclosureTracksProfile(
			(apiConfiguration) => (
				<OpenAI apiConfiguration={apiConfiguration} setApiConfigurationField={setApiConfigurationField} />
			),
			{ openAiNativeBaseUrl: "https://openai.example" },
		)
	})

	it("tracks OpenRouter profile changes", () => {
		assertDisclosureTracksProfile(
			(apiConfiguration) => (
				<OpenRouter
					apiConfiguration={apiConfiguration}
					setApiConfigurationField={setApiConfigurationField}
					selectedModelId="model"
					uriScheme="alpha"
					organizationAllowList={{ allowAll: true }}
				/>
			),
			{ openRouterBaseUrl: "https://openrouter.example" },
		)
	})
})
