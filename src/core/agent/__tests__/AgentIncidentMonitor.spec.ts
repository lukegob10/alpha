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
		stepId?: string
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
		...(options.stepId ? { stepId: options.stepId } : {}),
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

	it("projects completed and failed turns with safe details and deduplicated counters", () => {
		const monitor = new AgentIncidentMonitor({ now: () => 9_000 })
		const positiveEvents = [
			turnStarted({
				taskId: "positive-task",
				turnId: "positive-turn",
				eventId: "positive-start",
				sequence: 1,
				at: 100,
			}),
			lifecycleEvent(
				"step_started",
				{ phase: "working" },
				{
					taskId: "positive-task",
					turnId: "positive-turn",
					stepId: "positive-step",
					eventId: "positive-step-start",
					sequence: 2,
					at: 110,
				},
			),
			lifecycleEvent(
				"step_status_changed",
				{ status: "completed" },
				{
					taskId: "positive-task",
					turnId: "positive-turn",
					stepId: "positive-step",
					eventId: "positive-step-complete",
					sequence: 3,
					at: 120,
				},
			),
			lifecycleEvent(
				"tool_call_accepted",
				{
					item: {
						itemId: "positive-call-item",
						type: "tool_call",
						toolCallId: "positive-call-id",
						name: "read_file",
						arguments: { path: "PRIVATE_PATH" },
						status: "accepted",
					},
				},
				{
					taskId: "positive-task",
					turnId: "positive-turn",
					eventId: "positive-tool-accepted",
					sequence: 4,
					at: 130,
				},
			),
			lifecycleEvent(
				"tool_result_recorded",
				{
					item: {
						itemId: "positive-result-item",
						type: "tool_result",
						toolCallId: "positive-call-id",
						status: "success",
						output: "PRIVATE_TOOL_OUTPUT",
					},
				},
				{
					taskId: "positive-task",
					turnId: "positive-turn",
					eventId: "positive-tool-success",
					sequence: 5,
					at: 140,
				},
			),
			lifecycleEvent(
				"turn_completed",
				{ status: "completed" },
				{
					taskId: "positive-task",
					turnId: "positive-turn",
					eventId: "positive-complete",
					sequence: 6,
					at: 150,
				},
			),
		]
		for (const event of positiveEvents) monitor.observe(event)
		monitor.observe(positiveEvents[3])

		const failedEvents = [
			turnStarted({
				taskId: "failed-turn-task",
				turnId: "reused-turn-id",
				eventId: "failed-start",
				sequence: 1,
				at: 200,
			}),
			lifecycleEvent(
				"tool_call_accepted",
				{
					item: {
						itemId: "failed-call-item",
						type: "tool_call",
						toolCallId: "failed-call-id",
						name: "run_command",
						arguments: { command: "PRIVATE_COMMAND" },
						status: "accepted",
					},
				},
				{
					taskId: "failed-turn-task",
					turnId: "reused-turn-id",
					eventId: "failed-tool-accepted",
					sequence: 2,
					at: 210,
				},
			),
			lifecycleEvent(
				"tool_result_recorded",
				{
					item: {
						itemId: "failed-result-item",
						type: "tool_result",
						toolCallId: "failed-call-id",
						status: "error",
						output: "PRIVATE_ERROR_OUTPUT",
					},
				},
				{
					taskId: "failed-turn-task",
					turnId: "reused-turn-id",
					eventId: "failed-tool-error",
					sequence: 3,
					at: 220,
				},
			),
			turnFailed({
				taskId: "failed-turn-task",
				turnId: "reused-turn-id",
				eventId: "failed-terminal",
				sequence: 4,
				at: 230,
			}),
		]
		for (const event of failedEvents) monitor.observe(event)

		const snapshot = monitor.snapshot()
		const positive = snapshot.turns.find(({ taskId }) => taskId === digest("positive-task"))!
		const failed = snapshot.turns.find(({ taskId }) => taskId === digest("failed-turn-task"))!
		expect(positive).toMatchObject({
			id: digest("turn\0positive-task\0run-incident\0positive-turn"),
			status: "completed",
			startedAt: 100,
			endedAt: 150,
			durationMs: 50,
			steps: 1,
			toolCalls: 1,
			toolErrors: 0,
		})
		expect(failed).toMatchObject({
			status: "failed",
			startedAt: 200,
			endedAt: 230,
			toolCalls: 1,
			toolErrors: 1,
		})
		const detail = monitor.getTurnDetail(positive.id)!
		expect(detail.turn.id).toBe(positive.id)
		expect(detail.events.map(({ kind }) => kind)).toEqual([
			"turn_started",
			"step_started",
			"step_completed",
			"tool_accepted",
			"tool_succeeded",
			"turn_completed",
		])
		expect(detail.events.filter(({ kind }) => kind === "tool_accepted")[0].toolName).toBe("read_file")
		expect(monitor.getTurnDetail(digest("unavailable"))).toBeUndefined()
		expect(incidentDashboardSnapshotSchema.safeParse(snapshot).success).toBe(true)
		const exposed = JSON.stringify({ snapshot, detail })
		for (const privateValue of [
			"positive-task",
			"positive-turn",
			"positive-step",
			"positive-call-id",
			"PRIVATE_PATH",
			"PRIVATE_TOOL_OUTPUT",
			"PRIVATE_COMMAND",
			"PRIVATE_ERROR_OUTPUT",
		])
			expect(exposed).not.toContain(privateValue)
	})

	it("restores turn rows from seeded lifecycle tails and excludes diagnostic sessions", () => {
		const monitor = new AgentIncidentMonitor({ now: () => 5_000 })
		const started = turnStarted({
			taskId: "restored-positive",
			turnId: "restored-turn",
			eventId: "restore-start",
			at: 100,
			sequence: 1,
		})
		const completed = lifecycleEvent(
			"turn_completed",
			{ status: "completed" },
			{ taskId: "restored-positive", turnId: "restored-turn", eventId: "restore-complete", at: 125, sequence: 2 },
		)
		const failed = turnFailed({ taskId: "restored-diagnostic", eventId: "diagnostic-fail", at: 200, sequence: 1 })
		const snapshot = monitor.restore([
			{ taskId: "restored-positive", status: "completed", updatedAt: 125, events: [started, completed] },
			{
				taskId: "restored-diagnostic",
				status: "failed",
				updatedAt: 200,
				diagnosticSession: true,
				events: [failed],
			},
		])

		expect(snapshot.turns).toHaveLength(1)
		expect(snapshot.turns[0]).toMatchObject({ status: "completed", startedAt: 100, endedAt: 125, durationMs: 25 })
		expect(snapshot.turns[0].taskId).toBe(digest("restored-positive"))
		expect(snapshot.turns.map(({ taskId }) => taskId)).not.toContain(digest("restored-diagnostic"))
		expect(monitor.getTurnDetail(digest("turn\0restored-diagnostic\0run-incident\0turn-incident"))).toBeUndefined()
	})

	it("bounds retained turns and detail events and explains inferred start times", () => {
		const monitor = new AgentIncidentMonitor({ now: () => 9_000 })
		const first = lifecycleEvent(
			"step_started",
			{ phase: "working" },
			{
				taskId: "long-turn-task",
				turnId: "long-turn",
				stepId: "step-0",
				eventId: "long-step-0",
				sequence: 1,
				at: 100,
			},
		)
		monitor.observe(first)
		for (let index = 1; index < 50; index++) {
			monitor.observe(
				lifecycleEvent(
					"step_started",
					{ phase: "working" },
					{
						taskId: "long-turn-task",
						turnId: "long-turn",
						stepId: `step-${index}`,
						eventId: `long-step-${index}`,
						sequence: index + 1,
						at: 100 + index,
					},
				),
			)
		}
		const snapshot = monitor.snapshot()
		const longTurnId = digest("turn\0long-turn-task\0run-incident\0long-turn")
		const detail = monitor.getTurnDetail(longTurnId)!
		const prompt = monitor.buildTurnInvestigationPrompt(longTurnId)!
		expect(snapshot.turns.length).toBeLessThanOrEqual(64)
		expect(detail.events).toHaveLength(40)
		expect(detail.turn.steps).toBe(50)
		expect(prompt).toContain("first retained lifecycle event; original start may be earlier")
		expect(prompt).toContain("Steps: 50")
		expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(12_000)
		expect(incidentDashboardSnapshotSchema.safeParse(snapshot).success).toBe(true)

		const boundedMonitor = new AgentIncidentMonitor({ now: () => 9_000 })
		for (let index = 0; index < 70; index++) {
			const options = {
				taskId: "bounded-task",
				runId: "bounded-run",
				turnId: `bounded-turn-${index}`,
				at: 500 + index * 2,
			}
			boundedMonitor.observe(turnStarted({ ...options, eventId: `bounded-start-${index}`, sequence: 1 }))
			boundedMonitor.observe(
				lifecycleEvent(
					"turn_completed",
					{ status: "completed" },
					{ ...options, eventId: `bounded-complete-${index}`, sequence: 2, at: options.at + 1 },
				),
			)
		}
		const boundedSnapshot = boundedMonitor.snapshot()
		expect(boundedSnapshot.turns).toHaveLength(64)
		expect(incidentDashboardSnapshotSchema.safeParse(boundedSnapshot).success).toBe(true)
		const retainedTurnIds = boundedSnapshot.turns.map(({ id }) => id)
		const oldStarted = turnStarted({
			taskId: "bounded-task",
			runId: "bounded-run",
			turnId: "older-than-retained",
			eventId: "old-retained-start",
			at: 1,
			sequence: 1,
		})
		const oldCompleted = lifecycleEvent(
			"turn_completed",
			{ status: "completed" },
			{
				taskId: "bounded-task",
				runId: "bounded-run",
				turnId: "older-than-retained",
				eventId: "old-retained-complete",
				at: 2,
				sequence: 2,
			},
		)
		const withOldHistory = boundedMonitor.restore([
			{ taskId: "bounded-task", status: "completed", updatedAt: 2, events: [oldStarted, oldCompleted] },
		])
		expect(withOldHistory.turns.map(({ id }) => id)).toEqual(retainedTurnIds)
	})

	it("builds positive and error turn prompts from safe references only", () => {
		const monitor = new AgentIncidentMonitor({ now: () => 9_000 })
		monitor.observe(turnStarted({ taskId: "safe-task", turnId: "safe-turn", eventId: "safe-start", sequence: 1 }))
		monitor.observe(
			lifecycleEvent(
				"turn_completed",
				{ status: "completed", reason: "PRIVATE_COMPLETION_REASON" },
				{ taskId: "safe-task", turnId: "safe-turn", eventId: "safe-complete", sequence: 2 },
			),
		)
		monitor.observe(
			turnStarted({
				taskId: "failed-safe-task",
				turnId: "failed-safe-turn",
				eventId: "failed-safe-start",
				sequence: 1,
			}),
		)
		monitor.observe(
			turnFailed({
				taskId: "failed-safe-task",
				turnId: "failed-safe-turn",
				eventId: "failed-safe-end",
				sequence: 2,
			}),
		)
		const completedId = digest("turn\0safe-task\0run-incident\0safe-turn")
		const failedId = digest("turn\0failed-safe-task\0run-incident\0failed-safe-turn")
		const completedPrompt = monitor.buildTurnInvestigationPrompt(completedId)!
		const failedPrompt = monitor.buildTurnInvestigationPrompt(failedId)!

		expect(completedPrompt).toContain("Status: completed")
		expect(completedPrompt).toContain(`Turn ID SHA-256: ${digest("safe-turn")}`)
		expect(failedPrompt).toContain("Status: failed")
		expect(failedPrompt).toContain(`Turn ID SHA-256: ${digest("failed-safe-turn")}`)
		expect(completedPrompt).not.toContain("PRIVATE_COMPLETION_REASON")
		expect(failedPrompt).not.toContain("failed-safe-task")
		expect(monitor.getTurnInvestigationReferences(failedId)).toEqual({
			taskId: "failed-safe-task",
			turnIdSha256: digest("failed-safe-turn"),
		})
	})
})
