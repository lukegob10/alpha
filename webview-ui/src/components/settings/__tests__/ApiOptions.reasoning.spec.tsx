import React from "react"

import { render } from "@/utils/test-utils"
import type { ModelInfo, ProviderSettings } from "@alpha-code/types"

const { thinkingBudgetProps } = vi.hoisted(() => ({
	thinkingBudgetProps: [] as Array<Record<string, unknown>>,
}))

vi.mock("@src/components/settings/providers", () => ({
	OpenAICompatible: () => null,
	Stellar: () => null,
	Vertex: () => null,
	VSCodeLM: () => null,
}))

vi.mock("../ThinkingBudget", () => ({
	ThinkingBudget: (props: Record<string, unknown>) => {
		thinkingBudgetProps.push(props)
		return <div data-testid="thinking-budget" />
	},
}))

vi.mock("../ModelPicker", () => ({ ModelPicker: () => null }))
vi.mock("../ApiErrorMessage", () => ({ ApiErrorMessage: () => null }))
vi.mock("../Verbosity", () => ({ Verbosity: () => null }))
vi.mock("../TodoListSettingsControl", () => ({ TodoListSettingsControl: () => null }))
vi.mock("../TemperatureControl", () => ({ TemperatureControl: () => null }))
vi.mock("../RateLimitSecondsControl", () => ({ RateLimitSecondsControl: () => null }))
vi.mock("../ConsecutiveMistakeLimitControl", () => ({ ConsecutiveMistakeLimitControl: () => null }))

vi.mock("../constants", () => ({
	PROVIDERS: [{ value: "vertex", label: "GCP Vertex AI" }],
	MODELS_BY_PROVIDER: { vertex: { "gemini-3.7-flash": {} } },
}))

vi.mock("../utils/organizationFilters", () => ({
	filterProviders: (providers: unknown[]) => providers,
	filterModels: (models: unknown) => models,
}))

vi.mock("../utils/providerModelConfig", () => ({
	getProviderServiceConfig: () => ({ serviceName: "GCP Vertex AI", serviceUrl: "" }),
	getDefaultModelIdForProvider: () => "gemini-3.7-flash",
	getStaticModelsForProvider: () => ({ "gemini-3.7-flash": {} }),
	shouldUseGenericModelPicker: () => true,
	handleModelChangeSideEffects: vi.fn(),
}))

vi.mock("@src/components/ui/hooks/useSelectedModel", () => ({
	useSelectedModel: () => ({
		provider: "vertex",
		id: "gemini-3.7-flash",
		info: {
			supportsReasoningEffort: ["low", "medium", "high"],
			contextWindow: 1_048_576,
			supportsPromptCache: true,
		} satisfies ModelInfo,
	}),
}))

vi.mock("@src/components/ui", () => ({
	SearchableSelect: () => <div data-testid="provider-select" />,
	Collapsible: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
	CollapsibleTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
	CollapsibleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/utils/validate", () => ({
	validateApiConfigurationExcludingModelErrors: () => undefined,
	getModelValidationError: () => undefined,
}))

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("react-use", () => ({ useDebounce: vi.fn() }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({ VSCodeLink: () => null }))

import ApiOptions from "../ApiOptions"

describe("ApiOptions reasoning ownership", () => {
	beforeEach(() => {
		thinkingBudgetProps.length = 0
	})

	it("hides the Vertex profile effort selector because task reasoning owns it", () => {
		const apiConfiguration: ProviderSettings = {
			apiProvider: "vertex",
			apiModelId: "gemini-3.7-flash",
		}

		render(
			<ApiOptions
				uriScheme={undefined}
				apiConfiguration={apiConfiguration}
				setApiConfigurationField={vi.fn()}
				errorMessage={undefined}
				setErrorMessage={vi.fn()}
			/>,
		)

		expect(thinkingBudgetProps.at(-1)).toMatchObject({
			showReasoningEffort: false,
		})
	})
})
