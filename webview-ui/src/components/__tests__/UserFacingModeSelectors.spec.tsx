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
})
