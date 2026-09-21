import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@alpha-code/types"
import { MAX_DESIGN_HANDOFF_CHARS } from "@alpha-code/types"

import { parseProposedPlan } from "../../../shared/plan-mode"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import { TaskHistoryStore } from "../TaskHistoryStore"
import { createDesignHandoff } from "../designHandoff"

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
}))

// Keep this persistence test focused on TaskHistoryStore's file/index behavior.
vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn().mockImplementation(async (filePath: string, data: unknown) => {
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, JSON.stringify(data), "utf8")
	}),
}))

describe("design handoff persistence", () => {
	it("creates a bounded handoff whose markdown is the parsed plan body", () => {
		const text = "<proposed_plan>\n# Durable design\n\n- Keep the tags out of storage.\n</proposed_plan>"
		const parsed = parseProposedPlan(text)
		const handoff = createDesignHandoff(text, "primary-task")

		expect(parsed?.complete).toBe(true)
		expect(handoff).toEqual(
			expect.objectContaining({
				title: "Durable design",
				markdown: parsed?.content,
				sourceTaskId: "primary-task",
			}),
		)
		expect(handoff?.digest).toMatch(/^[a-f0-9]{64}$/)
		expect(handoff?.updatedAt).toEqual(expect.any(Number))
	})

	it("ignores incomplete or over-sized plan blocks", () => {
		expect(createDesignHandoff("<proposed_plan>\n# Still streaming", "primary-task")).toBeUndefined()

		const oversized = `<proposed_plan>\n${"x".repeat(MAX_DESIGN_HANDOFF_CHARS + 1)}\n</proposed_plan>`
		expect(createDesignHandoff(oversized, "primary-task")).toBeUndefined()
	})

	it("reloads the latest handoff from the authoritative task file during reconciliation", async () => {
		const tempBase = await fs.realpath(os.tmpdir())
		const storageRoot = await fs.mkdtemp(path.join(tempBase, "alpha-design-handoff-"))
		const taskId = "design-handoff-task"
		const firstHandoff = createDesignHandoff(
			"<proposed_plan>\n# First revision\n\n- Start here.\n</proposed_plan>",
			taskId,
		)!
		const latestHandoff = createDesignHandoff(
			"<proposed_plan>\n# Latest revision\n\n- Continue here.\n</proposed_plan>",
			taskId,
		)!
		const first: HistoryItem = {
			id: taskId,
			number: 1,
			ts: 1,
			task: "Implement the design",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			designHandoff: firstHandoff,
		}
		const latest: HistoryItem = { ...first, ts: 2, designHandoff: latestHandoff }
		const store = new TaskHistoryStore(storageRoot)
		const reloaded = new TaskHistoryStore(storageRoot)

		try {
			await store.initialize()
			await store.upsert(first)
			await store.upsert(latest)
			await store.flushIndex()

			// Simulate a crash between the authoritative task-file write and index refresh.
			const indexPath = path.join(storageRoot, "tasks", GlobalFileNames.historyIndex)
			await fs.writeFile(indexPath, JSON.stringify({ version: 1, updatedAt: 1, entries: [first] }), "utf8")

			await reloaded.initialize()

			expect(reloaded.get(taskId)?.designHandoff).toEqual(latestHandoff)
			expect(reloaded.get(taskId)?.designHandoff?.markdown).toBe("# Latest revision\n\n- Continue here.")
		} finally {
			store.dispose()
			reloaded.dispose()
			await Promise.all([store.flushIndex(), reloaded.flushIndex()])
			expect(path.dirname(path.resolve(storageRoot))).toBe(path.resolve(tempBase))
			expect(path.basename(storageRoot)).toMatch(/^alpha-design-handoff-/)
			await fs.rm(storageRoot, { recursive: true, force: true })
		}
	})
})
