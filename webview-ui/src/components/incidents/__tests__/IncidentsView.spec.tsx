import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ExtensionMessage, IncidentDashboardSnapshot } from "@alpha-code/types"
import { vscode } from "../../../utils/vscode"
import IncidentsView from "../IncidentsView"

vi.mock("../../../utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))
vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: { time?: string; count?: number; title?: string }) => {
			const labels: Record<string, string> = {
				title: "Incident dashboard",
				debugMode: "Debug mode",
				description: "Review recent task activity and investigate alerts.",
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
		expect(screen.getByText("Agent turn failed")).toBeInTheDocument()
		expect(screen.getByRole("heading", { name: "Activity timeline" })).toBeInTheDocument()
		expect(screen.getAllByText("Turn failed")).toHaveLength(2)
		expect(screen.getAllByText("Task 1234abcd")).toHaveLength(2)
		expect(screen.getByText("Evidence captured")).toBeInTheDocument()
		expect(screen.getByText("Evidence not checked")).toBeInTheDocument()
		expect(screen.getByText("read_file")).toBeInTheDocument()
		expect(screen.getByText("aaaaaaaaaaaa")).toBeInTheDocument()
		expect(screen.getByText("bbbbbbbbbbbb")).toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: "Start debugging task for Agent turn failed" }))
		expect(vscode.postMessage).toHaveBeenLastCalledWith({
			type: "startDebuggingTask",
			alertId: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
		})
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
		reply({ type: "incidentDashboardUpdate", snapshot: { ...snapshot, tasks: [], alerts: [] } })

		expect(await screen.findByText("No current alerts.")).toBeInTheDocument()
		expect(screen.getByText("No recent task activity.")).toBeInTheDocument()
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
})
