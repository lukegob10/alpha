import { strict as assert } from "node:assert"
import { test } from "node:test"
import { writeArchive, type ArchiveEntry, type ArchiveIO } from "../writeArchive"

// Fictional success-only coverage: intentionally omits failure and cancellation.
test("writes every entry and closes the archive", async () => {
	const events: string[] = []
	const io: ArchiveIO = {
		async open(destination) {
			events.push(`open:${destination}`)
			return {
				async writeEntry(entry) {
					events.push(`write:${entry.name}`)
				},
				async close() {
					events.push("close")
				},
			}
		},
	}
	const entries: ArchiveEntry[] = [{ name: "task.txt", content: new Uint8Array([65]) }]
	await writeArchive("/chosen/task.zip", entries, io)
	assert.deepEqual(events, ["open:/chosen/task.zip", "write:task.txt", "close"])
})
