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

	beforeEach(async () => {
		storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-incident-launch-"))
		monitor = new AgentIncidentMonitor({ now: () => 100 })
		alertId = monitor.observe(failureEvent)!.id
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
})
