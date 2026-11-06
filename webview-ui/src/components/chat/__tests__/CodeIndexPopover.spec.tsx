import { cloneElement } from "react"
import type { IndexingStatus } from "@alpha-code/types"

import { act, cleanup, fireEvent, render, screen, within } from "@src/utils/test-utils"
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

// FAST reflects placeholders onto hidden form proxies as its controls upgrade.
const getTextField = (placeholder: string) => {
	const fields = [
		...new Set(
			screen
				.getAllByPlaceholderText(placeholder)
				.map((element) => element.closest<HTMLElement>("vscode-text-field")),
		),
	]
	expect(fields).toHaveLength(1)
	const [field] = fields
	if (!field) throw new Error(`Expected a text field for ${placeholder}`)
	return field
}

const setTextFieldValue = (placeholder: string, value: string) => {
	const field = getTextField(placeholder)
	act(() => {
		Object.assign(field, { value })
		fireEvent.input(field)
	})
}

describe("CodeIndexPopover", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(useShellState, { partial: true }).mockReturnValue({
			codebaseIndexConfig: undefined,
			codebaseIndexModels: undefined,
			cwd: "/workspace",
			apiConfiguration: undefined,
		})
	})

	it.each([
		["vertex", "gemini-embedding-2"],
		["gemini", "gemini-embedding-2"],
		["openai-native", "text-embedding-3-small"],
		["openai", "Qwen/Qwen3-Embedding-4B"],
		["openrouter", "mongodb/voyage-code-4"],
		["bedrock", "amazon.titan-embed-text-v2:0"],
	] as const)("offers standard %s models even when the saved host catalog is older", async (provider, modelId) => {
		vi.mocked(useShellState, { partial: true }).mockReturnValue({
			...useShellState(),
			codebaseIndexConfig: { codebaseIndexEnabled: true, codebaseIndexEmbedderProvider: provider },
			codebaseIndexModels: { [provider]: {} },
		})
		render(
			<CodeIndexPopover indexingStatus={indexingStatus}>
				<PopoverTrigger asChild>
					<button>Open code index</button>
				</PopoverTrigger>
			</CodeIndexPopover>,
		)
		fireEvent.click(screen.getByRole("button", { name: "Open code index" }))
		fireEvent.click(await screen.findByRole("button", { name: "settings:codeIndex.setupConfigLabel" }))
		const picker = screen.getByRole("combobox", { name: "settings:codeIndex.modelLabel" })
		fireEvent.click(picker)
		expect(
			await screen.findByRole("option", { name: (name) => name.startsWith(`${modelId} `) }),
		).toBeInTheDocument()
	})

	it("saves a compatible preset with its built-in dimensions and preserves the draft across refreshes", async () => {
		const state = {
			...useShellState(),
			codebaseIndexConfig: {
				codebaseIndexEnabled: true,
				codebaseIndexEmbedderProvider: "openai",
				codebaseIndexOpenAiCompatibleBaseUrl: "https://embeddings.test/v1",
				codebaseIndexEmbedderModelId: "nomic-ai/nomic-embed-text-v1.5",
				codebaseIndexEmbedderModelDimension: 384,
			},
		}
		vi.mocked(useShellState).mockReturnValue(state)
		const view = (
			<CodeIndexPopover indexingStatus={indexingStatus}>
				<PopoverTrigger asChild>
					<button>Open code index</button>
				</PopoverTrigger>
			</CodeIndexPopover>
		)
		const { rerender } = render(view)
		fireEvent.click(screen.getByRole("button", { name: "Open code index" }))
		fireEvent.click(await screen.findByRole("button", { name: "settings:codeIndex.setupConfigLabel" }))
		expect(getTextField("settings:codeIndex.embeddingModelIdLabel")).toHaveProperty(
			"value",
			"nomic-ai/nomic-embed-text-v1.5",
		)
		const picker = screen.getByRole("combobox", { name: "settings:codeIndex.modelLabel" })
		fireEvent.click(picker)
		fireEvent.click(
			await screen.findByRole("option", { name: (name) => name.startsWith("Qwen/Qwen3-Embedding-4B ") }),
		)
		expect(screen.queryByPlaceholderText("settings:codeIndex.embeddingDimensionLabel")).not.toBeInTheDocument()

		vi.mocked(useShellState).mockReturnValue({
			...state,
			codebaseIndexConfig: { ...state.codebaseIndexConfig },
		})
		rerender(cloneElement(view))
		expect(picker).toHaveTextContent("Qwen/Qwen3-Embedding-4B")
		fireEvent.click(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "saveCodeIndexSettingsAtomic",
			codeIndexSettings: expect.objectContaining({
				codebaseIndexEmbedderModelId: "Qwen/Qwen3-Embedding-4B",
				codebaseIndexEmbedderModelDimension: undefined,
			}),
		})
	})

	it("allows a custom compatible model and requires its output dimensions", async () => {
		vi.mocked(useShellState, { partial: true }).mockReturnValue({
			...useShellState(),
			codebaseIndexConfig: {
				codebaseIndexEnabled: true,
				codebaseIndexEmbedderProvider: "openai",
				codebaseIndexOpenAiCompatibleBaseUrl: "https://embeddings.test/v1",
				codebaseIndexEmbedderModelId: "text-embedding-3-small",
			},
		})
		render(
			<CodeIndexPopover indexingStatus={indexingStatus}>
				<PopoverTrigger asChild>
					<button>Open code index</button>
				</PopoverTrigger>
			</CodeIndexPopover>,
		)
		fireEvent.click(screen.getByRole("button", { name: "Open code index" }))
		fireEvent.click(await screen.findByRole("button", { name: "settings:codeIndex.setupConfigLabel" }))
		const picker = screen.getByRole("combobox", { name: "settings:codeIndex.modelLabel" })
		fireEvent.click(picker)
		fireEvent.click(await screen.findByRole("option", { name: "settings:codeIndex.customModelOption" }))
		setTextFieldValue("settings:codeIndex.embeddingModelIdLabel", "nomic-ai/nomic-embed-text-v1.5")
		fireEvent.click(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" }))
		expect(await screen.findByText("settings:codeIndex.validation.embeddingDimensionRequired")).toBeVisible()
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: "saveCodeIndexSettingsAtomic" }),
		)

		setTextFieldValue("settings:codeIndex.embeddingDimensionLabel", "768")
		fireEvent.click(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "saveCodeIndexSettingsAtomic",
			codeIndexSettings: expect.objectContaining({
				codebaseIndexEmbedderModelId: "nomic-ai/nomic-embed-text-v1.5",
				codebaseIndexEmbedderModelDimension: 768,
			}),
		})
	})

	it("explains that yellow freshness status keeps validated search available", async () => {
		render(
			<CodeIndexPopover indexingStatus={{ ...indexingStatus, systemStatus: "Indexing" }}>
				<PopoverTrigger asChild>
					<button>Open code index</button>
				</PopoverTrigger>
			</CodeIndexPopover>,
		)
		fireEvent.click(screen.getByRole("button", { name: "Open code index" }))
		expect(await screen.findByText("settings:codeIndex.freshnessNote")).toBeVisible()
	})

	it("normalizes a legacy result limit and preserves slider edits across state refreshes until saving", async () => {
		const state = {
			...useShellState(),
			codebaseIndexConfig: {
				codebaseIndexEnabled: true,
				codebaseIndexEmbedderProvider: "vertex" as const,
				codebaseIndexVertexProjectId: "index-project",
				codebaseIndexVertexRegion: "global",
				codebaseIndexSearchMaxResults: 150,
			},
		}
		vi.mocked(useShellState).mockReturnValue(state)
		const view = (
			<CodeIndexPopover indexingStatus={indexingStatus}>
				<PopoverTrigger asChild>
					<button type="button">Open code index</button>
				</PopoverTrigger>
			</CodeIndexPopover>
		)
		const { rerender } = render(view)
		fireEvent.click(screen.getByRole("button", { name: "Open code index" }))
		fireEvent.click(await screen.findByRole("button", { name: "settings:codeIndex.setupConfigLabel" }))
		fireEvent.click(screen.getByRole("button", { name: "settings:codeIndex.advancedConfigLabel" }))
		const slider = within(screen.getByTestId("search-max-results-slider")).getByRole("slider", {
			name: "settings:codeIndex.searchMaxResultsLabel",
		})
		expect(slider).toHaveAttribute("aria-valuemax", "100")
		expect(slider).toHaveAttribute("aria-valuenow", "100")
		fireEvent.keyDown(slider, { key: "ArrowLeft" })
		expect(slider).toHaveAttribute("aria-valuenow", "90")
		vi.mocked(useShellState).mockReturnValue({
			...state,
			codebaseIndexConfig: { ...state.codebaseIndexConfig },
		})
		rerender(cloneElement(view))
		expect(slider).toHaveAttribute("aria-valuenow", "90")
		fireEvent.click(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "saveCodeIndexSettingsAtomic",
			codeIndexSettings: expect.objectContaining({ codebaseIndexSearchMaxResults: 90 }),
		})
	})

	it("preserves a Vertex selection and project edits across extension state refreshes", async () => {
		const state = {
			...useShellState(),
			codebaseIndexConfig: {
				codebaseIndexEnabled: true,
				codebaseIndexEmbedderProvider: "openai" as const,
			},
			apiConfiguration: {
				apiProvider: "vertex" as const,
				vertexProjectId: "index-project",
				vertexRegion: "us-central1",
				vertexGatewayBaseUrl: "https://old.example.com/vertex",
				vertexGatewayCaBundlePath: "test.pem",
				vertexGatewayHelixCommand: "test-token-command",
			},
		}
		vi.mocked(useShellState).mockReturnValue(state)
		const view = (
			<CodeIndexPopover indexingStatus={indexingStatus}>
				<PopoverTrigger asChild>
					<button type="button">Open code index</button>
				</PopoverTrigger>
			</CodeIndexPopover>
		)
		const { rerender } = render(view)
		fireEvent.click(screen.getByRole("button", { name: "Open code index" }))
		fireEvent.click(await screen.findByRole("button", { name: "settings:codeIndex.setupConfigLabel" }))
		fireEvent.keyDown(screen.getAllByRole("combobox")[1], { key: "ArrowDown" })
		fireEvent.click(await screen.findByRole("option", { name: "settings:codeIndex.vertexProvider" }))
		const project = screen.getByPlaceholderText("settings:placeholders.projectId")
		fireEvent.input(project, { target: { value: "edited-index-project" } })
		fireEvent.input(screen.getByPlaceholderText("settings:placeholders.credentialsJson"), {
			target: { value: '{"client_email":"test@example.com"}' },
		})

		// State broadcasts deserialize new objects even when the persisted settings have not changed.
		vi.mocked(useShellState).mockReturnValue({
			...state,
			codebaseIndexConfig: { ...state.codebaseIndexConfig },
			apiConfiguration: { ...state.apiConfiguration },
		})
		rerender(cloneElement(view))

		expect(screen.getByPlaceholderText("settings:placeholders.projectId")).toHaveProperty(
			"value",
			"edited-index-project",
		)
		fireEvent.click(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "saveCodeIndexSettingsAtomic",
			codeIndexSettings: expect.objectContaining({
				codebaseIndexEmbedderProvider: "vertex",
				codebaseIndexEmbedderModelId: "gemini-embedding-001",
				codebaseIndexVertexProjectId: "edited-index-project",
				codebaseIndexVertexJsonCredentials: '{"client_email":"test@example.com"}',
			}),
		})

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "codeIndexSettingsSaved", success: true } }),
			)
		})
		expect(screen.getByPlaceholderText("settings:placeholders.projectId")).toHaveProperty(
			"value",
			"edited-index-project",
		)
		expect(screen.getByPlaceholderText("settings:codeIndex.savedSecretPlaceholder")).toHaveProperty("value", "")
		expect(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" })).toBeDisabled()
	})

	it("reloads the latest persisted settings after discarding edits and reopening setup", async () => {
		const state = {
			...useShellState(),
			codebaseIndexConfig: {
				codebaseIndexEnabled: true,
				codebaseIndexEmbedderProvider: "vertex" as const,
				codebaseIndexVertexProjectId: "index-project",
				codebaseIndexVertexRegion: "us-central1",
			},
		}
		vi.mocked(useShellState).mockReturnValue(state)
		const view = (
			<CodeIndexPopover indexingStatus={indexingStatus}>
				<PopoverTrigger asChild>
					<button type="button">Open code index</button>
				</PopoverTrigger>
			</CodeIndexPopover>
		)
		const { rerender } = render(view)
		fireEvent.click(screen.getByRole("button", { name: "Open code index" }))
		fireEvent.click(await screen.findByRole("button", { name: "settings:codeIndex.setupConfigLabel" }))
		fireEvent.input(screen.getByPlaceholderText("settings:placeholders.projectId"), {
			target: { value: "draft-project" },
		})
		vi.mocked(useShellState).mockReturnValue({
			...state,
			codebaseIndexConfig: {
				...state.codebaseIndexConfig,
				codebaseIndexVertexProjectId: "updated-project",
			},
		})
		rerender(cloneElement(view))
		expect(screen.getByPlaceholderText("settings:placeholders.projectId")).toHaveProperty("value", "draft-project")
		fireEvent.click(screen.getByRole("button", { name: "Open code index" }))
		fireEvent.click(await screen.findByRole("button", { name: "settings:unsavedChangesDialog.discardButton" }))
		fireEvent.click(screen.getByRole("button", { name: "Open code index" }))
		expect(await screen.findByPlaceholderText("settings:placeholders.projectId")).toHaveProperty(
			"value",
			"updated-project",
		)
		expect(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" })).toBeDisabled()
	})

	it.each(["edited-key", ""])("keeps Gemini secret edits and saved-secret presence separate (%s)", async (draft) => {
		render(
			<CodeIndexPopover indexingStatus={indexingStatus}>
				<PopoverTrigger asChild>
					<button type="button">Open code index</button>
				</PopoverTrigger>
			</CodeIndexPopover>,
		)
		fireEvent.click(screen.getByRole("button", { name: "Open code index" }))
		fireEvent.click(await screen.findByRole("button", { name: "settings:codeIndex.setupConfigLabel" }))
		fireEvent.keyDown(screen.getAllByRole("combobox")[1], { key: "ArrowDown" })
		fireEvent.click(await screen.findByRole("option", { name: "settings:codeIndex.geminiProvider" }))
		const input = screen.getByPlaceholderText("settings:codeIndex.geminiApiKeyPlaceholder")
		if (draft) fireEvent.input(input, { target: { value: draft } })
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "codeIndexSecretStatus", values: { hasGeminiApiKey: true } },
				}),
			),
		)
		expect(input).toHaveProperty("value", draft)
		fireEvent.click(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" }))
		const saved = vi
			.mocked(vscode.postMessage)
			.mock.calls.find(([message]) => message.type === "saveCodeIndexSettingsAtomic")?.[0]
		expect(saved?.codeIndexSettings).toMatchObject({
			codebaseIndexEmbedderProvider: "gemini",
			codebaseIndexEmbedderModelId: "gemini-embedding-001",
		})
		if (draft) expect(saved?.codeIndexSettings?.codebaseIndexGeminiApiKey).toBe(draft)
		else expect(saved?.codeIndexSettings).not.toHaveProperty("codebaseIndexGeminiApiKey")
	})

	it.each([false, true])(
		"acknowledges the saved Gemini key while preserving later edits (%s)",
		async (editDuringSave) => {
			vi.mocked(useShellState, { partial: true }).mockReturnValue({
				...useShellState(),
				codebaseIndexConfig: { codebaseIndexEnabled: true, codebaseIndexEmbedderProvider: "gemini" },
			})
			render(
				<CodeIndexPopover indexingStatus={{ ...indexingStatus, workspaceEnabled: true }}>
					<PopoverTrigger asChild>
						<button type="button">Open code index</button>
					</PopoverTrigger>
				</CodeIndexPopover>,
			)
			fireEvent.click(screen.getByRole("button", { name: "Open code index" }))
			fireEvent.click(await screen.findByRole("button", { name: "settings:codeIndex.setupConfigLabel" }))
			const input = screen.getByPlaceholderText("settings:codeIndex.geminiApiKeyPlaceholder")
			fireEvent.input(input, { target: { value: "index-secret" } })
			fireEvent.click(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" }))
			expect(vscode.postMessage).toHaveBeenCalledWith({
				type: "saveCodeIndexSettingsAtomic",
				codeIndexSettings: expect.objectContaining({ codebaseIndexGeminiApiKey: "index-secret" }),
			})
			if (editDuringSave) fireEvent.input(input, { target: { value: "next-secret" } })
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", { data: { type: "codeIndexSettingsSaved", success: true } }),
				)
			})

			// The save acknowledgement must be sufficient; the separate status round trip can be delayed.
			expect(input).toHaveProperty("value", editDuringSave ? "next-secret" : "")
			if (editDuringSave) {
				expect(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" })).toBeEnabled()
			} else {
				expect(input).toHaveAttribute("placeholder", "settings:codeIndex.savedSecretPlaceholder")
				expect(screen.getByText("settings:codeIndex.geminiApiKeySaved")).toBeVisible()
				expect(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" })).toBeDisabled()
				fireEvent.click(screen.getByRole("button", { name: "settings:codeIndex.startIndexingButton" }))
				expect(vscode.postMessage).toHaveBeenCalledWith({ type: "startIndexing" })
			}
		},
	)

	it("requires a dedicated Gemini key before saving a new configuration", async () => {
		vi.mocked(useShellState, { partial: true }).mockReturnValue({
			...useShellState(),
			codebaseIndexConfig: { codebaseIndexEnabled: true, codebaseIndexEmbedderProvider: "gemini" },
		})
		render(
			<CodeIndexPopover indexingStatus={indexingStatus}>
				<PopoverTrigger asChild>
					<button type="button">Open code index</button>
				</PopoverTrigger>
			</CodeIndexPopover>,
		)
		fireEvent.click(screen.getByRole("button", { name: "Open code index" }))
		fireEvent.click(await screen.findByRole("button", { name: "settings:codeIndex.setupConfigLabel" }))
		fireEvent.input(screen.getByPlaceholderText("settings:codeIndex.geminiApiKeyPlaceholder"), {
			target: { value: " " },
		})
		fireEvent.click(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" }))
		expect(await screen.findByText("settings:codeIndex.validation.apiKeyRequired")).toBeInTheDocument()
		expect(
			vi
				.mocked(vscode.postMessage)
				.mock.calls.some(([message]) => message.type === "saveCodeIndexSettingsAtomic"),
		).toBe(false)
	})

	it("keeps save errors visible for five seconds", async () => {
		render(
			<CodeIndexPopover indexingStatus={indexingStatus}>
				<PopoverTrigger asChild>
					<button type="button">Open code index</button>
				</PopoverTrigger>
			</CodeIndexPopover>,
		)
		fireEvent.click(screen.getByRole("button", { name: "Open code index" }))
		await screen.findByText("settings:codeIndex.title")

		vi.useFakeTimers()
		try {
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "codeIndexSettingsSaved", success: false, error: "Save failed" },
					}),
				)
			})

			expect(screen.getByText("Save failed")).toBeInTheDocument()
			act(() => vi.advanceTimersByTime(4_999))
			expect(screen.getByText("Save failed")).toBeInTheDocument()
			act(() => vi.advanceTimersByTime(1))
			expect(screen.queryByText("Save failed")).not.toBeInTheDocument()
		} finally {
			try {
				// Drain Radix's deferred unmount autofocus before restoring the clock or DOM realm.
				cleanup()
				await act(async () => {
					await vi.runOnlyPendingTimersAsync()
				})
			} finally {
				vi.useRealTimers()
			}
		}
	})
})
