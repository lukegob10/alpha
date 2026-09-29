import fs from "fs/promises"
import os from "os"
import path from "path"

import type { AgentLifecycleEvent } from "@alpha-code/types"
import { AgentIncidentMonitor } from "../../agent/AgentIncidentMonitor"
import type { Task } from "../../task/Task"
import { AlphaProvider } from "../AlphaProvider"

const failureEvent: AgentLifecycleEvent = {
	version: 1,
	eventId: "failure-event",
	sequence: 1,
	taskId: "source-task",
	runId: "run-one",
	turnId: "turn-one",
	occurredAt: 100,
	type: "turn_failed",
	payload: { status: "failed", error: "PRIVATE PROVIDER ERROR" },
}

describe("AlphaProvider incident investigation launch", () => {
	let storage: string
	let monitor: AgentIncidentMonitor
	let alertId: string
	let provider: AlphaProvider
	let createTask: ReturnType<typeof vi.fn>
	let showTaskWithId: ReturnType<typeof vi.fn>
	let getAll: ReturnType<typeof vi.fn>
	let positiveTurnId: string
	let failedTurnId: string

	beforeEach(async () => {
		storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-incident-launch-"))
		monitor = new AgentIncidentMonitor({ now: () => 100 })
		alertId = monitor.observe(failureEvent)!.id
		monitor.observe({
			...failureEvent,
			eventId: "positive-turn-start",
			sequence: 1,
			taskId: "success-source",
			turnId: "positive-turn",
			type: "turn_started",
			payload: { phase: "working" },
		})
		monitor.observe({
			...failureEvent,
			eventId: "positive-turn-completed",
			sequence: 2,
			taskId: "success-source",
			turnId: "positive-turn",
			occurredAt: 101,
			type: "turn_completed",
			payload: { status: "completed" },
		})
		failedTurnId = monitor.snapshot().turns.find((turn) => turn.status === "failed")!.id
		positiveTurnId = monitor.snapshot().turns.find((turn) => turn.status === "completed")!.id
		createTask = vi.fn().mockResolvedValue({ taskId: "diagnostic-task" } as Task)
		showTaskWithId = vi.fn().mockResolvedValue(undefined)
		getAll = vi.fn(() => [])
		provider = Object.assign(Object.create(AlphaProvider.prototype), {
			incidentMonitor: monitor,
			incidentHistoryLoaded: true,
			incidentLaunches: new Map(),
			taskHistoryStoreReady: Promise.resolve(),
			taskHistoryStore: { getAll },
			contextProxy: { globalStorageUri: { fsPath: storage } },
			taskSessions: { canCreateTask: () => true },
			isIncidentDashboardEnabled: () => true,
			createTask,
			showTaskWithId,
		}) as AlphaProvider
	})

	afterEach(async () => {
		await fs.rm(storage, { recursive: true, force: true })
	})

	it("creates one marked read-only investigation from redacted evidence without modifying the source task", async () => {
		const [first, second] = await Promise.all([
			provider.startIncidentDebuggingTask(alertId),
			provider.startIncidentDebuggingTask(alertId),
		])
		expect(first).toBe(second)
		expect(createTask).toHaveBeenCalledTimes(1)
		const [prompt, images, parent, options] = createTask.mock.calls[0]!
		expect(prompt).toContain("Observed facts")
		expect(prompt).toContain("Unverified hypotheses")
		expect(prompt).not.toContain("PRIVATE PROVIDER ERROR")
		expect(prompt).not.toContain(storage)
		expect(images).toBeUndefined()
		expect(parent).toBeUndefined()
		expect(options).toMatchObject({
			background: true,
			preserveExisting: true,
			diagnosticSession: true,
			diagnosticIncidentId: alertId,
			diagnosticSourceTaskId: "source-task",
		})
		expect(showTaskWithId).toHaveBeenCalledExactlyOnceWith("diagnostic-task")
	})

	it("reopens a persisted investigation instead of creating another task", async () => {
		getAll.mockReturnValue([{ id: "old-investigation", diagnosticIncidentId: alertId }])
		const oldTask = { taskId: "old-investigation" } as Task
		Object.assign(provider, { getLiveTask: () => oldTask })
		expect(await provider.startIncidentDebuggingTask(alertId)).toBe(oldTask)
		expect(showTaskWithId).toHaveBeenCalledExactlyOnceWith("old-investigation")
		expect(createTask).not.toHaveBeenCalled()
	})

	it("returns lazy turn details and launches read-only investigations for positive and error turns", async () => {
		const [failureDetail, positiveDetail] = await Promise.all([
			provider.getIncidentDashboardTurnDetail(failedTurnId),
			provider.getIncidentDashboardTurnDetail(positiveTurnId),
		])
		expect(failureDetail?.turn).toMatchObject({ id: failedTurnId, status: "failed" })
		expect(positiveDetail?.turn).toMatchObject({ id: positiveTurnId, status: "completed" })

		const [first, duplicate] = await Promise.all([
			provider.startIncidentDebuggingTurnTask(positiveTurnId),
			provider.startIncidentDebuggingTurnTask(positiveTurnId),
		])
		const failed = await provider.startIncidentDebuggingTurnTask(failedTurnId)
		expect(first).toBe(duplicate)
		expect(createTask).toHaveBeenCalledTimes(2)
		expect(createTask.mock.calls[0]?.[0]).toContain("Status: completed")
		expect(createTask.mock.calls[0]?.[0]).not.toContain("PRIVATE PROVIDER ERROR")
		expect(createTask.mock.calls[0]?.[3]).toMatchObject({
			diagnosticSession: true,
			diagnosticIncidentId: `turn:${positiveTurnId}`,
			diagnosticSourceTaskId: "success-source",
		})
		expect(createTask.mock.calls[1]?.[0]).toContain("Status: failed")
		expect(createTask.mock.calls[1]?.[3]).toMatchObject({
			diagnosticSession: true,
			diagnosticIncidentId: `turn:${failedTurnId}`,
			diagnosticSourceTaskId: "source-task",
		})
		expect(showTaskWithId).toHaveBeenCalledTimes(2)
		expect(failed).toMatchObject({ taskId: "diagnostic-task" })
	})

	it("rejects raw turn identifiers at the provider boundary", async () => {
		expect(await provider.getIncidentDashboardTurnDetail("raw-turn-id")).toBeUndefined()
		await expect(provider.startIncidentDebuggingTurnTask("raw-turn-id")).rejects.toThrow(
			"Turn is no longer available",
		)
		expect(createTask).not.toHaveBeenCalled()
	})

	it("requires the debug gate for turn details and investigations", async () => {
		Object.assign(provider, { isIncidentDashboardEnabled: () => false })
		expect(await provider.getIncidentDashboardTurnDetail(failedTurnId)).toBeUndefined()
		await expect(provider.startIncidentDebuggingTurnTask(failedTurnId)).rejects.toThrow(
			"Alpha debug mode is disabled",
		)
		expect(createTask).not.toHaveBeenCalled()
	})
})
