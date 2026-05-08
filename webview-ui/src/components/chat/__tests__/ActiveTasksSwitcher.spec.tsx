import { fireEvent, render, screen } from "@/utils/test-utils"
import type { LiveTaskSummary } from "@roo-code/types"

import { vscode } from "@src/utils/vscode"

import { ActiveTasksSwitcher } from "../ActiveTasksSwitcher"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const makeTask = (overrides: Partial<LiveTaskSummary>): LiveTaskSummary => ({
	id: "task-1",
	rootTaskId: "task-1",
	currentTaskId: "task-1",
	title: "Implement feature",
	status: "running",
	isFocused: false,
	isSubtask: false,
	unreadCount: 0,
	queueSize: 0,
	workspacePath: "/repo/main",
	isolation: { mode: "shared", workspacePath: "/repo/main" },
	createdAt: 1,
	updatedAt: 1,
	...overrides,
})

describe("ActiveTasksSwitcher", () => {
	beforeEach(() => {
		vi.mocked(vscode.postMessage).mockClear()
	})

	it("renders live task statuses, badges, workspace labels, and usage summaries", () => {
		render(
			<ActiveTasksSwitcher
				focusedTaskId="task-2"
				liveTasks={[
					makeTask({
						id: "task-1",
						currentTaskId: "task-1",
						title: "Background analysis",
						status: "interactive",
						unreadCount: 2,
						queueSize: 1,
						tokensIn: 1000,
						tokensOut: 500,
						totalCost: 0.1234,
					}),
					makeTask({
						id: "task-2",
						currentTaskId: "task-2",
						title: "Worktree task",
						status: "queued",
						isFocused: true,
						workspacePath: "/repo/worktrees/task-2",
						isolation: {
							mode: "worktree",
							workspacePath: "/repo/worktrees/task-2",
							branch: "task-2",
						},
					}),
				]}
			/>,
		)

		expect(screen.getByText("Background analysis")).toBeInTheDocument()
		expect(screen.getByText("Needs input")).toBeInTheDocument()
		expect(screen.getAllByText("2").length).toBeGreaterThan(0)
		expect(screen.getByText("Q 1")).toBeInTheDocument()
		expect(screen.getByText("1.5K tok / $0.1234")).toBeInTheDocument()
		expect(screen.getByText("Worktree task")).toBeInTheDocument()
		expect(screen.getByText("Queued")).toBeInTheDocument()
		expect(screen.getByText("task-2")).toBeInTheDocument()
	})

	it("focuses a background task and cancels with the selected task id", () => {
		render(
			<ActiveTasksSwitcher
				focusedTaskId="other-task"
				liveTasks={[makeTask({ id: "task-1", currentTaskId: "current-1" })]}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Focus task Implement feature/i }))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "focusTask", taskId: "current-1" })

		fireEvent.click(screen.getByLabelText("Cancel task"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "cancelTask", taskId: "current-1" })
	})

	it("returns the focused task to the pool from the switcher", () => {
		render(
			<ActiveTasksSwitcher
				focusedTaskId="current-1"
				liveTasks={[makeTask({ id: "task-1", currentTaskId: "current-1", isFocused: true })]}
			/>,
		)

		fireEvent.click(screen.getByLabelText("Return current task to pool"))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "dockTask", taskId: "current-1" })

		fireEvent.click(screen.getByRole("button", { name: /Return to pool Implement feature/i }))
		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "dockTask", taskId: "current-1" })
	})
})
