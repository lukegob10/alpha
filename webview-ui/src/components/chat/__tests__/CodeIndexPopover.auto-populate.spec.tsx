import type { IndexingStatus } from "@alpha-code/types"

import { act, cleanup, fireEvent, render, screen } from "@src/utils/test-utils"
import { PopoverTrigger } from "@src/components/ui"
import { useShellState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import { CodeIndexPopover } from "../CodeIndexPopover"

vi.mock("@src/context/ExtensionStateContext", () => ({
	useShellState: vi.fn(),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("@src/components/ui/hooks/useAlphaPortal", () => ({
	useAlphaPortal: () => document.body,
}))

vi.mock("@src/hooks/useEscapeKey", () => ({ useEscapeKey: vi.fn() }))

const indexingStatus: IndexingStatus = {
	systemStatus: "Standby",
	processedItems: 0,
	totalItems: 0,
}

const vertexModels = {
	"gemini-embedding-001": { dimension: 3072 },
}

function renderPopover(
	apiConfiguration: Record<string, unknown> | undefined,
	codebaseIndexConfig: Record<string, unknown> = {
		codebaseIndexEnabled: true,
		codebaseIndexEmbedderProvider: "legacy-embedding-provider",
	},
) {
	vi.mocked(useShellState, { partial: true }).mockReturnValue({
		codebaseIndexConfig,
		codebaseIndexModels: { vertex: vertexModels },
		cwd: "/workspace",
		apiConfiguration,
	})

	render(
		<CodeIndexPopover indexingStatus={indexingStatus}>
			<PopoverTrigger asChild>
				<button type="button">Open code index</button>
			</PopoverTrigger>
		</CodeIndexPopover>,
	)

	fireEvent.click(screen.getByRole("button", { name: "Open code index" }))
	return screen.findByRole("button", { name: "settings:codeIndex.setupConfigLabel" })
}

describe("CodeIndexPopover Vertex configuration", () => {
	it.each([
		["OpenAI", "openai-native", "codebaseIndexOpenAiApiKey", "text-embedding-3-large"],
		["OpenRouter", "openrouter", "codebaseIndexOpenRouterApiKey", "qwen/qwen3-embedding-8b"],
		["Amazon Bedrock", "bedrock", "codebaseIndexBedrockApiKey", "cohere.embed-v4:0"],
		["OpenAI Compatible", "openai", "codebaseIndexOpenAiCompatibleApiKey", "custom-model"],
	] as const)(
		"offers all embedding providers and saves independent %s settings",
		async (_label, provider, field, model) => {
			await renderPopover(undefined)
			fireEvent.click(await screen.findByRole("button", { name: "settings:codeIndex.setupConfigLabel" }))
			fireEvent.keyDown(screen.getAllByRole("combobox")[1], { key: "ArrowDown" })
			expect(await screen.findAllByRole("option")).toHaveLength(6)
			fireEvent.click(screen.getByRole("option", { name: `settings:codeIndex.embeddingProviders.${provider}` }))
			fireEvent.input(screen.getByPlaceholderText("settings:codeIndex.embeddingApiKeyPlaceholder"), {
				target: { value: "index-secret" },
			})
			if (provider === "openai") {
				fireEvent.input(screen.getByPlaceholderText("settings:placeholders.baseUrl"), {
					target: { value: "https://embeddings.test/v1" },
				})
				fireEvent.input(screen.getByPlaceholderText("settings:codeIndex.embeddingModelIdLabel"), {
					target: { value: model },
				})
				fireEvent.input(screen.getByPlaceholderText("settings:codeIndex.embeddingDimensionLabel"), {
					target: { value: "1024" },
				})
			}
			fireEvent.click(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" }))
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "saveCodeIndexSettingsAtomic",
				codeIndexSettings: expect.objectContaining({
					codebaseIndexEmbedderProvider: provider,
					codebaseIndexEmbedderModelId: model,
					[field]: "index-secret",
				}),
			})
			const saved = vi
				.mocked(vscode.postMessage)
				.mock.calls.find(([message]) => message.type === "saveCodeIndexSettingsAtomic")?.[0].codeIndexSettings
			expect(saved).not.toHaveProperty("codebaseIndexGeminiApiKey")
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", { data: { type: "codeIndexSettingsSaved", success: true } }),
				)
			})
			expect(screen.getByPlaceholderText("settings:codeIndex.savedSecretPlaceholder")).toHaveValue("")
		},
	)
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers({ shouldAdvanceTime: true })
	})

	afterEach(async () => {
		try {
			// Radix defers unmount autofocus; flush it before JSDOM restores the Node realm.
			cleanup()
			await act(async () => {
				await vi.runOnlyPendingTimersAsync()
			})
		} finally {
			vi.useRealTimers()
		}
	})

	it("populates only standard Google Cloud fields from active Vertex chat settings", async () => {
		await renderPopover({
			apiProvider: "vertex",
			projectId: "index-project",
			location: "global",
			gatewayBaseUrl: "https://gateway.example.com/vertex",
			helixCommand: "company-auth print-token",
		})

		fireEvent.click(await screen.findByRole("button", { name: "settings:codeIndex.setupConfigLabel" }))
		const providerSelect = screen.getAllByRole("combobox")[1]
		fireEvent.keyDown(providerSelect, { key: "ArrowDown" })
		fireEvent.click(await screen.findByRole("option", { name: "settings:codeIndex.vertexProvider" }))

		expect(screen.getByPlaceholderText("settings:placeholders.projectId")).toHaveValue("index-project")
		expect(screen.queryByPlaceholderText("settings:placeholders.baseUrl")).not.toBeInTheDocument()
		expect(
			screen.queryByPlaceholderText("settings:providers.vertexGatewayCommandPlaceholder"),
		).not.toBeInTheDocument()

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "requestCodeIndexSecretStatus" })
	})

	it("does not copy non-Vertex chat settings into Vertex index settings", async () => {
		await renderPopover({
			apiProvider: "openai",
			openAiBaseUrl: "https://openai.example.com/v1",
		})

		fireEvent.click(await screen.findByRole("button", { name: "settings:codeIndex.setupConfigLabel" }))
		const providerSelect = screen.getAllByRole("combobox")[1]
		fireEvent.keyDown(providerSelect, { key: "ArrowDown" })
		fireEvent.click(await screen.findByRole("option", { name: "settings:codeIndex.vertexProvider" }))

		expect(screen.getByPlaceholderText("settings:placeholders.projectId")).toHaveValue("")
		expect(screen.queryByPlaceholderText("settings:placeholders.baseUrl")).not.toBeInTheDocument()
		expect(
			screen.queryByPlaceholderText("settings:providers.vertexGatewayCommandPlaceholder"),
		).not.toBeInTheDocument()
	})

	it("clears a legacy embedding dimension when migrating to Vertex", async () => {
		await renderPopover(
			{
				apiProvider: "vertex",
				projectId: "index-project",
				location: "global",
			},
			{
				codebaseIndexEnabled: true,
				codebaseIndexEmbedderProvider: "legacy-embedding-provider",
				codebaseIndexEmbedderModelId: "legacy-model",
				codebaseIndexEmbedderModelDimension: 1536,
			},
		)

		fireEvent.click(await screen.findByRole("button", { name: "settings:codeIndex.setupConfigLabel" }))
		const providerSelect = screen.getAllByRole("combobox")[1]
		fireEvent.keyDown(providerSelect, { key: "ArrowDown" })
		fireEvent.click(await screen.findByRole("option", { name: "settings:codeIndex.vertexProvider" }))
		fireEvent.click(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" }))

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "saveCodeIndexSettingsAtomic",
			codeIndexSettings: expect.objectContaining({
				codebaseIndexEmbedderProvider: "vertex",
				codebaseIndexEmbedderModelId: "gemini-embedding-001",
				codebaseIndexEmbedderModelDimension: undefined,
			}),
		})
	})
})
