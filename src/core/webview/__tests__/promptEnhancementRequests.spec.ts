import { describe, expect, it } from "vitest"

import { beginPromptEnhancement, cancelPromptEnhancement, cancelPromptEnhancements } from "../promptEnhancementRequests"

describe("prompt enhancement request ownership", () => {
	it("isolates cancellation by provider, request and task", () => {
		const firstProvider = {}
		const secondProvider = {}
		const first = beginPromptEnhancement(firstProvider, "first", "task-a")
		const second = beginPromptEnhancement(firstProvider, "second", "task-b")
		const otherWindow = beginPromptEnhancement(secondProvider, "first", "task-a")
		cancelPromptEnhancement(firstProvider, "first", "task-b")
		expect(first.signal.aborted).toBe(false)
		cancelPromptEnhancement(firstProvider, "first", "task-a")
		expect(first.signal.aborted).toBe(true)
		expect(second.signal.aborted).toBe(false)
		expect(otherWindow.signal.aborted).toBe(false)
	})

	it("preserves successor ownership when a superseded request finishes", () => {
		const provider = {}
		const previous = beginPromptEnhancement(provider, "request")
		const successor = beginPromptEnhancement(provider, "request")
		expect(previous.signal.aborted).toBe(true)
		expect(previous.isOwned()).toBe(false)
		previous.finish()
		expect(successor.isOwned()).toBe(true)
		cancelPromptEnhancement(provider, "request")
		expect(successor.signal.aborted).toBe(true)
		successor.finish()
		expect(successor.isOwned()).toBe(false)
	})

	it("cancels matching task and taskless requests before joining a Stop", () => {
		const provider = {}
		const task = beginPromptEnhancement(provider, "task", "task-a")
		const preview = beginPromptEnhancement(provider, "preview")
		const background = beginPromptEnhancement(provider, "background", "task-b")
		cancelPromptEnhancements(provider, "task-a")
		expect(task.signal.aborted).toBe(true)
		expect(preview.signal.aborted).toBe(true)
		expect(background.signal.aborted).toBe(false)
		cancelPromptEnhancements(provider)
		expect(background.signal.aborted).toBe(true)
	})

	it("bounds accepted concurrent requests and frees capacity on terminal settlement", () => {
		const provider = {}
		const requests = Array.from({ length: 8 }, (_, index) => beginPromptEnhancement(provider, String(index)))
		expect(() => beginPromptEnhancement(provider, "overflow")).toThrow("Too many concurrent prompt enhancements")
		requests[0].finish()
		expect(() => beginPromptEnhancement(provider, "replacement")).not.toThrow()
	})
})
