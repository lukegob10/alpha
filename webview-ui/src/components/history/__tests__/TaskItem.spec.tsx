import { render, screen, fireEvent } from "@/utils/test-utils"
import { TaskLifecycleState, TaskStatus, type LiveTaskMetadata } from "@roo-code/types"
import { ExtensionStateContext } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"

import TaskItem from "../TaskItem"

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@/utils/format", () => ({
	formatTimeAgo: vi.fn(() => "2 hours ago"),
	formatDate: vi.fn(() => "January 15 at 2:30 PM"),
	formatLargeNumber: vi.fn((num: number) => num.toString()),
}))

const mockTask = {
	id: "1",
	number: 1,
	task: "Test task",
	ts: Date.now(),
	tokensIn: 100,
	tokensOut: 50,
	totalCost: 0.002,
	workspace: "/test/workspace",
}

const liveTask = (overrides: Partial<LiveTaskMetadata>): LiveTaskMetadata => ({
	id: "1",
	status: TaskStatus.Running,
	lifecycle: TaskLifecycleState.Running,
	isActive: false,
	isStreaming: true,
	isWaitingForInput: false,
	lastUpdatedAt: Date.now(),
	queueCount: 0,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...overrides,
})

describe("TaskItem", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders task information", () => {
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		expect(screen.getByText("Test task")).toBeInTheDocument()
		expect(screen.getByText("$0.00")).toBeInTheDocument() // Component shows $0.00 for small amounts
	})

	it("handles selection in selection mode", () => {
		const onToggleSelection = vi.fn()
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={onToggleSelection}
				isSelectionMode={true}
			/>,
		)

		const checkbox = screen.getByRole("checkbox")
		fireEvent.click(checkbox)

		expect(onToggleSelection).toHaveBeenCalledWith("1", true)
	})

	it("shows action buttons", () => {
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		// Should show copy and export buttons
		expect(screen.getByTestId("copy-prompt-button")).toBeInTheDocument()
		expect(screen.getByTestId("export")).toBeInTheDocument()
	})

	it("displays time ago information", () => {
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		// Should display time ago format
		expect(screen.getByText(/ago/)).toBeInTheDocument()
	})

	it("applies hover effect class", () => {
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		const taskItem = screen.getByTestId("task-item-1")
		expect(taskItem).toHaveClass("hover:text-vscode-foreground")
	})

	it("opens the task when the row is clicked", () => {
		render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		fireEvent.click(screen.getByTestId("task-item-1"))

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "1" })
	})

	it("shows waiting live tasks as a static status dot", () => {
		const { container } = render(
			<ExtensionStateContext.Provider
				value={
					{
						currentTaskId: "1",
						liveTasksById: {
							"1": liveTask({
								lifecycle: TaskLifecycleState.Waiting,
								status: TaskStatus.Idle,
								isStreaming: false,
								waitingReason: "idle",
							}),
						},
					} as any
				}>
				<TaskItem
					item={mockTask}
					variant="full"
					isSelected={false}
					onToggleSelection={vi.fn()}
					isSelectionMode={false}
				/>
			</ExtensionStateContext.Provider>,
		)

		const indicator = screen.getByTestId("task-status-indicator")
		expect(indicator).toHaveAttribute("aria-label", "Task status: Idle")
		expect(container.querySelector(".animate-spin")).not.toBeInTheDocument()
	})

	it("shows completed live tasks as a static complete status", () => {
		render(
			<ExtensionStateContext.Provider
				value={
					{
						currentTaskId: undefined,
						liveTasksById: {
							"1": liveTask({
								lifecycle: TaskLifecycleState.Completed,
								status: TaskStatus.None,
								isStreaming: false,
							}),
						},
					} as any
				}>
				<TaskItem
					item={mockTask}
					variant="full"
					isSelected={false}
					onToggleSelection={vi.fn()}
					isSelectionMode={false}
				/>
			</ExtensionStateContext.Provider>,
		)

		expect(screen.getByTestId("task-status-indicator")).toHaveAttribute("aria-label", "Task status: Complete")
	})
})
