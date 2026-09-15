import { cloneElement } from "react"
import type { IndexingStatus } from "@alpha-code/types"

import { act, fireEvent, render, screen } from "@src/utils/test-utils"
import { PopoverTrigger } from "@src/components/ui"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"

import { CodeIndexPopover } from "../CodeIndexPopover"

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(),
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

vi.mock("@src/components/ui/hooks/useOpenRouterModelProviders", () => ({
	OPENROUTER_DEFAULT_PROVIDER_NAME: "OpenRouter",
	useOpenRouterModelProviders: () => ({ data: undefined }),
}))

const indexingStatus: IndexingStatus = {
	systemStatus: "Standby",
	processedItems: 0,
	totalItems: 0,
}

describe("CodeIndexPopover", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(useExtensionState, { partial: true }).mockReturnValue({
			codebaseIndexConfig: undefined,
			codebaseIndexModels: undefined,
			cwd: "/workspace",
			apiConfiguration: undefined,
		})
	})

	it("preserves a Vertex selection and endpoint edits across extension state refreshes", async () => {
		const state = {
			...useExtensionState(),
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
		vi.mocked(useExtensionState).mockReturnValue(state)
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
		const endpoint = screen.getByPlaceholderText("settings:placeholders.baseUrl")
		fireEvent.input(endpoint, { target: { value: "https://index.example.com/vertex" } })
		fireEvent.input(screen.getByPlaceholderText("settings:placeholders.credentialsJson"), {
			target: { value: '{"client_email":"test@example.com"}' },
		})

		// State broadcasts deserialize new objects even when the persisted settings have not changed.
		vi.mocked(useExtensionState).mockReturnValue({
			...state,
			codebaseIndexConfig: { ...state.codebaseIndexConfig },
			apiConfiguration: { ...state.apiConfiguration },
		})
		rerender(cloneElement(view))

		expect(screen.getByPlaceholderText("settings:placeholders.baseUrl")).toHaveProperty(
			"value",
			"https://index.example.com/vertex",
		)
		fireEvent.click(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "saveCodeIndexSettingsAtomic",
			codeIndexSettings: expect.objectContaining({
				codebaseIndexEmbedderProvider: "vertex",
				codebaseIndexEmbedderModelId: "gemini-embedding-001",
				codebaseIndexVertexGatewayBaseUrl: "https://index.example.com/vertex",
				codebaseIndexVertexJsonCredentials: '{"client_email":"test@example.com"}',
			}),
		})

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "codeIndexSettingsSaved", success: true } }),
			)
		})
		expect(screen.getByPlaceholderText("settings:placeholders.baseUrl")).toHaveProperty(
			"value",
			"https://index.example.com/vertex",
		)
		expect(screen.getByPlaceholderText("settings:placeholders.credentialsJson")).toHaveProperty("value", "")
		expect(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" })).toBeDisabled()
	})

	it("reloads the latest persisted settings after discarding edits and reopening setup", async () => {
		const state = {
			...useExtensionState(),
			codebaseIndexConfig: {
				codebaseIndexEnabled: true,
				codebaseIndexEmbedderProvider: "vertex" as const,
				codebaseIndexVertexProjectId: "index-project",
				codebaseIndexVertexRegion: "us-central1",
				codebaseIndexVertexGatewayBaseUrl: "https://saved.example.com/vertex",
			},
		}
		vi.mocked(useExtensionState).mockReturnValue(state)
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
		fireEvent.input(screen.getByPlaceholderText("settings:placeholders.baseUrl"), {
			target: { value: "https://draft.example.com/vertex" },
		})
		vi.mocked(useExtensionState).mockReturnValue({
			...state,
			codebaseIndexConfig: {
				...state.codebaseIndexConfig,
				codebaseIndexVertexGatewayBaseUrl: "https://updated.example.com/vertex",
			},
		})
		rerender(cloneElement(view))
		expect(screen.getByPlaceholderText("settings:placeholders.baseUrl")).toHaveProperty(
			"value",
			"https://draft.example.com/vertex",
		)
		fireEvent.click(screen.getByRole("button", { name: "Open code index" }))
		fireEvent.click(await screen.findByRole("button", { name: "settings:unsavedChangesDialog.discardButton" }))
		fireEvent.click(screen.getByRole("button", { name: "Open code index" }))
		expect(await screen.findByPlaceholderText("settings:placeholders.baseUrl")).toHaveProperty(
			"value",
			"https://updated.example.com/vertex",
		)
		expect(screen.getByRole("button", { name: "settings:codeIndex.saveSettings" })).toBeDisabled()
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
			vi.useRealTimers()
		}
	})
})
