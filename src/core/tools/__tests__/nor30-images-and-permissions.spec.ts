import { getNativeTools } from "../../prompts/tools/native-tools"
import { describe, expect, it, vi } from "vitest"

import {
	capturedSurface,
	fixtureDescriptor,
	fixtureRegistry,
	imageResults,
	makeExecutionHost,
	runToolCalls,
	toolResults,
} from "./nor30-tool-fixtures"
import { ToolRegistry } from "../ToolRegistry"
import type { ToolDescriptor } from "../ToolRegistry"

describe("NOR-30 captured tool execution: images and permissions", () => {
	it("commits native leaf images after their tool result", async () => {
		const schemas = getNativeTools({ supportsImages: true })
		const registry = new ToolRegistry({ nativeTools: schemas, supportsImages: true })
		const surface = capturedSurface(registry)
		const images = ["data:image/png;base64,base64ImageData"]
		const harness = makeExecutionHost({
			approval: { response: "yesButtonClicked", text: "I see a cat", images },
		})

		const outcome = await runToolCalls(harness, surface, [
			{
				id: "image-1",
				name: "ask_followup_question",
				arguments: { question: "What do you see?", follow_up: [] },
			},
		])

		expect(outcome.results[0].status).toBe("success")
		expect(toolResults(harness)).toHaveLength(1)
		expect(toolResults(harness)[0]).toMatchObject({
			tool_use_id: "image-1",
			content: expect.stringContaining("I see a cat"),
		})
		expect(typeof toolResults(harness)[0].content).toBe("string")
		expect(imageResults(harness)).toHaveLength(1)
		expect(imageResults(harness)[0]).toMatchObject({
			type: "image",
			source: { type: "base64", media_type: "image/png", data: "base64ImageData" },
		})
		expect(harness.userMessageContent.indexOf(toolResults(harness)[0])).toBeLessThan(
			harness.userMessageContent.indexOf(imageResults(harness)[0]),
		)
		expect(harness.host.say).toHaveBeenCalledWith("user_feedback", "I see a cat", images)
	})

	it("keeps a native text-only result a string when the leaf has no images", async () => {
		const schemas = getNativeTools({ supportsImages: true })
		const registry = new ToolRegistry({ nativeTools: schemas, supportsImages: true })
		const surface = capturedSurface(registry)
		const harness = makeExecutionHost({ approval: { response: "yesButtonClicked", text: "Alice" } })

		const outcome = await runToolCalls(harness, surface, [
			{
				id: "text-only-1",
				name: "ask_followup_question",
				arguments: { question: "What is your name?", follow_up: [] },
			},
		])

		expect(outcome.results[0].status).toBe("success")
		expect(typeof outcome.results[0].content).toBe("string")
		expect(outcome.results[0].content).toContain("Alice")
		expect(imageResults(harness)).toHaveLength(0)
	})

	it("returns a deterministic fallback for a leaf that emits no output", async () => {
		const registry = fixtureRegistry(fixtureDescriptor("nor30_empty", async () => undefined))
		const surface = capturedSurface(registry)
		const harness = makeExecutionHost()

		const outcome = await runToolCalls(harness, surface, [{ id: "empty-1", name: "nor30_empty" }], {
			validateCall: () => {},
		})

		expect(outcome.results[0]).toMatchObject({ status: "success", content: "(tool did not return anything)" })
		expect(toolResults(harness)).toEqual([
			expect.objectContaining({ tool_use_id: "empty-1", content: "(tool did not return anything)" }),
		])
	})

	it("turns an approval denial into one denied receipt without running the effect", async () => {
		const leaf = vi.fn(async ({ callbacks }: Parameters<ToolDescriptor["execute"]>[0]) => {
			if (await callbacks.askApproval("tool", "NOR-30 permission")) callbacks.pushToolResult("must not run")
		})
		const registry = fixtureRegistry(
			fixtureDescriptor("nor30_requires_permission", leaf, {
				requiresApproval: true,
			}),
		)
		const surface = capturedSurface(registry)
		const harness = makeExecutionHost({ approval: { response: "noButtonClicked" } })

		const outcome = await runToolCalls(
			harness,
			surface,
			[{ id: "permission-denied-1", name: "nor30_requires_permission" }],
			{ validateCall: () => {} },
		)

		expect(leaf).toHaveBeenCalledOnce()
		expect(outcome.results[0].status).toBe("denied")
		expect(outcome.approvalRequestCount).toBe(1)
		expect(outcome.approvalDeniedCount).toBe(1)
		expect(String(outcome.results[0].content)).toContain("denied")
		expect(toolResults(harness)).toHaveLength(1)
		expect(toolResults(harness)[0]).toMatchObject({ tool_use_id: "permission-denied-1", is_error: true })
	})
})
