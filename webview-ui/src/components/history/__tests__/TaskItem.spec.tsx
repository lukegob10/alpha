import { act, render, screen, fireEvent } from "@/utils/test-utils"
import { TaskLifecycleState, TaskStatus, type LiveTaskMetadata } from "@alpha-code/types"
import { ExtensionStateContext, type ExtensionStateContextType } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"

import TaskItem from "../TaskItem"
import { TASK_OPENING_FEEDBACK_TIMEOUT_MS } from "../useTaskOpeningFeedback"

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
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

const taskWithLiveMetadata = (metadata: LiveTaskMetadata | undefined, variant: "compact" | "full" = "compact") => (
	<ExtensionStateContext.Provider
		value={
			{
				currentTaskId: undefined,
				liveTasksById: metadata ? { [metadata.id]: metadata } : {},
				getCachedTranscriptRevision: () => undefined,
			} as unknown as ExtensionStateContextType
		}>
		<TaskItem item={mockTask} variant={variant} />
	</ExtensionStateContext.Provider>
)

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

	it("selects compact rows with a checkbox or keyboard without opening the chat", () => {
		const onToggleSelection = vi.fn()
		const { rerender } = render(
			<TaskItem item={mockTask} variant="compact" isSelectionMode onToggleSelection={onToggleSelection} />,
		)
		const row = screen.getByTestId("task-item-1")
		const checkbox = screen.getByRole("checkbox")
		fireEvent.click(checkbox)
		expect(onToggleSelection).toHaveBeenCalledTimes(1)
		expect(onToggleSelection).toHaveBeenLastCalledWith("1", true)
		fireEvent.keyDown(row, { key: "Enter" })
		expect(onToggleSelection).toHaveBeenCalledTimes(2)
		fireEvent.keyDown(checkbox, { key: "Enter" })
		expect(onToggleSelection).toHaveBeenCalledTimes(2)
		rerender(
			<TaskItem
				item={mockTask}
				variant="compact"
				isSelectionMode
				isSelected
				onToggleSelection={onToggleSelection}
			/>,
		)
		expect(checkbox).toBeChecked()
		expect(row).toHaveAttribute("aria-pressed", "true")
		fireEvent.keyDown(row, { key: " " })
		expect(onToggleSelection).toHaveBeenLastCalledWith("1", false)
		rerender(<TaskItem item={mockTask} variant="compact" isSelectionMode />)
		fireEvent.click(row)
		expect(vscode.postMessage).not.toHaveBeenCalled()
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

	it("uses the compact metadata slot for the saved task age when there is no live status", () => {
		render(<TaskItem item={mockTask} variant="compact" />)
		const metadata = screen.getByTestId("task-metadata")
		const age = screen.getByTestId("task-time-ago")

		expect(metadata).toHaveClass("w-12", "justify-end")
		expect(age).toHaveClass("w-12", "text-right")
		expect(metadata.children).toHaveLength(1)
		expect(screen.queryByTestId("task-status-indicator")).not.toBeInTheDocument()
	})

	it.each([
		TaskLifecycleState.Initializing,
		TaskLifecycleState.Running,
		TaskLifecycleState.Waiting,
		TaskLifecycleState.Completed,
		TaskLifecycleState.Failed,
	])("replaces the compact timestamp with live %s status in the same slot", (lifecycle) => {
		render(taskWithLiveMetadata(liveTask({ lifecycle })))
		const metadata = screen.getByTestId("task-metadata")

		expect(metadata).toHaveClass("w-12", "justify-end")
		expect(metadata.children).toHaveLength(1)
		expect(metadata).toContainElement(screen.getByTestId("task-status-indicator"))
		expect(screen.queryByTestId("task-time-ago")).not.toBeInTheDocument()
	})

	it("restores the compact timestamp when live session metadata is removed", () => {
		const { rerender } = render(taskWithLiveMetadata(liveTask({})))
		expect(screen.queryByTestId("task-time-ago")).not.toBeInTheDocument()

		rerender(taskWithLiveMetadata(undefined))
		expect(screen.queryByTestId("task-status-indicator")).not.toBeInTheDocument()
		expect(screen.getByTestId("task-metadata")).toContainElement(screen.getByTestId("task-time-ago"))
		expect(screen.getByTestId("task-metadata").children).toHaveLength(1)
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

	it("lets a containing task group own the shared card surface", () => {
		render(
			<TaskItem
				item={mockTask}
				variant="compact"
				contained
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		const taskItem = screen.getByTestId("task-item-1")
		expect(taskItem).toHaveAttribute("data-contained", "true")
		expect(taskItem).not.toHaveClass("surface-raised")
	})

	it("opens the task when the row is clicked", () => {
		vi.useFakeTimers()
		const { unmount } = render(
			<TaskItem
				item={mockTask}
				variant="full"
				isSelected={false}
				onToggleSelection={vi.fn()}
				isSelectionMode={false}
			/>,
		)

		try {
			const taskItem = screen.getByTestId("task-item-1")
			fireEvent.click(taskItem)
			fireEvent.click(taskItem)

			expect(vscode.postMessage).toHaveBeenCalledWith({ type: "showTaskWithId", text: "1" })
			expect(vscode.postMessage).toHaveBeenCalledTimes(1)
			expect(taskItem).toHaveAttribute("aria-busy", "true")
			expect(screen.getByTestId("task-opening-indicator")).toBeInTheDocument()

			act(() => vi.advanceTimersByTime(TASK_OPENING_FEEDBACK_TIMEOUT_MS))
			expect(taskItem).toHaveAttribute("aria-busy", "false")
			expect(screen.queryByTestId("task-opening-indicator")).not.toBeInTheDocument()

			fireEvent.click(taskItem)
			expect(vscode.postMessage).toHaveBeenCalledTimes(2)
		} finally {
			unmount()
			vi.useRealTimers()
		}
	})

	it("clears opening feedback when the host acknowledges the task", async () => {
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
		fireEvent.click(taskItem)
		expect(taskItem).toHaveAttribute("aria-busy", "true")

		await act(async () => {
			window.dispatchEvent(
				new MessageEvent("message", { data: { type: "taskOpenResult", taskId: "1", success: true } }),
			)
		})

		expect(taskItem).toHaveAttribute("aria-busy", "false")
		expect(screen.queryByTestId("task-opening-indicator")).not.toBeInTheDocument()
	})

	describe.each(["compact", "full"] as const)("%s task status", (variant) => {
		it.each([
			{ lifecycle: TaskLifecycleState.Initializing, isStreaming: false, label: "Starting" },
			{ lifecycle: TaskLifecycleState.Running, isStreaming: true, label: "Running" },
			{ lifecycle: TaskLifecycleState.Running, isStreaming: false, label: "Active" },
		])("shows a spinner for background $label tasks", ({ lifecycle, isStreaming, label }) => {
			render(taskWithLiveMetadata(liveTask({ lifecycle, isStreaming }), variant))

			const indicator = screen.getByTestId("task-status-indicator")
			expect(indicator).toHaveAttribute("aria-label", `Task status: ${label}`)
			expect(indicator.querySelector(".animate-spin")).toHaveClass("motion-reduce:animate-none")
			expect(indicator.querySelector(".rounded-full")).not.toBeInTheDocument()
			expect(screen.queryByTestId("task-opening-indicator")).not.toBeInTheDocument()
		})

		it.each([
			{ status: TaskStatus.Interactive, isWaitingForInput: false },
			{ status: TaskStatus.Running, isWaitingForInput: true },
		])("shows Needs input as a blue dot (status=$status)", ({ status, isWaitingForInput }) => {
			render(
				taskWithLiveMetadata(
					liveTask({ lifecycle: TaskLifecycleState.Waiting, status, isWaitingForInput }),
					variant,
				),
			)
			const indicator = screen.getByRole("img", { name: "Task status: Needs input" })
			expect(indicator.querySelector(".rounded-full")).toHaveClass("bg-vscode-textLink-foreground")
			expect(indicator.querySelector("svg")).not.toBeInTheDocument()
		})

		it("shows Complete as a green dot even with stale streaming and input flags", () => {
			render(
				taskWithLiveMetadata(
					liveTask({ lifecycle: TaskLifecycleState.Completed, isWaitingForInput: true }),
					variant,
				),
			)
			const indicator = screen.getByRole("img", { name: "Task status: Complete" })
			expect(indicator.querySelector(".rounded-full")).toHaveClass("bg-vscode-charts-green")
			expect(indicator.querySelector("svg")).not.toBeInTheDocument()
		})

		it("shows Failed as a static error symbol even with stale streaming and input flags", () => {
			render(
				taskWithLiveMetadata(
					liveTask({ lifecycle: TaskLifecycleState.Failed, isWaitingForInput: true }),
					variant,
				),
			)
			const indicator = screen.getByRole("img", { name: "Task status: Failed" })
			expect(indicator.querySelector(".lucide-circle-alert")).toHaveClass("text-vscode-errorForeground")
			expect(indicator.querySelector(".animate-spin")).not.toBeInTheDocument()
			expect(indicator.querySelector(".rounded-full")).not.toBeInTheDocument()
		})
	})

	it.each([
		{ lifecycle: TaskLifecycleState.Waiting, status: TaskStatus.Interactive, label: "Needs input" },
		{ lifecycle: TaskLifecycleState.Completed, status: TaskStatus.None, label: "Complete" },
		{ lifecycle: TaskLifecycleState.Failed, status: TaskStatus.None, label: "Failed" },
	])("replaces the running spinner when the task becomes $label", ({ lifecycle, status, label }) => {
		const { rerender } = render(taskWithLiveMetadata(liveTask({})))
		expect(screen.getByTestId("task-status-indicator").querySelector(".animate-spin")).toBeInTheDocument()

		// A delayed streaming update must not keep a waiting or finished task spinning.
		rerender(taskWithLiveMetadata(liveTask({ lifecycle, status, isStreaming: true })))

		const indicator = screen.getByTestId("task-status-indicator")
		expect(indicator).toHaveAttribute("aria-label", `Task status: ${label}`)
		expect(indicator.querySelector(".animate-spin")).not.toBeInTheDocument()
		if (lifecycle === TaskLifecycleState.Failed) {
			expect(indicator.querySelector(".lucide-circle-alert")).toBeInTheDocument()
		} else {
			expect(indicator.querySelector(".rounded-full")).toBeInTheDocument()
		}
	})

	it("shows waiting live tasks as a static status dot", () => {
		const { container } = render(
			<ExtensionStateContext.Provider
				value={
					{
						currentTaskId: "1",
						getCachedTranscriptRevision: () => undefined,
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
						getCachedTranscriptRevision: () => undefined,
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
