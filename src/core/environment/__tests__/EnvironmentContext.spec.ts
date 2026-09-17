import { EnvironmentContext, awaitEnvironmentRead } from "../EnvironmentContext"

describe("EnvironmentContext commit boundary", () => {
	const facts = [{ name: "Current Mode", value: "code" }]

	it("advances only a committed baseline and settles receipts exactly once", () => {
		const context = new EnvironmentContext()
		const receipt = { commit: vi.fn(), release: vi.fn() }
		const abandoned = context.prepare("task/session", facts, "A", [receipt])
		abandoned.release()
		abandoned.release()
		abandoned.commit()
		expect(receipt.commit).not.toHaveBeenCalled()
		expect(receipt.release).toHaveBeenCalledOnce()
		const retry = context.prepare("task/session", facts, "A+B", [receipt])
		expect(retry.details).toContain("Environment Snapshot")
		expect(retry.details).toContain("A+B")
		retry.commit()
		retry.commit()
		retry.release()
		expect(receipt.commit).toHaveBeenCalledOnce()
		expect(context.prepare("task/session", facts, "", []).details).toBe("")
	})

	it("keeps a reset fresh even if an old save subsequently commits", () => {
		const context = new EnvironmentContext()
		const receipt = { commit: vi.fn() }
		const old = context.prepare("task/session", facts, "A", [receipt])
		context.reset()
		old.commit()
		expect(receipt.commit).toHaveBeenCalledOnce()
		expect(context.needsFullSnapshot).toBe(true)
		expect(context.prepare("task/session", facts, "", []).details).toContain("Environment Snapshot")
	})

	it("commits delivery progress independently from fact resets without accepting older cursors", () => {
		const context = new EnvironmentContext()
		const cursor = { terminalId: 33, processIndex: 1 }
		context.prepare("task/session", facts, "A", [], [], cursor).release()
		expect(context.terminalOutputCursor).toBeUndefined()
		context.prepare("task/session", facts, "A", [], [], cursor).commit()
		expect(context.terminalOutputCursor).toEqual(cursor)
		const stale = context.prepare("task/session", facts, "B", [], [], { terminalId: 34, processIndex: 0 })
		context.reset()
		expect(context.terminalOutputCursor).toEqual(cursor)
		stale.commit()
		expect(context.terminalOutputCursor).toEqual({ terminalId: 34, processIndex: 0 })
		expect(context.needsFullSnapshot).toBe(true)
		const earlier = context.prepare("task/session", facts, "", [], [], cursor)
		context.prepare("task/session", facts, "", [], [], { terminalId: 35, processIndex: 0 }).commit()
		earlier.commit()
		expect(context.terminalOutputCursor).toEqual({ terminalId: 35, processIndex: 0 })
	})

	it("isolates task/session identity, explicitly removes fields and retains omitted baseline listings", () => {
		const context = new EnvironmentContext()
		context
			.prepare("task/one", [...facts, { name: "Cost", value: "$1" }, { name: "Files", value: "a.ts" }], "", [])
			.commit()
		const delta = context.prepare("task/one", facts, "", [], ["Files"])
		expect(delta.details).toContain("# Cost\n(none; previous value no longer applies)")
		expect(delta.details).not.toContain("# Files")
		delta.commit()
		expect(context.prepare("task/one", facts, "", [], ["Files"]).details).toBe("")
		expect(context.prepare("task/two", facts, "", []).details).toContain("Environment Snapshot")
	})

	it("does not leak abort listeners or surface a late read rejection", async () => {
		const controller = new AbortController()
		const add = vi.spyOn(controller.signal, "addEventListener")
		const remove = vi.spyOn(controller.signal, "removeEventListener")
		let rejectRead!: (error: Error) => void
		const read = new Promise<string>((_resolve, reject) => {
			rejectRead = reject
		})
		const pending = awaitEnvironmentRead(read, controller.signal)
		controller.abort(new Error("cancelled"))
		await expect(pending).rejects.toThrow("cancelled")
		expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1])
		rejectRead(new Error("late read failure"))
		await Promise.resolve()
	})
})
