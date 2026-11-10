import { expect } from "vitest"
import { useState, type ChangeEvent, type HTMLAttributes, type ReactNode } from "react"
import type { McpServer } from "@alpha-code/types"

import { fireEvent, render, screen } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"

import McpView from "../McpView"

const mockMcpState = vi.hoisted(() => {
	const server: McpServer = {
		name: "Existing MCP",
		config: '{"command":"node","args":["server.js"]}',
		status: "connected",
		source: "project",
		tools: [{ name: "lookup", enabledForPrompt: true, alwaysAllow: false }],
		resources: [],
		resourceTemplates: [],
	}
	return { alwaysAllowMcp: false, approvalMode: "auto" as const, mcpServers: [server] }
})

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: { label?: string }) =>
			key === "settings:helpFor" ? `Help for ${options?.label}` : key,
	}),
}))
vi.mock("@src/hooks/useTooManyTools", () => ({
	useTooManyTools: () => ({ isOverThreshold: false, title: "", message: "" }),
}))
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockMcpState,
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, href }: { children?: ReactNode; href?: string }) => <a href={href}>{children}</a>,
	VSCodePanels: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	VSCodePanelTab: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => (
		<div role="tab" {...props}>
			{children}
		</div>
	),
	VSCodePanelView: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => (
		<div role="tabpanel" {...props}>
			{children}
		</div>
	),
	VSCodeCheckbox: ({
		children,
		checked,
		disabled,
		onChange,
	}: {
		children?: ReactNode
		checked?: boolean
		disabled?: boolean
		onChange?: (event: ChangeEvent<HTMLInputElement>) => void
	}) => (
		<label>
			<input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
			{children}
		</label>
	),
}))

describe("MCP settings without Marketplace", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockMcpState.alwaysAllowMcp = false
		mockMcpState.mcpServers.length = 1
		mockMcpState.mcpServers[0].status = "connected"
		delete mockMcpState.mcpServers[0].error
	})

	it("keeps configured servers and global, project, and refresh actions available", () => {
		render(<McpView mcpEnabled onMcpEnabledChange={vi.fn()} />)

		expect(screen.getByText("Existing MCP")).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: /marketplace/i })).not.toBeInTheDocument()
		for (const [label, type] of [
			["mcp:editGlobalMCP", "openMcpSettings"],
			["mcp:editProjectMCP", "openProjectMcpSettings"],
			["mcp:refreshMCP", "refreshAllMcpServers"],
		]) {
			fireEvent.click(screen.getByRole("button", { name: label }))
			expect(vscode.postMessage).toHaveBeenLastCalledWith({ type })
		}
	})

	it("keeps MCP enablement in the owning settings edit buffer", () => {
		const onMcpEnabledChange = vi.fn()
		render(<McpView mcpEnabled onMcpEnabledChange={onMcpEnabledChange} />)
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.click(screen.getByRole("switch", { name: "mcp:enableToggle.title" }))

		expect(onMcpEnabledChange).toHaveBeenCalledTimes(1)
		expect(onMcpEnabledChange).toHaveBeenCalledWith(false)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("keeps management and enablement explanations behind contextual help", () => {
		render(<McpView mcpEnabled onMcpEnabledChange={vi.fn()} onAlwaysAllowMcpChange={vi.fn()} />)
		expect(screen.queryByText("mcp:managementDescription")).not.toBeInTheDocument()
		expect(screen.queryByText("mcp:enableToggle.description")).not.toBeInTheDocument()
		expect(screen.queryByText("settings:autoApprove.mcp.description")).not.toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: "Help for mcp:title" }))
		expect(screen.getByRole("dialog", { name: "Help for mcp:title" })).toHaveTextContent(
			"mcp:managementDescription",
		)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("uses the settings draft to reveal tool grants without committing permissions", () => {
		function SettingsDraft() {
			const [alwaysAllowMcp, setAlwaysAllowMcp] = useState(false)
			return (
				<McpView
					mcpEnabled
					onMcpEnabledChange={vi.fn()}
					alwaysAllowMcp={alwaysAllowMcp}
					onAlwaysAllowMcpChange={setAlwaysAllowMcp}
				/>
			)
		}
		render(<SettingsDraft />)
		fireEvent.click(screen.getByRole("button", { name: "mcp:serverActions.showDetails" }))
		expect(screen.queryByRole("checkbox", { name: "mcp:tool.alwaysAllow" })).not.toBeInTheDocument()

		fireEvent.click(screen.getByRole("checkbox", { name: "settings:autoApprove.mcp.label" }))

		expect(screen.getByRole("checkbox", { name: "mcp:tool.alwaysAllow" })).not.toBeChecked()
		expect(mockMcpState.alwaysAllowMcp).toBe(false)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("respects a disabled draft grant gate when committed grants are enabled", () => {
		mockMcpState.alwaysAllowMcp = true
		render(<McpView mcpEnabled onMcpEnabledChange={vi.fn()} alwaysAllowMcp={false} />)
		fireEvent.click(screen.getByRole("button", { name: "mcp:serverActions.showDetails" }))

		expect(screen.queryByRole("checkbox", { name: "mcp:tool.alwaysAllow" })).not.toBeInTheDocument()
	})

	it("keeps server inspection and configuration available while MCP is off", () => {
		mockMcpState.mcpServers[0].status = "disconnected"
		render(<McpView mcpEnabled={false} onMcpEnabledChange={vi.fn()} />)

		expect(screen.getByText("Existing MCP")).toBeInTheDocument()
		expect(screen.queryByText("mcp:disabledDescription")).not.toBeInTheDocument()
		expect(screen.queryByText("mcp:managementDescription")).not.toBeInTheDocument()
		expect(screen.getByRole("button", { name: "mcp:refreshMCP" })).toBeDisabled()
		expect(screen.getByRole("button", { name: "mcp:serverActions.restart" })).toBeDisabled()
		fireEvent.click(screen.getByRole("button", { name: "mcp:serverActions.showDetails" }))
		expect(screen.getByText("lookup")).toBeInTheDocument()
		fireEvent.click(screen.getByText("mcp:advancedSettings"))
		expect(screen.getByRole("combobox", { name: "mcp:networkTimeout.label" })).toHaveValue("60")
		fireEvent.click(screen.getByRole("button", { name: "mcp:editProjectMCP" }))
		expect(vscode.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "openProjectMcpSettings" })
	})

	it("keeps connection errors visible without opening help or details", () => {
		mockMcpState.mcpServers[0].status = "disconnected"
		mockMcpState.mcpServers[0].error = "Sign in to reconnect"
		render(<McpView mcpEnabled onMcpEnabledChange={vi.fn()} />)

		expect(screen.getByText("Sign in to reconnect")).toBeVisible()
		expect(screen.getByRole("button", { name: "mcp:serverStatus.retryConnection" })).toBeEnabled()
		expect(screen.getByRole("button", { name: "mcp:serverActions.showDetails" })).toHaveAttribute(
			"aria-expanded",
			"false",
		)
	})

	it("explains the Full Access override without changing stored grants", () => {
		const onAlwaysAllowMcpChange = vi.fn()
		render(
			<McpView
				mcpEnabled
				onMcpEnabledChange={vi.fn()}
				alwaysAllowMcp={false}
				onAlwaysAllowMcpChange={onAlwaysAllowMcpChange}
				approvalMode="bypass"
			/>,
		)

		expect(screen.getByRole("checkbox", { name: "settings:autoApprove.mcp.label" })).toBeDisabled()
		expect(screen.queryByText("settings:autoApprove.mcp.bypassDescription")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Help for settings:autoApprove.mcp.label" }))
		expect(screen.getByText("settings:autoApprove.mcp.bypassDescription")).toBeInTheDocument()
		expect(onAlwaysAllowMcpChange).not.toHaveBeenCalled()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("keeps panel identities and labels distinct across expanded servers", () => {
		mockMcpState.mcpServers.push({
			...mockMcpState.mcpServers[0],
			name: "Another MCP",
			source: "global",
			instructions: "Server instructions",
		})
		const { rerender } = render(<McpView mcpEnabled onMcpEnabledChange={vi.fn()} />)
		for (const button of screen.getAllByRole("button", { name: "mcp:serverActions.showDetails" })) {
			fireEvent.click(button)
		}
		const tabs = screen.getAllByRole("tab")
		const panels = screen.getAllByRole("tabpanel")
		const ids = [...tabs, ...panels].map((element) => element.id)
		expect(tabs).toHaveLength(7)
		expect(panels).toHaveLength(7)
		expect(ids.every(Boolean)).toBe(true)
		expect(new Set(ids).size).toBe(ids.length)
		for (const tab of tabs) {
			const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "")
			expect(panel).toHaveAttribute("role", "tabpanel")
			expect(panel).toHaveAttribute("aria-labelledby", tab.id)
		}

		rerender(<McpView mcpEnabled onMcpEnabledChange={vi.fn()} alwaysAllowMcp />)
		expect(
			[...screen.getAllByRole("tab"), ...screen.getAllByRole("tabpanel")].map((element) => element.id),
		).toEqual(ids)
	})
})
