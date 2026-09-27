import { getNativeTools } from "../../prompts/tools/native-tools"
import { describe, expect, it, vi } from "vitest"

import {
	capturedSurface,
	fixtureDescriptor,
	fixtureRegistry,
	makeExecutionHost,
	runToolCalls,
	toolResults,
} from "./nor30-tool-fixtures"
import { ToolRegistry } from "../ToolRegistry"
import type { ToolDescriptor } from "../ToolRegistry"

describe("NOR-30 captured tool execution: images and permissions", () => {
	it("forwards images attached to a native user answer and commits its structured result", async () => {
		const schemas = getNativeTools({ supportsImages: true, planMode: true })
		const registry = new ToolRegistry({ nativeTools: schemas, supportsImages: true })
		const surface = capturedSurface(registry, { schemas, mode: "architect", profile: "plan" })
		const images = ["data:image/png;base64,base64ImageData"]
		const harness = makeExecutionHost({
			approval: { response: "messageResponse", text: "I see a cat", images },
		})
		Object.assign(harness.task, { taskKind: "primary" })

		const outcome = await runToolCalls(
			harness,
			surface,
			[
				{
					id: "image-1",
					name: "request_user_input",
					arguments: {
						questions: [
							{
								id: "image_description",
								header: "Image",
								question: "What do you see?",
								options: [
									{ label: "Describe it", description: "Tell me what is visible." },
									{ label: "Skip", description: "Continue without a description." },
								],
							},
						],
					},
				},
			],
			{ mode: "architect" },
		)

		expect(outcome.results[0].status).toBe("success")
		expect(toolResults(harness)).toHaveLength(1)
		expect(toolResults(harness)[0]).toMatchObject({
			tool_use_id: "image-1",
			content: JSON.stringify({ answers: { image_description: { answers: ["I see a cat"] } } }),
		})
		expect(typeof toolResults(harness)[0].content).toBe("string")
		expect(harness.host.say).toHaveBeenCalledWith("user_feedback", "I see a cat", images)
	})

	it("keeps a native text-only result a string when the leaf has no images", async () => {
		const schemas = getNativeTools({ supportsImages: true, planMode: true })
		const registry = new ToolRegistry({ nativeTools: schemas, supportsImages: true })
		const surface = capturedSurface(registry, { schemas, mode: "architect", profile: "plan" })
		const harness = makeExecutionHost({ approval: { response: "messageResponse", text: "Alice" } })
		Object.assign(harness.task, { taskKind: "primary" })

		const outcome = await runToolCalls(
			harness,
			surface,
			[
				{
					id: "text-only-1",
					name: "request_user_input",
					arguments: {
						questions: [
							{
								id: "name",
								header: "Name",
								question: "What is your name?",
								options: [
									{ label: "Alice", description: "Use Alice as the name." },
									{ label: "Skip", description: "Continue without a name." },
								],
							},
						],
					},
				},
			],
			{ mode: "architect" },
		)

		expect(outcome.results[0].status).toBe("success")
		expect(typeof outcome.results[0].content).toBe("string")
		expect(outcome.results[0].content).toBe(JSON.stringify({ answers: { name: { answers: ["Alice"] } } }))
		expect(harness.host.say).toHaveBeenCalledWith("user_feedback", "Alice", undefined)
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
