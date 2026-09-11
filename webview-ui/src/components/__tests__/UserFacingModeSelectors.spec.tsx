import { fireEvent, render, screen, waitFor } from "@/utils/test-utils"

import ScheduledTasksView from "@/components/scheduled-tasks/ScheduledTasksView"
import { CreateSkillDialog } from "@/components/settings/CreateSkillDialog"

let mockExtensionState: Record<string, unknown>

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockExtensionState,
}))

vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("@/components/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/ui")>()),
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
	listApiConfigMeta: [{ id: "profile", name: "Scheduled profile" }],
	scheduledTasks: [],
	scheduledTaskRuns: [],
})

describe("secondary user-facing mode selectors", () => {
	beforeEach(() => {
		mockExtensionState = baseState()
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
			apiConfig: { id: "profile", name: "Scheduled profile" },
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
