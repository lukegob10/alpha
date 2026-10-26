import { DEFAULT_MEMORY_SETTINGS } from "@alpha-code/types"
import { TaskMemoryContext } from "../../../services/memory/TaskMemoryContext"
import { Task } from "../Task"

function memoryTask(options: { taskKind?: "primary" | "subagent" } = {}) {
	const readSummary = vi.fn(async () => "An initial remembered fact")
	const context = new TaskMemoryContext({
		settings: { ...DEFAULT_MEMORY_SETTINGS, enabled: true },
		rootPath: "/alpha/memories_v2",
		readSummary,
		...options,
	})
	const persist = vi.fn<(_reason: string) => Promise<void>>(async () => undefined)
	const task = Object.assign(Object.create(Task.prototype), {
		taskMemoryContext: context,
		memoryPreferenceSaveQueue: Promise.resolve(),
		requireAlphaMessagesSaved: persist,
	}) as Task
	return { task, context, persist, readSummary }
}

describe("Task memory integration", () => {
	it("persists explicit generation changes while retaining the frozen prompt context", async () => {
		const { task, persist, readSummary } = memoryTask()
		const initial = await task.getMemoryContext()
		await task.setMemoryGenerationEnabled(false)
		expect(persist).toHaveBeenCalledWith("memory generation preference")
		expect(task.memory).toEqual({ version: "v2", useMemories: true, generateMemories: false })
		readSummary.mockResolvedValue("Different memory from another conversation")
		expect(await task.getMemoryContext()).toBe(initial)
		expect(readSummary).toHaveBeenCalledOnce()
	})

	it("serializes generation preference persistence without a stale overlapping toggle", async () => {
		const { task, persist } = memoryTask()
		let finishSave!: () => void
		persist.mockImplementationOnce(() => new Promise<void>((resolve) => (finishSave = resolve)))
		const disable = task.setMemoryGenerationEnabled(false)
		const enable = task.setMemoryGenerationEnabled(true)
		await Promise.resolve()
		expect(task.memory.generateMemories).toBe(false)
		expect(persist).toHaveBeenCalledOnce()
		finishSave()
		await Promise.all([disable, enable])
		expect(task.memory.generateMemories).toBe(true)
		expect(persist).toHaveBeenCalledTimes(2)
	})

	it("keeps generation off after a failed opt-in and allows a later explicit retry", async () => {
		const { task, context, persist } = memoryTask()
		context.setGenerationEnabled(false)
		persist.mockRejectedValueOnce(new Error("Persistence failed"))
		await expect(task.setMemoryGenerationEnabled(true)).rejects.toThrow("Persistence failed")
		expect(task.memory.generateMemories).toBe(false)
		await task.setMemoryGenerationEnabled(true)
		expect(task.memory.generateMemories).toBe(true)
	})

	it("retains an opt-out even when the preference cannot be persisted", async () => {
		const { task, persist } = memoryTask()
		persist.mockRejectedValueOnce(new Error("Persistence failed"))
		await expect(task.setMemoryGenerationEnabled(false)).rejects.toThrow("Persistence failed")
		expect(task.memory.generateMemories).toBe(false)
		await task.setMemoryGenerationEnabled(false)
		expect(persist).toHaveBeenCalledTimes(2)
	})

	it("records external context once and persists that exclusion provenance", async () => {
		const { task, persist } = memoryTask()
		await task.markMemoryExternalContext()
		await task.markMemoryExternalContext()
		expect(task.memory.externalContext).toBe(true)
		expect(persist).toHaveBeenCalledExactlyOnceWith("memory source provenance")
	})

	it("retries failed provenance persistence before allowing another external effect", async () => {
		const { task, persist } = memoryTask()
		persist.mockRejectedValueOnce(new Error("Persistence failed"))
		await expect(task.markMemoryExternalContext()).rejects.toThrow("Persistence failed")
		expect(task.memory.externalContext).toBe(true)
		await task.markMemoryExternalContext()
		await task.markMemoryExternalContext()
		expect(persist).toHaveBeenCalledTimes(2)
	})

	it("cannot opt a managed child into generation or reread host memory", async () => {
		const { task, persist, readSummary } = memoryTask({ taskKind: "subagent" })
		await task.setMemoryGenerationEnabled(true)
		expect(task.memory.generateMemories).toBe(false)
		expect(await task.getMemoryContext()).toBeUndefined()
		expect(readSummary).not.toHaveBeenCalled()
		expect(persist).not.toHaveBeenCalled()
	})
})
