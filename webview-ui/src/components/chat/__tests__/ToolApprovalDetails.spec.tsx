import { render, screen } from "@/utils/test-utils"
import "@src/i18n/setup"
import { ToolApprovalDetails, isTaskOperationApproval } from "../ToolApprovalDetails"

describe("ToolApprovalDetails", () => {
	it.each(["create_task", "send_task_message", "steer_task", "stop_task", "followupTask"])(
		"shows the reviewable %s payload",
		(tool) => {
			const text = JSON.stringify({
				tool,
				taskId: "recipient-42",
				objective: "Inspect parser",
				message: "Please check <script> before replying",
				workspaceMode: "worktree",
				reason: "Review dependencies",
			})
			expect(isTaskOperationApproval(text)).toBe(true)
			const { container } = render(<ToolApprovalDetails text={text} />)
			expect(screen.getByRole("note")).toHaveTextContent("recipient-42")
			expect(screen.getByText("Inspect parser")).toBeInTheDocument()
			expect(screen.getByText("Please check <script> before replying")).toBeInTheDocument()
			expect(screen.getByText("worktree")).toBeInTheDocument()
			expect(container.querySelector("script")).toBeNull()
		},
	)

	it.each([undefined, "running"])("recognizes a list-pages approval with status %s", (status) => {
		const text = JSON.stringify({ tool: "browserAction", action: "list_browser_pages", status })
		render(<ToolApprovalDetails text={text} isPending />)

		expect(screen.getByText("List browser pages")).toBeInTheDocument()
		expect(screen.getByText("Awaiting browser approval")).toBeInTheDocument()
		expect(screen.queryByText(text)).not.toBeInTheDocument()
	})

	it("keeps historical approval details as plain text", () => {
		const code = 'const value = "<script>"\nconsole.log(value)'
		const { container, rerender } = render(
			<ToolApprovalDetails
				text={JSON.stringify({ tool: "browserAction", action: "run_playwright_code", pageId: "page-42", code })}
			/>,
		)

		expect(screen.getByText("Run browser automation")).toBeInTheDocument()
		expect(screen.getByText("Browser approval request")).toBeInTheDocument()
		expect(screen.queryByText("Awaiting browser approval")).not.toBeInTheDocument()
		expect(screen.getByText("page-42")).toBeInTheDocument()
		expect(screen.getByText(code, { normalizer: (value) => value })).toBeInTheDocument()
		expect(container.querySelector("script")).toBeNull()

		const files = ["/workspace/example A.txt", "/workspace/example B.txt"]
		rerender(
			<ToolApprovalDetails
				text={JSON.stringify({ tool: "browserAction", action: "handle_dialog", selectFiles: files })}
			/>,
		)
		expect(screen.getByText("Handle browser dialog")).toBeInTheDocument()
		expect(screen.getByText("Files to share")).toBeInTheDocument()
		expect(screen.getByText(files.join("\n"), { normalizer: (value) => value })).toBeInTheDocument()
	})

	it("keeps unknown and malformed operation details readable", () => {
		const text = '{"tool":"futureOperation","payload":"review me"}'
		const { rerender } = render(<ToolApprovalDetails text={text} />)
		expect(screen.getByText(text)).toBeInTheDocument()
		rerender(<ToolApprovalDetails text="Malformed operation payload" />)
		expect(screen.getByText("Malformed operation payload")).toBeInTheDocument()
	})
})
