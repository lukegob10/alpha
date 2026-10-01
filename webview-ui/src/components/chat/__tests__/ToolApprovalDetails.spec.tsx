import { render, screen } from "@/utils/test-utils"
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
	it("keeps unknown and malformed operation details readable", () => {
		const text = '{"tool":"futureOperation","payload":"review me"}'
		const { rerender } = render(<ToolApprovalDetails text={text} />)
		expect(screen.getByText(text)).toBeInTheDocument()
		rerender(<ToolApprovalDetails text="Malformed operation payload" />)
		expect(screen.getByText("Malformed operation payload")).toBeInTheDocument()
	})
})
