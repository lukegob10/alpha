import type { ChangeEvent, ReactNode } from "react"
import type { McpServer } from "@alpha-code/types"

import { fireEvent, render, screen } from "@/utils/test-utils"
import { vscode } from "@src/utils/vscode"

import McpView from "../McpView"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock("@src/hooks/useTooManyTools", () => ({
	useTooManyTools: () => ({ isOverThreshold: false, title: "", message: "" }),
}))
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		alwaysAllowMcp: false,
		mcpServers: [
			{
				name: "Existing MCP",
				config: '{"command":"node","args":["server.js"]}',
				status: "connected",
				source: "project",
				tools: [],
				resources: [],
				resourceTemplates: [],
			} satisfies McpServer,
		],
	}),
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, href }: { children?: ReactNode; href?: string }) => <a href={href}>{children}</a>,
	VSCodeCheckbox: ({
		children,
		checked,
		onChange,
	}: {
		children?: ReactNode
		checked?: boolean
		onChange?: (event: ChangeEvent<HTMLInputElement>) => void
	}) => (
		<label>
			<input type="checkbox" checked={checked} onChange={onChange} />
			{children}
		</label>
	),
}))

describe("MCP settings without Marketplace", () => {
	beforeEach(() => vi.clearAllMocks())

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

		fireEvent.click(screen.getByRole("checkbox", { name: "mcp:enableToggle.title" }))

		expect(onMcpEnabledChange).toHaveBeenCalledTimes(1)
		expect(onMcpEnabledChange).toHaveBeenCalledWith(false)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
})
