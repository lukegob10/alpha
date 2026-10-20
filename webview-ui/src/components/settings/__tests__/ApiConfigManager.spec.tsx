// npx vitest src/components/settings/__tests__/ApiConfigManager.spec.tsx

import { render, screen, fireEvent, within, act } from "@/utils/test-utils"

import ApiConfigManager from "../ApiConfigManager"

vi.mock("@/i18n/TranslationContext", async () => {
	const { default: i18n } = await import("@/i18n/setup")
	return {
		useAppTranslation: () => ({
			t: (key: string, options?: { fields?: string }) => (options?.fields ? `${key}: ${options.fields}` : key),
			i18n,
		}),
	}
})

// Mock VSCode components
vitest.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ value, onInput, placeholder, onKeyDown, "data-testid": dataTestId }: any) => (
		<input
			value={value}
			onChange={(e) => onInput(e)}
			placeholder={placeholder}
			onKeyDown={onKeyDown}
			data-testid={dataTestId}
			ref={undefined} // Explicitly set ref to undefined to avoid warning
		/>
	),
}))

vitest.mock("@/components/ui", () => ({
	...vitest.importActual("@/components/ui"),
	Dialog: ({ children, open }: any) => (
		<div role="dialog" aria-modal="true" style={{ display: open ? "block" : "none" }} data-testid="dialog">
			{children}
		</div>
	),
	DialogContent: ({ children }: any) => <div data-testid="dialog-content">{children}</div>,
	DialogTitle: ({ children }: any) => <div data-testid="dialog-title">{children}</div>,
	Button: ({ children, onClick, disabled, "data-testid": dataTestId }: any) => (
		<button onClick={onClick} disabled={disabled} data-testid={dataTestId}>
			{children}
		</button>
	),
	Input: ({ value, onInput, placeholder, onKeyDown, "data-testid": dataTestId }: any) => (
		<input
			value={value}
			onChange={(e) => onInput(e)}
			placeholder={placeholder}
			onKeyDown={onKeyDown}
			data-testid={dataTestId}
		/>
	),
	StandardTooltip: ({ children, content }: any) => <div title={content}>{children}</div>,
	// New components for searchable dropdown
	Popover: ({ children, open }: any) => (
		<div className="popover" style={{ position: "relative" }}>
			{children}
			{open && <div className="popover-content" style={{ position: "absolute", top: "100%", left: 0 }}></div>}
		</div>
	),
	PopoverTrigger: ({ children }: any) => <div className="popover-trigger">{children}</div>,
	PopoverContent: ({ children }: any) => <div className="popover-content">{children}</div>,
	Command: ({ children }: any) => <div className="command">{children}</div>,
	CommandInput: ({ value, onValueChange, placeholder, className, "data-testid": dataTestId }: any) => (
		<input
			value={value}
			onChange={(e) => onValueChange(e.target.value)}
			placeholder={placeholder}
			className={className}
			data-testid={dataTestId}
		/>
	),
	CommandList: ({ children }: any) => <div className="command-list">{children}</div>,
	CommandEmpty: ({ children }: any) => (children ? <div className="command-empty">{children}</div> : null),
	CommandGroup: ({ children }: any) => <div className="command-group">{children}</div>,
	CommandItem: ({ children, value, onSelect }: any) => (
		<div className="command-item" onClick={() => onSelect(value)} data-value={value}>
			{children}
		</div>
	),
	// Keep old components for backward compatibility
	Select: ({ value, onValueChange }: any) => (
		<select
			value={value}
			onChange={(e) => {
				if (onValueChange) onValueChange(e.target.value)
			}}
			data-testid="select-component">
			<option value="Default Config">Default Config</option>
			<option value="Another Config">Another Config</option>
		</select>
	),
	SelectTrigger: ({ children }: any) => <div className="select-trigger-mock">{children}</div>,
	SelectValue: ({ children }: any) => <div className="select-value-mock">{children}</div>,
	SelectContent: ({ children }: any) => <div className="select-content-mock">{children}</div>,
	SelectItem: ({ children, value }: any) => (
		<option value={value} className="select-item-mock">
			{children}
		</option>
	),
	SearchableSelect: ({ value, onValueChange, options, placeholder, disabled, "data-testid": dataTestId }: any) => (
		<select
			value={value}
			disabled={disabled}
			onChange={(e) => {
				if (onValueChange) onValueChange(e.target.value)
			}}
			data-testid={dataTestId || "select-component"}>
			<option value="">{placeholder || "settings:common.select"}</option>
			{options?.map((option: any) => (
				<option key={option.value} value={option.value} disabled={option.disabled}>
					{option.label}
				</option>
			))}
		</select>
	),
}))

describe("ApiConfigManager", () => {
	const mockOnSelectConfig = vitest.fn()
	const mockOnDeleteConfig = vitest.fn()
	const mockOnRenameConfig = vitest.fn()
	const mockOnUpsertConfig = vitest.fn()

	const defaultProps = {
		currentApiConfigName: "Default Config",
		listApiConfigMeta: [
			{ id: "default", name: "Default Config" },
			{ id: "another", name: "Another Config" },
		],
		onSelectConfig: mockOnSelectConfig,
		onDeleteConfig: mockOnDeleteConfig,
		onRenameConfig: mockOnRenameConfig,
		onUpsertConfig: mockOnUpsertConfig,
	}

	beforeEach(() => {
		vitest.clearAllMocks()
	})

	const getRenameForm = () => screen.getByTestId("rename-form")
	const getDialogContent = () => screen.getByTestId("dialog-content")

	it("explains retained unavailable profiles and prevents selection while preserving profile management", () => {
		render(
			<ApiConfigManager
				{...defaultProps}
				listApiConfigMeta={[
					...defaultProps.listApiConfigMeta,
					{
						id: "invalid",
						name: "Invalid saved profile",
						availability: "invalid",
						invalidFields: ["modelTemperature", "apiModelId"],
					},
					{ id: "unsupported", name: "Unsupported saved profile", availability: "unsupported" },
				]}
			/>,
		)

		expect(screen.getByRole("option", { name: /Invalid saved profile/ })).toBeDisabled()
		expect(screen.getByRole("option", { name: /Unsupported saved profile/ })).toBeDisabled()
		fireEvent.change(screen.getByTestId("select-component"), { target: { value: "Invalid saved profile" } })
		expect(mockOnSelectConfig).not.toHaveBeenCalled()
		const notice = screen.getByTestId("unavailable-profiles")
		expect(notice).toHaveTextContent("Invalid saved profile")
		expect(notice).toHaveTextContent("modelTemperature, apiModelId")
		expect(notice).toHaveTextContent("settings:providers.profileUnavailableHelp")
		fireEvent.click(screen.getByTestId("delete-unavailable-profile-invalid"))
		expect(mockOnDeleteConfig).toHaveBeenCalledTimes(1)
		expect(mockOnDeleteConfig).toHaveBeenCalledWith("Invalid saved profile")
		expect(screen.getByTestId("add-profile-button")).toBeEnabled()
		expect(screen.getByTestId("rename-profile-button")).toBeEnabled()
	})

	it("opens new profile dialog when clicking add button", () => {
		render(<ApiConfigManager {...defaultProps} />)

		const addButton = screen.getByTestId("add-profile-button")
		fireEvent.click(addButton)

		expect(screen.getByTestId("dialog")).toBeVisible()
		expect(screen.getByTestId("dialog-title")).toHaveTextContent("settings:providers.newProfile")
	})

	it("creates new profile with entered name", () => {
		render(<ApiConfigManager {...defaultProps} />)

		// Open dialog
		const addButton = screen.getByTestId("add-profile-button")
		fireEvent.click(addButton)

		// Enter new profile name
		const input = screen.getByTestId("new-profile-input")
		fireEvent.input(input, { target: { value: "New Profile" } })

		// Click create button
		const createButton = screen.getByText("settings:providers.createProfile")
		fireEvent.click(createButton)

		expect(mockOnUpsertConfig).toHaveBeenCalledWith("New Profile")
	})

	it("shows error when creating profile with existing name", () => {
		render(<ApiConfigManager {...defaultProps} />)

		// Open dialog
		const addButton = screen.getByTestId("add-profile-button")
		fireEvent.click(addButton)

		// Enter existing profile name
		const input = screen.getByTestId("new-profile-input")
		fireEvent.input(input, { target: { value: "Default Config" } })

		// Click create button to trigger validation
		const createButton = screen.getByText("settings:providers.createProfile")
		fireEvent.click(createButton)

		// Verify error message
		const dialogContent = getDialogContent()
		const errorMessage = within(dialogContent).getByTestId("error-message")
		expect(errorMessage).toHaveTextContent("settings:providers.nameExists")
		expect(mockOnUpsertConfig).not.toHaveBeenCalled()
	})

	it("prevents creating profile with empty name", () => {
		render(<ApiConfigManager {...defaultProps} />)

		// Open dialog
		const addButton = screen.getByTestId("add-profile-button")
		fireEvent.click(addButton)

		// Enter empty name
		const input = screen.getByTestId("new-profile-input")
		fireEvent.input(input, { target: { value: "   " } })

		// Verify create button is disabled
		const createButton = screen.getByText("settings:providers.createProfile")
		expect(createButton).toBeDisabled()
		expect(mockOnUpsertConfig).not.toHaveBeenCalled()
	})

	it("allows renaming the current config", () => {
		render(<ApiConfigManager {...defaultProps} />)

		// Start rename
		const renameButton = screen.getByTestId("rename-profile-button")
		fireEvent.click(renameButton)

		// Find input and enter new name
		const input = screen.getByDisplayValue("Default Config")
		fireEvent.input(input, { target: { value: "New Name" } })

		// Save
		const saveButton = screen.getByTestId("save-rename-button")
		fireEvent.click(saveButton)

		expect(mockOnRenameConfig).toHaveBeenCalledWith("Default Config", "New Name")
	})

	it("shows error when renaming to existing config name", () => {
		render(<ApiConfigManager {...defaultProps} />)

		// Start rename
		const renameButton = screen.getByTestId("rename-profile-button")
		fireEvent.click(renameButton)

		// Find input and enter existing name
		const input = screen.getByDisplayValue("Default Config")
		fireEvent.input(input, { target: { value: "Another Config" } })

		// Save to trigger validation
		const saveButton = screen.getByTestId("save-rename-button")
		fireEvent.click(saveButton)

		// Verify error message
		const renameForm = getRenameForm()
		const errorMessage = within(renameForm).getByTestId("error-message")
		expect(errorMessage).toHaveTextContent("settings:providers.nameExists")
		expect(mockOnRenameConfig).not.toHaveBeenCalled()
	})

	it("waits for rename acknowledgement, retains a failed name, and allows retry", async () => {
		let completeRename!: (error?: string) => void
		const onRenameConfig = vitest.fn(() => new Promise<string | undefined>((resolve) => (completeRename = resolve)))
		render(<ApiConfigManager {...defaultProps} onRenameConfig={onRenameConfig} />)
		fireEvent.click(screen.getByTestId("rename-profile-button"))
		fireEvent.input(screen.getByDisplayValue("Default Config"), { target: { value: "New Name" } })
		fireEvent.click(screen.getByTestId("save-rename-button"))

		expect(screen.getByDisplayValue("New Name")).toBeInTheDocument()
		expect(screen.getByTestId("save-rename-button")).toBeDisabled()
		expect(screen.getByTestId("cancel-rename-button")).toBeDisabled()
		fireEvent.keyDown(screen.getByDisplayValue("New Name"), { key: "Enter" })
		expect(onRenameConfig).toHaveBeenCalledTimes(1)

		await act(async () => completeRename("Could not save the profile name"))
		expect(within(getRenameForm()).getByTestId("error-message")).toHaveTextContent(
			"Could not save the profile name",
		)
		expect(screen.getByDisplayValue("New Name")).toBeInTheDocument()
		expect(screen.getByTestId("save-rename-button")).toBeEnabled()
		fireEvent.click(screen.getByTestId("save-rename-button"))
		expect(onRenameConfig).toHaveBeenCalledTimes(2)
		await act(async () => completeRename())
		expect(screen.queryByTestId("rename-form")).not.toBeInTheDocument()
	})

	it("keeps an acknowledged rename pending through a same-profile name refresh", async () => {
		let completeRename!: (error?: string) => void
		const onRenameConfig = vitest.fn(() => new Promise<string | undefined>((resolve) => (completeRename = resolve)))
		const { rerender } = render(<ApiConfigManager {...defaultProps} onRenameConfig={onRenameConfig} />)
		fireEvent.click(screen.getByTestId("rename-profile-button"))
		fireEvent.input(screen.getByDisplayValue("Default Config"), { target: { value: "New Name" } })
		fireEvent.click(screen.getByTestId("save-rename-button"))
		rerender(
			<ApiConfigManager
				{...defaultProps}
				onRenameConfig={onRenameConfig}
				currentApiConfigName="New Name"
				listApiConfigMeta={[
					{ id: "default", name: "New Name" },
					{ id: "another", name: "Another Config" },
				]}
			/>,
		)

		expect(screen.getByTestId("rename-form")).toBeInTheDocument()
		expect(screen.getByTestId("save-rename-button")).toBeDisabled()
		await act(async () => completeRename())
		expect(screen.queryByTestId("rename-form")).not.toBeInTheDocument()
		expect(screen.getByTestId("select-component")).toHaveValue("New Name")
	})

	it("ignores a delayed rename error after the current profile ID changes", async () => {
		let completeRename!: (error?: string) => void
		const onRenameConfig = vitest.fn(() => new Promise<string | undefined>((resolve) => (completeRename = resolve)))
		const { rerender } = render(<ApiConfigManager {...defaultProps} onRenameConfig={onRenameConfig} />)
		fireEvent.click(screen.getByTestId("rename-profile-button"))
		fireEvent.input(screen.getByDisplayValue("Default Config"), { target: { value: "New Name" } })
		fireEvent.click(screen.getByTestId("save-rename-button"))
		rerender(
			<ApiConfigManager
				{...defaultProps}
				onRenameConfig={onRenameConfig}
				listApiConfigMeta={[{ id: "replacement", name: "Default Config" }]}
			/>,
		)
		await act(async () => completeRename("Stale error"))

		expect(screen.queryByTestId("rename-form")).not.toBeInTheDocument()
		expect(screen.queryByText("Stale error")).not.toBeInTheDocument()
		fireEvent.click(screen.getByTestId("rename-profile-button"))
		expect(screen.getByDisplayValue("Default Config")).toBeInTheDocument()
		expect(screen.getByTestId("save-rename-button")).toBeEnabled()
	})

	it("blocks profile actions when the settings view owns a pending rename after remount", () => {
		render(<ApiConfigManager {...defaultProps} profileActionsDisabled />)
		for (const action of [
			"select-component",
			"add-profile-button",
			"rename-profile-button",
			"delete-profile-button",
		]) {
			expect(screen.getByTestId(action)).toBeDisabled()
		}
		fireEvent.change(screen.getByTestId("select-component"), { target: { value: "Another Config" } })
		fireEvent.click(screen.getByTestId("add-profile-button"))
		fireEvent.click(screen.getByTestId("rename-profile-button"))
		fireEvent.click(screen.getByTestId("delete-profile-button"))
		expect(mockOnSelectConfig).not.toHaveBeenCalled()
		expect(mockOnDeleteConfig).not.toHaveBeenCalled()
		expect(mockOnRenameConfig).not.toHaveBeenCalled()
		expect(mockOnUpsertConfig).not.toHaveBeenCalled()
	})

	it("prevents renaming to empty name", () => {
		render(<ApiConfigManager {...defaultProps} />)

		// Start rename
		const renameButton = screen.getByTestId("rename-profile-button")
		fireEvent.click(renameButton)

		// Find input and enter empty name
		const input = screen.getByDisplayValue("Default Config")
		fireEvent.input(input, { target: { value: "   " } })

		// Verify save button is disabled
		const saveButton = screen.getByTestId("save-rename-button")
		expect(saveButton).toBeDisabled()
		expect(mockOnRenameConfig).not.toHaveBeenCalled()
	})

	it("allows selecting a different config", () => {
		render(<ApiConfigManager {...defaultProps} />)

		// The SearchableSelect mock renders as a simple select element
		const selectElement = screen.getByTestId("select-component") as HTMLSelectElement

		// Change the select value to "Another Config"
		fireEvent.change(selectElement, { target: { value: "Another Config" } })

		expect(mockOnSelectConfig).toHaveBeenCalledWith("Another Config")
	})

	it("allows deleting the current config when not the only one", () => {
		render(<ApiConfigManager {...defaultProps} />)

		const deleteButton = screen.getByTestId("delete-profile-button")
		expect(deleteButton).not.toBeDisabled()

		fireEvent.click(deleteButton)
		expect(mockOnDeleteConfig).toHaveBeenCalledWith("Default Config")
	})

	it("disables delete button when only one config exists", () => {
		render(<ApiConfigManager {...defaultProps} listApiConfigMeta={[{ id: "default", name: "Default Config" }]} />)

		const deleteButton = screen.getByTestId("delete-profile-button")
		expect(deleteButton).toHaveAttribute("disabled")
	})

	it("cancels rename operation when clicking cancel", () => {
		render(<ApiConfigManager {...defaultProps} />)

		// Start rename
		const renameButton = screen.getByTestId("rename-profile-button")
		fireEvent.click(renameButton)

		// Find input and enter new name
		const input = screen.getByDisplayValue("Default Config")
		fireEvent.input(input, { target: { value: "New Name" } })

		// Cancel
		const cancelButton = screen.getByTestId("cancel-rename-button")
		fireEvent.click(cancelButton)

		// Verify rename was not called
		expect(mockOnRenameConfig).not.toHaveBeenCalled()

		// Verify we're back to normal view
		expect(screen.queryByDisplayValue("New Name")).not.toBeInTheDocument()
	})

	it("handles keyboard events in new profile dialog", () => {
		render(<ApiConfigManager {...defaultProps} />)

		// Open dialog
		const addButton = screen.getByTestId("add-profile-button")
		fireEvent.click(addButton)

		const input = screen.getByTestId("new-profile-input")

		// Test Enter key
		fireEvent.input(input, { target: { value: "New Profile" } })
		fireEvent.keyDown(input, { key: "Enter" })
		expect(mockOnUpsertConfig).toHaveBeenCalledWith("New Profile")

		// Test Escape key
		fireEvent.keyDown(input, { key: "Escape" })
		expect(screen.getByTestId("dialog")).not.toBeVisible()
	})

	it("handles keyboard events in rename mode", () => {
		render(<ApiConfigManager {...defaultProps} />)

		// Start rename
		const renameButton = screen.getByTestId("rename-profile-button")
		fireEvent.click(renameButton)

		const input = screen.getByDisplayValue("Default Config")

		// Test Enter key
		fireEvent.input(input, { target: { value: "New Name" } })
		fireEvent.keyDown(input, { key: "Enter" })
		expect(mockOnRenameConfig).toHaveBeenCalledWith("Default Config", "New Name")

		// Test Escape key
		fireEvent.keyDown(input, { key: "Escape" })
		expect(screen.queryByDisplayValue("New Name")).not.toBeInTheDocument()
	})
})
