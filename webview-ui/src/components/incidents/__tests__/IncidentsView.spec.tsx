import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ExtensionMessage, IncidentDashboardSnapshot } from "@alpha-code/types"
import { vscode } from "../../../utils/vscode"
import IncidentsView from "../IncidentsView"

vi.mock("../../../utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (
			key: string,
			options?: {
				time?: string
				count?: number
				title?: string
				task?: string
				id?: string
				maximum?: number
				minutes?: number
				seconds?: number
			},
		) => {
			const labels: Record<string, string> = {
				title: "Incident dashboard",
				project: "Project",
				projectUnavailable: "Not recorded",
				debugMode: "Debug mode",
				description:
					"Review task activity, compare successful and error turns, and inspect lifecycle evidence.",
				refresh: "Refresh",
				loading: "Loading recent activity…",
				unavailable: "Dashboard data could not be loaded. Try again.",
				tryAgain: "Try again",
				attention: "Needs attention",
				alerts: "Alerts",
				alertCount: `${options?.count ?? 0} alerts`,
				noAlerts: "No current alerts.",
				recent: "Current and recent tasks",
				activity: "Activity timeline",
				noActivity: "No recent task activity.",
				noTaskActivity: "No activity recorded for this task.",
				turnSummary: "Turn summary",
				turns: "Recent turns",
				turnSampleScope: `Showing ${options?.count ?? 0} recent turns (up to ${options?.maximum ?? 64} in this snapshot).`,
				observedTurns: "Observed turns",
				positiveTurns: "Positive turns",
				positiveDefinition: "Completed with no tool errors",
				errorTurns: "Turns with errors",
				errorDefinition: "Failed or recorded a tool error",
				averageDuration: "Average duration",
				recordedDurations: `${options?.count ?? 0} turns with duration`,
				durationUnavailable: "—",
				"duration.seconds": `${options?.count ?? 0}s`,
				"duration.minutes": `${options?.count ?? 0}m`,
				"duration.minutesSeconds": `${options?.minutes ?? 0}m ${options?.seconds ?? 0}s`,
				turnStatusCounts: "Turn counts by status",
				"turnStatus.running": "Running",
				"turnStatus.completed": "Completed",
				"turnStatus.failed": "Failed",
				"turnStatus.cancelled": "Cancelled",
				"turnStatus.interrupted": "Interrupted",
				filterTurns: "Filter turns",
				"turnFilter.all": "All turns",
				"turnFilter.positive": "Positive",
				"turnFilter.errors": "With errors",
				turnResultCount: `${options?.count ?? 0} turns`,
				noTurns: "No recent turns are available.",
				noTurnsForFilter: "No turns match this filter.",
				turnTableCaption:
					"Recent turns with status, timing, step, and tool counts. Select a turn to load its investigation details.",
				turnColumn: "Turn",
				statusColumn: "Status",
				startedColumn: "Started",
				durationColumn: "Duration",
				stepsColumn: "Steps",
				toolCallsColumn: "Tool calls",
				toolErrorsColumn: "Tool errors",
				inspectTurn: `Inspect turn ${options?.id ?? ""} for ${options?.task ?? ""}`,
				investigation: "Investigation",
				turnDetailTitle: `Turn details · ${options?.task ?? ""}`,
				loadingTurnDetail: "Loading turn evidence…",
				turnDetailUnavailable: "Turn details are unavailable. Refresh the dashboard and try again.",
				turnDetailInvalid: "Turn details could not be validated.",
				startDebuggingTurn: "Debug this turn",
				startDebuggingTurnFor: `Start debugging turn for ${options?.task ?? ""}`,
				noTurnEvents: "No lifecycle events were recorded for this turn.",
				"turnEvent.turn_started": "Turn started",
				"turnEvent.step_started": "Step started",
				"turnEvent.step_completed": "Step completed",
				"turnEvent.step_failed": "Step failed",
				"turnEvent.tool_accepted": "Tool accepted",
				"turnEvent.tool_succeeded": "Tool succeeded",
				"turnEvent.tool_failed": "Tool failed",
				"turnEvent.approval_requested": "Approval requested",
				"turnEvent.approval_resolved": "Approval resolved",
				"turnEvent.turn_completed": "Turn completed",
				"turnEvent.turn_failed": "Turn failed",
				"turnEvent.turn_cancelled": "Turn cancelled",
				"turnEvent.turn_interrupted": "Turn interrupted",
				startDebuggingTask: "Start debugging task",
				startDebuggingTaskFor: `Start debugging task for ${options?.title ?? ""}`,
				errorStatusLabel: "Status",
				statusUnavailable: "Unavailable",
				"errorStatus.failed": "Failed",
				"errorStatus.incomplete": "Incomplete",
				"evidenceStatus.captured": "Evidence captured",
				"evidenceStatus.absent": "Evidence absent",
				"evidenceStatus.incomplete": "Evidence incomplete",
				"evidenceStatus.notChecked": "Evidence not checked",
				affectedTask: "Task",
				taskUnavailable: "Task unavailable",
				turnId: "Turn",
				affectedTool: "Tool",
				toolCallId: "Tool call",
				updated: `Updated ${options?.time ?? ""}`,
				snapshotUpdated: `Dashboard refreshed ${options?.time ?? ""}`,
				unknownTime: "Unknown time",
				"severity.error": "Error",
				"severity.warning": "Warning",
				"state.failed": "Failed",
				"state.running": "Running",
				"event.turn_failed": "Turn failed",
				"event.turn_started": "Turn started",
			}
			return labels[key] ?? key
		},
	}),
}))

const snapshot: IncidentDashboardSnapshot = {
	generatedAt: Date.UTC(2026, 8, 28, 12),
	tasks: [
		{
			taskId: "1111111111111111111111111111111111111111111111111111111111111111",
			label: "Task 1234abcd",
			state: "failed",
			updatedAt: Date.UTC(2026, 8, 28, 11, 59),
			timeline: [
				{
					id: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
					at: Date.UTC(2026, 8, 28, 11, 59),
					kind: "turn_failed",
					label: "Turn failed",
				},
			],
		},
	],
	alerts: [
		{
			id: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
			severity: "error",
			title: "Agent turn failed",
			summary: "A task turn ended in an explicit failure. Review the bounded lifecycle evidence.",
			at: Date.UTC(2026, 8, 28, 11, 59),
			taskId: "1111111111111111111111111111111111111111111111111111111111111111",
			evidenceStatus: "captured",
			turnIdSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			toolCallIdSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			toolName: "read_file",
			errorStatus: "failed",
		},
	],
	turns: [
		{
			id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
			taskId: "1111111111111111111111111111111111111111111111111111111111111111",
			taskLabel: "Task 1234abcd",
			status: "completed",
			startedAt: Date.UTC(2026, 8, 28, 11, 54),
			endedAt: Date.UTC(2026, 8, 28, 11, 56),
			durationMs: 120_000,
			steps: 5,
			toolCalls: 3,
			toolErrors: 0,
			evidenceStatus: "captured",
		},
		{
			id: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
			taskId: "1111111111111111111111111111111111111111111111111111111111111111",
			taskLabel: "Task 1234abcd",
			status: "failed",
			startedAt: Date.UTC(2026, 8, 28, 11, 57),
			endedAt: Date.UTC(2026, 8, 28, 11, 57, 45),
			durationMs: 45_000,
			steps: 2,
			toolCalls: 2,
			toolErrors: 1,
			evidenceStatus: "incomplete",
		},
		{
			id: "9999999999999999999999999999999999999999999999999999999999999999",
			taskId: "1111111111111111111111111111111111111111111111111111111111111111",
			taskLabel: "Task 1234abcd",
			status: "running",
			startedAt: Date.UTC(2026, 8, 28, 11, 58),
			steps: 1,
			toolCalls: 0,
			toolErrors: 0,
		},
	],
}

function reply(message: ExtensionMessage) {
	act(() => window.dispatchEvent(new MessageEvent("message", { data: message })))
}

describe("IncidentsView", () => {
	beforeEach(() => vi.clearAllMocks())
	afterEach(() => vi.restoreAllMocks())

	it("requests a snapshot, renders current alerts and a recent task timeline, and starts an alert-scoped task", async () => {
		render(<IncidentsView />)

		expect(vscode.postMessage).toHaveBeenCalledWith({ type: "incidentDashboardReady" })
		reply({ type: "incidentDashboardUpdate", snapshot })

		expect(await screen.findByRole("heading", { name: "Incident dashboard" })).toBeInTheDocument()
		expect(screen.getByRole("heading", { name: "Alerts" })).toBeInTheDocument()
		expect(screen.getByRole("heading", { name: "Recent turns" })).toBeInTheDocument()
		expect(screen.getByRole("table")).toBeInTheDocument()
		expect(screen.getByText("Positive turns")).toBeInTheDocument()
		expect(screen.getByText("Turns with errors")).toBeInTheDocument()
		expect(screen.getByText("Agent turn failed")).toBeInTheDocument()
		expect(screen.getByRole("heading", { name: "Activity timeline" })).toBeInTheDocument()
		expect(screen.queryByText("Turn failed")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Task 1234abcd" }))
		expect(screen.getAllByText("Turn failed")).toHaveLength(2)
		expect(screen.getAllByText("Task 1234abcd").length).toBeGreaterThanOrEqual(2)
		expect(screen.getByText("Evidence captured")).toBeInTheDocument()
		expect(screen.getByText("Evidence not checked")).toBeVisible()
		expect(screen.getByText("read_file")).toBeInTheDocument()
		expect(screen.getByText("aaaaaaaaaaaa")).toBeInTheDocument()
		expect(screen.getByText("bbbbbbbbbbbb")).toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: "Start debugging task for Agent turn failed" }))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "startDebuggingTask",
			alertId: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
		})
	})

	it("shows chat titles and keeps task timelines collapsed until selected", () => {
		render(<IncidentsView />)
		reply({
			type: "incidentDashboardUpdate",
			snapshot: {
				...snapshot,
				tasks: snapshot.tasks.map((task) => ({ ...task, chatTitle: "Fix the dashboard" })),
				turns: snapshot.turns.map((turn) => ({ ...turn, chatTitle: "Fix the dashboard" })),
			},
		})
		expect(within(screen.getByRole("table")).getAllByText("Fix the dashboard")).toHaveLength(3)
		expect(screen.queryByText("Turn failed")).not.toBeInTheDocument()
		const task = screen.getByRole("button", { name: "Fix the dashboard" })
		expect(task).toHaveAttribute("aria-expanded", "false")
		fireEvent.click(task)
		expect(task).toHaveAttribute("aria-expanded", "true")
		expect(screen.getAllByText("Turn failed")).toHaveLength(2)
		fireEvent.click(task)
		expect(screen.queryByText("Turn failed")).not.toBeInTheDocument()
	})

	it.each(["/home/me/Alpha-Code/", "C:\\projects\\Alpha-Code\\"])(
		"shows the project folder and retains the full path on hover: %s",
		(workspace) => {
			render(<IncidentsView />)
			reply({
				type: "incidentDashboardUpdate",
				snapshot: {
					...snapshot,
					tasks: snapshot.tasks.map((task) => ({ ...task, workspace })),
					turns: snapshot.turns.map((turn) => ({ ...turn, workspace })),
				},
			})
			const labels = screen.getAllByText("Project: Alpha-Code")
			expect(labels).toHaveLength(5)
			for (const label of labels) expect(label).toHaveAttribute("title", workspace)
			expect(screen.queryByText(workspace)).not.toBeInTheDocument()
			fireEvent.click(screen.getByRole("button", { name: /Inspect turn eeeee/ }))
			expect(screen.getAllByText("Project: Alpha-Code")).toHaveLength(6)
		},
	)

	it("does not invent a project for older tasks without a saved workspace", () => {
		render(<IncidentsView />)
		reply({ type: "incidentDashboardUpdate", snapshot })
		expect(screen.getAllByText("Project: Not recorded")).toHaveLength(5)
	})

	it("rejects snapshot fields that could expose prompts or tool output", async () => {
		render(<IncidentsView />)
		reply({
			type: "incidentDashboardUpdate",
			snapshot: { ...snapshot, prompt: "PRIVATE PROMPT", toolOutput: "PRIVATE TOOL OUTPUT" },
		} as unknown as ExtensionMessage)

		expect(await screen.findByRole("alert")).toHaveTextContent("Dashboard data could not be loaded")
		expect(screen.queryByText(/PRIVATE PROMPT|PRIVATE TOOL OUTPUT/)).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Start debugging task" })).not.toBeInTheDocument()
	})

	it("rejects user content smuggled into fields reserved for fixed safe labels", async () => {
		render(<IncidentsView />)
		reply({
			type: "incidentDashboardUpdate",
			snapshot: {
				...snapshot,
				alerts: [
					{
						...snapshot.alerts[0],
						summary: "A task failed while processing PRIVATE PROMPT CONTENT.",
					},
				],
			},
		} as unknown as ExtensionMessage)

		expect(await screen.findByRole("alert")).toHaveTextContent("Dashboard data could not be loaded")
		expect(screen.queryByText(/PRIVATE PROMPT CONTENT/)).not.toBeInTheDocument()
	})

	it("shows a clear empty state when there are no alerts or recent tasks", async () => {
		render(<IncidentsView />)
		reply({ type: "incidentDashboardUpdate", snapshot: { ...snapshot, tasks: [], alerts: [], turns: [] } })

		expect(await screen.findByText("No current alerts.")).toBeInTheDocument()
		expect(screen.getByText("No recent task activity.")).toBeInTheDocument()
		expect(screen.getByText("No recent turns are available.")).toBeInTheDocument()
	})

	it("distinguishes absent evidence and unavailable task labels", async () => {
		render(<IncidentsView />)
		reply({
			type: "incidentDashboardUpdate",
			snapshot: {
				...snapshot,
				tasks: [],
				alerts: [{ ...snapshot.alerts[0], evidenceStatus: "absent" }],
			},
		})

		expect(await screen.findByText("Evidence absent")).toBeInTheDocument()
		expect(screen.getByText("Task unavailable")).toBeInTheDocument()
	})

	it("rejects snapshots that exceed the activity bounds", async () => {
		render(<IncidentsView />)
		const task = snapshot.tasks[0]
		reply({
			type: "incidentDashboardUpdate",
			snapshot: {
				...snapshot,
				tasks: Array.from({ length: 13 }, (_, index) => ({
					...task,
					taskId: index.toString(16).padStart(64, "0"),
				})),
			},
		})

		expect(await screen.findByRole("alert")).toHaveTextContent("Dashboard data could not be loaded")
		expect(screen.queryByText("Task 1234abcd")).not.toBeInTheDocument()
	})

	it("summarizes positive and error turns and loads investigation detail only when a row is selected", async () => {
		render(<IncidentsView />)
		reply({ type: "incidentDashboardUpdate", snapshot })

		const table = await screen.findByRole("table")
		expect(within(table).getAllByRole("row")).toHaveLength(4)
		expect(screen.getByText("Showing 3 recent turns (up to 64 in this snapshot).")).toBeInTheDocument()
		expect(screen.getByText("1m 23s")).toBeInTheDocument()
		expect(vscode.postMessage).toHaveBeenCalledTimes(1)

		fireEvent.click(screen.getByRole("button", { name: "Inspect turn eeeeeeeeeeee for Task 1234abcd" }))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "incidentDashboardRequestTurnDetail",
			turnId: snapshot.turns[0].id,
		})
		expect(screen.getByRole("status")).toHaveTextContent("Loading turn evidence")
		expect(screen.getByRole("heading", { name: "Recent turns" })).toBeInTheDocument()

		reply({
			type: "incidentDashboardTurnDetail",
			turnId: snapshot.turns[0].id,
			detail: {
				turn: snapshot.turns[0],
				events: [
					{
						id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						at: snapshot.turns[0].startedAt,
						kind: "step_completed",
					},
				],
			},
		})
		expect(await screen.findByText("Step completed")).toBeInTheDocument()
		expect(screen.getAllByText("Evidence captured").length).toBeGreaterThan(1)

		fireEvent.click(screen.getByRole("button", { name: "Start debugging turn for Task 1234abcd" }))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "startDebuggingTurn",
			turnId: snapshot.turns[0].id,
		})

		fireEvent.click(screen.getByRole("button", { name: "With errors" }))
		expect(screen.getByRole("button", { name: "With errors" })).toHaveAttribute("aria-pressed", "true")
		expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2)
		fireEvent.click(screen.getByRole("button", { name: "Inspect turn ffffffffffff for Task 1234abcd" }))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "incidentDashboardRequestTurnDetail",
			turnId: snapshot.turns[1].id,
		})
		reply({
			type: "incidentDashboardTurnDetail",
			turnId: snapshot.turns[1].id,
			detail: {
				turn: snapshot.turns[1],
				events: [
					{
						id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
						at: snapshot.turns[1].startedAt,
						kind: "tool_failed",
						toolName: "read_file",
					},
				],
			},
		})
		expect(await screen.findByText("Tool failed")).toBeInTheDocument()
		expect(
			within(screen.getByRole("region", { name: "Turn details · Task 1234abcd" })).getByText("read_file"),
		).toBeInTheDocument()
	})

	it("ignores stale detail and clears the loading state when the selected detail is unavailable", async () => {
		render(<IncidentsView />)
		reply({ type: "incidentDashboardUpdate", snapshot })
		fireEvent.click(await screen.findByRole("button", { name: "Inspect turn eeeeeeeeeeee for Task 1234abcd" }))
		fireEvent.click(screen.getByRole("button", { name: "With errors" }))
		fireEvent.click(screen.getByRole("button", { name: "Inspect turn ffffffffffff for Task 1234abcd" }))

		reply({
			type: "incidentDashboardTurnDetail",
			turnId: snapshot.turns[0].id,
			detail: { turn: snapshot.turns[0], events: [] },
		})
		expect(screen.getByRole("status")).toHaveTextContent("Loading turn evidence")

		reply({ type: "incidentDashboardTurnDetail", turnId: snapshot.turns[1].id })
		expect(await screen.findByRole("status")).toHaveTextContent("Turn details are unavailable")
	})

	it("rejects malformed turn detail before rendering its event fields", async () => {
		render(<IncidentsView />)
		reply({ type: "incidentDashboardUpdate", snapshot })
		fireEvent.click(await screen.findByRole("button", { name: "Inspect turn eeeeeeeeeeee for Task 1234abcd" }))
		reply({
			type: "incidentDashboardTurnDetail",
			turnId: snapshot.turns[0].id,
			detail: {
				turn: snapshot.turns[0],
				events: [
					{
						id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						at: snapshot.turns[0].startedAt,
						kind: "step_completed",
						prompt: "PRIVATE PROMPT CONTENT",
					},
				],
			},
		} as unknown as ExtensionMessage)

		expect(await screen.findByRole("alert")).toHaveTextContent("Turn details could not be validated")
		expect(screen.queryByText(/PRIVATE PROMPT CONTENT/)).not.toBeInTheDocument()
	})
})
