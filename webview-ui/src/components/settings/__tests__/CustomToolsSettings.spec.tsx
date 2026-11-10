import type { ChangeEvent, ComponentProps, ReactNode } from "react"
import { act, fireEvent, render, screen, waitFor } from "@/utils/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { vscode } from "@/utils/vscode"

import { CustomToolsSettings } from "../CustomToolsSettings"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: { label?: string }) => (options?.label ? `${key}: ${options.label}` : key),
	}),
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({
		checked,
		onChange,
		children,
	}: {
		checked: boolean
		onChange: (event: ChangeEvent<HTMLInputElement>) => void
		children: ReactNode
	}) => (
		<label>
			<input type="checkbox" checked={checked} onChange={onChange} />
			{children}
		</label>
	),
}))
vi.mock("@/components/ui", () => ({
	Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => <button {...props} />,
}))

const defaultProps = {
	enabled: false,
	committedEnabled: false,
	isActive: true,
	onChange: vi.fn(),
}

function publishTools() {
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "customToolsResult",
					tools: [
						{
							name: "project_tool",
							description: "Project tool description",
							source: "F:/workspace/.alpha/tools/project_tool.ts",
							parameters: {
								properties: { count: { type: "number", description: "Number of items" } },
								required: ["count"],
							},
						},
					],
				},
			}),
		)
	})
}

describe("CustomToolsSettings saved enablement", () => {
	beforeEach(() => vi.clearAllMocks())

	it("buffers enabling without importing or exposing a refresh action before Save", () => {
		const { rerender } = render(<CustomToolsSettings {...defaultProps} />)

		fireEvent.click(screen.getByRole("checkbox"))
		expect(defaultProps.onChange).toHaveBeenCalledWith(true)
		rerender(<CustomToolsSettings {...defaultProps} enabled />)

		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(screen.getByText("settings:customTools.saveToLoad")).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "settings:customTools.refreshButton" })).not.toBeInTheDocument()
	})

	it("can cancel unsaved enabling without loading executable modules", () => {
		const { rerender } = render(<CustomToolsSettings {...defaultProps} enabled />)

		rerender(<CustomToolsSettings {...defaultProps} />)

		expect(vscode.postMessage).not.toHaveBeenCalled()
		expect(screen.queryByText("settings:customTools.saveToLoad")).not.toBeInTheDocument()
	})

	it("loads after host state confirms the saved opt-in and permits explicit refresh", () => {
		const { rerender } = render(<CustomToolsSettings {...defaultProps} enabled />)
		expect(vscode.postMessage).not.toHaveBeenCalled()

		rerender(<CustomToolsSettings {...defaultProps} enabled committedEnabled />)
		expect(vscode.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "refreshCustomTools" })

		publishTools()
		expect(screen.getByText("project_tool")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "settings:customTools.refreshButton" }))
		expect(vscode.postMessage).toHaveBeenCalledTimes(2)
		expect(vscode.postMessage).toHaveBeenLastCalledWith({ type: "refreshCustomTools" })
	})

	it("does not load executable tools from a hidden settings-search mount", () => {
		const { rerender } = render(<CustomToolsSettings {...defaultProps} enabled committedEnabled isActive={false} />)
		expect(vscode.postMessage).not.toHaveBeenCalled()

		rerender(<CustomToolsSettings {...defaultProps} enabled committedEnabled />)
		expect(vscode.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "refreshCustomTools" })
	})

	it("ignores a late catalog response once host enablement has been revoked", () => {
		const { rerender } = render(<CustomToolsSettings {...defaultProps} enabled committedEnabled />)
		publishTools()
		expect(screen.getByText("project_tool")).toBeInTheDocument()

		rerender(<CustomToolsSettings {...defaultProps} enabled />)
		publishTools()

		expect(screen.queryByText("project_tool")).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "settings:customTools.refreshButton" })).not.toBeInTheDocument()
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)
	})

	it("keeps catalog loading and failures distinct from an empty catalog", () => {
		render(<CustomToolsSettings {...defaultProps} enabled committedEnabled />)
		expect(screen.queryByText("settings:customTools.noTools")).not.toBeInTheDocument()

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "customToolsResult", tools: [], error: "Source could not be loaded" },
				}),
			)
		})

		expect(screen.getByRole("alert")).toHaveTextContent("Source could not be loaded")
		expect(screen.queryByText("settings:customTools.noTools")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "settings:customTools.refreshButton" }))
		expect(screen.queryByRole("alert")).not.toBeInTheDocument()
		expect(vscode.postMessage).toHaveBeenCalledTimes(2)
	})

	it("keeps the executable warning visible while showing explanations and tool details on demand", async () => {
		render(<CustomToolsSettings {...defaultProps} enabled committedEnabled />)
		expect(screen.getByText("settings:customTools.executableWarning")).toBeInTheDocument()
		expect(screen.queryByText("settings:customTools.description")).not.toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: "settings:helpFor: settings:customTools.name" }))
		expect(screen.getByRole("dialog")).toHaveTextContent("settings:customTools.description")
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())

		publishTools()
		expect(screen.getByText("project_tool")).toBeInTheDocument()
		expect(screen.queryByText("Project tool description")).not.toBeInTheDocument()
		expect(screen.queryByText("F:/workspace/.alpha/tools/project_tool.ts")).not.toBeInTheDocument()
		expect(screen.queryByText("Number of items")).not.toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: "settings:helpFor: project_tool" }))
		const details = screen.getByRole("dialog")
		expect(details).toHaveTextContent("Project tool description")
		expect(details).toHaveTextContent("F:/workspace/.alpha/tools/project_tool.ts")
		expect(details).toHaveTextContent("count")
		expect(details).toHaveTextContent("Number of items")
		expect(vscode.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "refreshCustomTools" })
	})
})
