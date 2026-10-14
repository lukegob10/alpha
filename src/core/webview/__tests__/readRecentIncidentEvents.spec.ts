import fs from "fs/promises"
import os from "os"
import path from "path"

import { GlobalFileNames } from "../../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../../utils/storage"
import { readRecentIncidentEvents } from "../readRecentIncidentEvents"

describe("readRecentIncidentEvents", () => {
	let storage: string

	beforeEach(async () => {
		storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-incident-read-"))
	})

	afterEach(async () => {
		await fs.rm(storage, { recursive: true, force: true })
	})

	it("loads only validated events from the bounded journal tail", async () => {
		const taskId = "incident-task"
		const directory = await getTaskDirectoryPath(storage, taskId)
		const event = (index: number) => ({
			version: 1,
			eventId: `event-${index}`,
			sequence: index + 1,
			taskId,
			runId: "run-one",
			turnId: "turn-one",
			occurredAt: index + 1,
			type: "phase_changed",
			payload: { phase: "working" },
		})
		const lines = Array.from({ length: 300 }, (_, index) => JSON.stringify(event(index)))
		lines.push(JSON.stringify({ ...event(301), taskId: "different-task" }))
		lines.push("not-json")
		await fs.writeFile(path.join(directory, GlobalFileNames.agentLifecycleEvents), `${lines.join("\n")}\n`)
		const result = await readRecentIncidentEvents(storage, taskId)
		expect(result.status).toBe("incomplete")
		expect(result.events).toHaveLength(254)
		expect(result.events[0]?.eventId).toBe("event-46")
		expect(result.events.at(-1)?.eventId).toBe("event-299")
	})

	it("treats a missing journal as absent evidence", async () => {
		expect(await readRecentIncidentEvents(storage, "missing-task")).toEqual({ events: [], status: "absent" })
		await expect(fs.stat(path.join(storage, "tasks"))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it.each(["record limit", "byte limit", "partial append"])(
		"reports incomplete coverage after a %s",
		async (boundary) => {
			const taskId = "bounded-task"
			const directory = await getTaskDirectoryPath(storage, taskId)
			const lineCount = boundary === "record limit" ? 257 : boundary === "byte limit" ? 20 : 2
			const lines = Array.from({ length: lineCount }, (_, index) =>
				JSON.stringify({
					version: 1,
					taskId,
					runId: "run",
					turnId: "turn",
					eventId: `event-${index}`,
					sequence: index + 1,
					occurredAt: index + 1,
					type: "turn_failed",
					payload: { status: "failed", error: boundary === "byte limit" ? "x".repeat(10_000) : "failure" },
				}),
			)
			await fs.writeFile(
				path.join(directory, GlobalFileNames.agentLifecycleEvents),
				lines.join("\n") + "\n" + (boundary === "partial append" ? '{"version":' : ""),
			)
			const result = await readRecentIncidentEvents(storage, taskId)
			expect(result.status).toBe("incomplete")
			expect(result.events.length).toBeGreaterThan(0)
			if (boundary !== "byte limit") expect(result.events).toHaveLength(boundary === "record limit" ? 256 : 2)
		},
	)
})
