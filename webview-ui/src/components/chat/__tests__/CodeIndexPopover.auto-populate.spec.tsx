import type { IndexingStatus } from "@alpha-code/types"

import { fireEvent, render, screen } from "@src/utils/test-utils"
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
	vi.mocked(useExtensionState, { partial: true }).mockReturnValue({
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
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("offers only Vertex embedding settings and populates them from active Vertex chat settings", async () => {
		await renderPopover({
			apiProvider: "vertex",
			projectId: "index-project",
			location: "global",
			gatewayBaseUrl: "https://gateway.example.com/vertex",
			helixCommand: "helix auth access-token print -a",
		})

		fireEvent.click(await screen.findByRole("button", { name: "settings:codeIndex.setupConfigLabel" }))
		const providerSelect = screen.getAllByRole("combobox")[1]
		fireEvent.keyDown(providerSelect, { key: "ArrowDown" })
		fireEvent.click(await screen.findByRole("option", { name: "settings:codeIndex.vertexProvider" }))

		expect(screen.getByPlaceholderText("settings:placeholders.projectId")).toHaveValue("index-project")
		expect(screen.getByPlaceholderText("settings:placeholders.baseUrl")).toHaveValue(
			"https://gateway.example.com/vertex",
		)
		expect(screen.getByPlaceholderText("helix auth access-token print -a")).toBeInTheDocument()

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
		expect(screen.getByPlaceholderText("settings:placeholders.baseUrl")).toHaveValue("")
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
