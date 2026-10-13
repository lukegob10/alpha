import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import { vi, describe, it, expect, beforeEach } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React from "react"
import {
	providerProfileRenameRequestSchema,
	providerProfileSaveRequestSchema,
	type ProviderProfileRenameResult,
	type ProviderProfileSaveResult,
} from "@alpha-code/types"

import SettingsView from "../SettingsView"
import { vscode } from "@src/utils/vscode"

// Mock vscode API
const mockPostMessage = vi.fn()
const mockVscode = {
	postMessage: mockPostMessage,
}
;(global as any).acquireVsCodeApi = () => mockVscode
vi.spyOn(vscode, "postMessage").mockImplementation(mockPostMessage)

// Mock the extension state context
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(),
}))

// Mock the translation context
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
	useTranslation: () => ({
		t: (key: string) => key,
	}),
}))

// Mock UI components
vi.mock("@src/components/ui", () => ({
	ToggleSwitch: ({ checked, onChange, "aria-label": ariaLabel, "data-testid": dataTestId }: any) => (
		<button role="switch" aria-checked={checked} aria-label={ariaLabel} data-testid={dataTestId} onClick={onChange}>
			Toggle
		</button>
	),
	Input: ({ value, onChange, placeholder, id, type, className, ...props }: any) => (
		<input
			type={type || "text"}
			value={value}
			onChange={onChange}
			placeholder={placeholder}
			id={id}
			className={className}
			{...props}
		/>
	),
	Textarea: ({ value, onChange, placeholder, id, className, ...props }: any) => (
		<textarea
			value={value}
			onChange={onChange}
			placeholder={placeholder}
			id={id}
			className={className}
			{...props}
		/>
	),
	Checkbox: ({ checked, onCheckedChange, id, className, ...props }: any) => (
		<input
			type="checkbox"
			checked={checked}
			onChange={(e) => onCheckedChange?.(e.target.checked)}
			id={id}
			className={className}
			{...props}
		/>
	),
	AlertDialog: ({ children, open }: any) => (open ? <div data-testid="alert-dialog">{children}</div> : null),
	AlertDialogContent: ({ children }: any) => <div>{children}</div>,
	AlertDialogTitle: ({ children }: any) => <div>{children}</div>,
	AlertDialogDescription: ({ children }: any) => <div>{children}</div>,
	AlertDialogCancel: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
	AlertDialogAction: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button>,
	AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
	AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
	Button: ({ children, onClick, disabled, ...props }: any) => (
		<button onClick={onClick} disabled={disabled} {...props}>
			{children}
		</button>
	),
	Tooltip: ({ children }: any) => <>{children}</>,
	TooltipContent: ({ children }: any) => <div>{children}</div>,
	TooltipProvider: ({ children }: any) => <>{children}</>,
	TooltipTrigger: ({ children }: any) => <>{children}</>,
	StandardTooltip: ({ children, content }: any) => <div title={content}>{children}</div>,
	Popover: ({ children }: any) => <>{children}</>,
	PopoverTrigger: ({ children }: any) => <>{children}</>,
	PopoverContent: ({ children }: any) => <div>{children}</div>,
	Select: ({ children, value, onValueChange }: any) => (
		<div data-testid="select" data-value={value}>
			<button onClick={() => onValueChange && onValueChange("test-change")}>{value}</button>
			{children}
		</div>
	),
	SelectContent: ({ children }: any) => <div data-testid="select-content">{children}</div>,
	SelectGroup: ({ children }: any) => <div data-testid="select-group">{children}</div>,
	SelectItem: ({ children, value }: any) => (
		<div data-testid={`select-item-${value}`} data-value={value}>
			{children}
		</div>
	),
	SelectTrigger: ({ children }: any) => <div data-testid="select-trigger">{children}</div>,
	SelectValue: ({ placeholder }: any) => <div data-testid="select-value">{placeholder}</div>,
	Slider: ({ value, onValueChange, "data-testid": dataTestId }: any) => (
		<input
			type="range"
			value={value?.[0] ?? 0}
			onChange={(e) => onValueChange?.([parseFloat(e.target.value)])}
			data-testid={dataTestId}
		/>
	),
	SearchableSelect: ({ value, onValueChange, options, placeholder }: any) => (
		<select value={value} onChange={(e) => onValueChange(e.target.value)} data-testid="searchable-select">
			{placeholder && <option value="">{placeholder}</option>}
			{options?.map((opt: any) => (
				<option key={opt.value} value={opt.value}>
					{opt.label}
				</option>
			))}
		</select>
	),
	Collapsible: ({ children, open }: any) => (
		<div className="collapsible-mock" data-open={open}>
			{children}
		</div>
	),
	CollapsibleTrigger: ({ children, className, onClick }: any) => (
		<div className={`collapsible-trigger-mock ${className || ""}`} onClick={onClick}>
			{children}
		</div>
	),
	CollapsibleContent: ({ children, className }: any) => (
		<div className={`collapsible-content-mock ${className || ""}`}>{children}</div>
	),
	Dialog: ({ children, ...props }: any) => (
		<div data-testid="dialog" {...props}>
			{children}
		</div>
	),
	DialogContent: ({ children, ...props }: any) => (
		<div data-testid="dialog-content" {...props}>
			{children}
		</div>
	),
	DialogHeader: ({ children, ...props }: any) => (
		<div data-testid="dialog-header" {...props}>
			{children}
		</div>
	),
	DialogTitle: ({ children, ...props }: any) => (
		<div data-testid="dialog-title" {...props}>
			{children}
		</div>
	),
	DialogDescription: ({ children, ...props }: any) => (
		<div data-testid="dialog-description" {...props}>
			{children}
		</div>
	),
	DialogFooter: ({ children, ...props }: any) => (
		<div data-testid="dialog-footer" {...props}>
			{children}
		</div>
	),
}))

// Mock ModesView and McpView since they're rendered during indexing
vi.mock("@src/components/modes/ModesView", () => ({
	default: () => null,
}))

vi.mock("@src/components/mcp/McpView", () => ({
	default: ({ mcpEnabled, onMcpEnabledChange }: any) => (
		<button
			data-testid="cached-mcp-enabled"
			data-value={String(mcpEnabled)}
			onClick={() => onMcpEnabledChange(!mcpEnabled)}>
			Toggle MCP
		</button>
	),
}))

vi.mock("@src/components/worktrees/WorktreesView", () => ({
	WorktreesView: ({ showWorktreesInHomeScreen, onShowWorktreesInHomeScreenChange }: any) => (
		<button
			data-testid="cached-worktrees-home"
			data-value={String(showWorktreesInHomeScreen)}
			onClick={() => onShowWorktreesInHomeScreenChange(!showWorktreesInHomeScreen)}>
			Toggle Worktrees home
		</button>
	),
}))

// Mock Tab components
vi.mock("../common/Tab", () => ({
	Tab: ({ children }: any) => <div>{children}</div>,
	TabContent: React.forwardRef<HTMLDivElement, any>(({ children }, ref) => <div ref={ref}>{children}</div>),
	TabHeader: ({ children }: any) => <div>{children}</div>,
	TabList: ({ children }: any) => <div data-testid="settings-tab-list">{children}</div>,
	TabTrigger: React.forwardRef<HTMLButtonElement, any>(({ children, onClick }, ref) => (
		<button ref={ref} onClick={onClick}>
			{children}
		</button>
	)),
}))

// Mock child components that are complex
vi.mock("../ApiConfigManager", () => ({
	default: vi.fn(
		({
			currentApiConfigName,
			onSelectConfig,
			onDeleteConfig,
			onUpsertConfig,
			onRenameConfig,
			profileActionsDisabled,
		}: any) => (
			<div data-testid="api-config-manager">
				<span data-testid="current-profile-name">{currentApiConfigName}</span>
				<button
					data-testid="rename-profile"
					disabled={profileActionsDisabled}
					onClick={() =>
						onRenameConfig(
							currentApiConfigName,
							currentApiConfigName === "renamed" ? "third-name" : "renamed",
						)
					}>
					Rename profile
				</button>
				<button
					data-testid="select-profile"
					disabled={profileActionsDisabled}
					onClick={() => onSelectConfig("other")}>
					Select profile
				</button>
				<button
					data-testid="delete-profile"
					disabled={profileActionsDisabled}
					onClick={() => onDeleteConfig("default")}>
					Delete profile
				</button>
				<button
					data-testid="create-profile"
					disabled={profileActionsDisabled}
					onClick={() => onUpsertConfig("new-profile")}>
					Create profile
				</button>
			</div>
		),
	),
}))

vi.mock("../ApiOptions", () => ({
	default: vi.fn(() => <div data-testid="api-options">ApiOptions</div>),
}))

// Mock other settings components - ensure they don't interact with props
vi.mock("../AutoApproveSettings", () => ({
	AutoApproveSettings: vi.fn(() => <div>AutoApproveSettings</div>),
}))
vi.mock("../CheckpointSettings", () => ({
	CheckpointSettings: vi.fn(() => <div>CheckpointSettings</div>),
}))
vi.mock("../NotificationSettings", () => ({
	NotificationSettings: vi.fn(() => <div>NotificationSettings</div>),
}))
vi.mock("../ContextManagementSettings", () => ({
	ContextManagementSettings: vi.fn(() => <div>ContextManagementSettings</div>),
}))
vi.mock("../TerminalSettings", () => ({
	TerminalSettings: vi.fn(({ terminalInheritEnv, onTerminalInheritEnvLoaded, setCachedStateField }: any) => (
		<div>
			<button data-testid="load-inherit-env" onClick={() => onTerminalInheritEnvLoaded(true)}>
				Load inherit environment
			</button>
			<button
				data-testid="cached-inherit-env"
				data-value={String(terminalInheritEnv)}
				onClick={() => setCachedStateField("terminalInheritEnv", !terminalInheritEnv)}>
				Toggle inherit environment
			</button>
		</div>
	)),
}))
vi.mock("../ExperimentalSettings", () => ({
	ExperimentalSettings: vi.fn(() => <div>ExperimentalSettings</div>),
}))
vi.mock("../LanguageSettings", () => ({
	LanguageSettings: vi.fn(() => <div>LanguageSettings</div>),
}))
vi.mock("../About", () => ({
	About: vi.fn(() => <div>About</div>),
}))
vi.mock("../PromptsSettings", () => ({
	default: vi.fn(() => <div>PromptsSettings</div>),
}))
vi.mock("../SlashCommandsSettings", () => ({
	SlashCommandsSettings: vi.fn(() => <div>SlashCommandsSettings</div>),
}))
vi.mock("../UISettings", () => ({
	UISettings: vi.fn(() => <div>UISettings</div>),
}))
vi.mock("../SectionHeader", () => ({
	SectionHeader: ({ children }: any) => <div>{children}</div>,
}))
vi.mock("../Section", () => ({
	Section: ({ children }: any) => <div>{children}</div>,
}))
vi.mock("../SettingsSearch", () => ({
	SettingsSearch: () => null,
}))

import { useExtensionState } from "@src/context/ExtensionStateContext"
import ApiOptions from "../ApiOptions"
import { ContextManagementSettings } from "../ContextManagementSettings"
import { NotificationSettings } from "../NotificationSettings"

describe("SettingsView - Unsaved Changes Detection", () => {
	let queryClient: QueryClient

	const defaultExtensionState = {
		currentApiConfigName: "default",
		listApiConfigMeta: [],
		uriScheme: "vscode",
		settingsImportedAt: undefined,
		apiConfiguration: {
			apiProvider: "openai",
			apiModelId: "", // Empty string initially
		},
		alwaysAllowReadOnly: false,
		alwaysAllowReadOnlyOutsideWorkspace: false,
		allowedCommands: [],
		deniedCommands: [],
		allowedMaxRequests: undefined,
		allowedMaxCost: undefined,
		language: "en",
		alwaysAllowExecute: false,
		alwaysAllowMcp: false,
		alwaysAllowModeSwitch: false,
		alwaysAllowSubtasks: false,
		alwaysAllowWrite: false,
		alwaysAllowWriteOutsideWorkspace: false,
		alwaysAllowWriteProtected: false,
		autoCondenseContext: false,
		autoCondenseContextPercent: 50,
		enableCheckpoints: false,
		experiments: {},
		maxOpenTabsContext: 10,
		maxWorkspaceFiles: 200,
		mcpEnabled: false,
		soundEnabled: false,
		ttsEnabled: false,
		ttsSpeed: 1.0,
		soundVolume: 0.5,
		telemetrySetting: "unset",
		terminalOutputLineLimit: 500,
		terminalOutputCharacterLimit: 50000,
		terminalShellIntegrationTimeout: 3000,
		terminalShellIntegrationDisabled: false,
		terminalCommandDelay: 0,
		terminalPowershellCounter: false,
		terminalZshClearEolMark: false,
		terminalZshOhMy: false,
		terminalZshP10k: false,
		terminalZdotdir: false,
		writeDelayMs: 0,
		showRooIgnoredFiles: false,
		maxReadFileLine: -1,
		maxImageFileSize: 5,
		maxTotalImageSize: 20,
		customCondensingPrompt: "",
		customSupportPrompts: {},
		profileThresholds: {},
		alwaysAllowFollowupQuestions: false,
		followupAutoApproveTimeoutMs: undefined,
		includeDiagnosticMessages: false,
		maxDiagnosticMessages: 50,
		includeTaskHistoryInEnhance: true,
		openRouterImageApiKey: undefined,
		openRouterImageGenerationSelectedModel: undefined,
		reasoningBlockCollapsed: true,
	}

	beforeEach(() => {
		vi.clearAllMocks()
		// Reset the ApiOptions mock to its default implementation
		vi.mocked(ApiOptions).mockImplementation(() => {
			// Don't do anything with props, just render a div
			return <div data-testid="api-options">ApiOptions</div>
		})
		vi.mocked(NotificationSettings).mockImplementation(() => <div>NotificationSettings</div>)
		queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		})
		;(useExtensionState as any).mockReturnValue(defaultExtensionState)
	})

	it("should not show unsaved changes when settings are automatically initialized", async () => {
		const onDone = vi.fn()

		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={onDone} />
			</QueryClientProvider>,
		)

		// Wait for the component to render
		await waitFor(() => {
			expect(screen.getByTestId("api-options")).toBeInTheDocument()
		})

		// Wait for any async state updates to complete
		await waitFor(() => {
			const saveButton = screen.getByTestId("save-button") as HTMLButtonElement
			expect(saveButton.disabled).toBe(true)
		})

		// Click the Done button
		const doneButton = screen.getByText("settings:common.done")
		fireEvent.click(doneButton)

		// Should not show unsaved changes dialog - onDone should be called immediately
		await waitFor(() => {
			expect(onDone).toHaveBeenCalled()
		})

		// Verify no dialog appeared
		expect(screen.queryByText("settings:unsavedChangesDialog.title")).not.toBeInTheDocument()
	})

	it("should not trigger unsaved changes for automatic model initialization", async () => {
		const onDone = vi.fn()

		// Mock ApiOptions to simulate ModelPicker initialization
		vi.mocked(ApiOptions).mockImplementation(({ setApiConfigurationField, apiConfiguration }) => {
			const [hasInitialized, setHasInitialized] = React.useState(false)

			React.useEffect(() => {
				// Only run once and only if not already initialized
				if (!hasInitialized && apiConfiguration?.apiModelId === "") {
					// Simulate automatic initialization from empty string to a value
					setApiConfigurationField("apiModelId", "default-model", false)
					setHasInitialized(true)
				}
			}, [hasInitialized, apiConfiguration?.apiModelId, setApiConfigurationField])

			return (
				<div data-testid="api-options" data-initialized={hasInitialized}>
					ApiOptions with Init
				</div>
			)
		})

		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={onDone} />
			</QueryClientProvider>,
		)

		// Wait for the component to render and effects to run
		await waitFor(() => {
			expect(screen.getByTestId("api-options")).toBeInTheDocument()
		})

		await waitFor(() => expect(screen.getByTestId("api-options")).toHaveAttribute("data-initialized", "true"))

		// Check that save button is disabled (no changes detected)
		const saveButton = screen.getByTestId("save-button") as HTMLButtonElement
		expect(saveButton.disabled).toBe(true)

		// Click the Done button
		const doneButton = screen.getByText("settings:common.done")
		fireEvent.click(doneButton)

		// Should not show unsaved changes dialog
		expect(screen.queryByText("settings:unsavedChangesDialog.title")).not.toBeInTheDocument()

		// onDone should be called
		expect(onDone).toHaveBeenCalled()
	})

	it("should show unsaved changes when user makes actual changes", async () => {
		const onDone = vi.fn()

		// Create a custom mock for this test that simulates user interaction
		const ApiOptionsWithButton = vi.fn(({ setApiConfigurationField }) => {
			const handleUserChange = () => {
				// Simulate user action (isUserAction = true by default)
				setApiConfigurationField("apiModelId", "user-selected-model")
			}

			return (
				<div data-testid="api-options">
					<button onClick={handleUserChange} data-testid="change-model">
						Change Model
					</button>
				</div>
			)
		})

		// Override the mock for this specific test
		vi.mocked(ApiOptions).mockImplementation(ApiOptionsWithButton)

		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={onDone} />
			</QueryClientProvider>,
		)

		// Wait for the component to render
		await waitFor(() => {
			expect(screen.getByTestId("api-options")).toBeInTheDocument()
		})

		// Simulate user changing a setting
		const changeButton = screen.getByTestId("change-model")
		fireEvent.click(changeButton)

		// Click the Done button
		const doneButton = screen.getByText("settings:common.done")
		fireEvent.click(doneButton)

		// Should show unsaved changes dialog
		await waitFor(() => {
			expect(screen.getByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
		})

		// onDone should not be called yet
		expect(onDone).not.toHaveBeenCalled()
	})

	it("keeps provider edits isolated from live extension state until Save", async () => {
		const liveState = {
			...defaultExtensionState,
			apiConfiguration: { ...defaultExtensionState.apiConfiguration },
		}
		;(useExtensionState as any).mockReturnValue(liveState)
		vi.mocked(ApiOptions).mockImplementation(({ apiConfiguration, setApiConfigurationField }) => (
			<div data-testid="api-options">
				<span data-testid="cached-model">{apiConfiguration.apiModelId}</span>
				<button onClick={() => setApiConfigurationField("apiModelId", "buffered-model")}>Edit model</button>
			</div>
		))

		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} />
			</QueryClientProvider>,
		)

		await waitFor(() => expect(screen.getByText("Edit model")).toBeInTheDocument())
		mockPostMessage.mockClear()
		fireEvent.click(screen.getByText("Edit model"))

		expect(liveState.apiConfiguration.apiModelId).toBe("")
		expect(screen.getByTestId("cached-model")).toHaveTextContent("buffered-model")
		expect(mockPostMessage).not.toHaveBeenCalled()

		fireEvent.click(screen.getByTestId("save-button"))

		expect(mockPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "upsertApiConfiguration",
				apiConfiguration: expect.objectContaining({ apiModelId: "buffered-model" }),
			}),
		)
	})

	it("renames only the persisted profile identity while provider edits stay buffered", async () => {
		const liveState = {
			...defaultExtensionState,
			listApiConfigMeta: [{ id: "profile-a", name: "default" }],
			apiConfiguration: {
				apiProvider: "openai",
				openAiBaseUrl: "https://saved.example/v1",
				openAiApiKey: "saved-key",
				openAiModelId: "saved-model",
			},
		}
		;(useExtensionState as any).mockReturnValue(liveState)
		vi.mocked(ApiOptions).mockImplementation(({ apiConfiguration, setApiConfigurationField }) => (
			<div data-testid="api-options">
				<span data-testid="cached-provider">{apiConfiguration.apiProvider}</span>
				<span data-testid="cached-endpoint">{apiConfiguration.openAiBaseUrl}</span>
				<span data-testid="cached-key">{apiConfiguration.openAiApiKey}</span>
				<span data-testid="cached-model">{apiConfiguration.openAiModelId}</span>
				<button
					onClick={() => {
						setApiConfigurationField("apiProvider", "stellar")
						setApiConfigurationField("openAiBaseUrl", "https://buffered.example/v1")
						setApiConfigurationField("openAiApiKey", "buffered-key")
						setApiConfigurationField("openAiModelId", "buffered-model")
					}}>
					Edit provider settings
				</button>
			</div>
		))
		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} />
			</QueryClientProvider>,
		)
		await waitFor(() => expect(screen.getByText("Edit provider settings")).toBeInTheDocument())
		fireEvent.click(screen.getByText("Edit provider settings"))
		mockPostMessage.mockClear()
		fireEvent.click(screen.getByTestId("rename-profile"))

		expect(mockPostMessage).toHaveBeenCalledExactlyOnceWith({
			type: "renameApiConfiguration",
			apiConfigurationRename: { requestId: expect.any(String), id: "profile-a", newName: "renamed" },
		})
		expect(screen.getByTestId("cached-provider")).toHaveTextContent("stellar")
		expect(screen.getByTestId("cached-endpoint")).toHaveTextContent("https://buffered.example/v1")
		expect(screen.getByTestId("cached-key")).toHaveTextContent("buffered-key")
		expect(screen.getByTestId("cached-model")).toHaveTextContent("buffered-model")
		expect(screen.getByTestId("save-button")).toBeDisabled()
		fireEvent.click(screen.getByText("settings:common.done"))
		expect(screen.getByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
		expect(liveState.apiConfiguration).toEqual({
			apiProvider: "openai",
			openAiBaseUrl: "https://saved.example/v1",
			openAiApiKey: "saved-key",
			openAiModelId: "saved-model",
		})
	})

	describe("profile rename edit-buffer lifecycle", () => {
		const setupDirtyProfile = (omitSavedSecret = false, onProviderLayout?: () => void, profileId = "profile-a") => {
			const savedProvider = {
				apiProvider: "openai",
				openAiBaseUrl: "https://saved.example/v1",
				openAiApiKey: omitSavedSecret ? undefined : "saved-key",
				openAiModelId: "saved-model",
			}
			let liveState = {
				...defaultExtensionState,
				settingsImportedAt: undefined as number | undefined,
				listApiConfigMeta: [{ id: profileId, name: "default" }],
				apiConfiguration: savedProvider,
			}
			;(useExtensionState as any).mockImplementation(() => liveState)
			let editPendingModel: (model: string) => void = () => undefined
			vi.mocked(ApiOptions).mockImplementation(function BufferedProviderOptions({
				apiConfiguration,
				setApiConfigurationField,
			}) {
				editPendingModel = (model: string) => setApiConfigurationField("openAiModelId", model)
				React.useLayoutEffect(() => onProviderLayout?.())
				return (
					<div data-testid="api-options">
						<span data-testid="cached-provider">{apiConfiguration.apiProvider}</span>
						<span data-testid="cached-endpoint">{apiConfiguration.openAiBaseUrl}</span>
						<span data-testid="cached-key">{apiConfiguration.openAiApiKey}</span>
						<span data-testid="cached-model">{apiConfiguration.openAiModelId}</span>
						<button
							onClick={() => {
								setApiConfigurationField("apiProvider", "stellar")
								setApiConfigurationField("openAiBaseUrl", "https://buffered.example/v1")
								setApiConfigurationField("openAiApiKey", "buffered-key")
								setApiConfigurationField("openAiModelId", "buffered-model")
							}}>
							Edit provider settings
						</button>
						<button onClick={() => setApiConfigurationField("openAiModelId", "newer-model")}>
							Change pending model
						</button>
					</div>
				)
			})
			let editPendingSound: (enabled: boolean) => void = () => undefined
			vi.mocked(NotificationSettings).mockImplementation(({ soundEnabled, setCachedStateField }) => {
				editPendingSound = (enabled: boolean) => setCachedStateField("soundEnabled", enabled)
				return (
					<div>
						<span data-testid="cached-sound">{String(soundEnabled)}</span>
						<button onClick={() => setCachedStateField("soundEnabled", true)}>Enable sound</button>
						<button onClick={() => setCachedStateField("soundEnabled", false)}>Disable sound</button>
					</div>
				)
			})
			const onDone = vi.fn()
			const view = () => (
				<QueryClientProvider client={queryClient}>
					<SettingsView onDone={() => onDone()} />
				</QueryClientProvider>
			)
			const result = render(view())
			fireEvent.click(screen.getByText("Edit provider settings"))
			fireEvent.click(screen.getByTestId("tab-notifications"))
			fireEvent.click(screen.getByText("Enable sound"))
			fireEvent.click(screen.getByTestId("tab-providers"))
			mockPostMessage.mockClear()
			const rename = () => {
				fireEvent.click(screen.getByTestId("rename-profile"))
				const message = mockPostMessage.mock.calls.findLast(
					([message]) => message.type === "renameApiConfiguration",
				)
				return providerProfileRenameRequestSchema.parse(message?.[0].apiConfigurationRename)
			}
			const respond = async (response: ProviderProfileRenameResult) => {
				await act(async () => {
					window.dispatchEvent(
						new MessageEvent("message", {
							data: { type: "apiConfigurationRenamed", apiConfigurationRenameResult: response },
						}),
					)
				})
			}
			const save = () => {
				fireEvent.click(screen.getByTestId("save-button"))
				const message = mockPostMessage.mock.calls.findLast(
					([message]) => message.type === "upsertApiConfiguration",
				)
				return providerProfileSaveRequestSchema.parse({
					requestId: message?.[0].requestId,
					id: message?.[0].apiConfigurationId,
				})
			}
			const respondSave = async (response: unknown) => {
				await act(async () => {
					window.dispatchEvent(
						new MessageEvent("message", {
							data: { type: "apiConfigurationSaved", apiConfigurationSaveResult: response },
						}),
					)
				})
			}
			const refresh = (updates: Partial<typeof liveState>) => {
				liveState = { ...liveState, ...updates }
				result.rerender(view())
			}
			const expectDraft = () => {
				expect(screen.getByTestId("cached-provider")).toHaveTextContent("stellar")
				expect(screen.getByTestId("cached-endpoint")).toHaveTextContent("https://buffered.example/v1")
				expect(screen.getByTestId("cached-key")).toHaveTextContent("buffered-key")
				expect(screen.getByTestId("cached-model")).toHaveTextContent("buffered-model")
				fireEvent.click(screen.getByTestId("tab-notifications"))
				expect(screen.getByTestId("cached-sound")).toHaveTextContent("true")
				fireEvent.click(screen.getByTestId("tab-providers"))
			}
			return {
				...result,
				onDone,
				rename,
				respond,
				save,
				respondSave,
				refresh,
				expectDraft,
				savedProvider,
				editModel: (model: string) => editPendingModel(model),
				editSound: (enabled: boolean) => editPendingSound(enabled),
			}
		}

		it("saves a stale editor name by its captured profile ID exactly once", () => {
			const test = setupDirtyProfile()
			// Another view can rename this saved profile before this editor receives any refresh.
			test.expectDraft()
			fireEvent.click(screen.getByTestId("save-button"))
			expect(mockPostMessage.mock.calls.filter(([message]) => message.type === "upsertApiConfiguration")).toEqual(
				[
					[
						{
							type: "upsertApiConfiguration",
							requestId: expect.any(String),
							apiConfigurationId: "profile-a",
							text: "default",
							apiConfiguration: expect.objectContaining({
								apiProvider: "stellar",
								openAiBaseUrl: "https://buffered.example/v1",
								openAiApiKey: "buffered-key",
								openAiModelId: "buffered-model",
							}),
						},
					],
				],
			)
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "updateSettings",
					updatedSettings: expect.objectContaining({ soundEnabled: true }),
				}),
			)
		})

		it("keeps modern edits dirty until the extension acknowledges Save", () => {
			const test = setupDirtyProfile()
			fireEvent.click(screen.getByTestId("save-button"))
			fireEvent.click(screen.getByText("settings:common.done"))
			expect(screen.getByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
			expect(test.onDone).not.toHaveBeenCalled()
			test.expectDraft()
		})

		it.each(["provider", "global"] as const)(
			"keeps a %s edit dirty when Save succeeds in the same event batch",
			(field) => {
				const test = setupDirtyProfile()
				const request = test.save()
				act(() => {
					if (field === "provider") test.editModel("newer-model")
					else test.editSound(false)
					expect(screen.getByTestId("cached-model")).toHaveTextContent("buffered-model")
					window.dispatchEvent(
						new MessageEvent("message", {
							data: {
								type: "apiConfigurationSaved",
								apiConfigurationSaveResult: {
									requestId: request.requestId,
									status: "success",
									id: request.id,
									name: "default",
								},
							},
						}),
					)
				})
				if (field === "provider") expect(screen.getByTestId("cached-model")).toHaveTextContent("newer-model")
				else {
					fireEvent.click(screen.getByTestId("tab-notifications"))
					expect(screen.getByTestId("cached-sound")).toHaveTextContent("false")
				}
				expect(screen.getByTestId("save-button")).toBeEnabled()
				fireEvent.click(screen.getByText("settings:common.done"))
				expect(screen.getByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
			},
		)

		it("clears dirty only for the matching valid Save success", async () => {
			const test = setupDirtyProfile()
			const request = test.save()
			const response: ProviderProfileSaveResult = {
				requestId: request.requestId,
				status: "success",
				id: request.id,
				name: "default",
			}
			await test.respondSave({ ...response, unexpected: true })
			await test.respondSave({ ...response, requestId: "other-request" })
			await test.respondSave({ ...response, id: "other-profile" })
			expect(screen.getByTestId("save-button")).toBeDisabled()
			fireEvent.click(screen.getByText("settings:common.done"))
			expect(screen.getByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
			fireEvent.click(screen.getByText("settings:unsavedChangesDialog.cancelButton"))
			await test.respondSave(response)
			test.expectDraft()
			expect(screen.getByTestId("save-button")).toBeDisabled()
			fireEvent.click(screen.getByText("settings:common.done"))
			expect(test.onDone).toHaveBeenCalledTimes(1)
		})

		it.each(["invalid", "notFound", "saveFailed"] as const)(
			"retains provider/global drafts and retries after Save reports %s",
			async (error) => {
				const test = setupDirtyProfile()
				const request = test.save()
				if (error === "notFound") test.refresh({ listApiConfigMeta: [] })
				await test.respondSave({ requestId: request.requestId, status: "error", error })
				expect(screen.getByRole("alert")).toHaveTextContent(`settings:providers.saveErrors.${error}`)
				expect(screen.getByTestId("save-button")).toBeEnabled()
				test.expectDraft()
				fireEvent.click(screen.getByText("settings:common.done"))
				expect(screen.getByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
				fireEvent.click(screen.getByText("settings:unsavedChangesDialog.cancelButton"))
				const retry = test.save()
				expect(retry.id).toBe("profile-a")
				expect(retry.requestId).not.toBe(request.requestId)
				await test.respondSave({
					requestId: request.requestId,
					status: "success",
					id: request.id,
					name: "default",
				})
				expect(screen.getByTestId("save-button")).toBeDisabled()
				await test.respondSave({
					requestId: retry.requestId,
					status: "success",
					id: retry.id,
					name: "default",
				})
				fireEvent.click(screen.getByText("settings:common.done"))
				expect(test.onDone).toHaveBeenCalledTimes(1)
			},
		)

		it("keeps provider and global edits made while Save is pending dirty", async () => {
			const test = setupDirtyProfile()
			const request = test.save()
			fireEvent.click(screen.getByText("Change pending model"))
			fireEvent.click(screen.getByTestId("tab-notifications"))
			fireEvent.click(screen.getByText("Disable sound"))
			fireEvent.click(screen.getByTestId("tab-providers"))
			await test.respondSave({
				requestId: request.requestId,
				status: "success",
				id: request.id,
				name: "default",
			})
			expect(screen.getByTestId("cached-model")).toHaveTextContent("newer-model")
			expect(screen.getByTestId("save-button")).toBeEnabled()
			mockPostMessage.mockClear()
			test.save()
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "upsertApiConfiguration",
					apiConfigurationId: request.id,
					apiConfiguration: expect.objectContaining({ openAiModelId: "newer-model" }),
				}),
			)
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "updateSettings",
					updatedSettings: expect.objectContaining({ soundEnabled: false }),
				}),
			)
		})

		it("does not restore an older profile name from a delayed Save success", async () => {
			const test = setupDirtyProfile()
			const request = test.save()
			for (const action of ["rename-profile", "select-profile", "delete-profile", "create-profile"]) {
				expect(screen.getByTestId(action)).toBeDisabled()
			}
			test.refresh({
				currentApiConfigName: "external-name",
				listApiConfigMeta: [{ id: request.id, name: "external-name" }],
			})
			await test.respondSave({ requestId: request.requestId, status: "success", id: request.id, name: "default" })
			expect(screen.getByTestId("current-profile-name")).toHaveTextContent("external-name")
			fireEvent.click(screen.getByText("Change pending model"))
			mockPostMessage.mockClear()
			test.save()
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "upsertApiConfiguration",
					apiConfigurationId: request.id,
					text: "external-name",
				}),
			)
		})

		it("releases a missing Save result for retry and ignores the timed-out response", async () => {
			const test = setupDirtyProfile()
			vi.useFakeTimers()
			const timeoutSpy = vi.spyOn(globalThis, "setTimeout")
			const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")
			try {
				const request = test.save()
				expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000)
				act(() => vi.advanceTimersByTime(30_000))
				expect(screen.getByRole("alert")).toHaveTextContent("settings:providers.saveErrors.timeout")
				expect(screen.getByTestId("save-button")).toBeEnabled()
				test.expectDraft()
				timeoutSpy.mockClear()
				const retry = test.save()
				const retryTimeout =
					timeoutSpy.mock.results[timeoutSpy.mock.calls.findIndex(([, delay]) => delay === 30_000)]
				await test.respondSave({
					requestId: request.requestId,
					status: "success",
					id: request.id,
					name: "default",
				})
				expect(screen.getByTestId("save-button")).toBeDisabled()
				await test.respondSave({ requestId: retry.requestId, status: "success", id: retry.id, name: "default" })
				expect(clearTimeoutSpy).toHaveBeenCalledWith(retryTimeout.value)
				fireEvent.click(screen.getByText("settings:common.done"))
				expect(test.onDone).toHaveBeenCalledTimes(1)
			} finally {
				timeoutSpy.mockRestore()
				clearTimeoutSpy.mockRestore()
				vi.useRealTimers()
			}
		})

		it.each(["selection", "import", "discard", "unmount"] as const)(
			"releases a pending Save timer and ignores its result after %s",
			async (reset) => {
				const test = setupDirtyProfile()
				vi.useFakeTimers()
				const timeoutSpy = vi.spyOn(globalThis, "setTimeout")
				const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")
				try {
					const request = test.save()
					const timeout =
						timeoutSpy.mock.results[timeoutSpy.mock.calls.findIndex(([, delay]) => delay === 30_000)]
					if (reset === "selection") {
						test.refresh({
							listApiConfigMeta: [{ id: "profile-b", name: "default" }],
							apiConfiguration: { ...test.savedProvider, openAiModelId: "reset-model" },
						})
					} else if (reset === "import") {
						test.refresh({
							settingsImportedAt: 123,
							apiConfiguration: { ...test.savedProvider, openAiModelId: "reset-model" },
						})
					} else if (reset === "discard") {
						fireEvent.click(screen.getByText("settings:common.done"))
						fireEvent.click(screen.getByText("settings:unsavedChangesDialog.discardButton"))
					} else {
						test.unmount()
					}
					expect(clearTimeoutSpy).toHaveBeenCalledWith(timeout.value)
					if (reset === "unmount") return
					fireEvent.click(screen.getByText("Edit provider settings"))
					await test.respondSave({
						requestId: request.requestId,
						status: "success",
						id: request.id,
						name: "default",
					})
					expect(screen.getByTestId("cached-model")).toHaveTextContent("buffered-model")
					expect(screen.getByTestId("save-button")).toBeEnabled()
					fireEvent.click(screen.getByText("settings:common.done"))
					expect(screen.getByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
				} finally {
					timeoutSpy.mockRestore()
					clearTimeoutSpy.mockRestore()
					vi.useRealTimers()
				}
			},
		)

		it("retains dirty state and releases pending Save after a transport error", () => {
			const test = setupDirtyProfile()
			mockPostMessage
				.mockImplementationOnce(() => undefined)
				.mockImplementationOnce(() => {
					throw new Error("test transport failure")
				})
			test.save()
			expect(screen.getByRole("alert")).toHaveTextContent("settings:providers.saveErrors.saveFailed")
			expect(screen.getByTestId("save-button")).toBeEnabled()
			test.expectDraft()
		})

		it.each([
			{
				delivery: "metadata first",
				updates: { listApiConfigMeta: [{ id: "profile-a", name: "external-name" }] },
			},
			{ delivery: "name first", updates: { currentApiConfigName: "external-name" } },
			{ delivery: "profile no longer listed", updates: { listApiConfigMeta: [] } },
		])("retains its existing Save target when a rename refresh has $delivery", ({ updates }) => {
			const test = setupDirtyProfile()
			test.refresh(updates)
			test.expectDraft()
			fireEvent.click(screen.getByTestId("save-button"))
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "upsertApiConfiguration",
					apiConfigurationId: "profile-a",
					apiConfiguration: expect.objectContaining({ openAiModelId: "buffered-model" }),
				}),
			)
			expect(
				mockPostMessage.mock.calls.filter(([message]) => message.type === "upsertApiConfiguration"),
			).toHaveLength(1)
		})

		it.each(["", " imported-profile-id "])("sends a defined ID unchanged for host validation: %j", (id) => {
			setupDirtyProfile(false, undefined, id)
			fireEvent.click(screen.getByTestId("save-button"))
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "upsertApiConfiguration",
					apiConfigurationId: id,
					requestId: expect.any(String),
				}),
			)
		})

		it("retains a known same-name target through Discard when metadata disappears", () => {
			const test = setupDirtyProfile()
			test.refresh({ listApiConfigMeta: [] })
			fireEvent.click(screen.getByText("settings:common.done"))
			fireEvent.click(screen.getByText("settings:unsavedChangesDialog.discardButton"))
			expect(screen.getByTestId("cached-model")).toHaveTextContent("saved-model")
			fireEvent.click(screen.getByText("Edit provider settings"))
			expect(test.save().id).toBe("profile-a")
		})

		it.each(["discard", "import"] as const)(
			"waits for the new identity when %s adopts another unresolved profile buffer",
			(reset) => {
				const test = setupDirtyProfile()
				test.refresh({
					currentApiConfigName: "selected-profile",
					listApiConfigMeta: [],
					apiConfiguration: { ...test.savedProvider, openAiModelId: "selected-model" },
					...(reset === "import" ? { settingsImportedAt: 123 } : {}),
				})
				if (reset === "discard") {
					test.expectDraft()
					fireEvent.click(screen.getByText("settings:common.done"))
					fireEvent.click(screen.getByText("settings:unsavedChangesDialog.discardButton"))
				}
				expect(screen.getByTestId("cached-model")).toHaveTextContent("selected-model")
				fireEvent.click(screen.getByText("Edit provider settings"))
				expect(screen.getByTestId("save-button")).toBeDisabled()
				expect(screen.getByText("settings:providers.profileIdentityPending")).toBeInTheDocument()
				mockPostMessage.mockClear()
				fireEvent.click(screen.getByTestId("save-button"))
				expect(mockPostMessage).not.toHaveBeenCalled()
				test.refresh({ listApiConfigMeta: [{ id: "profile-b", name: "selected-profile" }] })
				expect(screen.getByTestId("cached-model")).toHaveTextContent("buffered-model")
				expect(test.save().id).toBe("profile-b")
			},
		)

		it("creates a new profile by name after discarding an existing profile's dirty edits", () => {
			const test = setupDirtyProfile()
			fireEvent.click(screen.getByTestId("create-profile"))
			expect(screen.getByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
			fireEvent.click(screen.getByText("settings:unsavedChangesDialog.discardButton"))
			expect(mockPostMessage.mock.calls.filter(([message]) => message.type === "upsertApiConfiguration")).toEqual(
				[[{ type: "upsertApiConfiguration", text: "new-profile", apiConfiguration: test.savedProvider }]],
			)
		})

		it("keeps the old buffer and ID paired until a real selection reset commits", async () => {
			let saveBeforeSelectionEffect = false
			const test = setupDirtyProfile(false, () => {
				if (!saveBeforeSelectionEffect) return
				saveBeforeSelectionEffect = false
				// This layout effect runs after the selection render, before SettingsView resyncs its buffer.
				fireEvent.click(screen.getByTestId("save-button"))
			})
			saveBeforeSelectionEffect = true
			test.refresh({
				currentApiConfigName: "selected-profile",
				listApiConfigMeta: [{ id: "profile-b", name: "selected-profile" }],
				apiConfiguration: { ...test.savedProvider, openAiModelId: "selected-model" },
			})
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "upsertApiConfiguration",
					apiConfigurationId: "profile-a",
					apiConfiguration: expect.objectContaining({ openAiModelId: "buffered-model" }),
				}),
			)
			await waitFor(() => expect(screen.getByTestId("cached-model")).toHaveTextContent("selected-model"))
			fireEvent.click(screen.getByText("Edit provider settings"))
			mockPostMessage.mockClear()
			fireEvent.click(screen.getByTestId("save-button"))
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "upsertApiConfiguration", apiConfigurationId: "profile-b" }),
			)
		})

		it.each(["response-first", "refresh-first"] as const)(
			"keeps all drafts and saves to the renamed profile with %s delivery",
			async (order) => {
				const test = setupDirtyProfile(order === "response-first")
				const request = test.rename()
				expect(screen.getByTestId("save-button")).toBeDisabled()
				fireEvent.click(screen.getByTestId("save-button"))
				expect(mockPostMessage).toHaveBeenCalledOnce()
				const response: ProviderProfileRenameResult = {
					requestId: request.requestId,
					status: "success",
					id: request.id,
					oldName: "default",
					newName: "renamed",
				}
				const refresh = () =>
					test.refresh({
						currentApiConfigName: "renamed",
						listApiConfigMeta: [{ id: "profile-a", name: "renamed" }],
						apiConfiguration: { ...test.savedProvider, openAiModelId: "refreshed-saved-model" },
					})
				if (order === "response-first") {
					await test.respond(response)
					// Save must target the committed name even before its state projection arrives.
					expect(screen.getByTestId("current-profile-name")).toHaveTextContent("renamed")
					test.expectDraft()
					fireEvent.click(screen.getByTestId("save-button"))
				} else {
					refresh()
					test.expectDraft()
					expect(screen.getByTestId("save-button")).toBeDisabled()
					await test.respond(response)
					fireEvent.click(screen.getByTestId("save-button"))
				}
				expect(mockPostMessage).toHaveBeenCalledWith({
					type: "upsertApiConfiguration",
					requestId: expect.any(String),
					apiConfigurationId: "profile-a",
					text: "renamed",
					apiConfiguration: expect.objectContaining({
						apiProvider: "stellar",
						openAiBaseUrl: "https://buffered.example/v1",
						openAiApiKey: "buffered-key",
						openAiModelId: "buffered-model",
					}),
				})
				expect(mockPostMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "updateSettings",
						updatedSettings: expect.objectContaining({ soundEnabled: true }),
					}),
				)
			},
		)

		it("ignores unrelated acknowledgements and retries after a failed rename without losing drafts", async () => {
			const test = setupDirtyProfile()
			const request = test.rename()
			await test.respond({ requestId: "unrelated", status: "error", error: "saveFailed" })
			expect(screen.getByTestId("save-button")).toBeDisabled()
			test.expectDraft()
			await test.respond({ requestId: request.requestId, status: "error", error: "saveFailed" })
			expect(screen.getByTestId("save-button")).toBeEnabled()
			expect(screen.getByTestId("current-profile-name")).toHaveTextContent("default")
			test.expectDraft()
			const retry = test.rename()
			expect(retry.requestId).not.toBe(request.requestId)
			await test.respond({
				requestId: request.requestId,
				status: "success",
				id: "profile-a",
				oldName: "default",
				newName: "stale-name",
			})
			expect(screen.getByTestId("save-button")).toBeDisabled()
			expect(screen.getByTestId("current-profile-name")).toHaveTextContent("default")
			await test.respond({ requestId: retry.requestId, status: "error", error: "nameInUse" })
			expect(screen.getByTestId("save-button")).toBeEnabled()
			test.expectDraft()
		})

		it("discards against the latest saved settings after a successful dirty rename", async () => {
			const test = setupDirtyProfile()
			const request = test.rename()
			await test.respond({
				requestId: request.requestId,
				status: "success",
				id: "profile-a",
				oldName: "default",
				newName: "renamed",
			})
			test.refresh({
				currentApiConfigName: "renamed",
				listApiConfigMeta: [{ id: "profile-a", name: "renamed" }],
				apiConfiguration: {
					...test.savedProvider,
					openAiModelId: "latest-saved-model",
					openAiApiKey: "latest-saved-key",
				},
				soundEnabled: false,
			})
			test.expectDraft()
			fireEvent.click(screen.getByText("settings:common.done"))
			expect(screen.getByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
			fireEvent.click(screen.getByText("settings:unsavedChangesDialog.discardButton"))
			expect(test.onDone).toHaveBeenCalledOnce()
			expect(screen.getByTestId("cached-model")).toHaveTextContent("latest-saved-model")
			expect(screen.getByTestId("cached-key")).toHaveTextContent("latest-saved-key")
			fireEvent.click(screen.getByTestId("tab-notifications"))
			expect(screen.getByTestId("cached-sound")).toHaveTextContent("false")
			expect(mockPostMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ type: "upsertApiConfiguration" }),
			)
		})

		it("adopts an external same-ID rename as the later Save target while preserving drafts", async () => {
			const test = setupDirtyProfile()
			const request = test.rename()
			await test.respond({
				requestId: request.requestId,
				status: "success",
				id: "profile-a",
				oldName: "default",
				newName: "renamed",
			})
			test.refresh({
				currentApiConfigName: "external-name",
				listApiConfigMeta: [{ id: "profile-a", name: "external-name" }],
			})
			test.expectDraft()
			fireEvent.click(screen.getByTestId("save-button"))
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "upsertApiConfiguration", text: "external-name" }),
			)
		})

		it("resets on a same-name different-ID selection and ignores its old pending rename", async () => {
			const test = setupDirtyProfile()
			const request = test.rename()
			test.refresh({
				listApiConfigMeta: [{ id: "profile-b", name: "default" }],
				apiConfiguration: { ...test.savedProvider, openAiModelId: "selected-model" },
			})
			expect(screen.getByTestId("cached-model")).toHaveTextContent("selected-model")
			expect(screen.getByTestId("save-button")).toBeDisabled()
			fireEvent.click(screen.getByText("Edit provider settings"))
			await test.respond({
				requestId: request.requestId,
				status: "success",
				id: "profile-a",
				oldName: "default",
				newName: "renamed",
			})
			expect(screen.getByTestId("current-profile-name")).toHaveTextContent("default")
			expect(screen.getByTestId("cached-model")).toHaveTextContent("buffered-model")
			expect(screen.getByTestId("save-button")).toBeEnabled()
			const nextRename = test.rename()
			expect(nextRename.id).toBe("profile-b")
		})

		it("resets drafts on settings import and releases a pending rename", async () => {
			const test = setupDirtyProfile()
			const request = test.rename()
			test.refresh({
				settingsImportedAt: 123,
				apiConfiguration: { ...test.savedProvider, openAiModelId: "imported-model" },
			})
			expect(screen.getByTestId("cached-model")).toHaveTextContent("imported-model")
			await test.respond({
				requestId: request.requestId,
				status: "success",
				id: "profile-a",
				oldName: "default",
				newName: "renamed",
			})
			expect(screen.getByTestId("current-profile-name")).toHaveTextContent("default")
			fireEvent.click(screen.getByText("Edit provider settings"))
			expect(screen.getByTestId("save-button")).toBeEnabled()
			expect(test.save().id).toBe("profile-a")
		})

		it("blocks profile actions across tab remounts while a rename is pending", async () => {
			const test = setupDirtyProfile()
			const request = test.rename()
			test.expectDraft()
			for (const action of ["rename-profile", "select-profile", "delete-profile", "create-profile"]) {
				expect(screen.getByTestId(action)).toBeDisabled()
				fireEvent.click(screen.getByTestId(action))
			}
			expect(mockPostMessage).toHaveBeenCalledOnce()
			await test.respond({ requestId: request.requestId, status: "error", error: "saveFailed" })
			expect(screen.getByTestId("rename-profile")).toBeEnabled()
			expect(screen.getByTestId("save-button")).toBeEnabled()
		})

		it("uses a correlated committed name even when recovery reports a newer external rename", async () => {
			const test = setupDirtyProfile()
			const request = test.rename()
			await test.respond({
				requestId: request.requestId,
				status: "success",
				id: "profile-a",
				oldName: "default",
				newName: "committed-other-name",
			})
			test.expectDraft()
			expect(screen.getByTestId("current-profile-name")).toHaveTextContent("committed-other-name")
			fireEvent.click(screen.getByTestId("save-button"))
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "upsertApiConfiguration", text: "committed-other-name" }),
			)
		})

		it("waits for profile-name convergence before another rename can begin", async () => {
			const test = setupDirtyProfile()
			const first = test.rename()
			await test.respond({
				requestId: first.requestId,
				status: "success",
				id: "profile-a",
				oldName: "default",
				newName: "renamed",
			})
			expect(screen.getByTestId("current-profile-name")).toHaveTextContent("renamed")
			expect(screen.getByText("settings:providers.profileRefreshPending")).toBeInTheDocument()
			for (const action of ["rename-profile", "select-profile", "delete-profile", "create-profile"]) {
				expect(screen.getByTestId(action)).toBeDisabled()
				fireEvent.click(screen.getByTestId(action))
			}
			expect(mockPostMessage).toHaveBeenCalledOnce()
			expect(screen.getByTestId("save-button")).toBeEnabled()
			test.expectDraft()
			test.refresh({ currentApiConfigName: "renamed", listApiConfigMeta: [{ id: "profile-a", name: "renamed" }] })
			expect(screen.getByTestId("rename-profile")).toBeEnabled()
			const second = test.rename()
			expect(second.newName).toBe("third-name")
			await test.respond({
				requestId: second.requestId,
				status: "success",
				id: "profile-a",
				oldName: "renamed",
				newName: "third-name",
			})
			// An older projection of the first rename cannot recreate its now-stale name on Save.
			test.refresh({ currentApiConfigName: "renamed", listApiConfigMeta: [{ id: "profile-a", name: "renamed" }] })
			expect(screen.getByTestId("current-profile-name")).toHaveTextContent("third-name")
			test.expectDraft()
			fireEvent.click(screen.getByTestId("save-button"))
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "upsertApiConfiguration", text: "third-name" }),
			)
		})

		it("reconciles a newer committed name after the requested name was already projected", async () => {
			const test = setupDirtyProfile()
			const request = test.rename()
			test.refresh({ currentApiConfigName: "renamed", listApiConfigMeta: [{ id: "profile-a", name: "renamed" }] })
			await test.respond({
				requestId: request.requestId,
				status: "success",
				id: "profile-a",
				oldName: "default",
				newName: "committed-other-name",
			})
			test.expectDraft()
			expect(screen.getByTestId("current-profile-name")).toHaveTextContent("committed-other-name")
			fireEvent.click(screen.getByTestId("save-button"))
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "upsertApiConfiguration", text: "committed-other-name" }),
			)
		})

		it("targets the reverted saved name after a failed rename without discarding drafts", async () => {
			const test = setupDirtyProfile()
			const request = test.rename()
			test.refresh({ currentApiConfigName: "renamed", listApiConfigMeta: [{ id: "profile-a", name: "renamed" }] })
			await test.respond({
				requestId: request.requestId,
				status: "error",
				error: "saveFailed",
				profile: { id: "profile-a", name: "default" },
			})
			test.expectDraft()
			expect(screen.getByTestId("current-profile-name")).toHaveTextContent("default")
			fireEvent.click(screen.getByTestId("save-button"))
			expect(mockPostMessage).toHaveBeenCalledWith(
				expect.objectContaining({ type: "upsertApiConfiguration", text: "default" }),
			)
		})

		it("preserves drafts when the renamed name arrives before matching metadata", async () => {
			const test = setupDirtyProfile()
			const request = test.rename()
			test.refresh({ currentApiConfigName: "renamed" })
			test.expectDraft()
			await test.respond({
				requestId: request.requestId,
				status: "success",
				id: "profile-a",
				oldName: "default",
				newName: "renamed",
			})
			expect(screen.getByTestId("save-button")).toBeEnabled()
			test.refresh({ currentApiConfigName: "default" })
			expect(screen.getByTestId("current-profile-name")).toHaveTextContent("renamed")
			test.expectDraft()
			expect(test.save().id).toBe("profile-a")
		})

		it("keeps dirty edits when a profile ID is missing and sends no rename mutation", async () => {
			const test = setupDirtyProfile()
			test.refresh({ listApiConfigMeta: [] })
			await act(async () => fireEvent.click(screen.getByTestId("rename-profile")))
			expect(mockPostMessage).not.toHaveBeenCalled()
			expect(screen.getByTestId("save-button")).toBeEnabled()
			test.expectDraft()
		})

		it("releases the request on unmount and ignores its late result in a new settings view", async () => {
			const first = setupDirtyProfile()
			const oldRequest = first.rename()
			first.unmount()
			const next = setupDirtyProfile()
			const newRequest = next.rename()
			await next.respond({
				requestId: oldRequest.requestId,
				status: "success",
				id: "profile-a",
				oldName: "default",
				newName: "old-result",
			})
			expect(screen.getByTestId("current-profile-name")).toHaveTextContent("default")
			expect(screen.getByTestId("save-button")).toBeDisabled()
			await next.respond({ requestId: newRequest.requestId, status: "error", error: "saveFailed" })
			expect(screen.getByTestId("save-button")).toBeEnabled()
			next.expectDraft()
		})
	})

	it("keeps dirty cached edits across a live refresh and discards against the latest state", async () => {
		const onDone = vi.fn()
		let liveState = {
			...defaultExtensionState,
			apiConfiguration: { ...defaultExtensionState.apiConfiguration },
		}
		;(useExtensionState as any).mockImplementation(() => liveState)
		vi.mocked(ApiOptions).mockImplementation(({ apiConfiguration, setApiConfigurationField }) => (
			<div data-testid="api-options">
				<span data-testid="cached-model">{apiConfiguration.apiModelId}</span>
				<button onClick={() => setApiConfigurationField("apiModelId", "buffered-model")}>Edit model</button>
			</div>
		))

		const { rerender } = render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={onDone} />
			</QueryClientProvider>,
		)

		await waitFor(() => expect(screen.getByText("Edit model")).toBeInTheDocument())
		fireEvent.click(screen.getByText("Edit model"))
		expect(screen.getByTestId("cached-model")).toHaveTextContent("buffered-model")

		liveState = {
			...liveState,
			apiConfiguration: { ...liveState.apiConfiguration, apiModelId: "refreshed-model" },
		}
		rerender(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={onDone} />
			</QueryClientProvider>,
		)

		await waitFor(() => expect(screen.getByTestId("cached-model")).toHaveTextContent("buffered-model"))
		fireEvent.click(screen.getByText("settings:common.done"))
		expect(screen.getByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()

		fireEvent.click(screen.getByText("settings:unsavedChangesDialog.cancelButton"))
		expect(screen.getByTestId("cached-model")).toHaveTextContent("buffered-model")
		expect(onDone).not.toHaveBeenCalled()

		fireEvent.click(screen.getByText("settings:common.done"))
		fireEvent.click(screen.getByText("settings:unsavedChangesDialog.discardButton"))
		await waitFor(() => expect(onDone).toHaveBeenCalledOnce())
		expect(screen.getByTestId("cached-model")).toHaveTextContent("refreshed-model")
	})

	it("saves the cached value after a live refresh without adopting the refreshed value", async () => {
		let liveState = {
			...defaultExtensionState,
			apiConfiguration: { ...defaultExtensionState.apiConfiguration },
		}
		;(useExtensionState as any).mockImplementation(() => liveState)
		vi.mocked(ApiOptions).mockImplementation(({ apiConfiguration, setApiConfigurationField }) => (
			<div data-testid="api-options">
				<span data-testid="cached-model">{apiConfiguration.apiModelId}</span>
				<button onClick={() => setApiConfigurationField("apiModelId", "buffered-model")}>Edit model</button>
			</div>
		))

		const { rerender } = render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} />
			</QueryClientProvider>,
		)

		await waitFor(() => expect(screen.getByText("Edit model")).toBeInTheDocument())
		fireEvent.click(screen.getByText("Edit model"))
		liveState = {
			...liveState,
			apiConfiguration: { ...liveState.apiConfiguration, apiModelId: "refreshed-model" },
		}
		rerender(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} />
			</QueryClientProvider>,
		)

		await waitFor(() => expect(screen.getByTestId("cached-model")).toHaveTextContent("buffered-model"))
		mockPostMessage.mockClear()
		fireEvent.click(screen.getByTestId("save-button"))

		expect(mockPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "upsertApiConfiguration",
				apiConfiguration: expect.objectContaining({ apiModelId: "buffered-model" }),
			}),
		)
		expect(liveState.apiConfiguration.apiModelId).toBe("refreshed-model")
		const legacySave = mockPostMessage.mock.calls.find(
			([message]) => message.type === "upsertApiConfiguration",
		)?.[0]
		expect(legacySave).not.toHaveProperty("apiConfigurationId")
		expect(legacySave).not.toHaveProperty("requestId")
	})

	it.each(["save", "discard"] as const)(
		"keeps a quick reasoning update separate from Settings %s",
		async (action) => {
			const onDone = vi.fn()
			let liveState = {
				...defaultExtensionState,
				apiConfiguration: { ...defaultExtensionState.apiConfiguration, reasoningEffort: "medium" },
				taskReasoning: {
					taskId: "task-a",
					requested: { kind: "effort", effort: "medium" },
					effective: { kind: "effort", effort: "medium" },
					capabilities: { kind: "effort", efforts: ["low", "medium", "high"], canDisable: true },
				},
			}
			;(useExtensionState as any).mockImplementation(() => liveState)
			vi.mocked(ApiOptions).mockImplementation(({ apiConfiguration, setApiConfigurationField }) => (
				<div data-testid="api-options">
					<span data-testid="cached-reasoning">{apiConfiguration.reasoningEffort}</span>
					<button onClick={() => setApiConfigurationField("reasoningEffort", "low")}>
						Edit default reasoning
					</button>
				</div>
			))
			const view = () => (
				<QueryClientProvider client={queryClient}>
					<SettingsView onDone={onDone} />
				</QueryClientProvider>
			)
			const { rerender } = render(view())
			await waitFor(() => expect(screen.getByText("Edit default reasoning")).toBeInTheDocument())
			fireEvent.click(screen.getByText("Edit default reasoning"))

			liveState = {
				...liveState,
				taskReasoning: {
					...liveState.taskReasoning,
					requested: { kind: "effort", effort: "high" },
					effective: { kind: "effort", effort: "high" },
				},
			}
			rerender(view())
			expect(screen.getByTestId("cached-reasoning")).toHaveTextContent("low")
			mockPostMessage.mockClear()

			if (action === "save") {
				fireEvent.click(screen.getByTestId("save-button"))
				expect(mockPostMessage).toHaveBeenCalledWith(
					expect.objectContaining({
						type: "upsertApiConfiguration",
						apiConfiguration: expect.objectContaining({ reasoningEffort: "low" }),
					}),
				)
			} else {
				fireEvent.click(screen.getByText("settings:common.done"))
				fireEvent.click(screen.getByText("settings:unsavedChangesDialog.discardButton"))
				await waitFor(() => expect(onDone).toHaveBeenCalledOnce())
				expect(screen.getByTestId("cached-reasoning")).toHaveTextContent("medium")
				expect(mockPostMessage).not.toHaveBeenCalledWith(
					expect.objectContaining({ type: "upsertApiConfiguration" }),
				)
			}
			expect(liveState.taskReasoning.requested.effort).toBe("high")
			expect(mockPostMessage).not.toHaveBeenCalledWith(
				expect.objectContaining({ type: "setTaskReasoningPreference" }),
			)
		},
	)

	it("keeps non-provider settings isolated from live extension state until Save", async () => {
		const liveState = { ...defaultExtensionState, soundEnabled: false }
		;(useExtensionState as any).mockReturnValue(liveState)
		vi.mocked(NotificationSettings).mockImplementation(({ soundEnabled, setCachedStateField }) => (
			<div>
				<span data-testid="cached-sound">{String(soundEnabled)}</span>
				<button onClick={() => setCachedStateField("soundEnabled", true)}>Enable sound</button>
			</div>
		))

		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} targetSection="notifications" />
			</QueryClientProvider>,
		)

		await waitFor(() => expect(screen.getByText("Enable sound")).toBeInTheDocument())
		mockPostMessage.mockClear()
		fireEvent.click(screen.getByText("Enable sound"))

		expect(liveState.soundEnabled).toBe(false)
		expect(screen.getByTestId("cached-sound")).toHaveTextContent("true")
		expect(mockPostMessage).not.toHaveBeenCalled()

		fireEvent.click(screen.getByTestId("save-button"))

		expect(mockPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ soundEnabled: true }),
			}),
		)
	})

	it("preserves named agent definitions when saving another buffered setting", async () => {
		const definitions = {
			reviewer: {
				description: "Review changes",
				model: "gpt-6",
				reasoningEffort: "low" as const,
				apiConfigId: "review-profile",
				developerInstructions: "Preserve existing public interfaces.",
			},
		}
		const profileRoutes = { review: "review-profile" }
		const liveState = {
			...defaultExtensionState,
			soundEnabled: false,
			subagentAgentTypes: definitions,
			subagentApiConfigByRole: profileRoutes,
			subagentDefaultApiConfigId: "default-child-profile",
		}
		;(useExtensionState as any).mockReturnValue(liveState)
		vi.mocked(NotificationSettings).mockImplementation(({ soundEnabled, setCachedStateField }) => (
			<button onClick={() => setCachedStateField("soundEnabled", !soundEnabled)}>Change sound</button>
		))
		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} targetSection="notifications" />
			</QueryClientProvider>,
		)
		mockPostMessage.mockClear()
		fireEvent.click(screen.getByText("Change sound"))
		expect(liveState.soundEnabled).toBe(false)
		expect(mockPostMessage).not.toHaveBeenCalled()
		fireEvent.click(screen.getByTestId("save-button"))
		expect(mockPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					soundEnabled: true,
					subagentAgentTypes: definitions,
					subagentApiConfigByRole: profileRoutes,
					subagentDefaultApiConfigId: "default-child-profile",
				}),
			}),
		)
	})

	it("saves post-turn and after-prefix controls from the local edit buffer", async () => {
		const liveState = {
			...defaultExtensionState,
			autoCondenseContext: true,
			autoCondenseContextScope: "full-context" as const,
			postTurnCondenseContextPercent: 0,
		}
		;(useExtensionState as any).mockReturnValue(liveState)
		vi.mocked(ContextManagementSettings).mockImplementation(
			({ autoCondenseContextScope, postTurnCondenseContextPercent, setCachedStateField }) => (
				<div>
					<span data-testid="cached-scope">{autoCondenseContextScope}</span>
					<span data-testid="cached-post-turn">{postTurnCondenseContextPercent}</span>
					<button onClick={() => setCachedStateField("autoCondenseContextScope", "after-prefix")}>
						Change scope
					</button>
					<button onClick={() => setCachedStateField("postTurnCondenseContextPercent", 80)}>
						Change threshold
					</button>
				</div>
			),
		)

		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} targetSection="contextManagement" />
			</QueryClientProvider>,
		)
		mockPostMessage.mockClear()
		fireEvent.click(screen.getByText("Change scope"))
		fireEvent.click(screen.getByText("Change threshold"))
		expect(liveState.autoCondenseContextScope).toBe("full-context")
		expect(liveState.postTurnCondenseContextPercent).toBe(0)
		expect(screen.getByTestId("cached-scope")).toHaveTextContent("after-prefix")
		expect(screen.getByTestId("cached-post-turn")).toHaveTextContent("80")
		expect(mockPostMessage).not.toHaveBeenCalled()

		fireEvent.click(screen.getByTestId("save-button"))
		expect(mockPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					autoCondenseContextScope: "after-prefix",
					postTurnCondenseContextPercent: 80,
				}),
			}),
		)
	})

	it.each([
		{
			field: "mcpEnabled",
			targetSection: "mcp",
			testId: "cached-mcp-enabled",
		},
		{
			field: "showWorktreesInHomeScreen",
			targetSection: "worktrees",
			testId: "cached-worktrees-home",
		},
	] as const)("buffers the embedded $field control until Save", async ({ field, targetSection, testId }) => {
		const liveState = {
			...defaultExtensionState,
			mcpEnabled: false,
			showWorktreesInHomeScreen: false,
		}
		;(useExtensionState as any).mockReturnValue(liveState)

		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} targetSection={targetSection} />
			</QueryClientProvider>,
		)

		await waitFor(() => expect(screen.getByTestId(testId)).toBeInTheDocument())
		mockPostMessage.mockClear()
		fireEvent.click(screen.getByTestId(testId))

		expect(liveState[field]).toBe(false)
		expect(screen.getByTestId(testId)).toHaveAttribute("data-value", "true")
		expect(mockPostMessage).not.toHaveBeenCalled()

		fireEvent.click(screen.getByTestId("save-button"))

		expect(mockPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ [field]: true }),
			}),
		)
	})

	it("buffers the VS Code inherit-environment setting and writes it only on Save", async () => {
		const liveState = { ...defaultExtensionState }
		;(useExtensionState as any).mockReturnValue(liveState)

		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} targetSection="terminal" />
			</QueryClientProvider>,
		)

		await waitFor(() => expect(screen.getByTestId("load-inherit-env")).toBeInTheDocument())
		fireEvent.click(screen.getByTestId("load-inherit-env"))
		await waitFor(() => expect(screen.getByTestId("cached-inherit-env")).toHaveAttribute("data-value", "true"))
		mockPostMessage.mockClear()

		fireEvent.click(screen.getByTestId("cached-inherit-env"))

		expect(liveState).not.toHaveProperty("terminalInheritEnv")
		expect(screen.getByTestId("cached-inherit-env")).toHaveAttribute("data-value", "false")
		expect(mockPostMessage).not.toHaveBeenCalled()

		fireEvent.click(screen.getByTestId("save-button"))

		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "updateVSCodeSetting",
			setting: "terminal.integrated.inheritEnv",
			value: false,
		})

		fireEvent.click(screen.getByTestId("load-inherit-env"))
		expect(screen.getByTestId("cached-inherit-env")).toHaveAttribute("data-value", "false")
	})

	it.each([
		["delete-profile", "deleteApiConfiguration"],
		["create-profile", "upsertApiConfiguration"],
	])("guards %s while settings contain unsaved edits", async (buttonTestId, messageType) => {
		vi.mocked(ApiOptions).mockImplementation(({ setApiConfigurationField }) => (
			<div data-testid="api-options">
				<button
					data-testid="change-model"
					onClick={() => setApiConfigurationField("apiModelId", "edited-model")}>
					Change Model
				</button>
			</div>
		))

		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} />
			</QueryClientProvider>,
		)

		await waitFor(() => expect(screen.getByTestId("change-model")).toBeInTheDocument())
		fireEvent.click(screen.getByTestId("change-model"))
		fireEvent.click(screen.getByTestId(buttonTestId))

		expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: messageType }))
		expect(screen.getByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
	})

	it("should handle initialization from undefined to value without triggering unsaved changes", async () => {
		const onDone = vi.fn()

		// Start with undefined apiModelId
		const stateWithUndefined = {
			...defaultExtensionState,
			apiConfiguration: {
				apiProvider: "openai",
				apiModelId: undefined,
			},
		}
		;(useExtensionState as any).mockReturnValue(stateWithUndefined)

		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={onDone} />
			</QueryClientProvider>,
		)

		// Wait for initialization
		await waitFor(() => {
			expect(screen.getByTestId("api-options")).toBeInTheDocument()
		})

		// Wait for save button to be disabled (no changes)
		await waitFor(() => {
			const saveButton = screen.getByTestId("save-button") as HTMLButtonElement
			expect(saveButton.disabled).toBe(true)
		})

		// Click Done button
		const doneButton = screen.getByText("settings:common.done")
		fireEvent.click(doneButton)

		// Should call onDone immediately without showing dialog
		await waitFor(() => {
			expect(onDone).toHaveBeenCalled()
		})

		// Verify no dialog appeared
		expect(screen.queryByText("settings:unsavedChangesDialog.title")).not.toBeInTheDocument()
	})

	it("should handle initialization from null to value without triggering unsaved changes", async () => {
		const onDone = vi.fn()

		// Start with null apiModelId
		const stateWithNull = {
			...defaultExtensionState,
			apiConfiguration: {
				apiProvider: "openai",
				apiModelId: null,
			},
		}
		;(useExtensionState as any).mockReturnValue(stateWithNull)

		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={onDone} />
			</QueryClientProvider>,
		)

		// Wait for initialization
		await waitFor(() => {
			expect(screen.getByTestId("api-options")).toBeInTheDocument()
		})

		// Wait for save button to be disabled (no changes)
		await waitFor(() => {
			const saveButton = screen.getByTestId("save-button") as HTMLButtonElement
			expect(saveButton.disabled).toBe(true)
		})

		// Click Done button
		const doneButton = screen.getByText("settings:common.done")
		fireEvent.click(doneButton)

		// Should call onDone immediately without showing dialog
		await waitFor(() => {
			expect(onDone).toHaveBeenCalled()
		})

		// Verify no dialog appeared
		expect(screen.queryByText("settings:unsavedChangesDialog.title")).not.toBeInTheDocument()
	})

	it("should not trigger changes when ApiOptions syncs model IDs during mount", async () => {
		const onDone = vi.fn()

		// This specifically tests the bug we fixed where ApiOptions' useEffect
		// was syncing selectedModelId with apiModelId and incorrectly triggering
		// change detection because it wasn't passing isUserAction=false

		// Mock ApiOptions to simulate the actual sync behavior
		vi.mocked(ApiOptions).mockImplementation(({ setApiConfigurationField, apiConfiguration }) => {
			const [hasSynced, setHasSynced] = React.useState(false)

			React.useEffect(() => {
				// Simulate the automatic sync that happens in the real component
				// This should NOT trigger unsaved changes because isUserAction=false
				// Only sync once to avoid multiple calls
				if (!hasSynced && apiConfiguration?.apiModelId === "") {
					setApiConfigurationField("apiModelId", "synced-model", false)
					setHasSynced(true)
				}
			}, [hasSynced, apiConfiguration?.apiModelId, setApiConfigurationField])

			return (
				<div data-testid="api-options" data-synced={hasSynced}>
					ApiOptions
				</div>
			)
		})

		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={onDone} />
			</QueryClientProvider>,
		)

		// Wait for component to fully mount and ApiOptions effect to run
		await waitFor(() => {
			expect(screen.getByTestId("api-options")).toBeInTheDocument()
		})

		await waitFor(() => expect(screen.getByTestId("api-options")).toHaveAttribute("data-synced", "true"))

		// Save button should still be disabled (no user changes)
		const saveButton = screen.getByTestId("save-button") as HTMLButtonElement
		expect(saveButton.disabled).toBe(true)

		// Clicking done should not show dialog
		const doneButton = screen.getByText("settings:common.done")
		fireEvent.click(doneButton)

		// Should call onDone directly without showing unsaved changes dialog
		await waitFor(() => {
			expect(onDone).toHaveBeenCalled()
		})

		// No dialog should appear
		expect(screen.queryByText("settings:unsavedChangesDialog.title")).not.toBeInTheDocument()
	})
})
