import React from "react"
import { expect } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import type { ModelInfo, ProviderSettings } from "@alpha-code/types"

vi.mock("@src/components/settings/providers", async () => {
	const { OpenAICompatible } = await import("../providers/OpenAICompatible")
	return { OpenAICompatible, Stellar: () => null, Vertex: () => null, VSCodeLM: () => null }
})

vi.mock("vscrui", () => ({
	Checkbox: ({
		checked,
		onChange,
		children,
	}: React.PropsWithChildren<{ checked: boolean; onChange: (value: boolean) => void }>) => (
		<label>
			<input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
			{children}
		</label>
	),
}))

vi.mock("../ThinkingBudget", () => ({ ThinkingBudget: () => null }))
vi.mock("../ModelPicker", () => ({ ModelPicker: () => null }))
vi.mock("../ApiErrorMessage", () => ({ ApiErrorMessage: () => null }))
vi.mock("../TodoListSettingsControl", () => ({ TodoListSettingsControl: () => null }))
vi.mock("../RateLimitSecondsControl", () => ({ RateLimitSecondsControl: () => null }))
vi.mock("../ConsecutiveMistakeLimitControl", () => ({ ConsecutiveMistakeLimitControl: () => null }))

vi.mock("@src/components/ui", () => ({
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
	Button: ({
		children,
		onClick,
	}: React.PropsWithChildren<{ onClick?: React.MouseEventHandler<HTMLButtonElement> }>) => (
		<button onClick={onClick}>{children}</button>
	),
	StandardTooltip: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
	Collapsible: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
	CollapsibleTrigger: ({ children }: React.PropsWithChildren) => <button>{children}</button>,
	CollapsibleContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
	Slider: ({ value, onValueChange }: { value: number[]; onValueChange: (value: number[]) => void }) => (
		<input
			type="range"
			min={0}
			max={2}
			step={0.01}
			value={value[0]}
			onChange={(event) => onValueChange([Number(event.target.value)])}
		/>
	),
	Select: ({
		children,
		value,
		onValueChange,
	}: React.PropsWithChildren<{ value: string; onValueChange: (value: string) => void }>) => (
		<div data-testid="verbosity-select" data-value={value}>
			<button onClick={() => onValueChange("low")}>Set low verbosity</button>
			<button onClick={() => onValueChange("default")}>Set server default</button>
			{children}
		</div>
	),
	SelectContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
	SelectItem: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
	SelectTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
	SelectValue: () => null,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: () => null,
	VSCodeButton: ({
		children,
		onClick,
	}: React.PropsWithChildren<{ onClick?: React.MouseEventHandler<HTMLButtonElement> }>) => (
		<button onClick={onClick}>{children}</button>
	),
	VSCodeTextField: ({ children, ...props }: React.PropsWithChildren<React.InputHTMLAttributes<HTMLInputElement>>) => (
		<div>
			{children}
			<input {...props} />
		</div>
	),
	VSCodeCheckbox: ({
		children,
		checked,
		onChange,
	}: React.PropsWithChildren<{ checked: boolean; onChange: React.ChangeEventHandler<HTMLInputElement> }>) => (
		<label>
			<input type="checkbox" checked={checked} onChange={onChange} />
			{children}
		</label>
	),
}))

vi.mock("@src/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }))
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }))
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("react-use", () => ({ useDebounce: vi.fn(), useEvent: vi.fn() }))

import ApiOptions from "../ApiOptions"

const declaredCapabilities: ModelInfo = {
	contextWindow: 128_000,
	supportsPromptCache: false,
	supportsTemperature: true,
	supportsVerbosity: true,
}

const nativeResponses: ProviderSettings = {
	apiProvider: "openai",
	apiModelId: "gpt-5.4",
	openAiModelId: "gpt-5.4",
	openAiBaseUrl: "https://api.openai.com/v1",
	openAiApiKey: "test-key",
	openAiCustomModelInfo: declaredCapabilities,
	modelTemperature: 0.6,
	verbosity: "high",
}

const CachedParameterSettings = ({
	liveConfiguration,
	onSave,
}: {
	liveConfiguration: ProviderSettings
	onSave: (configuration: ProviderSettings) => void
}) => {
	const [cachedConfiguration, setCachedConfiguration] = React.useState(liveConfiguration)
	const [dirty, setDirty] = React.useState(false)
	const [errorMessage, setErrorMessage] = React.useState<string | undefined>()
	React.useEffect(() => {
		if (!dirty) setCachedConfiguration(liveConfiguration)
	}, [liveConfiguration, dirty])
	const setField = React.useCallback(
		<K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K], isUserAction = true) => {
			setCachedConfiguration((previous) => {
				if (previous[field] === value) return previous
				if (isUserAction) setDirty(true)
				return { ...previous, [field]: value }
			})
		},
		[],
	)
	return (
		<>
			<ApiOptions
				uriScheme={undefined}
				apiConfiguration={cachedConfiguration}
				setApiConfigurationField={setField}
				errorMessage={errorMessage}
				setErrorMessage={setErrorMessage}
			/>
			<button onClick={() => setField("openAiModelId", "o3-custom")}>Use reasoning chat model</button>
			<button onClick={() => setField("openAiModelId", "gpt-5.4")}>Restore supported model</button>
			<button onClick={() => setField("consecutiveMistakeLimit", 10)}>Change consecutive mistake limit</button>
			<button disabled={!dirty || !!errorMessage} onClick={() => onSave(cachedConfiguration)}>
				Save buffered settings
			</button>
		</>
	)
}

describe("ApiOptions request parameter applicability", () => {
	const setApiConfigurationField = vi.fn()
	const setErrorMessage = vi.fn()
	const options = (apiConfiguration: ProviderSettings) => (
		<ApiOptions
			uriScheme={undefined}
			apiConfiguration={apiConfiguration}
			setApiConfigurationField={setApiConfigurationField}
			errorMessage={undefined}
			setErrorMessage={setErrorMessage}
		/>
	)

	beforeEach(() => vi.clearAllMocks())

	it.each<[string, ProviderSettings, boolean, boolean]>([
		["native Responses", nativeResponses, false, true],
		[
			"compatible Chat Completions",
			{ ...nativeResponses, openAiBaseUrl: "https://gateway.example.com/v1" },
			true,
			false,
		],
		["Azure Chat Completions", { ...nativeResponses, openAiUseAzure: true }, true, false],
		[
			"VS Code LM",
			{
				apiProvider: "vscode-lm",
				vsCodeLmModelSelector: { vendor: "copilot", id: "gpt-5.4" },
				modelTemperature: 0.6,
				verbosity: "high",
			},
			false,
			false,
		],
		["Vertex Gemini", { apiProvider: "vertex", apiModelId: "gemini-3.1-pro-preview" }, true, false],
		["Vertex model without temperature", { apiProvider: "vertex", apiModelId: "gemini-3.7-flash" }, false, false],
		["Vertex imported custom partner", { apiProvider: "vertex", apiModelId: "partner-future" }, true, false],
		["Stellar", { apiProvider: "stellar", apiModelId: "Meta-Llama-3.3-70B-Instruct" }, true, false],
		["Stellar imported custom model", { apiProvider: "stellar", apiModelId: "custom-gateway-model" }, true, false],
	])("shows controls executable by %s", (_name, configuration, temperatureVisible, verbosityVisible) => {
		render(options(configuration))
		expect(screen.queryByText("settings:temperature.useCustom") !== null).toBe(temperatureVisible)
		expect(screen.queryByTestId("verbosity") !== null).toBe(verbosityVisible)
	})

	it("does not infer verbosity support when a native model has no capability declaration", () => {
		render(
			options({
				...nativeResponses,
				openAiCustomModelInfo: { ...declaredCapabilities, supportsVerbosity: undefined },
			}),
		)
		expect(screen.queryByTestId("verbosity")).not.toBeInTheDocument()
		expect(setApiConfigurationField).not.toHaveBeenCalled()
	})

	it("does not infer temperature support from unknown custom model metadata", () => {
		render(
			options({
				...nativeResponses,
				openAiBaseUrl: "https://gateway.example.com/v1",
				openAiCustomModelInfo: {
					...declaredCapabilities,
					supportsTemperature: undefined,
					supportedParameters: [],
				},
			}),
		)
		expect(screen.queryByText("settings:temperature.useCustom")).not.toBeInTheDocument()
		expect(setApiConfigurationField).not.toHaveBeenCalled()
	})

	it("preserves temperature controls for an untouched legacy Chat Completions profile", () => {
		render(
			options({
				...nativeResponses,
				openAiBaseUrl: "https://gateway.example.com/v1",
				openAiCustomModelInfo: { maxTokens: 4096, contextWindow: 128_000, supportsPromptCache: false },
				modelTemperature: 0.8,
			}),
		)
		expect(screen.getByRole("slider")).toHaveValue("0.8")
		expect(
			screen.getByRole("checkbox", { name: "settings:providers.customModel.temperatureSupport.label" }),
		).toBeChecked()
		expect(setApiConfigurationField).not.toHaveBeenCalled()
	})

	it("respects an explicitly unsupported temperature capability on a compatible route", () => {
		render(
			options({
				...nativeResponses,
				openAiBaseUrl: "https://gateway.example.com/v1",
				openAiCustomModelInfo: { ...declaredCapabilities, supportsTemperature: false },
			}),
		)
		expect(screen.queryByText("settings:temperature.useCustom")).not.toBeInTheDocument()
	})

	it("hides a fixed temperature during budget reasoning and restores the saved preference when it is disabled", () => {
		const configuration = {
			...nativeResponses,
			openAiBaseUrl: "https://gateway.example.com/v1",
			openAiCustomModelInfo: { ...declaredCapabilities, supportsReasoningBudget: true },
			enableReasoningEffort: false,
		}
		const { rerender } = render(options(configuration))
		expect(screen.getByRole("slider")).toHaveValue("0.6")
		rerender(options({ ...configuration, enableReasoningEffort: true }))
		expect(screen.queryByText("settings:temperature.useCustom")).not.toBeInTheDocument()
		rerender(options(configuration))
		expect(screen.getByRole("slider")).toHaveValue("0.6")
		expect(setApiConfigurationField).not.toHaveBeenCalled()
	})

	it("uses the actual Vertex partner routing override when deciding whether temperature is editable", () => {
		const configuration: ProviderSettings = {
			apiProvider: "vertex",
			apiModelId: "xai/grok-4.6",
			modelTemperature: 0.6,
		}
		const { rerender } = render(options(configuration))
		expect(screen.getByRole("slider")).toHaveValue("0.6")
		rerender(options({ ...configuration, modelRoutingMap: { "xai/grok-4.6": "o3-custom" } }))
		expect(screen.queryByText("settings:temperature.useCustom")).not.toBeInTheDocument()
		expect(setApiConfigurationField).not.toHaveBeenCalled()
	})

	it("retains hidden saved parameters across route and model transitions without writes on render", () => {
		const { rerender } = render(options(nativeResponses))
		expect(screen.getByTestId("verbosity-select")).toHaveAttribute("data-value", "high")
		expect(setApiConfigurationField).not.toHaveBeenCalled()

		const compatible = { ...nativeResponses, openAiBaseUrl: "https://gateway.example.com/v1" }
		rerender(options(compatible))
		expect(screen.queryByTestId("verbosity")).not.toBeInTheDocument()
		expect(screen.getByRole("slider")).toHaveValue("0.6")

		rerender(options({ ...compatible, apiModelId: "custom-chat", openAiModelId: "custom-chat" }))
		expect(screen.getByRole("slider")).toHaveValue("0.6")
		rerender(options(nativeResponses))
		expect(screen.getByTestId("verbosity-select")).toHaveAttribute("data-value", "high")
		expect(setApiConfigurationField).not.toHaveBeenCalled()
		expect(nativeResponses).toMatchObject({ modelTemperature: 0.6, verbosity: "high" })
	})

	it("updates only the settings edit buffer on a user verbosity change", () => {
		render(options(nativeResponses))
		fireEvent.click(screen.getByText("Set low verbosity"))
		expect(setApiConfigurationField).toHaveBeenCalledExactlyOnceWith("verbosity", "low")
	})

	it("shows server-default verbosity for an unset value and can restore omission explicitly", () => {
		const { rerender } = render(options({ ...nativeResponses, verbosity: undefined }))
		expect(screen.getByTestId("verbosity-select")).toHaveAttribute("data-value", "default")
		expect(setApiConfigurationField).not.toHaveBeenCalled()
		rerender(options(nativeResponses))
		fireEvent.click(screen.getByText("Set server default"))
		expect(setApiConfigurationField).toHaveBeenCalledExactlyOnceWith("verbosity", undefined)
	})
})

describe("ApiOptions controlled settings edit buffer", () => {
	it("saves an unknown Vertex partner's legacy sampling preference after an unrelated edit", () => {
		const onSave = vi.fn()
		const liveConfiguration: ProviderSettings = {
			apiProvider: "vertex",
			apiModelId: "partner-future",
			vertexProjectId: "saved-project",
			vertexRegion: "us-central1",
			modelTemperature: 0.8,
		}
		render(<CachedParameterSettings liveConfiguration={liveConfiguration} onSave={onSave} />)
		expect(screen.getByRole("slider")).toHaveValue("0.8")
		expect(onSave).not.toHaveBeenCalled()
		fireEvent.click(screen.getByText("Change consecutive mistake limit"))
		fireEvent.click(screen.getByText("Save buffered settings"))
		expect(onSave).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ apiProvider: "vertex", apiModelId: "partner-future", modelTemperature: 0.8 }),
		)
		expect(liveConfiguration.modelTemperature).toBe(0.8)
	})

	it("saves an untouched legacy Chat Completions sampling preference after an unrelated edit", () => {
		const onSave = vi.fn()
		const liveConfiguration: ProviderSettings = {
			...nativeResponses,
			openAiBaseUrl: "https://gateway.example.com/v1",
			openAiCustomModelInfo: { maxTokens: 4096, contextWindow: 128_000, supportsPromptCache: false },
			modelTemperature: 0.8,
		}
		render(<CachedParameterSettings liveConfiguration={liveConfiguration} onSave={onSave} />)
		fireEvent.click(screen.getByRole("checkbox", { name: "settings:modelInfo.enableStreaming" }))
		expect(screen.getByRole("slider")).toHaveValue("0.8")
		fireEvent.click(screen.getByText("Save buffered settings"))
		expect(onSave).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				modelTemperature: 0.8,
				openAiCustomModelInfo: liveConfiguration.openAiCustomModelInfo,
			}),
		)
		expect(onSave.mock.calls[0][0].openAiCustomModelInfo).not.toHaveProperty("supportsTemperature")
	})

	it("saves retained parameter preferences after model/provider switches and a dirty live refresh", () => {
		const onSave = vi.fn()
		const liveConfiguration: ProviderSettings = {
			...nativeResponses,
			vsCodeLmModelSelector: { vendor: "copilot", id: "selected-model" },
		}
		const { rerender } = render(<CachedParameterSettings liveConfiguration={liveConfiguration} onSave={onSave} />)
		fireEvent.click(screen.getByText("Set low verbosity"))
		fireEvent.input(screen.getByPlaceholderText("settings:placeholders.baseUrl"), {
			target: { value: "https://gateway.example.com/v1" },
		})
		fireEvent.change(screen.getByRole("slider"), { target: { value: "0.25" } })
		fireEvent.click(screen.getByText("Use reasoning chat model"))
		expect(screen.queryByText("settings:temperature.useCustom")).not.toBeInTheDocument()
		fireEvent.click(screen.getByText("Restore supported model"))
		expect(screen.getByRole("slider")).toHaveValue("0.25")
		fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), { target: { value: "vscode-lm" } })
		expect(screen.queryByText("settings:temperature.useCustom")).not.toBeInTheDocument()
		expect(screen.queryByTestId("verbosity")).not.toBeInTheDocument()
		rerender(
			<CachedParameterSettings
				liveConfiguration={{ ...liveConfiguration, modelTemperature: 1.7, verbosity: "high" }}
				onSave={onSave}
			/>,
		)
		fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), { target: { value: "openai" } })
		expect(screen.getByPlaceholderText("settings:placeholders.baseUrl")).toHaveValue(
			"https://gateway.example.com/v1",
		)
		expect(screen.getByRole("slider")).toHaveValue("0.25")
		fireEvent.input(screen.getByPlaceholderText("settings:placeholders.baseUrl"), {
			target: { value: "https://api.openai.com/v1" },
		})
		expect(screen.getByTestId("verbosity-select")).toHaveAttribute("data-value", "low")
		expect(screen.queryByText("settings:temperature.useCustom")).not.toBeInTheDocument()
		fireEvent.click(screen.getByText("Save buffered settings"))
		expect(onSave).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				apiProvider: "openai",
				modelTemperature: 0.25,
				verbosity: "low",
			}),
		)
		expect(liveConfiguration).toMatchObject({ modelTemperature: 0.6, verbosity: "high" })
	})

	it("keeps an invalid first edit through a live refresh until it is corrected", () => {
		const onSave = vi.fn()
		const liveConfiguration: ProviderSettings = {
			...nativeResponses,
			includeMaxTokens: true,
			openAiCustomModelInfo: { ...declaredCapabilities, maxTokens: 512 },
		}
		const { rerender } = render(<CachedParameterSettings liveConfiguration={liveConfiguration} onSave={onSave} />)
		fireEvent.input(screen.getByTestId("max-output-tokens"), { target: { value: "1.5" } })
		rerender(
			<CachedParameterSettings
				liveConfiguration={{
					...liveConfiguration,
					modelTemperature: 1.7,
					verbosity: "low",
					openAiCustomModelInfo: { ...declaredCapabilities, maxTokens: 2048 },
				}}
				onSave={onSave}
			/>,
		)
		expect(screen.getByTestId("max-output-tokens")).toHaveValue("1.5")
		expect(screen.getByRole("alert")).toHaveTextContent("settings:validation.outputTokenLimit")
		expect(screen.getByText("Save buffered settings")).toBeDisabled()
		fireEvent.input(screen.getByTestId("max-output-tokens"), { target: { value: "256" } })
		fireEvent.click(screen.getByText("Save buffered settings"))
		expect(onSave).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				modelTemperature: 0.6,
				verbosity: "high",
				openAiCustomModelInfo: expect.objectContaining({ maxTokens: 256 }),
			}),
		)
		expect(liveConfiguration.openAiCustomModelInfo?.maxTokens).toBe(512)
	})

	it("keeps an invalid numeric draft and Save blocker through unrelated metadata edits", () => {
		const onSave = vi.fn()
		render(
			<CachedParameterSettings
				liveConfiguration={{
					...nativeResponses,
					includeMaxTokens: true,
					openAiCustomModelInfo: { ...declaredCapabilities, maxTokens: 512 },
				}}
				onSave={onSave}
			/>,
		)
		fireEvent.click(screen.getByText("Set low verbosity"))
		fireEvent.input(screen.getByTestId("max-output-tokens"), { target: { value: "1.5" } })
		fireEvent.click(
			screen.getByRole("checkbox", { name: "settings:providers.customModel.temperatureSupport.label" }),
		)
		expect(screen.getByTestId("max-output-tokens")).toHaveValue("1.5")
		expect(screen.getByRole("alert")).toHaveTextContent("settings:validation.outputTokenLimit")
		expect(screen.getByText("Save buffered settings")).toBeDisabled()
		fireEvent.click(screen.getByText("Save buffered settings"))
		expect(onSave).not.toHaveBeenCalled()
		fireEvent.input(screen.getByTestId("max-output-tokens"), { target: { value: "256" } })
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
		fireEvent.click(screen.getByText("Save buffered settings"))
		expect(onSave).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				verbosity: "low",
				openAiCustomModelInfo: expect.objectContaining({ maxTokens: 256, supportsTemperature: false }),
			}),
		)
	})

	it("clears the unmounted editor's invalid draft without erasing saved parameters", () => {
		const onSave = vi.fn()
		render(
			<CachedParameterSettings
				liveConfiguration={{
					...nativeResponses,
					includeMaxTokens: true,
					openAiCustomModelInfo: { ...declaredCapabilities, maxTokens: 512 },
					vsCodeLmModelSelector: { vendor: "copilot", id: "selected-model" },
				}}
				onSave={onSave}
			/>,
		)
		fireEvent.input(screen.getByTestId("max-output-tokens"), { target: { value: "1.5" } })
		fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), { target: { value: "vscode-lm" } })
		expect(screen.getByText("Save buffered settings")).toBeEnabled()
		fireEvent.click(screen.getByText("Save buffered settings"))
		expect(onSave).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				apiProvider: "vscode-lm",
				modelTemperature: 0.6,
				verbosity: "high",
				openAiCustomModelInfo: expect.objectContaining({ maxTokens: 512 }),
			}),
		)
	})

	it.each<[boolean, number | undefined, boolean]>([
		[true, undefined, true],
		[false, undefined, false],
		[true, 256, false],
	])(
		"validates an imported zero against inclusion=%s and override=%s on Save",
		(includeMaxTokens, modelMaxTokens, invalid) => {
			const onSave = vi.fn()
			const liveConfiguration: ProviderSettings = {
				...nativeResponses,
				includeMaxTokens,
				modelMaxTokens,
				openAiCustomModelInfo: { ...declaredCapabilities, maxTokens: 0 },
			}
			render(<CachedParameterSettings liveConfiguration={liveConfiguration} onSave={onSave} />)
			fireEvent.click(screen.getByText("Set low verbosity"))
			expect(screen.getByText("Save buffered settings")).toHaveProperty("disabled", invalid)
			if (invalid) {
				fireEvent.input(screen.getByTestId("max-output-tokens"), { target: { value: "-1" } })
				expect(screen.getByText("Save buffered settings")).toBeEnabled()
			}
			fireEvent.click(screen.getByText("Save buffered settings"))
			expect(onSave).toHaveBeenCalledOnce()
			expect(onSave.mock.calls[0][0]).toMatchObject({
				includeMaxTokens,
				modelMaxTokens,
				openAiCustomModelInfo: { maxTokens: invalid ? -1 : 0 },
			})
			expect(liveConfiguration.openAiCustomModelInfo?.maxTokens).toBe(0)
		},
	)

	it("blocks a native Responses cap below the route minimum and saves the valid correction", () => {
		const onSave = vi.fn()
		render(
			<CachedParameterSettings
				liveConfiguration={{
					...nativeResponses,
					includeMaxTokens: true,
					openAiCustomModelInfo: { ...declaredCapabilities, maxTokens: 15 },
				}}
				onSave={onSave}
			/>,
		)
		fireEvent.click(screen.getByText("Set low verbosity"))
		expect(screen.getByText("Save buffered settings")).toBeDisabled()
		fireEvent.input(screen.getByTestId("max-output-tokens"), { target: { value: "16" } })
		expect(screen.getByText("Save buffered settings")).toBeEnabled()
		fireEvent.click(screen.getByText("Save buffered settings"))
		expect(onSave).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				includeMaxTokens: true,
				openAiCustomModelInfo: expect.objectContaining({ maxTokens: 16 }),
			}),
		)
	})
})
