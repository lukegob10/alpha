import { expect } from "vitest"
import React from "react"
import { render, fireEvent, screen } from "@/utils/test-utils"

import { vscode } from "@src/utils/vscode"

import McpToolRow from "../McpToolRow"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: { label?: string }) => {
			if (key === "settings:helpFor") return `Help for ${options?.label}`
			const translations: Record<string, string> = {
				"mcp:tool.alwaysAllow": "Always allow",
				"mcp:tool.parameters": "Parameters",
				"mcp:tool.noDescription": "No description",
				"mcp:tool.enable": "Enable tool",
				"mcp:tool.enableDescription": "Disabled tools cannot be called.",
			}
			return translations[key] || key
		},
	}),
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: function MockVSCodeCheckbox({
		children,
		checked,
		onChange,
	}: {
		children?: React.ReactNode
		checked?: boolean
		onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
	}) {
		return (
			<label>
				<input type="checkbox" checked={checked} onChange={onChange} />
				{children}
			</label>
		)
	},
}))

describe("McpToolRow", () => {
	const mockTool = {
		name: "test-tool",
		description: "A test tool",
		alwaysAllow: false,
		enabledForPrompt: true,
	}

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("keeps the tool description in contextual help", () => {
		render(<McpToolRow tool={mockTool} />)

		expect(screen.getByText("test-tool")).toBeInTheDocument()
		expect(screen.queryByText("A test tool")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Help for test-tool" }))
		expect(screen.getByText("A test tool")).toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("does not show always allow checkbox when serverName is not provided", () => {
		render(<McpToolRow tool={mockTool} />)

		expect(screen.queryByText("Always allow")).not.toBeInTheDocument()
	})

	it("shows always allow checkbox when serverName and alwaysAllowMcp are provided", () => {
		render(<McpToolRow tool={mockTool} serverName="test-server" alwaysAllowMcp={true} />)

		expect(screen.getByText("Always allow")).toBeInTheDocument()
	})

	it("sends message to toggle always allow when checkbox is clicked", () => {
		render(<McpToolRow tool={mockTool} serverName="test-server" alwaysAllowMcp={true} />)

		const checkbox = screen.getByRole("checkbox")
		fireEvent.click(checkbox)

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "toggleToolAlwaysAllow",
			serverName: "test-server",
			toolName: "test-tool",
			alwaysAllow: true,
			source: "global",
		})
	})

	it("reflects always allow state in checkbox", () => {
		const alwaysAllowedTool = {
			...mockTool,
			alwaysAllow: true,
		}

		render(<McpToolRow tool={alwaysAllowedTool} serverName="test-server" alwaysAllowMcp={true} />)

		const checkbox = screen.getByRole("checkbox") as HTMLInputElement
		expect(checkbox.checked).toBe(true)
	})

	it("prevents event propagation when clicking the checkbox", () => {
		const mockOnClick = vi.fn()
		render(
			<div onClick={mockOnClick}>
				<McpToolRow tool={mockTool} serverName="test-server" alwaysAllowMcp={true} />
			</div>,
		)

		const container = screen.getByTestId("tool-row-container")
		fireEvent.click(container)

		expect(mockOnClick).not.toHaveBeenCalled()
	})

	it("shows input schema parameters on request", () => {
		const toolWithSchema = {
			...mockTool,
			inputSchema: {
				type: "object",
				properties: {
					param1: {
						type: "string",
						description: "First parameter",
					},
					param2: {
						type: "number",
						description: "Second parameter",
					},
				},
				required: ["param1"],
			},
		}

		render(<McpToolRow tool={toolWithSchema} serverName="test-server" />)

		expect(screen.queryByText("Parameters")).not.toBeInTheDocument()
		expect(screen.queryByText("First parameter")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Help for test-tool" }))
		expect(screen.getByText("Parameters")).toBeInTheDocument()
		expect(screen.getByText("param1")).toBeInTheDocument()
		expect(screen.getByText("param2")).toBeInTheDocument()
		expect(screen.getByText("First parameter")).toBeInTheDocument()
		expect(screen.getByText("Second parameter")).toBeInTheDocument()
	})

	it("shows toggle switch when serverName is provided and not in chat context", () => {
		render(<McpToolRow tool={mockTool} serverName="test-server" />)

		const toggleSwitch = screen.getByRole("switch", { name: "Enable tool" })
		expect(toggleSwitch).toBeInTheDocument()
	})

	it("hides toggle switch when isInChatContext is true", () => {
		render(<McpToolRow tool={mockTool} serverName="test-server" isInChatContext={true} />)

		const toggleSwitch = screen.queryByRole("switch", { name: "Enable tool" })
		expect(toggleSwitch).not.toBeInTheDocument()
	})

	it("shows correct toggle switch state based on enabledForPrompt", () => {
		// Test when enabled (should be checked)
		const { rerender } = render(<McpToolRow tool={mockTool} serverName="test-server" />)

		let toggleSwitch = screen.getByRole("switch", { name: "Enable tool" })
		expect(toggleSwitch).toHaveAttribute("aria-checked", "true")

		// Test when disabled (should not be checked)
		const disabledTool = { ...mockTool, enabledForPrompt: false }
		rerender(<McpToolRow tool={disabledTool} serverName="test-server" />)

		toggleSwitch = screen.getByRole("switch", { name: "Enable tool" })
		expect(toggleSwitch).toHaveAttribute("aria-checked", "false")
	})

	it("sends message to toggle enabledForPrompt when toggle switch is clicked", () => {
		render(<McpToolRow tool={mockTool} serverName="test-server" />)

		const toggleSwitch = screen.getByRole("switch", { name: "Enable tool" })
		fireEvent.click(toggleSwitch)

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "toggleToolEnabledForPrompt",
			serverName: "test-server",
			source: "global",
			toolName: "test-tool",
			isEnabled: false,
		})
	})

	it("disables a tool whose enabled state uses the default", () => {
		render(<McpToolRow tool={{ name: "default-enabled" }} serverName="test-server" serverSource="project" />)
		const toggleSwitch = screen.getByRole("switch", { name: "Enable tool" })
		expect(toggleSwitch).toHaveAttribute("aria-checked", "true")

		fireEvent.click(toggleSwitch)

		expect(vscode.postMessage).toHaveBeenCalledExactlyOnceWith({
			type: "toggleToolEnabledForPrompt",
			serverName: "test-server",
			source: "project",
			toolName: "default-enabled",
			isEnabled: false,
		})
	})

	it("hides always allow checkbox when tool is disabled", () => {
		const disabledTool = { ...mockTool, enabledForPrompt: false }
		render(<McpToolRow tool={disabledTool} serverName="test-server" alwaysAllowMcp={true} />)

		expect(screen.queryByText("Always allow")).not.toBeInTheDocument()
	})

	it("shows always allow checkbox when tool is enabled", () => {
		const enabledTool = { ...mockTool, enabledForPrompt: true }
		render(<McpToolRow tool={enabledTool} serverName="test-server" alwaysAllowMcp={true} />)

		expect(screen.getByText("Always allow")).toBeInTheDocument()
	})

	it("hides parameters section when tool is disabled", () => {
		const disabledToolWithSchema = {
			...mockTool,
			enabledForPrompt: false,
			inputSchema: {
				type: "object",
				properties: {
					param1: {
						type: "string",
						description: "First parameter",
					},
				},
				required: ["param1"],
			},
		}

		render(<McpToolRow tool={disabledToolWithSchema} serverName="test-server" />)

		fireEvent.click(screen.getByRole("button", { name: "Help for test-tool" }))
		expect(screen.queryByText("Parameters")).not.toBeInTheDocument()
		expect(screen.queryByText("param1")).not.toBeInTheDocument()
		expect(screen.queryByText("First parameter")).not.toBeInTheDocument()
	})

	it("shows parameters section when tool is enabled", () => {
		const enabledToolWithSchema = {
			...mockTool,
			enabledForPrompt: true,
			inputSchema: {
				type: "object",
				properties: {
					param1: {
						type: "string",
						description: "First parameter",
					},
				},
				required: ["param1"],
			},
		}

		render(<McpToolRow tool={enabledToolWithSchema} serverName="test-server" />)

		fireEvent.click(screen.getByRole("button", { name: "Help for test-tool" }))
		expect(screen.getByText("Parameters")).toBeInTheDocument()
		expect(screen.getByText("param1")).toBeInTheDocument()
		expect(screen.getByText("First parameter")).toBeInTheDocument()
	})

	it("marks disabled tools while keeping their help readable", () => {
		const disabledTool = {
			...mockTool,
			enabledForPrompt: false,
			description: "A disabled tool",
		}
		render(<McpToolRow tool={disabledTool} serverName="test-server" />)

		const toolName = screen.getByText("test-tool")
		expect(toolName).toHaveClass("text-vscode-descriptionForeground", "opacity-60")
		expect(screen.queryByText("A disabled tool")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Help for test-tool" }))
		expect(screen.getByText("A disabled tool")).toBeVisible()
	})

	it("marks enabled tools without expanding their descriptions", () => {
		const enabledTool = {
			...mockTool,
			enabledForPrompt: true,
			description: "An enabled tool",
		}
		render(<McpToolRow tool={enabledTool} serverName="test-server" />)

		const toolName = screen.getByText("test-tool")

		expect(toolName).toHaveClass("text-vscode-foreground")
		expect(toolName).not.toHaveClass("text-vscode-descriptionForeground", "opacity-60")
		expect(screen.queryByText("An enabled tool")).not.toBeInTheDocument()
	})
})
