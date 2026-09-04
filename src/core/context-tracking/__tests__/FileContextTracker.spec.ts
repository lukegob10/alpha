import { FileContextTracker } from "../FileContextTracker"
import type { TaskMetadata } from "../FileContextTrackerTypes"

function createTracker(): FileContextTracker {
	const tracker = new FileContextTracker({} as any, "task-1")
	vi.spyOn(tracker, "getTaskMetadata").mockResolvedValue({ files_in_context: [] })
	vi.spyOn(tracker, "saveTaskMetadata").mockResolvedValue()
	return tracker
}

async function markUserEditedFile(tracker: FileContextTracker, filePath: string): Promise<void> {
	await tracker.addFileToFileContextTracker("task-1", filePath, "user_edited")
}

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

describe("FileContextTracker modified-file receipts", () => {
	it("keeps captured files pending when persistence does not commit the receipt", async () => {
		const tracker = createTracker()
		await markUserEditedFile(tracker, "src/one.ts")
		await markUserEditedFile(tracker, "src/two.ts")

		const firstAttempt = tracker.captureRecentlyModifiedFiles()
		expect(firstAttempt.files).toEqual(["src/one.ts", "src/two.ts"])

		const retry = tracker.captureRecentlyModifiedFiles()
		expect(retry.files).toEqual(["src/one.ts", "src/two.ts"])
		retry.commit()
	})

	it("preserves a same-path modification that happens after capture", async () => {
		const tracker = createTracker()
		await markUserEditedFile(tracker, "src/one.ts")

		const receipt = tracker.captureRecentlyModifiedFiles()
		await markUserEditedFile(tracker, "src/one.ts")
		receipt.commit()

		expect(tracker.captureRecentlyModifiedFiles().files).toEqual(["src/one.ts"])
	})

	it("makes committing a receipt idempotent", async () => {
		const tracker = createTracker()
		await markUserEditedFile(tracker, "src/one.ts")

		const receipt = tracker.captureRecentlyModifiedFiles()
		receipt.commit()
		receipt.commit()

		expect(tracker.captureRecentlyModifiedFiles().files).toEqual([])
	})

	it("commits only the captured portion and leaves the capped remainder pending", async () => {
		const tracker = createTracker()
		await markUserEditedFile(tracker, "src/one.ts")
		await markUserEditedFile(tracker, "src/two.ts")
		await markUserEditedFile(tracker, "src/three.ts")

		const receipt = tracker.captureRecentlyModifiedFiles(2)
		expect(receipt.files).toEqual(["src/one.ts", "src/two.ts"])
		receipt.commit()

		expect(tracker.captureRecentlyModifiedFiles().files).toEqual(["src/three.ts"])
	})

	it("bounds the default receipt and leaves the remainder pending", async () => {
		const tracker = createTracker()
		const filePaths = Array.from({ length: 201 }, (_, index) => `src/${index}.ts`)
		for (const filePath of filePaths) {
			await markUserEditedFile(tracker, filePath)
		}

		const receipt = tracker.captureRecentlyModifiedFiles()
		expect(receipt.files).toHaveLength(200)
		receipt.commit()

		expect(tracker.captureRecentlyModifiedFiles().files).toEqual(["src/200.ts"])
	})

	it("skips an over-budget path without blocking later paths or acknowledging it", async () => {
		const tracker = createTracker()
		const longPath = `src/${"a".repeat(32)}.ts`
		await markUserEditedFile(tracker, longPath)
		await markUserEditedFile(tracker, "src/short.ts")

		const receipt = tracker.captureRecentlyModifiedFiles(200, 20)
		expect(receipt.files).toEqual(["src/short.ts"])
		expect(receipt.files.join("\n").length).toBeLessThanOrEqual(20)
		receipt.commit()

		expect(tracker.captureRecentlyModifiedFiles(200, 20).files).toEqual([])
		expect(tracker.captureRecentlyModifiedFiles(200, 100).files).toEqual([longPath])
	})
})
