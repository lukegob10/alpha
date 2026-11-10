import { waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { render, screen } from "@/utils/test-utils"

import McpView from "../McpView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock("@src/hooks/useTooManyTools", () => ({
	useTooManyTools: () => ({ isOverThreshold: false, title: "", message: "" }),
}))
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ mcpServers: [], alwaysAllowMcp: false, approvalMode: "auto" }),
}))

describe("MCP grants with the real VS Code checkbox", () => {
	it("does not turn controlled MCP availability refreshes into edits", () => {
		const onMcpEnabledChange = vi.fn()
		const { rerender } = render(<McpView mcpEnabled={false} onMcpEnabledChange={onMcpEnabledChange} />)
		rerender(<McpView mcpEnabled onMcpEnabledChange={onMcpEnabledChange} />)
		rerender(<McpView mcpEnabled={false} onMcpEnabledChange={onMcpEnabledChange} />)

		expect(screen.getByRole("switch", { name: "mcp:enableToggle.title" })).toHaveAttribute("aria-checked", "false")
		expect(onMcpEnabledChange).not.toHaveBeenCalled()
	})

	it("does not turn a Full Access presentation override into a saved grant", async () => {
		const onAlwaysAllowMcpChange = vi.fn()
		const props = { mcpEnabled: false, onMcpEnabledChange: vi.fn(), alwaysAllowMcp: false, onAlwaysAllowMcpChange }
		const { rerender } = render(<McpView {...props} approvalMode="auto" />)
		const checkbox = screen.getByRole("checkbox", { name: "settings:autoApprove.mcp.label" })
		expect(checkbox).toHaveProperty("checked", false)

		rerender(<McpView {...props} approvalMode="bypass" />)
		await waitFor(() => expect(checkbox).toHaveProperty("checked", true))
		expect(checkbox).toHaveProperty("disabled", true)
		expect(onAlwaysAllowMcpChange).not.toHaveBeenCalled()

		rerender(<McpView {...props} approvalMode="auto" />)
		await waitFor(() => expect(checkbox).toHaveProperty("checked", false))
		expect(onAlwaysAllowMcpChange).not.toHaveBeenCalled()
	})

	it("does not turn a controlled saved-grant refresh into an edit", async () => {
		const onAlwaysAllowMcpChange = vi.fn()
		const props = { mcpEnabled: false, onMcpEnabledChange: vi.fn(), onAlwaysAllowMcpChange }
		const { rerender } = render(<McpView {...props} alwaysAllowMcp={false} approvalMode="auto" />)
		const checkbox = screen.getByRole("checkbox", { name: "settings:autoApprove.mcp.label" })

		rerender(<McpView {...props} alwaysAllowMcp approvalMode="auto" />)
		await waitFor(() => expect(checkbox).toHaveProperty("checked", true))
		rerender(<McpView {...props} alwaysAllowMcp={false} approvalMode="auto" />)
		await waitFor(() => expect(checkbox).toHaveProperty("checked", false))

		expect(onAlwaysAllowMcpChange).not.toHaveBeenCalled()
	})
})
