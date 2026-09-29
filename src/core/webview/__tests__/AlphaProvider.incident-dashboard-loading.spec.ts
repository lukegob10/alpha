import type { RecentIncidentEvents } from "../readRecentIncidentEvents"

vi.mock("../readRecentIncidentEvents", () => ({ readRecentIncidentEvents: vi.fn() }))

import { readRecentIncidentEvents } from "../readRecentIncidentEvents"
import { AgentIncidentMonitor } from "../../agent/AgentIncidentMonitor"
import { AlphaProvider } from "../AlphaProvider"

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("AlphaProvider incident dashboard loading", () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.clearAllMocks()
	})

	it("publishes the in-memory snapshot before bounded history hydration completes", async () => {
		vi.useFakeTimers()
		const journalRead = vi.mocked(readRecentIncidentEvents)
		journalRead.mockImplementation(async () => {
			await delay(25)
			return { events: [], status: "absent" } satisfies RecentIncidentEvents
		})

		const baselineStartedAt = Date.now()
		const baselineLoad = (async () => {
			await delay(25) // Task history store initialization.
			await readRecentIncidentEvents("unused-storage-path", "baseline-task")
		})()
		await vi.advanceTimersByTimeAsync(50)
		await baselineLoad
		const baselineFirstSnapshotMs = Date.now() - baselineStartedAt
		expect(baselineFirstSnapshotMs).toBe(50)
		expect(journalRead).toHaveBeenCalledTimes(1)

		journalRead.mockClear()
		const monitor = new AgentIncidentMonitor({ now: Date.now })
		const snapshots: Array<ReturnType<typeof monitor.snapshot>> = []
		monitor.subscribe((snapshot) => snapshots.push(snapshot))
		const provider = Object.assign(Object.create(AlphaProvider.prototype), {
			incidentMonitor: monitor,
			incidentHistoryLoaded: false,
			taskHistoryStoreReady: delay(25),
			taskHistoryStore: {
				getAll: () => [{ id: "stored-task", status: "completed", ts: Date.now() }],
			},
			contextProxy: { globalStorageUri: { fsPath: "unused-storage-path" } },
			getLiveTaskIds: () => [],
			isIncidentDashboardEnabled: () => true,
			log: vi.fn(),
		}) as AlphaProvider

		const optimizedStartedAt = Date.now()
		const firstSnapshot = await provider.getIncidentDashboardSnapshot()
		const optimizedFirstSnapshotMs = Date.now() - optimizedStartedAt
		expect(optimizedFirstSnapshotMs).toBe(0)
		expect(firstSnapshot.tasks).toEqual([])
		expect(journalRead).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(50)
		expect(journalRead).toHaveBeenCalledExactlyOnceWith("unused-storage-path", "stored-task")
		expect(monitor.snapshot().tasks[0]?.state).toBe("completed")
		expect(snapshots.at(-1)?.tasks[0]?.state).toBe("completed")
	})
})
