import { describe, expect, it, vi } from "vitest"

import type { ApiStreamChunk } from "../../../api/transform/stream"
import { AgentTurnEngine, collectAgentResponse, type AgentResponse, type AgentTurnStagedHost } from "../AgentTurnEngine"

const claudeProvenance = {
	modelId: "claude-sonnet-4.6",
	modelVendor: "copilot",
	modelVersion: "claude-sonnet-4.6",
}

function collect(chunks: ApiStreamChunk[]): Promise<AgentResponse> {
	return collectAgentResponse(
		(async function* () {
			yield* chunks
		})(),
	)
}

describe("Claude Copilot responses in the shared turn engine", () => {
	it.each(["Inspect the requested module.", ""])(
		"continues a thinking-only step with visible reasoning %j until an assistant answer arrives",
		async (text) => {
			const thinking = {
				value: text,
				id: "thinking-1",
				metadata: { signature: "opaque-claude-signature", complete: true },
				...claudeProvenance,
			}
			const first = await collect([
				{ type: "reasoning", text, vscodeLmThinking: thinking },
				{ type: "usage", inputTokens: 20, outputTokens: 8 },
			])
			const final = await collect([{ type: "text", text: "The module uses the expected interface." }])
			const committed: AgentResponse[] = []
			const host: AgentTurnStagedHost<string> = {
				shouldAbort: () => false,
				sampleStep: vi.fn(async (input) => {
					expect(input).toBe(committed.length === 0 ? "request" : "continue-thinking")
					return { response: committed.length === 0 ? first : final }
				}),
				commitResponse: async ({ response }) => {
					committed.push(response)
				},
				selectContinuation: vi.fn(async () => ({ nextInput: "continue-thinking" })),
				releaseStep: vi.fn(),
			}

			const result = await new AgentTurnEngine(host).run("request")

			expect(result).toEqual({
				status: "completed",
				steps: 2,
				completionReason: "assistant",
				response: final,
			})
			expect(first.text).toBe("")
			expect(first.reasoning).toBe(text)
			expect(committed[0]!.items[0]).toEqual({ type: "reasoning", text, vscodeLmThinking: thinking })
			expect(host.sampleStep).toHaveBeenCalledTimes(2)
			expect(host.releaseStep).toHaveBeenCalledTimes(2)
		},
	)

	it("commits signed thinking and tool-only output before effects and samples the receipt follow-up after release", async () => {
		const thinking = {
			value: "Read the fixture before answering.",
			id: "thinking-read",
			metadata: { signature: "opaque-before-tool", complete: true },
			...claudeProvenance,
		}
		const toolResponse = await collect([
			{ type: "reasoning", text: thinking.value, vscodeLmThinking: thinking },
			{
				type: "tool_call",
				id: "toolu_claude_read",
				name: "exec_command",
				arguments: '{"cmd":"node inspect-fixture.cjs"}',
			},
		])
		const final = await collect([{ type: "text", text: "The fixture contains the expected value." }])
		const events: string[] = []
		const acceptedCalls: string[] = []
		const host: AgentTurnStagedHost<string> = {
			shouldAbort: () => false,
			sampleStep: async (input) => {
				events.push(`sample:${input}`)
				return { response: input === "request" ? toolResponse : final }
			},
			commitResponse: async ({ response }, step) => {
				await Promise.resolve()
				events.push(`commit:${step}`)
				if (step === 1) {
					expect(response.items).toEqual([
						{ type: "reasoning", text: thinking.value, vscodeLmThinking: thinking },
						{
							type: "tool_call",
							id: "toolu_claude_read",
							name: "exec_command",
							arguments: { cmd: "node inspect-fixture.cjs" },
						},
					])
				}
			},
			executeEffects: async ({ response }, step) => {
				await Promise.resolve()
				events.push(`effects:${step}`)
				acceptedCalls.push(...response.toolCalls.map((call) => call.id))
			},
			selectContinuation: async (_sample, step) => {
				events.push(`continue:${step}`)
				return { nextInput: "tool-receipt" }
			},
			releaseStep: async (_sample, step) => {
				await Promise.resolve()
				events.push(`release:${step}`)
			},
		}

		expect(await new AgentTurnEngine(host).run("request")).toEqual({
			status: "completed",
			steps: 2,
			completionReason: "assistant",
			response: final,
		})
		expect(acceptedCalls).toEqual(["toolu_claude_read"])
		expect(events).toEqual([
			"sample:request",
			"commit:1",
			"effects:1",
			"continue:1",
			"release:1",
			"sample:tool-receipt",
			"commit:2",
			"effects:2",
			"continue:2",
			"release:2",
		])
	})
})
