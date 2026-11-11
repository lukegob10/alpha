import type Anthropic from "@anthropic-ai/sdk"
import { describe, expect, it } from "vitest"

import type { ToolResponse } from "../../../shared/tools"
import { TOOL_OUTPUT_TRUNCATION_SUFFIX } from "../../tools/BaseTool"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { ToolScheduler, type ToolExecutionHost } from "../ToolScheduler"

const image: Anthropic.ImageBlockParam = {
	type: "image",
	source: { type: "base64", media_type: "image/png", data: "ZmVlZGJhY2s=" },
}

const textContent = (content: ToolResponse) =>
	typeof content === "string"
		? content
		: content
				.filter((part): part is Anthropic.TextBlockParam => part.type === "text")
				.map((part) => part.text)
				.join("\n")

async function runWithCap(maxOutputChars: number, content?: ToolResponse) {
	const receipts: Anthropic.ToolResultBlockParam[] = []
	const host: ToolExecutionHost = {
		taskId: "output-cap",
		cwd: process.cwd(),
		userMessageContent: receipts,
		say: async () => undefined,
		recordToolUsage: () => undefined,
		pushToolResultToUserContent(receipt) {
			receipts.push(receipt)
			return true
		},
	}
	const registry = new ToolRegistry({ includeBuiltIns: false })
	registry.register({
		name: "read_file",
		aliases: [],
		schema: { type: "function", function: { name: "read_file", parameters: { type: "object" } } },
		capabilities: { concurrency: "serial", sideEffects: "none", controlFlow: false, requiresApproval: false },
		maxOutputChars,
		execute: async ({ callbacks }) => {
			if (content !== undefined) callbacks.pushToolResult(content)
		},
	})
	const outcome = await new ToolScheduler({ executionHost: host, registry, mode: "code" }).run([
		{ type: "tool_call", id: "bounded-read", name: "read_file", arguments: {} },
	])
	return { outcome, receipts }
}

describe("ToolScheduler output character caps", () => {
	it.each([0, 0.5, 1, 2, 10, 11, 16, 34, 35, 64])(
		"fits string output and its marker within %s characters",
		async (cap) => {
			const { outcome, receipts } = await runWithCap(cap, "x".repeat(100))
			expect(outcome.results[0]).toMatchObject({ status: "success", truncated: true })
			expect(textContent(outcome.results[0].content).length).toBeLessThanOrEqual(Math.floor(cap))
			expect(receipts).toHaveLength(1)
			expect(receipts[0].content).toBe(outcome.results[0].content)
			if (cap >= TOOL_OUTPUT_TRUNCATION_SUFFIX.length) {
				expect(textContent(outcome.results[0].content)).toContain(TOOL_OUTPUT_TRUNCATION_SUFFIX)
			}
		},
	)

	it.each([0, 1, 16, 64])("preserves images and bounds joined text at %s characters", async (cap) => {
		const { outcome, receipts } = await runWithCap(cap, [
			{ type: "text", text: "first" },
			image,
			{ type: "text", text: "x".repeat(100) },
		])
		expect(outcome.results[0]).toMatchObject({ status: "success", truncated: true })
		expect(outcome.results[0].content).toEqual(expect.arrayContaining([image]))
		expect(textContent(outcome.results[0].content).length).toBeLessThanOrEqual(cap)
		expect(receipts[0].content).toEqual(outcome.results[0].content)
	})

	it("does not reintroduce a placeholder after truncating text-only blocks to zero", async () => {
		const { outcome, receipts } = await runWithCap(0, [{ type: "text", text: "File contents" }])
		expect(outcome.results[0]).toMatchObject({ status: "success", truncated: true })
		expect(receipts[0].content).toBe("")
	})

	it("bounds the placeholder when a tool returns no content", async () => {
		const { outcome, receipts } = await runWithCap(1)
		expect(outcome.results[0]).toMatchObject({ status: "success", truncated: true })
		expect(receipts[0].content).toBe("…")
	})
})
