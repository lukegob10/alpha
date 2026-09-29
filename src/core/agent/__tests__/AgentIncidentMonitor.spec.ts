import { createHash } from "crypto"
import { describe, expect, it } from "vitest"

import { agentLifecycleEventSchema, incidentDashboardSnapshotSchema, type AgentLifecycleEvent } from "@alpha-code/types"

import { AgentIncidentMonitor, buildIncidentInvestigationPrompt, type IncidentTaskSeed } from "../AgentIncidentMonitor"

const digest = (value: string) => createHash("sha256").update(value).digest("hex")

function lifecycleEvent(
	type: AgentLifecycleEvent["type"],
	payload: Record<string, unknown>,
	options: {
		taskId?: string
		runId?: string
		turnId?: string
		eventId?: string
		sequence?: number
		at?: number
	} = {},
): AgentLifecycleEvent {
	return agentLifecycleEventSchema.parse({
		version: 1,
		eventId: options.eventId ?? `event-${options.sequence ?? 1}`,
		sequence: options.sequence ?? 1,
		taskId: options.taskId ?? "task-incident",
		runId: options.runId ?? "run-incident",
		turnId: options.turnId ?? "turn-incident",
		occurredAt: options.at ?? 1_000 + (options.sequence ?? 1),
		type,
		payload,
	})
}

function turnStarted(options: Parameters<typeof lifecycleEvent>[2] = {}) {
	return lifecycleEvent("turn_started", { phase: "working" }, options)
}

function turnFailed(options: Parameters<typeof lifecycleEvent>[2] = {}) {
	return lifecycleEvent(
		"turn_failed",
		{ status: "failed", error: "PRIVATE_PROVIDER_ERROR" },
		{ sequence: 2, ...options },
	)
}

describe("AgentIncidentMonitor", () => {
	it("alerts immediately on explicit turn failure with only bounded safe evidence", () => {
		const monitor = new AgentIncidentMonitor({ now: () => 5_000 })
		const snapshots: Array<ReturnType<typeof monitor.snapshot>> = []
		const unsubscribe = monitor.subscribe((snapshot) => snapshots.push(snapshot))

		monitor.observe(turnStarted())
		const alert = monitor.observe(turnFailed())

		expect(alert).toMatchObject({
			severity: "error",
			title: "Agent turn failed",
			errorStatus: "failed",
			turnIdSha256: digest("turn-incident"),
		})
		expect(alert).not.toHaveProperty("evidenceStatus")
		expect(alert?.taskId).toBe(digest("task-incident"))
		expect(monitor.getAlert(alert!.id)?.taskState).toBe("failed")
		expect(monitor.getAlert(alert!.id)?.taskId).toBe("task-incident")
		expect(JSON.stringify(monitor.snapshot())).not.toContain("task-incident")
		expect(monitor.snapshot().tasks[0]).not.toHaveProperty("evidenceStatus")
		expect(snapshots.at(-1)?.alerts).toContainEqual(alert)
		expect(incidentDashboardSnapshotSchema.safeParse(monitor.snapshot()).success).toBe(true)
		expect(JSON.stringify(monitor.snapshot())).not.toContain("PRIVATE_PROVIDER_ERROR")
		expect(JSON.stringify(monitor.snapshot())).not.toContain("turn-incident")
		unsubscribe()
	})

	it("keeps approval waits, cancellations, interruptions, and slow healthy work out of alerts", () => {
		let now = 10_000
		const monitor = new AgentIncidentMonitor({ now: () => now })
		monitor.observe(lifecycleEvent("phase_changed", { phase: "awaiting_approval" }, { sequence: 1 }))
		monitor.observe(
			lifecycleEvent(
				"approval_requested",
				{
					item: {
						itemId: "approval-item",
						type: "approval",
						approvalId: "approval-id",
						status: "requested",
						reason: "PRIVATE_APPROVAL_REASON",
					},
				},
				{ sequence: 2 },
			),
		)
		expect(monitor.snapshot().tasks[0].state).toBe("waiting")

		monitor.observe(lifecycleEvent("turn_cancelled", { reason: "User cancelled" }, { sequence: 3 }))
		monitor.observe(
			lifecycleEvent("turn_interrupted", { status: "interrupted" }, { taskId: "restart-task", sequence: 1 }),
		)
		monitor.observe(turnStarted({ taskId: "healthy-task", sequence: 1, at: 1_000 }))
		now += 24 * 60 * 60 * 1_000

		expect(monitor.snapshot().alerts).toEqual([])
		expect(monitor.snapshot().tasks.find((task) => task.taskId === digest("task-incident"))?.state).toBe(
			"cancelled",
		)
		expect(monitor.snapshot().tasks.find((task) => task.taskId === digest("restart-task"))?.state).toBe(
			"interrupted",
		)
		expect(JSON.stringify(monitor.snapshot())).not.toContain("PRIVATE_APPROVAL_REASON")
	})

	it("attaches only a canonical allowlisted failed tool to a later turn alert", () => {
		const monitor = new AgentIncidentMonitor({ now: () => 3_000 })
		const accepted = lifecycleEvent(
			"tool_call_accepted",
			{
				item: {
					itemId: "call-item",
					type: "tool_call",
					toolCallId: "private-tool-call-id",
					name: "read_file",
					arguments: { path: "C:\\private\\workspace\\secret.ts" },
					status: "accepted",
				},
			},
			{ sequence: 1 },
		)
		const result = lifecycleEvent(
			"tool_result_recorded",
			{
				item: {
					itemId: "result-item",
					type: "tool_result",
					toolCallId: "private-tool-call-id",
					status: "error",
					output: "PRIVATE_TOOL_OUTPUT",
				},
			},
			{ sequence: 2 },
		)

		monitor.observe(accepted)
		expect(monitor.observe(result)).toBeUndefined()
		const alert = monitor.observe(
			lifecycleEvent("turn_failed", { status: "failed", error: "PRIVATE_ERROR" }, { sequence: 3 }),
		)

		expect(alert).toMatchObject({
			toolCallIdSha256: digest("private-tool-call-id"),
			toolName: "read_file",
			errorStatus: "failed",
		})
		const exposed = JSON.stringify({ snapshot: monitor.snapshot(), alert: monitor.getAlert(alert!.id) })
		expect(exposed).not.toContain("C:\\private\\workspace")
		expect(exposed).not.toContain("PRIVATE_TOOL_OUTPUT")
		expect(exposed).not.toContain("PRIVATE_ERROR")
		expect(exposed).not.toContain("private-tool-call-id")
	})

	it("does not attach stale tool identity after a successful tool result", () => {
		const monitor = new AgentIncidentMonitor({ now: () => 3_000 })
		monitor.observe(
			lifecycleEvent(
				"tool_call_accepted",
				{
					item: {
						itemId: "call-item",
						type: "tool_call",
						toolCallId: "completed-tool-call-id",
						name: "read_file",
						arguments: { path: "private.ts" },
						status: "accepted",
					},
				},
				{ sequence: 1 },
			),
		)
		monitor.observe(
			lifecycleEvent(
				"tool_result_recorded",
				{
					item: {
						itemId: "result-item",
						type: "tool_result",
						toolCallId: "completed-tool-call-id",
						status: "success",
						output: "PRIVATE_OUTPUT",
					},
				},
				{ sequence: 2 },
			),
		)
		const alert = monitor.observe(turnFailed({ sequence: 3 }))

		expect(alert).toBeDefined()
		expect(alert).not.toHaveProperty("toolName")
		expect(alert).not.toHaveProperty("toolCallIdSha256")
		expect(JSON.stringify(monitor.snapshot())).not.toContain("completed-tool-call-id")
		expect(JSON.stringify(monitor.snapshot())).not.toContain("PRIVATE_OUTPUT")
	})

	it("raises a distinct incomplete-evidence warning for confirmed lifecycle conflicts", () => {
		const monitor = new AgentIncidentMonitor({ now: () => 3_500 })
		const alert = monitor.recordProjectionIssue({
			taskId: "task-conflict",
			reason: "sequence_gap",
			eventId: "private-event-id",
			runId: "private-run-id",
			turnId: "private-turn-id",
			expectedSequence: 2,
			receivedSequence: 4,
		})

		expect(alert).toMatchObject({
			severity: "warning",
			title: "Lifecycle stream needs resync",
			errorStatus: "incomplete",
			evidenceStatus: "incomplete",
		})
		expect(monitor.snapshot().tasks[0].evidenceStatus).toBe("incomplete")
		expect(JSON.stringify(monitor.snapshot())).not.toContain("private-event-id")
		expect(JSON.stringify(monitor.snapshot())).not.toContain("private-run-id")
	})

	it("restores recent history without false failure alerts for canceled, interrupted, or diagnostic tasks", () => {
		const monitor = new AgentIncidentMonitor({ now: () => 9_000 })
		const seeds: IncidentTaskSeed[] = [
			{ taskId: "cancelled-task", status: "cancelled", updatedAt: 800 },
			{ taskId: "interrupted-task", status: "interrupted", updatedAt: 700 },
			{ taskId: "diagnostic-task", status: "failed", updatedAt: 900, diagnosticSession: true },
			{ taskId: "failed-task", status: "failed", updatedAt: 600 },
		]
		const snapshot = monitor.restore(seeds)

		expect(snapshot.tasks.map(({ taskId }) => taskId)).not.toContain(digest("diagnostic-task"))
		expect(snapshot.tasks.find(({ taskId }) => taskId === digest("cancelled-task"))?.state).toBe("cancelled")
		expect(snapshot.tasks.find(({ taskId }) => taskId === digest("interrupted-task"))?.state).toBe("interrupted")
		expect(snapshot.alerts).toHaveLength(1)
		expect(snapshot.alerts[0]).toMatchObject({ taskId: digest("failed-task"), errorStatus: "failed" })
	})

	it("merges restore data without replacing newer live task state or dropping live alerts", () => {
		const monitor = new AgentIncidentMonitor({ now: () => 5_000 })
		const liveStarted = turnStarted({ taskId: "live-task", at: 4_000, sequence: 1 })
		const liveFailed = turnFailed({ taskId: "live-task", at: 4_100, sequence: 2 })
		monitor.observe(liveStarted)
		const liveAlert = monitor.observe(liveFailed)
		monitor.setEvidenceStatus("live-task", "captured")

		monitor.restore([
			{
				taskId: "live-task",
				status: "active",
				updatedAt: 3_000,
				evidenceStatus: "absent",
				events: [liveStarted, liveFailed],
			},
			{ taskId: "historical-task", status: "completed", updatedAt: 3_500 },
		])

		expect(monitor.snapshot().alerts.map(({ id }) => id)).toContain(liveAlert?.id)
		expect(monitor.snapshot().tasks.find(({ taskId }) => taskId === digest("live-task"))?.state).toBe("failed")
		expect(monitor.snapshot().tasks.find(({ taskId }) => taskId === digest("live-task"))?.evidenceStatus).toBe(
			"captured",
		)
		expect(monitor.snapshot().alerts.find(({ id }) => id === liveAlert?.id)?.evidenceStatus).toBe("captured")
		expect(monitor.snapshot().tasks.map(({ taskId }) => taskId)).toContain(digest("historical-task"))
	})

	it("keeps task, timeline, and alert projections within schema limits", () => {
		const monitor = new AgentIncidentMonitor({
			now: () => 20_000,
			maxTasks: 99,
			maxAlerts: 99,
			maxTimelinePerTask: 99,
		})
		for (let index = 0; index < 20; index++) {
			monitor.observe(turnStarted({ taskId: `task-${index}`, sequence: 1, at: 1_000 + index }))
			monitor.observe(turnFailed({ taskId: `task-${index}`, sequence: 2, at: 1_001 + index }))
		}
		const snapshot = monitor.snapshot()

		expect(snapshot.tasks.length).toBeLessThanOrEqual(12)
		expect(snapshot.alerts.length).toBeLessThanOrEqual(12)
		expect(snapshot.tasks.every((task) => task.timeline.length <= 8)).toBe(true)
		expect(incidentDashboardSnapshotSchema.safeParse(snapshot).success).toBe(true)
	})

	it("builds a bounded investigation prompt from hashes and collector status only", () => {
		const monitor = new AgentIncidentMonitor({ now: () => 6_000 })
		monitor.observe(turnStarted())
		const alert = monitor.observe(turnFailed())
		const context = monitor.getAlert(alert!.id)!
		const collectedEvidence = {
			history: [{ role: "user", text: "PRIVATE_PROMPT" }],
			evidence: {
				status: "captured",
				taskIdSha256: digest("task-incident"),
				rawProviderHistory: { included: false, reason: "omitted_by_default" },
				sources: {
					lifecycle: {
						status: "captured",
						sourceBytes: 321,
						sourceSha256: "a".repeat(64),
						projection: { prompt: "PRIVATE_PROJECTION" },
					},
					transcript: {
						status: "captured",
						sourceBytes: 123,
						sourceSha256: "b".repeat(64),
						projection: "PRIVATE_TRANSCRIPT_CONTENT",
					},
				},
				joins: { missing: [] },
			},
		}

		const prompt = buildIncidentInvestigationPrompt(context, collectedEvidence)

		for (const heading of [
			"Observed facts",
			"Likely area",
			"Exact evidence references",
			"Unverified hypotheses",
			"Next checks",
		])
			expect(prompt).toContain(heading)
		expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(12_000)
		expect(prompt).toContain("SHA-256")
		expect(prompt).not.toContain("PRIVATE_PROMPT")
		expect(prompt).not.toContain("PRIVATE_PROJECTION")
		expect(prompt).not.toContain("PRIVATE_TRANSCRIPT_CONTENT")
		expect(prompt).not.toContain("PRIVATE_PROVIDER_ERROR")
	})
})
