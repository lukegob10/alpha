import React, { useState } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import {
	curatedProviders,
	curatedProviderApiKeyFields,
	getProviderDefaultModelId,
	getCuratedModelInfo,
	getCuratedProviderModels,
	type ProviderSettings,
} from "@alpha-code/types"
import type { ModelPicker } from "../ModelPicker"

const { pickerProps, reasoningProps, postMessage } = vi.hoisted(() => ({
	pickerProps: [] as Array<Record<string, unknown>>,
	reasoningProps: [] as Array<Record<string, unknown>>,
	postMessage: vi.fn(),
}))

vi.mock("@src/components/settings/providers", () => ({
	OpenAICompatible: () => null,
	Stellar: () => null,
	Vertex: () => null,
	VSCodeLM: () => null,
}))
vi.mock("../ModelPicker", () => ({
	ModelPicker: (props: React.ComponentProps<typeof ModelPicker>) => {
		pickerProps.push({ ...props })
		return (
			<select
				aria-label="Model"
				data-testid="curated-model-picker"
				value={props.apiConfiguration.apiModelId ?? ""}
				onChange={(event) => {
					props.setApiConfigurationField(props.modelIdKey, event.target.value)
					props.onModelChange?.(event.target.value)
				}}>
				{Object.keys(props.models ?? {}).map((modelId) => (
					<option key={modelId} value={modelId}>
						{modelId}
					</option>
				))}
			</select>
		)
	},
}))
vi.mock("../ThinkingBudget", () => ({
	ThinkingBudget: (props: Record<string, unknown>) => {
		reasoningProps.push(props)
		return null
	},
}))
vi.mock("../ApiErrorMessage", () => ({ ApiErrorMessage: () => null }))
vi.mock("../Verbosity", () => ({ Verbosity: () => null }))
vi.mock("../TodoListSettingsControl", () => ({ TodoListSettingsControl: () => null }))
vi.mock("../TemperatureControl", () => ({ TemperatureControl: () => null }))
vi.mock("../RateLimitSecondsControl", () => ({ RateLimitSecondsControl: () => null }))
vi.mock("../ConsecutiveMistakeLimitControl", () => ({ ConsecutiveMistakeLimitControl: () => null }))
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage } }))
vi.mock("react-use", () => ({ useDebounce: vi.fn() }))
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
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock("i18next", () => ({ default: { t: (key: string) => key } }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
	VSCodeTextField: ({ children, ...props }: React.PropsWithChildren<React.ComponentProps<"input">>) => (
		<div>
			{children}
			<input {...props} />
		</div>
	),
}))
vi.mock("@src/components/ui", () => ({
	Button: ({ children, onClick }: React.PropsWithChildren<{ onClick: () => void }>) => (
		<button onClick={onClick}>{children}</button>
	),
	SearchableSelect: ({
		value,
		onValueChange,
		options,
		"aria-label": label,
	}: {
		value: string
		onValueChange: (value: string) => void
		options: Array<{ value: string; label: string }>
		"aria-label"?: string
	}) => (
		<select aria-label={label ?? "Provider"} value={value} onChange={(event) => onValueChange(event.target.value)}>
			{options.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	),
	Collapsible: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
	CollapsibleTrigger: ({ children }: React.PropsWithChildren) => <button>{children}</button>,
	CollapsibleContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}))

import ApiOptions from "../ApiOptions"

const requestedCatalogs = curatedProviders.map((provider) => ({
	provider,
	modelIds: Object.keys(getCuratedProviderModels(provider)),
}))
const apiKeyProviders = curatedProviders.filter((provider) => curatedProviderApiKeyFields[provider] !== undefined)

function BufferedOptions({
	configuration,
	onError = vi.fn(),
}: {
	configuration: ProviderSettings
	onError?: React.Dispatch<React.SetStateAction<string | undefined>>
}) {
	const [buffer, setBuffer] = useState(configuration)
	return (
		<ApiOptions
			uriScheme={undefined}
			apiConfiguration={buffer}
			setApiConfigurationField={(field, value) => setBuffer((previous) => ({ ...previous, [field]: value }))}
			errorMessage={undefined}
			setErrorMessage={onError}
		/>
	)
}

describe("curated provider settings", () => {
	beforeEach(() => {
		pickerProps.length = 0
		reasoningProps.length = 0
		postMessage.mockClear()
	})

	it.each(requestedCatalogs)(
		"offers the requested $provider catalog and buffers each model selection",
		({ provider, modelIds }) => {
			const keyField = curatedProviderApiKeyFields[provider]
			const configuration: ProviderSettings = {
				apiProvider: provider,
				...(keyField ? { [keyField]: "saved-key" } : {}),
				apiModelId: "saved-unsupported-model",
				reasoningEffort: "high",
				modelMaxTokens: 32,
			}
			render(<BufferedOptions configuration={configuration} />)
			const picker = screen.getByRole("combobox", { name: "Model" })
			expect(Array.from(picker.querySelectorAll("option"), (option) => option.value).sort()).toEqual(
				[...modelIds].sort(),
			)
			for (const modelId of modelIds) {
				fireEvent.change(picker, { target: { value: modelId } })
				expect(picker).toHaveValue(modelId)
				expect(pickerProps.at(-1)).toMatchObject({
					allowCustomModel: false,
					apiConfiguration: {
						apiProvider: provider,
						apiModelId: modelId,
						modelMaxTokens: undefined,
						reasoningEffort: undefined,
					},
				})
				expect(reasoningProps.at(-1)).toMatchObject({
					modelInfo: getCuratedModelInfo(provider, modelId),
					showReasoningEffort: false,
				})
			}
			expect(configuration).toMatchObject({
				apiModelId: "saved-unsupported-model",
				reasoningEffort: "high",
				modelMaxTokens: 32,
			})
			expect(postMessage.mock.calls).toEqual(provider === "openai-codex" ? [[{ type: "chatGptAuthStatus" }]] : [])
		},
	)

	it.each(apiKeyProviders)("edits only the %s credential in the caller's buffer", (provider) => {
		const keyField = curatedProviderApiKeyFields[provider]
		if (!keyField) throw new Error("API-key provider requires a key field")
		const configuration: ProviderSettings = { apiProvider: provider, [keyField]: "saved-key" }
		render(<BufferedOptions configuration={configuration} />)
		const key = screen.getByTestId("curated-provider-api-key")
		expect(key).toHaveAttribute("type", "password")
		expect(key).toHaveValue("saved-key")
		fireEvent.input(key, { target: { value: "buffered-key" } })
		expect(key).toHaveValue("buffered-key")
		expect(configuration[keyField]).toBe("saved-key")
		expect(postMessage).not.toHaveBeenCalled()
		expect(pickerProps.at(-1)).toMatchObject({
			allowCustomModel: false,
			modelIdKey: "apiModelId",
			defaultModelId: getProviderDefaultModelId(provider),
		})
		expect(reasoningProps.at(-1)).toMatchObject({ showReasoningEffort: false })
	})

	it.each(["bedrock", "openai-codex"] as const)("does not show an API-key field for %s", (provider) => {
		render(<BufferedOptions configuration={{ apiProvider: provider }} />)
		expect(screen.queryByTestId("curated-provider-api-key")).not.toBeInTheDocument()
		expect(pickerProps.at(-1)).toMatchObject({ allowCustomModel: false, modelIdKey: "apiModelId" })
		expect(reasoningProps.at(-1)).toMatchObject({ showReasoningEffort: false })
	})

	it("keeps ChatGPT model choices available when account model information is empty", () => {
		render(<BufferedOptions configuration={{ apiProvider: "openai-codex" }} />)
		const before = pickerProps.at(-1)?.models
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "chatGptAuthStatus",
					chatGptAuthStatus: { connected: false, connecting: false, availableModelIds: [] },
				},
			}),
		)
		expect(pickerProps.at(-1)?.models).toBe(before)
		expect(postMessage.mock.calls).toEqual([[{ type: "chatGptAuthStatus" }]])
	})

	it("does not offer or validate ignored ChatGPT output limits from a previous provider", () => {
		const onError = vi.fn()
		const configuration: ProviderSettings = {
			apiProvider: "openai-codex",
			includeMaxTokens: true,
			modelMaxTokens: 1,
		}
		render(<BufferedOptions configuration={configuration} onError={onError} />)

		expect(screen.queryByTestId("curated-output-token-limit")).not.toBeInTheDocument()
		expect(screen.queryByRole("checkbox", { name: "settings:includeMaxOutputTokens" })).not.toBeInTheDocument()
		expect(onError).toHaveBeenLastCalledWith(undefined)
		expect(reasoningProps.at(-1)).toMatchObject({
			modelInfo: getCuratedModelInfo("openai-codex", getProviderDefaultModelId("openai-codex")),
			showReasoningEffort: false,
		})
		expect(configuration).toMatchObject({ includeMaxTokens: true, modelMaxTokens: 1 })
	})

	it("selects the new provider's default when explicitly switching to a different model catalog", () => {
		render(
			<BufferedOptions
				configuration={{ apiProvider: "anthropic", apiModelId: getProviderDefaultModelId("anthropic") }}
			/>,
		)
		fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), { target: { value: "openai-native" } })
		expect(pickerProps.at(-1)).toMatchObject({
			apiConfiguration: { apiProvider: "openai-native", apiModelId: getProviderDefaultModelId("openai-native") },
			allowCustomModel: false,
		})
	})

	it("keeps unavailable saved model IDs visible until the user chooses a replacement", () => {
		render(
			<BufferedOptions
				configuration={{
					apiProvider: "openrouter",
					apiModelId: "saved-unsupported-model",
					openRouterApiKey: "key",
				}}
			/>,
		)
		expect(pickerProps.at(-1)).toMatchObject({
			apiConfiguration: { apiModelId: "saved-unsupported-model" },
			errorMessage: expect.any(String),
		})
	})

	it("clears unsupported legacy settings only after an explicit buffered repair", () => {
		const configuration: ProviderSettings = {
			apiProvider: "openai-native",
			openAiNativeApiKey: "saved-key",
			openAiNativeBaseUrl: "https://saved-proxy.example/v1",
		}
		render(<BufferedOptions configuration={configuration} />)
		fireEvent.click(screen.getByText("settings:providers.useProviderDefaults"))
		expect(pickerProps.at(-1)).toMatchObject({ apiConfiguration: { openAiNativeBaseUrl: undefined } })
		expect(configuration.openAiNativeBaseUrl).toBe("https://saved-proxy.example/v1")
		expect(postMessage).not.toHaveBeenCalled()
	})

	it("repairs a saved native output cap in the settings buffer without replacing the profile", () => {
		const configuration: ProviderSettings = {
			apiProvider: "openai-native",
			openAiNativeApiKey: "key",
			includeMaxTokens: true,
			modelMaxTokens: 8,
		}
		const onError = vi.fn()
		render(<BufferedOptions configuration={configuration} onError={onError} />)
		const input = screen.getByTestId("curated-output-token-limit")
		expect(input).toHaveValue("8")
		expect(input).toHaveAttribute("aria-invalid", "true")
		expect(onError).toHaveBeenLastCalledWith("settings:validation.responsesOutputTokenLimit")
		fireEvent.input(input, { target: { value: "16" } })
		expect(input).toHaveValue("16")
		expect(input).toHaveAttribute("aria-invalid", "false")
		expect(onError).toHaveBeenLastCalledWith(undefined)
		expect(configuration.modelMaxTokens).toBe(8)
		expect(pickerProps.at(-1)).toMatchObject({ apiConfiguration: { modelMaxTokens: 16 } })
		expect(postMessage).not.toHaveBeenCalled()
	})

	it("keeps an invalid output draft editable, blocks Save, and clears the error after repair", () => {
		const onError = vi.fn()
		render(
			<BufferedOptions
				configuration={{ apiProvider: "xai", xaiApiKey: "key", includeMaxTokens: true, modelMaxTokens: 32 }}
				onError={onError}
			/>,
		)
		const input = screen.getByTestId("curated-output-token-limit")
		fireEvent.input(input, { target: { value: "invalid" } })
		expect(input).toHaveValue("invalid")
		expect(input).toHaveAttribute("aria-invalid", "true")
		expect(onError).toHaveBeenLastCalledWith("settings:validation.outputTokenLimit")
		expect(pickerProps.at(-1)).toMatchObject({ apiConfiguration: { modelMaxTokens: 0 } })
		fireEvent.input(input, { target: { value: "8" } })
		expect(input).toHaveAttribute("aria-invalid", "false")
		expect(onError).toHaveBeenLastCalledWith(undefined)
	})

	it("makes a disabled output cap inert while retaining its editable draft", () => {
		const onError = vi.fn()
		render(
			<BufferedOptions
				configuration={{ apiProvider: "xai", xaiApiKey: "key", includeMaxTokens: true, modelMaxTokens: 32 }}
				onError={onError}
			/>,
		)
		const input = screen.getByTestId("curated-output-token-limit")
		fireEvent.input(input, { target: { value: "invalid" } })
		expect(onError).toHaveBeenLastCalledWith("settings:validation.outputTokenLimit")
		fireEvent.click(screen.getByRole("checkbox", { name: "settings:includeMaxOutputTokens" }))
		expect(input).toHaveValue("invalid")
		expect(input).toHaveAttribute("aria-invalid", "false")
		expect(onError).toHaveBeenLastCalledWith(undefined)
		expect(pickerProps.at(-1)).toMatchObject({ apiConfiguration: { includeMaxTokens: false, modelMaxTokens: 0 } })
		fireEvent.click(screen.getByRole("checkbox", { name: "settings:includeMaxOutputTokens" }))
		expect(input).toHaveAttribute("aria-invalid", "true")
		expect(onError).toHaveBeenLastCalledWith("settings:validation.outputTokenLimit")
	})

	it("clears a local cap draft when the settings buffer changes profiles", () => {
		const configuration: ProviderSettings = {
			apiProvider: "xai",
			xaiApiKey: "key",
			includeMaxTokens: true,
			modelMaxTokens: 32,
		}
		const onError = vi.fn()
		const view = (profileIdentity: string) => (
			<ApiOptions
				profileIdentity={profileIdentity}
				uriScheme={undefined}
				apiConfiguration={configuration}
				setApiConfigurationField={vi.fn()}
				errorMessage={undefined}
				setErrorMessage={onError}
			/>
		)
		const result = render(view("profile-a"))
		fireEvent.input(screen.getByTestId("curated-output-token-limit"), { target: { value: "invalid" } })
		expect(onError).toHaveBeenLastCalledWith("settings:validation.outputTokenLimit")
		result.rerender(view("profile-b"))
		expect(screen.getByTestId("curated-output-token-limit")).toHaveValue("32")
		expect(onError).toHaveBeenLastCalledWith(undefined)
		expect(configuration.modelMaxTokens).toBe(32)
	})

	it("uses the new model's default cap when an explicit provider switch replaces its catalog", () => {
		const onError = vi.fn()
		render(
			<BufferedOptions
				configuration={{
					apiProvider: "xai",
					xaiApiKey: "xai-key",
					openAiNativeApiKey: "native-key",
					includeMaxTokens: true,
					modelMaxTokens: 32,
				}}
				onError={onError}
			/>,
		)
		fireEvent.input(screen.getByTestId("curated-output-token-limit"), { target: { value: "invalid" } })
		fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), { target: { value: "openai-native" } })
		expect(pickerProps.at(-1)).toMatchObject({
			apiConfiguration: { apiProvider: "openai-native", modelMaxTokens: undefined },
		})
		expect(screen.getByTestId("curated-output-token-limit")).toHaveValue("")
		expect(onError).toHaveBeenLastCalledWith(undefined)
	})
})
