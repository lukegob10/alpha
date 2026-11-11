import type Anthropic from "@anthropic-ai/sdk"
import { describe, expect, it, vi } from "vitest"

import type { ToolResponse } from "../../../shared/tools"
import type { ToolApprovalResponse } from "../../tools/BaseTool"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { ToolScheduler, type ToolExecutionHost } from "../ToolScheduler"

const feedbackImage = "data:image/png;base64,ZmVlZGJhY2s="
const expectedImage: Anthropic.ImageBlockParam = {
	type: "image",
	source: { type: "base64", media_type: "image/png", data: "ZmVlZGJhY2s=" },
}

async function runWithFeedback(approval: ToolApprovalResponse, result: ToolResponse) {
	const receipts: Anthropic.ToolResultBlockParam[] = []
	const effect = vi.fn()
	const host: ToolExecutionHost = {
		taskId: "approval-feedback",
		cwd: process.cwd(),
		userMessageContent: receipts,
		askApproval: vi.fn(async () => approval),
		say: vi.fn(async () => undefined),
		recordToolUsage: vi.fn(),
		pushToolResultToUserContent(receipt) {
			receipts.push(receipt)
			return true
		},
	}
	const registry = new ToolRegistry({ includeBuiltIns: false })
	registry.register({
		name: "write_to_file",
		aliases: [],
		schema: { type: "function", function: { name: "write_to_file", parameters: { type: "object" } } },
		capabilities: { concurrency: "serial", sideEffects: "workspace", controlFlow: false, requiresApproval: true },
		execute: async ({ callbacks }) => {
			if (await callbacks.askApproval("tool", "Write the requested file")) {
				effect()
				callbacks.pushToolResult(result)
			}
		},
	})
	const outcome = await new ToolScheduler({ executionHost: host, registry, mode: "code" }).run([
		{ type: "tool_call", id: "feedback-call", name: "write_to_file", arguments: {} },
	])
	return { outcome, host, effect, receipts }
}

describe("ToolScheduler legacy approval feedback", () => {
	it.each([
		{ name: "string result", result: "File written" as ToolResponse, text: "Use this screenshot" },
		{
			name: "block result",
			result: [{ type: "text", text: "File written" }] as ToolResponse,
			text: "Use this screenshot",
		},
		{ name: "image-only feedback", result: "File written" as ToolResponse, text: undefined },
	])("retains approval images with $name", async ({ result, text }) => {
		const { outcome, host, effect, receipts } = await runWithFeedback(
			{ response: "yesButtonClicked", text, images: [feedbackImage] },
			result,
		)

		expect(effect).toHaveBeenCalledOnce()
		expect(host.say).toHaveBeenCalledWith("user_feedback", text ?? "", [feedbackImage])
		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0]).toMatchObject({ callId: "feedback-call", status: "success" })
		expect(outcome.results[0].content).toEqual([
			{ type: "text", text: JSON.stringify({ status: "approved", feedback: text ?? "" }) },
			expectedImage,
			{ type: "text", text: "File written" },
		])
		expect(receipts).toEqual([
			{ type: "tool_result", tool_use_id: "feedback-call", content: outcome.results[0].content, is_error: false },
		])
	})

	it("keeps text-only approval feedback in a string result", async () => {
		const { outcome, receipts } = await runWithFeedback(
			{ response: "yesButtonClicked", text: "Keep the current format" },
			"File written",
		)
		expect(outcome.results[0]).toMatchObject({
			status: "success",
			content: `${JSON.stringify({ status: "approved", feedback: "Keep the current format" })}\n\nFile written`,
		})
		expect(receipts[0].content).toBe(outcome.results[0].content)
	})

	it("keeps denial feedback images without executing the effect", async () => {
		const { outcome, effect, receipts } = await runWithFeedback(
			{ response: "noButtonClicked", text: "This screenshot shows the wrong file", images: [feedbackImage] },
			"File written",
		)
		expect(effect).not.toHaveBeenCalled()
		expect(outcome.results[0]).toMatchObject({ status: "denied" })
		expect(receipts).toHaveLength(1)
		expect(receipts[0]).toMatchObject({ is_error: true, content: expect.arrayContaining([expectedImage]) })
	})

	it.each(["noButtonClicked", "messageResponse"] as const)(
		"retains image-only %s feedback as a denial",
		async (response) => {
			const { outcome, host, effect, receipts } = await runWithFeedback(
				{ response, images: [feedbackImage] },
				"File written",
			)
			expect(effect).not.toHaveBeenCalled()
			expect(host.say).toHaveBeenCalledWith("user_feedback", "", [feedbackImage])
			expect(outcome).toMatchObject({ approvalDeniedCount: 1, approvalCancelledCount: 0 })
			expect(outcome.results[0]).toMatchObject({ status: "denied" })
			expect(receipts).toHaveLength(1)
			expect(receipts[0]).toMatchObject({ is_error: true, content: expect.arrayContaining([expectedImage]) })
		},
	)
})
