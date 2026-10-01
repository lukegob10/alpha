import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { TaskLifecycleState, TaskStatus, type HistoryItem, type LiveTaskMetadata } from "@alpha-code/types"

import { vscode } from "@src/utils/vscode"

import { CrossTaskPanel } from "../CrossTaskPanel"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const makeHistoryItem = (
	id: string,
	parentTaskId: string,
	task: string,
	status: HistoryItem["status"] = "active",
): HistoryItem => ({
	id,
	orchestrationParentTaskId: parentTaskId,
	orchestrationWorkspaceMode: "shared",
	number: 1,
	ts: 100,
	task,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	status,
})

const makeLiveTask = (id: string, parentTaskId: string): LiveTaskMetadata => ({
	id,
	orchestrationParentTaskId: parentTaskId,
	orchestrationWorkspaceMode: "worktree",
	status: TaskStatus.Running,
	lifecycle: TaskLifecycleState.Running,
	isActive: false,
	isStreaming: true,
	isWaitingForInput: false,
	lastUpdatedAt: 200,
	queueCount: 0,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
})

describe("CrossTaskPanel", () => {
	beforeEach(() => vi.mocked(vscode.postMessage).mockClear())

	it("shows the owning task's child, reflects live status, opens it, and stops it", () => {
		const onOpen = vi.fn()
		render(
			<CrossTaskPanel
				parentTaskId="parent-1"
				taskHistory={[
					makeHistoryItem("child-1", "parent-1", "Parse the AST"),
					makeHistoryItem("child-2", "parent-1", "Completed inspection", "completed"),
					makeHistoryItem("child-3", "parent-1", "Stopped inspection", "interrupted"),
					makeHistoryItem("unrelated", "parent-2", "Private sibling task"),
				]}
				liveTasksById={{ "child-1": makeLiveTask("child-1", "parent-1") }}
				onOpen={onOpen}
			/>,
		)

		expect(screen.getByRole("navigation", { name: "crossTasks.title" })).toBeInTheDocument()
		expect(screen.getByText("Parse the AST")).toBeInTheDocument()
		expect(screen.getByText("Completed inspection")).toBeInTheDocument()
		expect(screen.getByText("Stopped inspection")).toBeInTheDocument()
		expect(screen.queryByText("Private sibling task")).not.toBeInTheDocument()
		expect(screen.queryByText("crossTasks.workspace.worktree")).not.toBeInTheDocument()
		expect(screen.queryByText("crossTasks.thread 5")).not.toBeInTheDocument()

		fireEvent.click(screen.getAllByRole("button", { name: "crossTasks.openTask" })[0])
		expect(onOpen).toHaveBeenCalledWith("child-1")
		fireEvent.click(screen.getByRole("button", { name: "crossTasks.stopTask" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "stopIndependentTask",
			parentTaskId: "parent-1",
			taskId: "child-1",
		})
		expect(screen.getAllByRole("button", { name: "crossTasks.openTask" })).toHaveLength(3)
		expect(screen.getAllByRole("button", { name: "crossTasks.stopTask" })).toHaveLength(1)
	})

	it("keeps every thread link in stable task-ID order", () => {
		const onOpen = vi.fn()
		const taskHistory = Array.from({ length: 10 }, (_, index) =>
			makeHistoryItem(
				`child-${String(10 - index).padStart(2, "0")}`,
				"parent-1",
				`Objective ${index}`,
				"completed",
			),
		)
		const { rerender } = render(
			<CrossTaskPanel parentTaskId="parent-1" taskHistory={taskHistory} onOpen={onOpen} />,
		)
		expect(screen.getAllByRole("button", { name: "crossTasks.openTask" })).toHaveLength(10)
		expect(screen.getByText("Objective 9")).toBeInTheDocument()
		rerender(<CrossTaskPanel parentTaskId="parent-1" taskHistory={[...taskHistory].reverse()} onOpen={onOpen} />)
		fireEvent.click(screen.getAllByRole("button", { name: "crossTasks.openTask" })[0])
		expect(onOpen).toHaveBeenCalledWith("child-01")
	})
})
