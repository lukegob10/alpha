import React from "react"
import { act, cleanup, render } from "@testing-library/react"
import type { ProviderSettings } from "@alpha-code/types"

vi.mock("@src/components/settings/providers", () => ({
	OpenAICompatible: () => null,
	Stellar: () => null,
	Vertex: () => null,
	VSCodeLM: () => null,
}))
vi.mock("../ModelPicker", () => ({ ModelPicker: () => null }))
vi.mock("../ThinkingBudget", () => ({ ThinkingBudget: () => null }))
vi.mock("../ApiErrorMessage", () => ({ ApiErrorMessage: () => null }))
vi.mock("../Verbosity", () => ({ Verbosity: () => null }))
vi.mock("../TodoListSettingsControl", () => ({ TodoListSettingsControl: () => null }))
vi.mock("../TemperatureControl", () => ({ TemperatureControl: () => null }))
vi.mock("../RateLimitSecondsControl", () => ({ RateLimitSecondsControl: () => null }))
vi.mock("../ConsecutiveMistakeLimitControl", () => ({ ConsecutiveMistakeLimitControl: () => null }))
vi.mock("@src/components/ui", () => ({ SearchableSelect: () => null }))
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock("@src/utils/validate", () => ({
	validateApiConfigurationExcludingModelErrors: () => undefined,
	getModelValidationError: () => undefined,
}))
vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({ VSCodeLink: () => null }))

import ApiOptions from "../ApiOptions"
import { vscode } from "@src/utils/vscode"

describe("ApiOptions model discovery", () => {
	const setApiConfigurationField = vi.fn()
	const setErrorMessage = vi.fn()
	const options = (apiConfiguration: ProviderSettings) => (
		<ApiOptions
			uriScheme={undefined}
			apiConfiguration={apiConfiguration}
			setApiConfigurationField={setApiConfigurationField}
			setErrorMessage={setErrorMessage}
			errorMessage={undefined}
			fromWelcomeView
		/>
	)

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(vscode.postMessage).mockReset()
		vi.useFakeTimers()
		vi.setSystemTime(0)
	})

	afterEach(() => {
		cleanup()
		vi.useRealTimers()
	})

	it("requests Copilot models on mount without a typing delay or a duplicate delayed request", async () => {
		const requestedAt: number[] = []
		vi.mocked(vscode.postMessage).mockImplementation(() => {
			requestedAt.push(Date.now())
		})
		const view = render(options({ apiProvider: "vscode-lm" }))
		expect(requestedAt).toEqual([0])
		view.rerender(options({ apiProvider: "vscode-lm", openAiBaseUrl: "https://unused.example.com/v1" }))
		await act(() => vi.advanceTimersByTimeAsync(250))
		expect(requestedAt).toEqual([0])
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "requestVsCodeLmModels" })
	})

	it("debounces OpenAI connection edits for 250 ms and sends the latest values", async () => {
		const configuration: ProviderSettings = {
			apiProvider: "openai",
			openAiBaseUrl: "https://first.example.com/v1",
			openAiApiKey: "saved-key",
		}
		const view = render(options(configuration))
		await act(() => vi.advanceTimersByTimeAsync(200))
		view.rerender(
			options({
				...configuration,
				openAiBaseUrl: "https://latest.example.com/v1",
				openAiHeaders: { "x-custom-header": "latest-value" },
			}),
		)
		await act(() => vi.advanceTimersByTimeAsync(249))
		expect(vscode.postMessage).not.toHaveBeenCalled()
		await act(() => vi.advanceTimersByTimeAsync(1))
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "requestOpenAiModels",
			values: {
				baseUrl: "https://latest.example.com/v1",
				apiKey: "saved-key",
				customHeaders: {},
				openAiHeaders: { "x-custom-header": "latest-value" },
			},
		})
	})

	it("requests Copilot models immediately when switching away from pending OpenAI discovery", async () => {
		const view = render(options({ apiProvider: "openai", openAiBaseUrl: "https://first.example.com/v1" }))
		await act(() => vi.advanceTimersByTimeAsync(100))
		view.rerender(options({ apiProvider: "vscode-lm" }))
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "requestVsCodeLmModels" })
		await act(() => vi.advanceTimersByTimeAsync(250))
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
	})

	it("cancels pending OpenAI discovery when the settings editor unmounts", async () => {
		const view = render(options({ apiProvider: "openai" }))
		await act(() => vi.advanceTimersByTimeAsync(100))
		view.unmount()
		await act(() => vi.advanceTimersByTimeAsync(250))
		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})
})
