import { describe, expect, it, vi } from "vitest"

import { AgentStepRuntime } from "../AgentStepRuntime"

describe("AgentStepRuntime", () => {
	it("keeps live references private and exposes only lookup operations", () => {
		const handler = { createMessage: vi.fn() }
		const readFile = vi.fn()
		const runtime = new AgentStepRuntime("context-1", {
			handler,
			executables: { read_file: readFile },
		})

		expect(runtime.contextId).toBe("context-1")
		expect(runtime.getHandler()).toBe(handler)
		expect(runtime.getExecutable("read_file")).toBe(readFile)
		expect(runtime.hasExecutable("read_file")).toBe(true)
		expect(runtime.getExecutableNames()).toEqual(["read_file"])
		expect(Object.keys(runtime)).toEqual([])
		expect(JSON.stringify(runtime)).toBeUndefined()
	})

	it("forks the association without cloning live references", () => {
		const handler = { id: "handler" }
		const executable = vi.fn()
		const runtime = new AgentStepRuntime("parent", {
			handler,
			executables: new Map([["tool", executable]]),
		})
		const child = runtime.forContext("child")

		expect(child.contextId).toBe("child")
		expect(runtime.isForContext("parent")).toBe(true)
		expect(child.isForContext("parent")).toBe(false)
		expect(child.getHandler()).toBe(handler)
		expect(child.getExecutable("tool")).toBe(executable)
		expect(Object.isFrozen(runtime)).toBe(true)
		expect(Object.isFrozen(child)).toBe(true)
	})
})
