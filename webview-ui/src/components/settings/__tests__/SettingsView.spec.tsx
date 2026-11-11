// pnpm --filter @alpha-code/vscode-webview test src/components/settings/__tests__/SettingsView.spec.tsx

import { render, screen, fireEvent, within, act } from "@/utils/test-utils"
import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { getProviderDefaultModelId, settingsForApprovalMode } from "@alpha-code/types"

import { vscode } from "@/utils/vscode"
import { ExtensionStateContextProvider } from "@/context/ExtensionStateContext"

import SettingsView, { sectionNames } from "../SettingsView"

vi.mock("@/i18n/TranslationContext", async () => {
	const { default: i18n } = await import("@/i18n/setup")
	return { useAppTranslation: () => ({ t: (key: string) => key, i18n }) }
})

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("../ApiConfigManager", () => ({
	__esModule: true,
	default: ({ currentApiConfigName }: any) => (
		<div data-testid="api-config-management">
			<span>Current config: {currentApiConfigName}</span>
		</div>
	),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, onClick, appearance, "data-testid": dataTestId }: any) =>
		appearance === "icon" ? (
			<button
				onClick={onClick}
				className="codicon codicon-close"
				aria-label="Remove command"
				data-testid={dataTestId}>
				<span className="codicon codicon-close" />
			</button>
		) : (
			<button onClick={onClick} data-appearance={appearance} data-testid={dataTestId}>
				{children}
			</button>
		),
	VSCodeCheckbox: ({ children, onChange, checked, "data-testid": dataTestId }: any) => (
		<label>
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange({ target: { checked: e.target.checked } })}
				aria-label={typeof children === "string" ? children : undefined}
				data-testid={dataTestId}
			/>
			{children}
		</label>
	),
	VSCodeTextField: ({ value, onInput, placeholder, "data-testid": dataTestId }: any) => (
		<input
			type="text"
			value={value}
			onChange={(e) => onInput({ target: { value: e.target.value } })}
			placeholder={placeholder}
			data-testid={dataTestId}
		/>
	),
	VSCodeDropdown: ({ children, value, onChange, id, "aria-label": ariaLabel }: any) => (
		<select id={id} aria-label={ariaLabel} value={value} onChange={onChange}>
			{children}
		</select>
	),
	VSCodeOption: ({ children, value }: any) => <option value={value}>{children}</option>,
	VSCodeLink: ({ children, href }: any) => <a href={href || "#"}>{children}</a>,
	VSCodeRadio: ({ value, checked, onChange }: any) => (
		<input type="radio" value={value} checked={checked} onChange={onChange} />
	),
	VSCodeRadioGroup: ({ children, onChange }: any) => <div onChange={onChange}>{children}</div>,
	VSCodeTextArea: ({ value, onChange, rows, className, "data-testid": dataTestId }: any) => (
		<textarea
			value={value}
			onChange={onChange}
			rows={rows}
			className={className}
			data-testid={dataTestId}
			role="textbox"
		/>
	),
}))

vi.mock("../../common/Tab", async () => ({
	...(await vi.importActual<typeof import("../../common/Tab")>("../../common/Tab")),
	Tab: ({ children }: any) => <div data-testid="tab-container">{children}</div>,
	TabHeader: ({ children }: any) => <div data-testid="tab-header">{children}</div>,
	TabContent: React.forwardRef<HTMLDivElement, any>(({ children, "data-testid": dataTestId }, ref) => (
		<div ref={ref} data-testid={dataTestId || "tab-content"}>
			{children}
		</div>
	)),
}))

vi.mock("@/components/ui", () => ({
	...vi.importActual("@/components/ui"),
	ToggleSwitch: ({ checked, onChange, "aria-label": ariaLabel, "data-testid": dataTestId }: any) => (
		<button role="switch" aria-checked={checked} aria-label={ariaLabel} data-testid={dataTestId} onClick={onChange}>
			Toggle
		</button>
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
	Popover: ({ children }: any) => <div data-testid="popover">{children}</div>,
	PopoverTrigger: ({ children }: any) => <div data-testid="popover-trigger">{children}</div>,
	PopoverContent: ({ children }: any) => <div data-testid="popover-content">{children}</div>,
	Command: ({ children }: any) => <div data-testid="command">{children}</div>,
	CommandInput: ({ value, onValueChange }: any) => (
		<input data-testid="command-input" value={value} onChange={(e) => onValueChange(e.target.value)} />
	),
	CommandGroup: ({ children }: any) => <div data-testid="command-group">{children}</div>,
	CommandItem: ({ children, onSelect }: any) => (
		<div data-testid="command-item" onClick={onSelect}>
			{children}
		</div>
	),
	CommandList: ({ children }: any) => <div data-testid="command-list">{children}</div>,
	CommandEmpty: ({ children }: any) => <div data-testid="command-empty">{children}</div>,
	Slider: ({ value, onValueChange, min, max, step, "data-testid": dataTestId }: any) => (
		<input
			type="range"
			min={min}
			max={max}
			step={step}
			value={value?.[0] ?? 0}
			onChange={(e) => onValueChange?.([parseFloat(e.target.value)])}
			data-testid={dataTestId}
		/>
	),
	Button: ({
		children,
		onClick,
		variant,
		className,
		"data-testid": dataTestId,
		"aria-pressed": pressed,
		disabled,
	}: any) => (
		<button
			onClick={onClick}
			data-variant={variant}
			className={className}
			data-testid={dataTestId}
			aria-pressed={pressed}
			disabled={disabled}>
			{children}
		</button>
	),
	StandardTooltip: ({ children, content }: any) => <div title={content}>{children}</div>,
	Input: ({ value, onChange, placeholder, "data-testid": dataTestId, ...props }: any) => (
		<input value={value} onChange={onChange} placeholder={placeholder} data-testid={dataTestId} {...props} />
	),
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
	SearchableSelect: ({
		value,
		onValueChange,
		options,
		placeholder,
		"aria-label": ariaLabel,
		"data-testid": testId,
	}: any) => (
		<select
			value={value}
			onChange={(e) => onValueChange(e.target.value)}
			aria-label={ariaLabel}
			data-testid={testId ?? "searchable-select"}>
			{placeholder && <option value="">{placeholder}</option>}
			{options?.map((opt: any) => (
				<option key={opt.value} value={opt.value}>
					{opt.label}
				</option>
			))}
		</select>
	),
	AlertDialog: ({ children, open }: any) => (open ? <div data-testid="alert-dialog">{children}</div> : null),
	AlertDialogContent: ({ children }: any) => <div data-testid="alert-dialog-content">{children}</div>,
	AlertDialogHeader: ({ children }: any) => <div data-testid="alert-dialog-header">{children}</div>,
	AlertDialogTitle: ({ children }: any) => <div data-testid="alert-dialog-title">{children}</div>,
	AlertDialogDescription: ({ children }: any) => <div data-testid="alert-dialog-description">{children}</div>,
	AlertDialogFooter: ({ children }: any) => <div data-testid="alert-dialog-footer">{children}</div>,
	AlertDialogAction: ({ children, onClick }: any) => (
		<button data-testid="alert-dialog-action" onClick={onClick}>
			{children}
		</button>
	),
	AlertDialogCancel: ({ children, onClick }: any) => (
		<button data-testid="alert-dialog-cancel" onClick={onClick}>
			{children}
		</button>
	),
	// Add Collapsible components
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

// Mock window.postMessage to trigger state hydration
const mockPostMessage = (state: any) => {
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "state",
					state: {
						version: "1.0.0",
						alphaMessages: [],
						taskHistory: [],
						shouldShowAnnouncement: false,
						apiConfiguration: {
							apiProvider: "anthropic",
							apiModelId: getProviderDefaultModelId("anthropic"),
							apiKey: "test-key",
						},
						...settingsForApprovalMode("ask"),
						allowedCommands: [],
						soundEnabled: false,
						soundVolume: 0.5,
						...state,
					},
				},
			}),
		)
	})
}

const renderSettingsView = (targetSection?: string, initialState: Record<string, unknown> = {}) => {
	const onDone = vi.fn()
	const queryClient = new QueryClient()

	const result = render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
				<SettingsView onDone={onDone} targetSection={targetSection} />
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)

	// Hydrate initial state.
	mockPostMessage(initialState)

	// Retained links select the control's current page without replacing the edit buffer.
	const revealSection = (sectionId: string) => {
		result.rerender(
			<ExtensionStateContextProvider>
				<QueryClientProvider client={queryClient}>
					<SettingsView onDone={onDone} targetSection={sectionId} />
				</QueryClientProvider>
			</ExtensionStateContextProvider>,
		)
	}

	const getSettingsContent = () => screen.getByRole("tabpanel")

	return { onDone, revealSection, getSettingsContent, unmount: result.unmount }
}

function getSectionElement(section: string): HTMLElement {
	const element = document.querySelector<HTMLElement>(`[data-settings-section="${section}"]`)
	if (!element) throw new Error(`Missing settings section: ${section}`)
	return element
}

function getPermissionsContent(): HTMLElement {
	const group = getSectionElement("preferences").querySelector<HTMLElement>('[data-settings-group="permissions"]')
	if (!group) throw new Error("Missing Permissions group in Preferences")
	const summary = within(group).getByText("settings:autoApprove.advanced", { selector: "summary" })
	if (!summary.closest<HTMLDetailsElement>("details")?.open) fireEvent.click(summary)
	expect(group).toBeVisible()
	expect(summary.closest("details")).toHaveAttribute("open")
	return group
}

const acknowledgeSettingsSave = () => {
	const request = vi
		.mocked(vscode.postMessage)
		.mock.calls.findLast(([message]) => message.type === "updateSettings")?.[0]
	expect(request?.settingsSave?.requestId).toEqual(expect.any(String))
	if (!request?.settingsSave) throw new Error("Expected a correlated settings save")
	const requestId = request.settingsSave.requestId
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "settingsSaved",
					settingsSaveResult: { requestId, status: "success" },
				},
			}),
		)
	})
}

describe("SettingsView - Startup rendering", () => {
	beforeEach(() => vi.clearAllMocks())

	it.each(["modes", "prompts"])("ignores a retired %s link without restoring a settings category", (section) => {
		const { getSettingsContent } = renderSettingsView(section)

		expect(sectionNames).not.toContain(section)
		expect(screen.queryByTestId(`tab-${section}`)).not.toBeInTheDocument()
		expect(document.querySelector(`[data-settings-section="${section}"]`)).not.toBeInTheDocument()
		expect(screen.getByTestId("tab-providers")).toHaveAttribute("aria-selected", "true")
		expect(within(getSettingsContent()).getByTestId("api-config-management")).toBeInTheDocument()
	})

	it("keeps four settings pages and opens legacy Agents links in Tools & agents", () => {
		const { getSettingsContent } = renderSettingsView("agents")
		expect(sectionNames).toEqual(["providers", "tools", "preferences", "advanced"])
		expect(getSettingsContent()).toHaveTextContent("agents:title")
		expect(within(getSettingsContent()).getByLabelText("agents:concurrency.label")).toBeInTheDocument()
		expect(screen.getByTestId("tab-tools")).toHaveAttribute("aria-selected", "true")
		expect(document.querySelectorAll("[data-settings-section]")).toHaveLength(4)
		for (const retired of [
			"permissions",
			"agents",
			"skills",
			"mcp",
			"notifications",
			"terminal",
			"worktrees",
			"language",
			"about",
		]) {
			expect(screen.queryByTestId(`tab-${retired}`)).not.toBeInTheDocument()
		}
	})

	it("makes settings searchable without loading unvisited resource managers", async () => {
		vi.useFakeTimers()
		const { unmount } = renderSettingsView("preferences")
		try {
			let indexingFrames = 0
			while (!screen.queryByTestId("settings-search-input") && indexingFrames <= sectionNames.length) {
				await act(async () => vi.advanceTimersToNextFrame())
				indexingFrames++
			}
			const resourceRequests = vi
				.mocked(vscode.postMessage)
				.mock.calls.map(([message]) => message.type)
				.filter((type) =>
					["requestCommands", "requestSkills", "listWorktrees", "getWorktreeIncludeStatus"].includes(type),
				)
			expect(resourceRequests).toEqual([])
			expect(indexingFrames).toBeLessThan(sectionNames.length)
			expect(screen.getByTestId("settings-search-input")).toBeInTheDocument()
		} finally {
			unmount()
			vi.clearAllTimers()
			vi.useRealTimers()
		}
	})

	it("finds page titles and loads resource managers only after selection", async () => {
		vi.useFakeTimers()
		const { unmount } = renderSettingsView("preferences")
		try {
			for (let frame = 0; frame < sectionNames.length + 1; frame++) {
				await act(async () => vi.advanceTimersToNextFrame())
			}
			const search = screen.getByTestId("settings-search-input")
			fireEvent.focus(search)
			for (const section of ["providers", "tools"]) {
				fireEvent.change(search, { target: { value: `settings:sections.${section}` } })
				expect(screen.getByRole("option", { name: `settings:sections.${section}` })).toBeInTheDocument()
			}
			fireEvent.change(search, { target: { value: "settings:sections.slashCommands" } })
			expect(screen.queryByRole("option", { name: "settings:sections.slashCommands" })).not.toBeInTheDocument()
			fireEvent.change(search, { target: { value: "settings:sections.modes" } })
			expect(screen.queryByRole("option", { name: "settings:sections.modes" })).not.toBeInTheDocument()
			fireEvent.change(search, { target: { value: "settings:sections.prompts" } })
			expect(screen.queryByRole("option", { name: "settings:sections.prompts" })).not.toBeInTheDocument()

			vi.mocked(vscode.postMessage).mockClear()
			fireEvent.change(search, { target: { value: "settings:sections.tools" } })
			fireEvent.click(screen.getByRole("option", { name: "settings:sections.tools" }))
			expect(vscode.postMessage).toHaveBeenCalledWith({ type: "requestSkills" })
			expect(vscode.postMessage).not.toHaveBeenCalledWith({ type: "listWorktrees" })
		} finally {
			unmount()
			vi.clearAllTimers()
			vi.useRealTimers()
		}
	})

	it("indexes enabled custom tools without refreshing them until Tools & agents is opened", async () => {
		vi.useFakeTimers()
		const { unmount } = renderSettingsView("preferences", { experiments: { customTools: true } })
		const refreshRequests = () =>
			vi.mocked(vscode.postMessage).mock.calls.filter(([message]) => message.type === "refreshCustomTools")
		try {
			for (let frame = 0; frame < sectionNames.length + 1; frame++) {
				await act(async () => vi.advanceTimersToNextFrame())
			}
			expect(refreshRequests()).toHaveLength(0)

			const search = screen.getByTestId("settings-search-input")
			fireEvent.focus(search)
			fireEvent.change(search, { target: { value: "settings:customTools.name" } })
			fireEvent.click(screen.getByRole("option", { name: "settings:customTools.name" }))
			await act(async () => vi.advanceTimersByTime(150))
			expect(refreshRequests()).toHaveLength(1)
			expect(
				within(screen.getByRole("tabpanel")).getByRole("checkbox", {
					name: "settings:customTools.name",
				}),
			).toBeChecked()
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
		} finally {
			unmount()
			vi.clearAllTimers()
			vi.useRealTimers()
		}
	})

	it("opens and reopens the folded compaction prompt through search without applying settings", async () => {
		vi.useFakeTimers()
		const { unmount } = renderSettingsView("preferences")
		try {
			for (let frame = 0; frame < sectionNames.length + 1; frame++) {
				await act(async () => vi.advanceTimersToNextFrame())
			}
			const editor = screen.getByTestId("condense-prompt-textarea")
			const details = editor.closest<HTMLDetailsElement>('details[data-settings-advanced="condense-prompt"]')
			if (!details) throw new Error("Missing compaction prompt disclosure")
			expect(details.open).toBe(false)
			for (let attempt = 0; attempt < 2; attempt++) {
				const search = screen.getByTestId("settings-search-input")
				fireEvent.focus(search)
				fireEvent.change(search, { target: { value: "prompts:supportPrompts.types.CONDENSE.label" } })
				fireEvent.click(screen.getByRole("option", { name: "prompts:supportPrompts.types.CONDENSE.label" }))
				await act(async () => vi.advanceTimersByTime(150))
				expect(screen.getByTestId("tab-advanced")).toHaveAttribute("aria-selected", "true")
				expect(details.open).toBe(true)
				expect(editor).toBeVisible()
				expect(within(screen.getByRole("tabpanel")).getByTestId("condense-prompt-textarea")).toBe(editor)
				details.open = false
				fireEvent.click(screen.getByTestId("tab-preferences"))
				expect(editor).not.toBeVisible()
			}
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
		} finally {
			unmount()
			vi.clearAllTimers()
			vi.useRealTimers()
		}
	})

	it("omits retired terminal setup controls from the Advanced page and settings search", async () => {
		vi.useFakeTimers()
		const { unmount } = renderSettingsView("advanced")
		try {
			for (let frame = 0; frame < sectionNames.length + 1; frame++) {
				await act(async () => vi.advanceTimersToNextFrame())
			}
			const panel = screen.getByRole("tabpanel")
			expect(panel.querySelector('[data-setting-id^="terminal-"]')).not.toBeInTheDocument()
			expect(within(panel).queryByText("settings:advanced.terminal")).not.toBeInTheDocument()
			const search = screen.getByTestId("settings-search-input")
			for (const label of [
				"settings:terminal.shellIntegrationTimeout.label",
				"settings:terminal.outputPreviewSize.label",
				"settings:terminal.zdotdir.label",
			]) {
				fireEvent.focus(search)
				fireEvent.change(search, { target: { value: label } })
				expect(screen.queryByRole("option", { name: label })).not.toBeInTheDocument()
			}
			expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
		} finally {
			unmount()
			vi.clearAllTimers()
			vi.useRealTimers()
		}
	})
})

describe("SettingsView - Agents edit buffer", () => {
	beforeEach(() => vi.clearAllMocks())
	const refresh = (state: Record<string, unknown>) =>
		act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } })))
	const openAdvanced = (content: HTMLElement) => {
		const summary = within(content).getByText("agents:advanced.title", { selector: "summary" })
		if (!summary.closest<HTMLDetailsElement>("details")?.open) fireEvent.click(summary)
		expect(within(content).getByTestId("agents-default-model")).toBeVisible()
	}

	it("saves Codex settings without forwarding retired settings", () => {
		const { getSettingsContent } = renderSettingsView("agents", {
			maxConcurrentSubagents: 2,
			subagentDefaultModel: "old-model",
			subagentRoleTimeoutsMs: { worker: 10_000 },
			subagentRootCostBudget: 1,
		})
		const content = getSettingsContent()
		openAdvanced(content)
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.change(within(content).getByTestId("agents-concurrency"), { target: { value: "4" } })
		fireEvent.change(within(content).getByTestId("agents-default-model"), { target: { value: "new-model" } })
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
		fireEvent.click(screen.getByTestId("save-button"))
		const update = vi
			.mocked(vscode.postMessage)
			.mock.calls.find(([message]) => message.type === "updateSettings")?.[0]
		expect(update).toEqual(
			expect.objectContaining({
				updatedSettings: expect.objectContaining({
					maxConcurrentSubagents: 4,
					subagentDefaultModel: "new-model",
				}),
			}),
		)
		expect(update?.updatedSettings).not.toHaveProperty("subagentRoleTimeoutsMs")
		expect(update?.updatedSettings).not.toHaveProperty("subagentRootCostBudget")
		expect(update?.updatedSettings).not.toHaveProperty("subagentDefaultApiConfigId")
		expect(update?.updatedSettings).not.toHaveProperty("subagentsEnabled")
		expect(update?.updatedSettings).not.toHaveProperty("subagentInterruptMessage")
		expect(screen.getByTestId("save-button")).toBeDisabled()
	})

	it("retains dirty edits during refresh and Cancel, then discards to the latest host values", () => {
		const { getSettingsContent, onDone } = renderSettingsView("agents", {
			maxConcurrentSubagents: 2,
			subagentDefaultModel: "initial-model",
		})
		openAdvanced(getSettingsContent())
		const concurrency = () => within(getSettingsContent()).getByTestId("agents-concurrency")
		fireEvent.change(concurrency(), { target: { value: "4" } })
		vi.mocked(vscode.postMessage).mockClear()
		refresh({ maxConcurrentSubagents: 3, subagentDefaultModel: "refreshed-model" })
		expect(concurrency()).toHaveValue(4)
		expect(within(getSettingsContent()).getByTestId("agents-default-model")).toHaveValue("initial-model")
		fireEvent.click(screen.getByRole("button", { name: "settings:common.done" }))
		fireEvent.click(screen.getByTestId("alert-dialog-cancel"))
		expect(concurrency()).toHaveValue(4)
		expect(onDone).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: "settings:common.done" }))
		fireEvent.click(screen.getByTestId("alert-dialog-action"))
		expect(concurrency()).toHaveValue(3)
		expect(within(getSettingsContent()).getByTestId("agents-default-model")).toHaveValue("refreshed-model")
		expect(onDone).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
	})

	it("keeps Save disabled for invalid agent edits after leaving Tools & agents", () => {
		const { getSettingsContent, revealSection } = renderSettingsView("agents", { maxConcurrentSubagents: 2 })
		fireEvent.change(within(getSettingsContent()).getByTestId("agents-concurrency"), { target: { value: "2.5" } })
		expect(screen.getByTestId("save-button")).toBeDisabled()
		fireEvent.click(screen.getByTestId("tab-preferences"))
		revealSection("notifications")
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(screen.getByTestId("save-button"))
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
		revealSection("agents")
		fireEvent.change(within(getSettingsContent()).getByTestId("agents-concurrency"), { target: { value: "3" } })
		expect(screen.getByTestId("save-button")).toBeEnabled()
	})

	it("resyncs imported current settings while ignoring retired limits", () => {
		const { getSettingsContent } = renderSettingsView("agents")
		openAdvanced(getSettingsContent())
		refresh({ maxConcurrentSubagents: 2 })
		fireEvent.change(within(getSettingsContent()).getByTestId("agents-concurrency"), { target: { value: "4" } })
		refresh({
			settingsImportedAt: 101,
			maxConcurrentSubagents: 64,
			subagentDefaultModel: "imported-model",
			subagentDefaultReasoningEffort: "high",
			subagentRoleTimeoutsMs: { worker: 10_000 },
		})
		expect(within(getSettingsContent()).getByTestId("agents-concurrency")).toHaveValue(64)
		expect(within(getSettingsContent()).getByTestId("agents-default-model")).toHaveValue("imported-model")
		expect(within(getSettingsContent()).getByTestId("agents-default-reasoning")).toHaveValue("high")
		expect(screen.getByTestId("save-button")).toBeDisabled()
	})

	it("serializes inheritance clearing without losing custom agent definitions", () => {
		const definition = {
			description: "Review public contracts",
			model: "review-model",
			reasoningEffort: "low",
			developerInstructions: "Preserve compatibility.",
		}
		const { getSettingsContent } = renderSettingsView("agents", {
			subagentDefaultModel: "old-model",
			subagentDefaultReasoningEffort: "high",
			subagentAgentTypes: { reviewer: definition },
		})
		openAdvanced(getSettingsContent())
		fireEvent.change(within(getSettingsContent()).getByTestId("agents-default-model"), { target: { value: "" } })
		fireEvent.change(within(getSettingsContent()).getByTestId("agents-default-reasoning"), {
			target: { value: "" },
		})
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(screen.getByTestId("save-button"))
		const update = vi
			.mocked(vscode.postMessage)
			.mock.calls.find(([message]) => message.type === "updateSettings")?.[0]
		expect(JSON.parse(JSON.stringify(update))).toEqual(
			expect.objectContaining({
				updatedSettings: expect.objectContaining({
					subagentDefaultModel: "",
					subagentDefaultReasoningEffort: null,
				}),
			}),
		)
		expect(update?.updatedSettings).not.toHaveProperty("subagentAgentTypes")
	})
})

describe("SettingsView - Context compaction", () => {
	beforeEach(() => vi.clearAllMocks())

	it("retains the raw conflict baseline for an untouched setting across an unrelated successful save", () => {
		const { revealSection, getSettingsContent } = renderSettingsView("preferences")
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "state",
						state: { settingsImportedAt: 1, soundEnabled: false, maxWorkspaceFiles: 450 },
					},
				}),
			),
		)
		fireEvent.click(within(getSettingsContent()).getByTestId("sound-enabled-checkbox"))
		fireEvent.click(screen.getByTestId("save-button"))
		acknowledgeSettingsSave()
		revealSection("advanced")
		const count = within(getSettingsContent()).getByTestId("workspace-files-limit-slider")
		expect(count).toHaveValue("200")
		fireEvent.change(count, { target: { value: "199" } })
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(screen.getByTestId("save-button"))
		const update = vi
			.mocked(vscode.postMessage)
			.mock.calls.find(([message]) => message.type === "updateSettings")?.[0]
		if (!update?.settingsSave) throw new Error("Expected a correlated settings save")
		expect(update.updatedSettings).toEqual({ maxWorkspaceFiles: 199 })
		expect(update.settingsSave.expectedSettings).toEqual({ maxWorkspaceFiles: 450 })
	})

	it("saves the global threshold and drops loaded legacy profile overrides", () => {
		const { revealSection, getSettingsContent } = renderSettingsView(undefined, {
			autoCondenseContext: true,
			autoCondenseContextPercent: 80,
			profileThresholds: { "legacy-profile": 35 },
		})
		revealSection("contextManagement")

		const content = getSettingsContent()
		const threshold = within(content).getByTestId("condense-threshold-slider")
		expect(threshold).toHaveValue("80")
		expect(within(content).queryByTestId("threshold-profile-select")).not.toBeInTheDocument()

		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.change(threshold, { target: { value: "65" } })
		expect(threshold).toHaveValue("65")
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))

		fireEvent.click(screen.getByTestId("save-button"))
		const update = vi
			.mocked(vscode.postMessage)
			.mock.calls.find(([message]) => message.type === "updateSettings")?.[0]
		expect(update).toEqual(
			expect.objectContaining({
				updatedSettings: expect.objectContaining({ autoCondenseContextPercent: 65 }),
			}),
		)
		expect(update).not.toEqual(
			expect.objectContaining({
				updatedSettings: expect.objectContaining({ profileThresholds: expect.anything() }),
			}),
		)
	})

	it("keeps a compaction edit after Cancel and discards it without saving", () => {
		const { revealSection, getSettingsContent, onDone } = renderSettingsView()
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "state",
						state: { autoCondenseContext: true, autoCondenseContextPercent: 80 },
					},
				}),
			),
		)
		revealSection("contextManagement")

		const threshold = () => within(getSettingsContent()).getByTestId("condense-threshold-slider")
		fireEvent.change(threshold(), { target: { value: "65" } })
		fireEvent.click(screen.getByRole("button", { name: "settings:common.done" }))
		fireEvent.click(screen.getByRole("button", { name: "settings:unsavedChangesDialog.cancelButton" }))

		expect(threshold()).toHaveValue("65")
		expect(onDone).not.toHaveBeenCalled()
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))

		fireEvent.click(screen.getByRole("button", { name: "settings:common.done" }))
		fireEvent.click(screen.getByRole("button", { name: "settings:unsavedChangesDialog.discardButton" }))

		expect(threshold()).toHaveValue("80")
		expect(onDone).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
	})
})

describe("SettingsView - Built-in Skills", () => {
	beforeEach(() => vi.clearAllMocks())

	const dispatchSettings = (state: Record<string, unknown>) => {
		act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } })))
	}

	it("keeps built-in enablement buffered across live refreshes and saves both disabled and enabled values", () => {
		const { revealSection } = renderSettingsView()
		const skills = [
			{
				name: "rich-documents",
				description: "Substantial HTML documents",
				path: "/extension/assets/skills/rich-documents/SKILL.md",
				source: "builtin",
			},
		]
		dispatchSettings({ settingsImportedAt: 1, disabledBuiltinSkills: ["other-default"], skills })
		act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "skills", skills } })))
		revealSection("skills")
		const checkbox = screen.getByLabelText("settings:skills.enabled")
		expect(checkbox).toBeChecked()
		fireEvent.click(checkbox)
		expect(checkbox).not.toBeChecked()
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))

		dispatchSettings({ disabledBuiltinSkills: [], skills, liveTaskIds: ["background-task"] })
		expect(checkbox).not.toBeChecked()
		fireEvent.click(screen.getByTestId("save-button"))
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					disabledBuiltinSkills: ["other-default", "rich-documents"],
				}),
			}),
		)
		acknowledgeSettingsSave()

		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(checkbox)
		expect(checkbox).toBeChecked()
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
		fireEvent.click(screen.getByTestId("save-button"))
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({ disabledBuiltinSkills: ["other-default"] }),
			}),
		)
	})
})

describe("SettingsView - Sound Settings", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("omits anonymous reporting controls and never saves a retained legacy reporting preference", () => {
		const { getSettingsContent } = renderSettingsView("preferences", { telemetrySetting: "enabled" })
		const content = getSettingsContent()
		expect(document.querySelector('[data-setting-id="about-telemetry"]')).not.toBeInTheDocument()
		expect(within(content).queryByLabelText("settings:footer.telemetry.label")).not.toBeInTheDocument()
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(within(content).getByTestId("sound-enabled-checkbox"))
		fireEvent.click(screen.getByTestId("save-button"))
		const update = vi
			.mocked(vscode.postMessage)
			.mock.calls.find(([message]) => message.type === "updateSettings")?.[0]
		if (!update?.settingsSave) throw new Error("Expected a correlated settings save")
		expect(update.updatedSettings).toEqual({ soundEnabled: true })
		expect(update.settingsSave.expectedSettings).toEqual({ soundEnabled: false })
		expect(update.updatedSettings).not.toHaveProperty("telemetrySetting")
	})

	it("ignores legacy speech settings and buffers notification sound edits until Save", () => {
		const { getSettingsContent } = renderSettingsView("notifications")
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "state",
						state: { ttsEnabled: true, ttsSpeed: 1.5, soundEnabled: false, soundVolume: 0.5 },
					},
				}),
			),
		)
		const content = getSettingsContent()
		expect(within(content).queryByTestId("tts-enabled-checkbox")).not.toBeInTheDocument()
		expect(within(content).queryByTestId("tts-speed-slider")).not.toBeInTheDocument()
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(within(content).getByTestId("sound-enabled-checkbox"))
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
		fireEvent.click(screen.getByTestId("save-button"))
		const update = vi
			.mocked(vscode.postMessage)
			.mock.calls.find(([message]) => message.type === "updateSettings")?.[0]
		expect(update?.updatedSettings).toEqual({ soundEnabled: true })
		expect(update?.updatedSettings).not.toHaveProperty("ttsEnabled")
		expect(update?.updatedSettings).not.toHaveProperty("ttsSpeed")
	})

	it("initializes with sound disabled by default", () => {
		// Render once and get the revealSection helper
		const { revealSection, getSettingsContent } = renderSettingsView()

		// Reveal sound preferences
		revealSection("notifications")

		const content = getSettingsContent()
		const soundCheckbox = within(content).getByTestId("sound-enabled-checkbox")
		expect(soundCheckbox).not.toBeChecked()

		// Volume slider should not be visible when sound is disabled
		expect(within(content).queryByTestId("sound-volume-slider")).not.toBeInTheDocument()
	})

	it("toggles sound setting and sends message to VSCode", () => {
		// Render once and get the revealSection helper
		const { revealSection, getSettingsContent } = renderSettingsView()

		// Reveal sound preferences
		revealSection("notifications")

		const content = getSettingsContent()
		const soundCheckbox = within(content).getByTestId("sound-enabled-checkbox")

		// Enable sound
		fireEvent.click(soundCheckbox)
		expect(soundCheckbox).toBeChecked()

		// Click Save to save settings
		const saveButton = screen.getByTestId("save-button")
		fireEvent.click(saveButton)

		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					soundEnabled: true,
				}),
			}),
		)
	})

	it("shows volume slider when sound is enabled", () => {
		// Render once and get the revealSection helper
		const { revealSection, getSettingsContent } = renderSettingsView()

		// Reveal sound preferences
		revealSection("notifications")

		const content = getSettingsContent()
		// Enable sound
		const soundCheckbox = within(content).getByTestId("sound-enabled-checkbox")
		fireEvent.click(soundCheckbox)

		// Volume slider should be visible
		const volumeSlider = within(content).getByTestId("sound-volume-slider")
		expect(volumeSlider).toBeInTheDocument()
		expect(volumeSlider).toHaveValue("0.5")
	})

	it("updates volume and sends message to VSCode when slider changes", () => {
		// Render once and get the revealSection helper
		const { revealSection, getSettingsContent } = renderSettingsView()

		// Reveal sound preferences
		revealSection("notifications")

		const content = getSettingsContent()
		// Enable sound
		const soundCheckbox = within(content).getByTestId("sound-enabled-checkbox")
		fireEvent.click(soundCheckbox)

		// Change volume
		const volumeSlider = within(content).getByTestId("sound-volume-slider")
		fireEvent.change(volumeSlider, { target: { value: "0.75" } })

		// Click Save to save settings
		const saveButton = screen.getByTestId("save-button")
		fireEvent.click(saveButton)

		// Verify message sent to VSCode
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					soundVolume: 0.75,
				}),
			}),
		)
	})
})

describe("SettingsView - API Configuration", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders ApiConfigManagement with correct props", () => {
		renderSettingsView()

		expect(screen.getByTestId("api-config-management")).toBeInTheDocument()
	})
})

describe("SettingsView - Approval Mode", () => {
	beforeEach(() => vi.clearAllMocks())

	const dispatchSettings = (state: Record<string, unknown>) => {
		act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } })))
	}

	it("keeps the session dial buffered through live refreshes and saves mode with derived chips", () => {
		const { revealSection, getSettingsContent } = renderSettingsView()
		dispatchSettings({ settingsImportedAt: 1, approvalMode: "ask" })
		revealSection("autoApprove")
		const auto = within(getSettingsContent()).getByTestId("approval-mode-auto")
		expect(auto).toBeVisible()
		expect(screen.getByTestId("tab-preferences")).toHaveAttribute("aria-selected", "true")
		expect(screen.queryByTestId("tab-permissions")).not.toBeInTheDocument()

		expect(within(getSettingsContent()).getByTestId("approval-mode-ask")).toHaveAttribute("aria-pressed", "true")
		fireEvent.click(auto)
		expect(auto).toHaveAttribute("aria-pressed", "true")
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))

		dispatchSettings({ approvalMode: "ask", liveTaskIds: ["background-task"] })
		expect(auto).toHaveAttribute("aria-pressed", "true")
		fireEvent.click(screen.getByTestId("save-button"))
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					approvalMode: "auto",
					alwaysAllowWrite: true,
					alwaysAllowTickets: true,
				}),
			}),
		)
	})

	it("resyncs imported Preferences permissions and discards a later draft to the latest host permissions", () => {
		const { getSettingsContent, onDone } = renderSettingsView("preferences", { ...settingsForApprovalMode("ask") })
		const mode = (name: "ask" | "auto" | "bypass") =>
			within(getSettingsContent()).getByTestId("approval-mode-" + name)
		expect(mode("ask")).toHaveAttribute("aria-pressed", "true")
		expect(screen.getByTestId("save-button")).toBeDisabled()
		// Imports explicitly replace the form snapshot; ordinary live pushes preserve buffered edits.
		dispatchSettings({ ...settingsForApprovalMode("auto"), settingsImportedAt: 1 })
		expect(mode("auto")).toHaveAttribute("aria-pressed", "true")
		expect(screen.getByTestId("save-button")).toBeDisabled()
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(mode("ask"))
		dispatchSettings({ ...settingsForApprovalMode("bypass"), liveTaskIds: ["background-task"] })
		expect(mode("ask")).toHaveAttribute("aria-pressed", "true")
		fireEvent.click(screen.getByTestId("tab-tools"))
		fireEvent.click(screen.getByTestId("tab-preferences"))
		expect(mode("ask")).toHaveAttribute("aria-pressed", "true")
		expect(screen.getByTestId("save-button")).toBeEnabled()
		fireEvent.click(screen.getByRole("button", { name: "settings:common.done" }))
		fireEvent.click(screen.getByTestId("alert-dialog-action"))
		expect(mode("bypass")).toHaveAttribute("aria-pressed", "true")
		expect(screen.getByTestId("save-button")).toBeDisabled()
		expect(onDone).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
	})

	it("preserves approval-mode edits on Cancel and resets them on Discard", () => {
		const { revealSection, getSettingsContent, onDone } = renderSettingsView()
		dispatchSettings({ settingsImportedAt: 1, approvalMode: "ask" })
		revealSection("autoApprove")
		const auto = within(getSettingsContent()).getByTestId("approval-mode-auto")

		fireEvent.click(auto)
		fireEvent.click(screen.getByRole("button", { name: "settings:common.done" }))
		fireEvent.click(screen.getByTestId("alert-dialog-cancel"))
		expect(auto).toHaveAttribute("aria-pressed", "true")
		expect(onDone).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole("button", { name: "settings:common.done" }))
		fireEvent.click(screen.getByTestId("alert-dialog-action"))
		expect(within(getSettingsContent()).getByTestId("approval-mode-ask")).toHaveAttribute("aria-pressed", "true")
		expect(onDone).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "updateSettings" }))
	})
})

describe("SettingsView - Allowed Commands", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("shows allowed commands section for the session dial", () => {
		const { revealSection } = renderSettingsView()
		revealSection("autoApprove")
		const content = getPermissionsContent()
		expect(within(content).getByTestId("allowed-commands-heading")).toBeInTheDocument()
		expect(within(content).getByTestId("command-input")).toBeInTheDocument()
	})

	it("edits only global command rules while inherited workspace rules remain read-only", () => {
		renderSettingsView("permissions")
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "state",
						state: {
							settingsImportedAt: 1,
							approvalMode: "ask",
							allowedCommands: ["git status", "workspace-only-command"],
							commandRuleSettings: {
								allowedCommands: ["git status"],
								deniedCommands: [],
								inherited: [
									{
										source: "workspace",
										allowedCommands: ["workspace-only-command"],
										deniedCommands: [],
									},
								],
							},
						},
					},
				}),
			),
		)
		const content = getPermissionsContent()
		expect(within(content).getByText("workspace-only-command")).toBeInTheDocument()
		expect(within(content).queryByTestId("remove-command-1")).not.toBeInTheDocument()
		fireEvent.click(within(content).getByTestId("remove-command-0"))
		expect(within(content).getByText("workspace-only-command")).toBeInTheDocument()
		vi.mocked(vscode.postMessage).mockClear()
		fireEvent.click(screen.getByTestId("save-button"))
		const update = vi
			.mocked(vscode.postMessage)
			.mock.calls.find(([message]) => message.type === "updateSettings")?.[0]
		if (!update?.settingsSave) throw new Error("Expected a correlated settings save")
		expect(update.updatedSettings).toEqual({ allowedCommands: [] })
		expect(update.settingsSave.expectedSettings).toEqual({ allowedCommands: ["git status"] })
	})

	it("adds new command to the list", () => {
		const { revealSection } = renderSettingsView()
		revealSection("autoApprove")
		const content = getPermissionsContent()
		const input = within(content).getByTestId("command-input")
		fireEvent.change(input, { target: { value: "npm test" } })
		fireEvent.click(within(content).getByTestId("add-command-button"))
		expect(within(content).getByText("npm test")).toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					allowedCommands: ["npm test"],
				}),
			}),
		)
	})

	it("removes command from the list", () => {
		const { revealSection } = renderSettingsView()
		revealSection("autoApprove")
		const content = getPermissionsContent()
		const input = within(content).getByTestId("command-input")
		fireEvent.change(input, { target: { value: "npm test" } })
		fireEvent.click(within(content).getByTestId("add-command-button"))
		fireEvent.click(within(content).getByTestId("remove-command-0"))
		expect(within(content).queryByText("npm test")).not.toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					allowedCommands: [],
				}),
			}),
		)
	})

	describe("SettingsView - Section Navigation", () => {
		beforeEach(() => {
			vi.clearAllMocks()
		})

		it("opens Providers by default and exposes four dedicated settings pages", () => {
			renderSettingsView()

			expect(screen.getByRole("tablist")).toBeInTheDocument()
			expect(document.querySelectorAll("[data-settings-section]")).toHaveLength(4)
			expect(screen.getByTestId("api-config-management")).toBeInTheDocument()
			expect(screen.getByTestId("tab-providers")).toHaveAttribute("aria-selected", "true")
			expect(screen.getByRole("tabpanel")).toHaveAttribute("data-settings-section", "providers")
		})

		it("shows unsaved changes dialog when clicking Done with unsaved changes", () => {
			// Render once and get the revealSection helper
			const { revealSection, getSettingsContent } = renderSettingsView()

			// Reveal sound preferences
			revealSection("notifications")

			const content = getSettingsContent()
			// Make a change to create unsaved changes
			const soundCheckbox = within(content).getByTestId("sound-enabled-checkbox")
			fireEvent.click(soundCheckbox)

			// Click the Done button
			const doneButton = screen.getByText("settings:common.done")
			fireEvent.click(doneButton)

			// Check that unsaved changes dialog is shown
			expect(screen.getByText("settings:unsavedChangesDialog.title")).toBeInTheDocument()
		})
	})
})

describe("SettingsView - Duplicate Commands", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("prevents duplicate commands", () => {
		// Render once and get the revealSection helper
		const { revealSection } = renderSettingsView()

		// Reveal permissions
		revealSection("autoApprove")

		const content = getPermissionsContent()
		const input = within(content).getByTestId("command-input")
		const addButton = within(content).getByTestId("add-command-button")

		// First addition
		fireEvent.change(input, { target: { value: "npm test" } })
		fireEvent.click(addButton)

		// Second addition attempt
		fireEvent.change(input, { target: { value: "npm test" } })
		fireEvent.click(addButton)

		// Verify command appears only once in active tab
		const commands = within(content).getAllByText("npm test")
		expect(commands).toHaveLength(1)
	})

	it("saves allowed commands when clicking Save", () => {
		// Render once and get the revealSection helper
		const { revealSection } = renderSettingsView()

		// Reveal permissions
		revealSection("autoApprove")

		const content = getPermissionsContent()
		const input = within(content).getByTestId("command-input")
		fireEvent.change(input, { target: { value: "npm test" } })
		fireEvent.click(within(content).getByTestId("add-command-button"))
		fireEvent.click(screen.getByTestId("save-button"))

		// Verify VSCode messages were sent
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					allowedCommands: ["npm test"],
				}),
			}),
		)
	})

	it("saves the session dial and derived chips together", () => {
		const { revealSection } = renderSettingsView()
		revealSection("autoApprove")
		const content = getPermissionsContent()
		const input = within(content).getByTestId("command-input")
		fireEvent.change(input, { target: { value: " * " } })
		fireEvent.click(within(content).getByTestId("add-command-button"))
		fireEvent.click(within(content).getByTestId("approval-mode-auto"))
		fireEvent.click(screen.getByTestId("save-button"))
		expect(vscode.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "updateSettings",
				updatedSettings: expect.objectContaining({
					approvalMode: "auto",
					alwaysAllowExecute: true,
					alwaysAllowSubagents: true,
					allowedCommands: ["*"],
				}),
			}),
		)
	})
})
