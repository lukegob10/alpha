import { render, screen, fireEvent, waitFor, act } from "@/utils/test-utils"
import { vi, describe, it, expect, beforeEach } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import React from "react"

const mockPostMessage = vi.hoisted(() => vi.fn())

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: mockPostMessage },
}))

// Import the actual component
import SettingsView from "../SettingsView"
import { NotificationSettings } from "../NotificationSettings"
import { useExtensionState } from "@src/context/ExtensionStateContext"

// Mock the extension state context
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(),
}))

// Mock the translation context
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
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
	AlertDialog: ({ open, children }: any) => (open ? <div data-testid="alert-dialog">{children}</div> : null),
	AlertDialogContent: ({ children }: any) => <div>{children}</div>,
	AlertDialogTitle: ({ children }: any) => <div data-testid="alert-title">{children}</div>,
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
	StandardTooltip: ({ children }: any) => <>{children}</>,
	Popover: ({ children }: any) => <>{children}</>,
	PopoverTrigger: ({ children }: any) => <>{children}</>,
	PopoverContent: ({ children }: any) => <div>{children}</div>,
	Tooltip: ({ children }: any) => <>{children}</>,
	TooltipProvider: ({ children }: any) => <>{children}</>,
	TooltipTrigger: ({ children }: any) => <>{children}</>,
	TooltipContent: ({ children }: any) => <div>{children}</div>,
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

vi.mock("@src/components/mcp/McpView", () => ({
	default: () => null,
}))

// Mock Tab components
vi.mock("../../common/Tab", async () => ({
	...(await vi.importActual<typeof import("../../common/Tab")>("../../common/Tab")),
	Tab: ({ children }: any) => <div>{children}</div>,
	TabContent: React.forwardRef<HTMLDivElement, any>(({ children }, ref) => <div ref={ref}>{children}</div>),
	TabHeader: ({ children }: any) => <div>{children}</div>,
}))

// Mock all child components to isolate the test
vi.mock("../ApiConfigManager", () => ({
	default: () => null,
}))

vi.mock("../ApiOptions", () => ({
	default: () => null,
}))

vi.mock("../AutoApproveSettings", () => ({
	AutoApproveSettings: ({
		followupAutoApproveTimeoutMs,
		setCachedStateField,
	}: {
		followupAutoApproveTimeoutMs?: number
		setCachedStateField: (field: "followupAutoApproveTimeoutMs", value: number) => void
	}) => (
		<button
			data-testid="wait-for-question-answers"
			data-timeout={followupAutoApproveTimeoutMs}
			onClick={() => setCachedStateField("followupAutoApproveTimeoutMs", 0)}>
			Wait indefinitely for answers
		</button>
	),
}))

vi.mock("../SectionHeader", () => ({
	SectionHeader: ({ children }: any) => <div>{children}</div>,
}))

// Mock all settings components
vi.mock("../CheckpointSettings", () => ({
	CheckpointSettings: () => null,
}))
vi.mock("../NotificationSettings", () => ({
	NotificationSettings: vi.fn(() => null),
}))
vi.mock("../ContextManagementSettings", () => ({
	ContextManagementSettings: () => null,
}))
vi.mock("../About", () => ({
	About: () => null,
}))
vi.mock("../UISettings", () => ({
	UISettings: ({
		autoSteer,
		setCachedStateField,
	}: {
		autoSteer: boolean
		setCachedStateField: (key: string, value: boolean) => void
	}) => (
		<label>
			<input
				type="checkbox"
				data-testid="auto-steer-checkbox"
				data-value={String(autoSteer)}
				checked={autoSteer}
				onChange={(event) => setCachedStateField("autoSteer", event.target.checked)}
			/>
			Auto-steer
		</label>
	),
}))

vi.mock("../SettingsSearch", () => ({
	SettingsSearch: () => null,
}))

describe("SettingsView - Change Detection Fix", () => {
	let queryClient: QueryClient

	const createExtensionState = (overrides = {}) => ({
		currentApiConfigName: "default",
		listApiConfigMeta: [],
		uriScheme: "vscode",
		settingsImportedAt: undefined,
		apiConfiguration: {
			apiProvider: "openai" as const,
			apiModelId: "", // Empty string initially
		},
		alwaysAllowReadOnly: false,
		alwaysAllowReadOnlyOutsideWorkspace: false,
		allowedCommands: [],
		deniedCommands: [],
		allowedMaxRequests: undefined,
		allowedMaxCost: undefined,
		language: "en" as const,
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
		soundVolume: 0.5,
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
		showAlphaIgnoredFiles: false,
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
		openRouterImageApiKey: undefined,
		openRouterImageGenerationSelectedModel: undefined,
		reasoningBlockCollapsed: true,
		autoSteer: undefined,
		...overrides,
	})

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(NotificationSettings).mockImplementation(() => <></>)
		queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		})
	})

	it("buffers indefinite question waiting across live refreshes and saves only on Settings Save", async () => {
		const liveState = createExtensionState({ didHydrateState: true, followupAutoApproveTimeoutMs: 60_000 })
		;(useExtensionState as any).mockReturnValue(liveState)
		const view = (
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} targetSection="autoApprove" />
			</QueryClientProvider>
		)
		const { rerender } = render(view)
		await waitFor(() =>
			expect(screen.getByTestId("wait-for-question-answers")).toHaveAttribute("data-timeout", "60000"),
		)
		mockPostMessage.mockClear()
		fireEvent.click(screen.getByTestId("wait-for-question-answers"))
		expect(screen.getByTestId("wait-for-question-answers")).toHaveAttribute("data-timeout", "0")
		expect(screen.getByTestId("save-button")).toBeEnabled()
		expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
		;(useExtensionState as any).mockReturnValue({ ...liveState, followupAutoApproveTimeoutMs: 120_000 })
		rerender(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} targetSection="autoApprove" />
			</QueryClientProvider>,
		)
		expect(screen.getByTestId("wait-for-question-answers")).toHaveAttribute("data-timeout", "0")
		fireEvent.click(screen.getByTestId("save-button"))
		expect(mockPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ followupAutoApproveTimeoutMs: 0 }),
			}),
		)
	})

	it("does not resave a retired preference supplied by stale state", async () => {
		;(useExtensionState as any).mockReturnValue({
			...createExtensionState({ didHydrateState: true, autoSteer: false }),
			personality: "none",
		})
		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} targetSection="ui" />
			</QueryClientProvider>,
		)
		await waitFor(() => expect(screen.getByTestId("auto-steer-checkbox")).not.toBeChecked())
		mockPostMessage.mockClear()
		fireEvent.click(screen.getByTestId("auto-steer-checkbox"))
		fireEvent.click(screen.getByTestId("save-button"))
		const save = mockPostMessage.mock.calls.find(([message]) => message.type === "updateSettings")?.[0]
		expect(save?.updatedSettings).toMatchObject({ autoSteer: true })
		expect(save?.updatedSettings).not.toHaveProperty("personality")
	})

	it("defaults to queuing and preserves unsaved steering edits across live state refreshes", async () => {
		const liveState = createExtensionState({ didHydrateState: true, autoSteer: undefined })
		;(useExtensionState as any).mockReturnValue(liveState)
		const view = () => (
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} targetSection="ui" />
			</QueryClientProvider>
		)
		const { rerender } = render(view())
		await waitFor(() => expect(screen.getByTestId("auto-steer-checkbox")).toHaveAttribute("data-value", "false"))
		mockPostMessage.mockClear()
		fireEvent.click(screen.getByTestId("auto-steer-checkbox"))
		expect(screen.getByTestId("auto-steer-checkbox")).toBeChecked()
		expect(mockPostMessage).not.toHaveBeenCalled()
		expect(liveState.autoSteer).toBeUndefined()
		;(useExtensionState as any).mockReturnValue({ ...liveState, autoSteer: false })
		rerender(view())
		expect(screen.getByTestId("auto-steer-checkbox")).toBeChecked()
		expect(screen.getByTestId("save-button")).toBeEnabled()
		fireEvent.click(screen.getByTestId("save-button"))
		expect(mockPostMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ autoSteer: true }),
			}),
		)
	})

	it("discards unsaved automatic steering edits without persisting them", async () => {
		const onDone = vi.fn()
		;(useExtensionState as any).mockReturnValue(createExtensionState({ didHydrateState: true, autoSteer: false }))
		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={onDone} targetSection="ui" />
			</QueryClientProvider>,
		)
		await waitFor(() => expect(screen.getByTestId("auto-steer-checkbox")).toHaveAttribute("data-value", "false"))
		mockPostMessage.mockClear()
		fireEvent.click(screen.getByTestId("auto-steer-checkbox"))
		fireEvent.click(screen.getByText("settings:common.done"))
		expect(onDone).not.toHaveBeenCalled()
		fireEvent.click(screen.getByText("settings:unsavedChangesDialog.discardButton"))
		expect(screen.getByTestId("auto-steer-checkbox")).not.toBeChecked()
		expect(screen.getByTestId("save-button")).toBeDisabled()
		expect(mockPostMessage).not.toHaveBeenCalled()
		expect(onDone).toHaveBeenCalledOnce()
	})

	it("resyncs automatic steering when settings are imported", async () => {
		const liveState = createExtensionState({ didHydrateState: true, autoSteer: false })
		;(useExtensionState as any).mockReturnValue(liveState)
		const view = () => (
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} targetSection="ui" />
			</QueryClientProvider>
		)
		const { rerender } = render(view())
		await waitFor(() => expect(screen.getByTestId("auto-steer-checkbox")).toHaveAttribute("data-value", "false"))
		;(useExtensionState as any).mockReturnValue({ ...liveState, autoSteer: true, settingsImportedAt: 1 })
		rerender(view())
		await waitFor(() => expect(screen.getByTestId("auto-steer-checkbox")).toBeChecked())
		expect(screen.getByTestId("save-button")).toBeDisabled()
	})

	it("should not show unsaved changes when no changes are made", async () => {
		const onDone = vi.fn()
		;(useExtensionState as any).mockReturnValue(createExtensionState())

		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={onDone} />
			</QueryClientProvider>,
		)

		// Wait for initial render
		await waitFor(() => {
			expect(screen.getByTestId("save-button")).toBeInTheDocument()
		})

		// Check that save button is disabled (no changes)
		const saveButton = screen.getByTestId("save-button") as HTMLButtonElement
		expect(saveButton.disabled).toBe(true)

		// Click Done button
		const doneButton = screen.getByText("settings:common.done")
		fireEvent.click(doneButton)

		// Should not show dialog
		expect(screen.queryByTestId("alert-dialog")).not.toBeInTheDocument()

		// onDone should be called
		expect(onDone).toHaveBeenCalled()
	})

	it("saves unrelated preferences without overwriting stored prompt customizations", async () => {
		const promptSettings = {
			customModePrompts: {
				code: { roleDefinition: "Existing Code role", customInstructions: "Existing Code instructions" },
				architect: { description: "Existing Plan description" },
				debug: { roleDefinition: "Preserved legacy role" },
			},
			customInstructions: "Existing global instructions",
		}
		const liveState = createExtensionState({ didHydrateState: true, autoSteer: false, ...promptSettings })
		;(useExtensionState as any).mockReturnValue(liveState)

		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} targetSection="ui" />
			</QueryClientProvider>,
		)

		await waitFor(() => expect(screen.getByTestId("auto-steer-checkbox")).not.toBeChecked())
		mockPostMessage.mockClear()
		fireEvent.click(screen.getByTestId("auto-steer-checkbox"))

		expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "mode" }))
		expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
		expect(screen.getByTestId("save-button")).toBeEnabled()

		fireEvent.click(screen.getByTestId("save-button"))

		const updateSettings = mockPostMessage.mock.calls
			.map(([message]) => message)
			.find((message) => message.type === "updateSettings")
		expect(updateSettings.updatedSettings).toMatchObject({ autoSteer: true })
		expect(updateSettings.updatedSettings).not.toHaveProperty("customModePrompts")
		expect(updateSettings.updatedSettings).not.toHaveProperty("customInstructions")
		expect(liveState).toMatchObject(promptSettings)
	})

	it("preserves saved confirmation limits when an unrelated preference is saved", () => {
		const savedLimits = { allowedMaxRequests: 12, allowedMaxCost: 2.5 }
		const liveState = {
			...createExtensionState({ didHydrateState: true, autoSteer: false }),
			...savedLimits,
		}
		vi.mocked(useExtensionState, { partial: true }).mockReturnValue(liveState)
		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} targetSection="preferences" />
			</QueryClientProvider>,
		)
		expect(screen.getByTestId("save-button")).toBeDisabled()
		mockPostMessage.mockClear()
		fireEvent.click(screen.getByTestId("auto-steer-checkbox"))
		fireEvent.click(screen.getByTestId("save-button"))
		const updates = mockPostMessage.mock.calls.filter(([message]) => message.type === "updateSettings")
		expect(updates).toHaveLength(1)
		const update = updates[0][0]
		expect(update.updatedSettings).toEqual({ autoSteer: true })
		expect(update.settingsSave.expectedSettings).toEqual({ autoSteer: false })
		for (const key of Object.keys(savedLimits)) {
			expect(update.updatedSettings).not.toHaveProperty(key)
			expect(update.settingsSave.expectedSettings).not.toHaveProperty(key)
		}
		expect(liveState).toMatchObject(savedLimits)
		expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "upsertApiConfiguration" }))
	})

	it("saves only an edited preference after permissions change in another view", () => {
		const liveState = {
			...createExtensionState({ didHydrateState: true, autoSteer: false }),
			approvalMode: "auto" as const,
			allowedCommands: ["git status", "workspace-only-command"],
			commandRuleSettings: {
				allowedCommands: ["git status"],
				deniedCommands: [],
				inherited: [
					{ source: "workspace" as const, allowedCommands: ["workspace-only-command"], deniedCommands: [] },
				],
			},
		}
		vi.mocked(useExtensionState, { partial: true }).mockImplementation(() => liveState)
		const view = () => (
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} targetSection="preferences" />
			</QueryClientProvider>
		)
		const { rerender } = render(view())
		fireEvent.click(screen.getByTestId("auto-steer-checkbox"))
		const refreshedState = { ...liveState, approvalMode: "ask" as const, allowedCommands: ["new-global-command"] }
		vi.mocked(useExtensionState, { partial: true }).mockReturnValue(refreshedState)
		rerender(view())
		mockPostMessage.mockClear()
		fireEvent.click(screen.getByTestId("save-button"))
		const update = mockPostMessage.mock.calls.find(([message]) => message.type === "updateSettings")?.[0]
		expect(update).toMatchObject({
			updatedSettings: { autoSteer: true },
			settingsSave: { requestId: expect.any(String), expectedSettings: { autoSteer: false } },
		})
		expect(update.updatedSettings).toEqual({ autoSteer: true })
		expect(update.settingsSave.expectedSettings).toEqual({ autoSteer: false })
		expect(mockPostMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "upsertApiConfiguration" }))
		expect(refreshedState.approvalMode).toBe("ask")
	})

	it("retains a conflicting preferences draft until it is explicitly discarded", () => {
		const onDone = vi.fn()
		vi.mocked(useExtensionState, { partial: true }).mockReturnValue(
			createExtensionState({ didHydrateState: true, autoSteer: false }),
		)
		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={onDone} targetSection="preferences" />
			</QueryClientProvider>,
		)
		fireEvent.click(screen.getByTestId("auto-steer-checkbox"))
		fireEvent.click(screen.getByTestId("save-button"))
		const update = mockPostMessage.mock.calls.find(([message]) => message.type === "updateSettings")?.[0]
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "settingsSaved",
						settingsSaveResult: {
							requestId: update.settingsSave.requestId,
							status: "error",
							error: "conflict",
							conflictingKeys: ["autoSteer"],
						},
					},
				}),
			)
		})
		expect(screen.getByTestId("auto-steer-checkbox")).toBeChecked()
		expect(screen.getByTestId("save-button")).toBeEnabled()
		expect(screen.getByRole("alert")).toHaveTextContent("settings:common.saveErrors.conflict")
		fireEvent.click(screen.getByText("settings:common.done"))
		expect(onDone).not.toHaveBeenCalled()
		fireEvent.click(screen.getByText("settings:unsavedChangesDialog.discardButton"))
		expect(onDone).toHaveBeenCalledOnce()
		expect(screen.getByTestId("auto-steer-checkbox")).not.toBeChecked()
	})

	it("clears a preferences-only save only after its matching global acknowledgement", () => {
		const onDone = vi.fn()
		vi.mocked(useExtensionState, { partial: true }).mockReturnValue(
			createExtensionState({ didHydrateState: true, autoSteer: false }),
		)
		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={onDone} targetSection="preferences" />
			</QueryClientProvider>,
		)
		fireEvent.click(screen.getByTestId("auto-steer-checkbox"))
		fireEvent.click(screen.getByTestId("save-button"))
		const update = mockPostMessage.mock.calls.find(([message]) => message.type === "updateSettings")?.[0]
		const acknowledge = (requestId: string) =>
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "settingsSaved", settingsSaveResult: { requestId, status: "success" } },
					}),
				)
			})
		acknowledge("another-settings-view")
		fireEvent.click(screen.getByText("settings:common.done"))
		expect(onDone).not.toHaveBeenCalled()
		fireEvent.click(screen.getByText("settings:unsavedChangesDialog.cancelButton"))
		acknowledge(update.settingsSave.requestId)
		fireEvent.click(screen.getByText("settings:common.done"))
		expect(onDone).toHaveBeenCalledOnce()
	})

	it("uses the committed partial-save baseline when the user reverts a failed preferences draft", () => {
		vi.mocked(useExtensionState, { partial: true }).mockReturnValue(
			createExtensionState({ didHydrateState: true, autoSteer: false }),
		)
		vi.mocked(NotificationSettings).mockImplementation(({ soundEnabled, setCachedStateField }) => (
			<button data-testid="sound-toggle" onClick={() => setCachedStateField("soundEnabled", !soundEnabled)}>
				Toggle sound
			</button>
		))
		render(
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={vi.fn()} targetSection="preferences" />
			</QueryClientProvider>,
		)
		fireEvent.click(screen.getByTestId("auto-steer-checkbox"))
		fireEvent.click(screen.getByTestId("sound-toggle"))
		fireEvent.click(screen.getByTestId("save-button"))
		const request = mockPostMessage.mock.calls.find(([message]) => message.type === "updateSettings")?.[0]
		expect(request.updatedSettings).toEqual({ autoSteer: true, soundEnabled: true })
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "settingsSaved",
						settingsSaveResult: {
							requestId: request.settingsSave.requestId,
							status: "error",
							error: "saveFailed",
							appliedKeys: ["soundEnabled"],
						},
					},
				}),
			)
		})
		expect(screen.getByTestId("save-button")).toBeEnabled()
		fireEvent.click(screen.getByTestId("auto-steer-checkbox"))
		fireEvent.click(screen.getByTestId("sound-toggle"))
		mockPostMessage.mockClear()
		fireEvent.click(screen.getByTestId("save-button"))
		const retry = mockPostMessage.mock.calls.find(([message]) => message.type === "updateSettings")?.[0]
		expect(retry.updatedSettings).toEqual({ soundEnabled: false })
		expect(retry.settingsSave.expectedSettings).toEqual({ soundEnabled: true })
	})
})
