import { fireEvent, render, screen, waitFor } from "@/utils/test-utils"

import GoalSeekView from "@/components/goal-seek/GoalSeekView"
import ScheduledTasksView from "@/components/scheduled-tasks/ScheduledTasksView"
import { CreateSkillDialog } from "@/components/settings/CreateSkillDialog"

let mockExtensionState: Record<string, unknown>

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockExtensionState,
}))

vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("@/components/ui", () => ({
	Button: ({ children, onClick, disabled, ...props }: any) => (
		<button onClick={onClick} disabled={disabled} aria-label={props["aria-label"]}>
			{children}
		</button>
	),
	Checkbox: ({ id, checked, onCheckedChange }: any) => (
		<input
			type="checkbox"
			id={id}
			checked={checked}
			data-testid={`checkbox-${id}`}
			onChange={(event) => onCheckedChange(event.target.checked)}
		/>
	),
	Dialog: ({ children, open }: any) => (open ? <div>{children}</div> : null),
	DialogContent: ({ children }: any) => <div>{children}</div>,
	DialogHeader: ({ children }: any) => <div>{children}</div>,
	DialogTitle: ({ children }: any) => <div>{children}</div>,
	DialogDescription: ({ children }: any) => <div>{children}</div>,
	DialogFooter: ({ children }: any) => <div>{children}</div>,
	Input: ({ onChange, ...props }: any) => <input onChange={onChange} {...props} />,
	Textarea: ({ onChange, ...props }: any) => <textarea onChange={onChange} {...props} />,
	Select: ({ children, value }: any) => <div data-select-value={value}>{children}</div>,
	SelectTrigger: ({ children }: any) => <div>{children}</div>,
	SelectValue: () => null,
	SelectContent: ({ children }: any) => <div>{children}</div>,
	SelectItem: ({ children, value }: any) => <div data-testid={`select-item-${value}`}>{children}</div>,
}))

const customMode = {
	slug: "security-review",
	name: "Security Review",
	roleDefinition: "Review security",
	groups: ["read"],
}

const baseState = () => ({
	renderContext: "sidebar",
	cwd: "/workspace",
	mode: "code",
	customModes: [customMode],
	goalSeekJobs: [],
	goalSeekRuns: [],
	goalSeekAttempts: [],
	scheduledTasks: [],
	scheduledTaskRuns: [],
})

describe("secondary user-facing mode selectors", () => {
	beforeEach(() => {
		mockExtensionState = baseState()
	})

	it("limits a new Goal Seek job to Plan and Code", () => {
		render(<GoalSeekView onDone={vi.fn()} />)

		expect(screen.getByTestId("select-item-architect")).toHaveTextContent("Plan")
		expect(screen.getByTestId("select-item-code")).toHaveTextContent("Code")
		expect(screen.queryByTestId("select-item-security-review")).not.toBeInTheDocument()
		expect(screen.queryByTestId("select-item-ask")).not.toBeInTheDocument()
		expect(screen.queryByTestId("select-item-debug")).not.toBeInTheDocument()
		expect(screen.queryByTestId("select-item-orchestrator")).not.toBeInTheDocument()
	})

	it("limits a new skill binding to Plan and Code", () => {
		render(<CreateSkillDialog open onOpenChange={vi.fn()} onSkillCreated={vi.fn()} hasWorkspace={true} />)

		expect(screen.getByTestId("checkbox-create-mode-architect")).toBeInTheDocument()
		expect(screen.getByText("Plan")).toBeInTheDocument()
		expect(screen.getByTestId("checkbox-create-mode-code")).toBeInTheDocument()
		expect(screen.queryByTestId("checkbox-create-mode-security-review")).not.toBeInTheDocument()
		expect(screen.queryByTestId("checkbox-create-mode-ask")).not.toBeInTheDocument()
		expect(screen.queryByTestId("checkbox-create-mode-debug")).not.toBeInTheDocument()
		expect(screen.queryByTestId("checkbox-create-mode-orchestrator")).not.toBeInTheDocument()
	})

	it("normalizes a hidden active mode when starting a new Goal Seek job", () => {
		mockExtensionState = { ...baseState(), mode: "security-review" }
		const { container } = render(<GoalSeekView onDone={vi.fn()} />)

		expect(container.querySelector('[data-select-value="code"]')).toBeInTheDocument()
		expect(screen.queryByTestId("select-item-security-review")).not.toBeInTheDocument()
	})

	it("retains the saved legacy mode when a Goal Seek job is opened", () => {
		mockExtensionState = {
			...baseState(),
			goalSeekJobs: [
				{
					id: "legacy-goal",
					name: "Legacy goal",
					goal: "Preserve the saved mode",
					verifier: { type: "prompt", prompt: "Verify" },
					direction: "maximize",
					targetScore: 100,
					maxAttempts: 3,
					maxFailedAttempts: 1,
					candidateCount: 2,
					mode: "debug",
				},
			],
		}
		render(<GoalSeekView onDone={vi.fn()} />)

		fireEvent.click(screen.getByRole("button", { name: /Legacy goal/ }))

		expect(screen.getByTestId("select-item-debug")).toHaveTextContent(/Debug/)
		expect(screen.queryByTestId("select-item-ask")).not.toBeInTheDocument()
		expect(screen.queryByTestId("select-item-orchestrator")).not.toBeInTheDocument()
	})

	it("hydrates a preselected Goal Seek job before allowing it to be saved", async () => {
		mockExtensionState = {
			...baseState(),
			goalSeekJobs: [
				{
					id: "goal-1",
					name: "Existing goal",
					goal: "Keep the existing draft",
					verifier: { type: "prompt", prompt: "Verify the result" },
					direction: "maximize",
					targetScore: 95,
					maxAttempts: 7,
					maxFailedAttempts: 2,
					candidateCount: 4,
					mode: "code",
				},
			],
		}

		render(<GoalSeekView onDone={vi.fn()} targetJobId="goal-1" />)

		await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Existing goal"))
		expect(screen.getByLabelText("Goal")).toHaveValue("Keep the existing draft")
		expect(screen.getByLabelText("Verifier prompt")).toHaveValue("Verify the result")
		expect(screen.getByLabelText("Target score")).toHaveValue(95)
		expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
	})

	it("retains the saved legacy mode when a scheduled task is opened", async () => {
		mockExtensionState = {
			...baseState(),
			scheduledTasks: [
				{
					id: "legacy-schedule",
					name: "Legacy schedule",
					prompt: "Run the saved task",
					execution: { type: "prompt" },
					mode: "orchestrator",
					schedule: {
						type: "daily",
						startAt: Date.now() + 60_000,
						timezone: "UTC",
						intervalDays: 1,
					},
					notificationPreference: "on_failure",
					enabled: true,
				},
			],
		}
		render(<ScheduledTasksView onDone={vi.fn()} targetTaskId="legacy-schedule" />)

		await waitFor(() => {
			expect(screen.getByTestId("select-item-orchestrator")).toHaveTextContent(/Orchestrator/)
		})
		expect(screen.getByTestId("select-item-architect")).toHaveTextContent("Plan")
		expect(screen.getByTestId("select-item-code")).toHaveTextContent("Code")
		expect(screen.queryByTestId("select-item-ask")).not.toBeInTheDocument()
		expect(screen.queryByTestId("select-item-debug")).not.toBeInTheDocument()
	})

	it("hydrates the first scheduled task and preserves an edited draft across context refreshes", async () => {
		const scheduledTask = {
			id: "schedule-1",
			name: "Existing schedule",
			prompt: "Keep the existing prompt",
			execution: { type: "prompt" },
			mode: "code",
			schedule: {
				type: "daily",
				startAt: Date.now() + 60_000,
				timezone: "UTC",
				intervalDays: 1,
			},
			notificationPreference: "on_failure",
			enabled: true,
		}
		mockExtensionState = { ...baseState(), scheduledTasks: [scheduledTask] }

		const { rerender } = render(<ScheduledTasksView onDone={vi.fn()} targetTaskId="schedule-1" />)

		await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Existing schedule"))
		fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsaved schedule edit" } })

		mockExtensionState = {
			...mockExtensionState,
			scheduledTasks: [{ ...scheduledTask, lastRunStatus: "succeeded" }],
		}
		rerender(<ScheduledTasksView onDone={vi.fn()} targetTaskId="schedule-1" />)

		expect(screen.getByLabelText("Name")).toHaveValue("Unsaved schedule edit")
		expect(screen.getByLabelText("Prompt")).toHaveValue("Keep the existing prompt")
		expect(screen.getByRole("button", { name: "Save" })).toBeEnabled()
	})
})
