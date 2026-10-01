import {
	incidentDashboardSnapshotSchema,
	incidentDashboardTurnDetailMessageSchema,
	incidentDashboardTurnDetailRequestSchema,
	incidentDashboardStartTurnInvestigationSchema,
} from "../incident-dashboard.js"

const hash = "a".repeat(64)
const turn = {
	id: hash,
	taskId: "b".repeat(64),
	taskLabel: "Task 0123abcd",
	status: "completed",
	startedAt: 100,
	endedAt: 150,
	durationMs: 50,
	steps: 2,
	toolCalls: 1,
	toolErrors: 0,
}

describe("incident dashboard turn contract", () => {
	it("accepts optional bounded chat titles and retains legacy anonymous rows", () => {
		const snapshot = { generatedAt: 200, tasks: [], alerts: [], turns: [turn] }
		expect(incidentDashboardSnapshotSchema.safeParse(snapshot).success).toBe(true)
		expect(
			incidentDashboardSnapshotSchema.safeParse({ ...snapshot, turns: [{ ...turn, chatTitle: "Fix dashboard" }] })
				.success,
		).toBe(true)
		for (const chatTitle of ["", "x".repeat(201)]) {
			expect(
				incidentDashboardSnapshotSchema.safeParse({ ...snapshot, turns: [{ ...turn, chatTitle }] }).success,
			).toBe(false)
		}
	})

	it("accepts bounded positive and error turns without exposing content", () => {
		const snapshot = { generatedAt: 200, tasks: [], alerts: [], turns: [turn, { ...turn, status: "failed" }] }
		expect(incidentDashboardSnapshotSchema.safeParse(snapshot).success).toBe(true)
		expect(incidentDashboardSnapshotSchema.safeParse({ ...snapshot, turns: Array(65).fill(turn) }).success).toBe(
			false,
		)
		expect(
			incidentDashboardSnapshotSchema.safeParse({ ...snapshot, turns: [{ ...turn, prompt: "secret" }] }).success,
		).toBe(false)
	})

	it("accepts an optional saved workspace while bounding its length", () => {
		const snapshot = { generatedAt: 200, tasks: [], alerts: [], turns: [turn] }
		for (const workspace of [undefined, "/projects/Alpha-Code", "C:\\projects\\Alpha-Code"]) {
			expect(
				incidentDashboardSnapshotSchema.safeParse({ ...snapshot, turns: [{ ...turn, workspace }] }).success,
			).toBe(true)
		}
		for (const workspace of ["", "x".repeat(4097)]) {
			expect(
				incidentDashboardSnapshotSchema.safeParse({ ...snapshot, turns: [{ ...turn, workspace }] }).success,
			).toBe(false)
		}
	})

	it("validates opaque detail requests and bounded responses", () => {
		expect(
			incidentDashboardTurnDetailRequestSchema.safeParse({
				type: "incidentDashboardRequestTurnDetail",
				turnId: hash,
			}).success,
		).toBe(true)
		expect(
			incidentDashboardStartTurnInvestigationSchema.safeParse({ type: "startDebuggingTurn", turnId: hash })
				.success,
		).toBe(true)
		expect(
			incidentDashboardTurnDetailRequestSchema.safeParse({
				type: "incidentDashboardRequestTurnDetail",
				turnId: "raw-id",
			}).success,
		).toBe(false)

		const message = {
			type: "incidentDashboardTurnDetail",
			turnId: hash,
			detail: { turn, events: [{ id: hash, at: 120, kind: "tool_succeeded", toolName: "read_file" }] },
		}
		expect(incidentDashboardTurnDetailMessageSchema.safeParse(message).success).toBe(true)
		expect(incidentDashboardTurnDetailMessageSchema.safeParse({ ...message, detail: undefined }).success).toBe(true)
		expect(
			incidentDashboardTurnDetailMessageSchema.safeParse({
				...message,
				detail: { ...message.detail, events: Array(41).fill(message.detail.events[0]) },
			}).success,
		).toBe(false)
		expect(
			incidentDashboardTurnDetailMessageSchema.safeParse({
				...message,
				detail: { ...message.detail, events: [{ ...message.detail.events[0], output: "secret" }] },
			}).success,
		).toBe(false)
	})
})
