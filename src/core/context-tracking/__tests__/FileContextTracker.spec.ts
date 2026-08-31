import { FileContextTracker } from "../FileContextTracker"
import type { TaskMetadata } from "../FileContextTrackerTypes"

describe("FileContextTracker metadata updates", () => {
	it("serializes concurrent read-modify-write transactions so neither file record is lost", async () => {
		const tracker = new FileContextTracker({} as any, "task-1")
		let persisted: TaskMetadata = { files_in_context: [] }
		let releaseFirstSave!: () => void
		let markFirstSaveStarted!: () => void
		const firstSaveStarted = new Promise<void>((resolve) => {
			markFirstSaveStarted = resolve
		})
		const firstSaveGate = new Promise<void>((resolve) => {
			releaseFirstSave = resolve
		})

		const readSpy = vi.spyOn(tracker, "getTaskMetadata").mockImplementation(async () => structuredClone(persisted))
		let saveCount = 0
		vi.spyOn(tracker, "saveTaskMetadata").mockImplementation(async (_taskId, metadata) => {
			saveCount++
			if (saveCount === 1) {
				markFirstSaveStarted()
				await firstSaveGate
			}
			persisted = structuredClone(metadata)
		})

		const firstUpdate = tracker.addFileToFileContextTracker("task-1", "src/one.ts", "read_tool")
		await firstSaveStarted
		const secondUpdate = tracker.addFileToFileContextTracker("task-1", "src/two.ts", "read_tool")
		await Promise.resolve()

		expect(readSpy).toHaveBeenCalledTimes(1)
		releaseFirstSave()
		await Promise.all([firstUpdate, secondUpdate])

		expect(persisted.files_in_context.map(({ path }) => path)).toEqual(["src/one.ts", "src/two.ts"])
		expect(readSpy).toHaveBeenCalledTimes(2)
	})
})
