import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import type { ProviderSettings } from "@alpha-code/types"

vi.mock("@src/components/settings/providers", async () => {
	const { OpenAICompatible } = await import("../providers/OpenAICompatible")
	return { OpenAICompatible, Vertex: () => null, VSCodeLM: () => null }
})

vi.mock("@src/components/ui", async () => {
	const collapsible = await import("@radix-ui/react-collapsible")
	return {
		Collapsible: collapsible.Root,
		CollapsibleTrigger: collapsible.Trigger,
		CollapsibleContent: collapsible.Content,
		SearchableSelect: ({
			value,
			onValueChange,
			options,
		}: {
			value: string
			onValueChange: (value: string) => void
			options: Array<{ value: string; label: string }>
		}) => (
			<select aria-label="Provider" value={value} onChange={(event) => onValueChange(event.target.value)}>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		),
		Button: ({ children, ...props }: React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>) => (
			<button {...props}>{children}</button>
		),
		StandardTooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
	}
})

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
	VSCodeButton: ({ children, onClick }: React.PropsWithChildren<{ onClick: () => void }>) => (
		<button onClick={onClick}>{children}</button>
	),
	VSCodeTextField: ({ children, ...props }: React.PropsWithChildren<React.InputHTMLAttributes<HTMLInputElement>>) => (
		<div>
			{children}
			<input {...props} />
		</div>
	),
}))

vi.mock("vscrui", () => ({
	Checkbox: ({
		checked,
		onChange,
		children,
	}: React.PropsWithChildren<{ checked: boolean; onChange: (checked: boolean) => void }>) => (
		<label>
			<input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
			{children}
		</label>
	),
}))

vi.mock("../ModelPicker", () => ({ ModelPicker: () => <div data-testid="model-picker">Model</div> }))
vi.mock("../ThinkingBudget", () => ({ ThinkingBudget: () => null }))
vi.mock("../Verbosity", () => ({ Verbosity: () => null }))
vi.mock("../TemperatureControl", () => ({ TemperatureControl: () => null }))
vi.mock("../RateLimitSecondsControl", () => ({ RateLimitSecondsControl: () => <div>Request interval</div> }))
vi.mock("../R1FormatSetting", () => ({ R1FormatSetting: () => <div>R1 compatibility</div> }))
vi.mock("../ApiErrorMessage", () => ({ ApiErrorMessage: () => null }))
vi.mock("../SettingsHelp", () => ({
	SettingsHelp: ({ label, children }: React.PropsWithChildren<{ label: string }>) => (
		<details>
			<summary aria-label={`Help: ${label}`} />
			{children}
		</details>
	),
}))
vi.mock("@src/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }))
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("react-use", () => ({ useDebounce: vi.fn(), useEvent: vi.fn() }))

import ApiOptions from "../ApiOptions"

function BufferedOptions({
	configuration,
	onSave = vi.fn(),
	fromWelcomeView = false,
}: {
	configuration: ProviderSettings
	onSave?: (configuration: ProviderSettings) => void
	fromWelcomeView?: boolean
}) {
	const [buffer, setBuffer] = React.useState(configuration)
	const [error, setError] = React.useState<string>()
	const setField = React.useCallback(<K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K]) => {
		setBuffer((previous) => (previous[field] === value ? previous : { ...previous, [field]: value }))
	}, [])
	return (
		<>
			<ApiOptions
				uriScheme={undefined}
				apiConfiguration={buffer}
				setApiConfigurationField={setField}
				fromWelcomeView={fromWelcomeView}
				errorMessage={error}
				setErrorMessage={setError}
			/>
			<button disabled={!!error} onClick={() => onSave(buffer)}>
				Save
			</button>
		</>
	)
}

const compatibleConfiguration: ProviderSettings = {
	apiProvider: "openai",
	openAiBaseUrl: "https://gateway.example.com/v1",
	openAiApiKey: "test-key",
	openAiModelId: "custom-model",
	includeMaxTokens: true,
	openAiCustomModelInfo: { contextWindow: 128_000, maxTokens: 512, supportsPromptCache: false },
	openAiStreamingEnabled: false,
	openAiHeaders: { "X-Route": "saved-route" },
}

describe("provider settings progressive disclosure", () => {
	it("keeps onboarding credentials and model visible while optional native limits stay collapsed", () => {
		const onSave = vi.fn()
		render(
			<BufferedOptions
				configuration={{
					apiProvider: "xai",
					xaiApiKey: "test-key",
					includeMaxTokens: true,
					modelMaxTokens: 512,
					todoListEnabled: false,
					consecutiveMistakeLimit: 7,
				}}
				fromWelcomeView
				onSave={onSave}
			/>,
		)
		expect(screen.getByTestId("curated-provider-api-key")).toBeVisible()
		expect(screen.getByTestId("model-picker")).toBeVisible()
		expect(screen.getByText("settings:providers.apiKeyStorageNotice")).not.toBeVisible()
		expect(screen.getByText("settings:providers.apiProviderDocs")).not.toBeVisible()
		const limit = screen.getByTestId("curated-output-token-limit")
		expect(limit).not.toBeVisible()
		const advanced = screen.getByRole("button", { name: "settings:providers.advancedModel" })
		expect(advanced).toHaveAttribute("aria-expanded", "false")
		fireEvent.click(advanced)
		expect(limit).toBeVisible()
		expect(screen.getByText("settings:providers.outputTokenLimitDescription")).not.toBeVisible()
		expect(limit).toHaveValue("512")
		expect(screen.queryByText("settings:advanced.todoList.label")).not.toBeInTheDocument()
		expect(screen.queryByText("settings:providers.consecutiveMistakeLimit.label")).not.toBeInTheDocument()
		fireEvent.click(screen.getByText("Save"))
		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				includeMaxTokens: true,
				modelMaxTokens: 512,
				todoListEnabled: false,
				consecutiveMistakeLimit: 7,
			}),
		)
	})

	it("retains a native invalid draft and Save blocker when its disclosure closes", () => {
		render(
			<BufferedOptions
				configuration={{ apiProvider: "xai", xaiApiKey: "key", includeMaxTokens: true, modelMaxTokens: 512 }}
			/>,
		)
		const advanced = screen.getByRole("button", { name: "settings:providers.advancedModel" })
		fireEvent.click(advanced)
		const limit = screen.getByTestId("curated-output-token-limit")
		fireEvent.input(limit, { target: { value: "invalid" } })
		expect(screen.getByText("Save")).toBeDisabled()
		fireEvent.click(advanced)
		expect(limit).not.toBeVisible()
		expect(screen.getByText("Save")).toBeDisabled()
		fireEvent.click(advanced)
		expect(limit).toHaveValue("invalid")
		fireEvent.input(limit, { target: { value: "256" } })
		expect(screen.getByText("Save")).toBeEnabled()
	})

	it("keeps compatible transport, capabilities and pricing out of onboarding until expanded", () => {
		const onSave = vi.fn()
		render(<BufferedOptions configuration={compatibleConfiguration} fromWelcomeView onSave={onSave} />)
		expect(screen.getByPlaceholderText("settings:placeholders.baseUrl")).toBeVisible()
		expect(screen.getByPlaceholderText("settings:placeholders.apiKey")).toBeVisible()
		expect(screen.getByTestId("model-picker")).toBeVisible()
		expect(screen.getByText("R1 compatibility")).not.toBeVisible()
		expect(screen.getByText("settings:providers.customHeaders")).not.toBeVisible()
		expect(screen.getByText("settings:providers.customModel.pricing.input.label")).not.toBeVisible()
		fireEvent.click(screen.getByRole("button", { name: "settings:providers.advancedConnection" }))
		expect(screen.getByText("R1 compatibility")).toBeVisible()
		expect(screen.getByText("settings:providers.customHeaders")).toBeVisible()
		expect(screen.getByText("settings:providers.customModel.pricing.input.label")).toBeVisible()
		expect(screen.getByRole("checkbox", { name: "settings:modelInfo.enableStreaming" })).not.toBeChecked()
		fireEvent.click(screen.getByText("Save"))
		expect(onSave).toHaveBeenCalledWith(expect.objectContaining(compatibleConfiguration))
	})

	it("preserves compatible draft headers and numeric errors across disclosure toggles", () => {
		render(<BufferedOptions configuration={compatibleConfiguration} />)
		const advanced = screen.getByRole("button", { name: "settings:providers.advancedConnection" })
		fireEvent.click(advanced)
		const header = screen.getByPlaceholderText("settings:providers.headerValue")
		fireEvent.input(header, { target: { value: "buffered-route" } })
		const limit = screen.getByTestId("max-output-tokens")
		fireEvent.input(limit, { target: { value: "1.5" } })
		expect(screen.getByText("Save")).toBeDisabled()
		fireEvent.click(advanced)
		expect(header).not.toBeVisible()
		expect(limit).not.toBeVisible()
		expect(screen.getByText("Save")).toBeDisabled()
		fireEvent.click(advanced)
		expect(header).toHaveValue("buffered-route")
		expect(limit).toHaveValue("1.5")
		fireEvent.input(limit, { target: { value: "256" } })
		expect(screen.getByText("Save")).toBeEnabled()
	})
})
