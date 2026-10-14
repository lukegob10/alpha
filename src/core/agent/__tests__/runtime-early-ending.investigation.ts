import { describe, expect, it } from "vitest"

import { AgentTurnEngine, type AgentResponse, type AgentTurnStagedHost } from "../AgentTurnEngine"
import type { AgentToolCall } from "../AgentResponse"
import { SearchLoopRecoveryPolicy } from "../SearchLoopRecoveryPolicy"

function search(index: number): AgentToolCall {
	return {
		type: "tool_call",
		id: `search-${index}`,
		name: "search_files",
		arguments: { path: `packages/package-${index}`, regex: `uniqueSymbol${index}` },
	}
}

function response(call?: AgentToolCall): AgentResponse {
	return {
		items: call ? [call] : [{ type: "text", text: "Implementation complete." }],
		text: call ? "" : "Implementation complete.",
		reasoning: "",
		toolCalls: call ? [call] : [],
	}
}

describe("runtime early-ending observations", () => {
	it("pauses after nine novel successful search-only steps despite new evidence in every receipt", async () => {
		const policy = new SearchLoopRecoveryPolicy()
		const actions: string[] = []
		const receipts: { callId: string; status: "success"; content: string }[] = []
		const host: AgentTurnStagedHost<number> = {
			shouldAbort: () => false,
			sampleStep: async (index) => ({ response: response(search(index)) }),
			executeEffects: async ({ response: sampled }) => {
				for (const call of sampled.toolCalls) {
					receipts.push({ callId: call.id, status: "success", content: `New evidence from ${call.id}` })
				}
			},
			onStepComplete: async (sampled) => {
				// The production policy receives calls only: successful receipts and
				// their novel evidence cannot affect its search-only step counter.
				const decision = policy.observe(sampled.toolCalls)
				actions.push(decision.action)
				if (decision.action === "pause") return { status: "incomplete", reason: "search-loop pause" }
				return undefined
			},
			selectContinuation: async (_sample, step) => ({ nextInput: step }),
		}

		const outcome = await new AgentTurnEngine(host).run(0)

		expect(receipts).toHaveLength(9)
		expect(new Set(receipts.map(({ content }) => content)).size).toBe(9)
		expect(receipts.every(({ status }) => status === "success")).toBe(true)
		expect(actions).toEqual([
			"continue",
			"continue",
			"recover",
			"continue",
			"continue",
			"recover",
			"continue",
			"continue",
			"pause",
		])
		expect(outcome).toMatchObject({ status: "incomplete", steps: 9, reason: "search-loop pause" })
	})

	it("renews the full search recovery window after a nonsearch step", () => {
		const policy = new SearchLoopRecoveryPolicy()
		for (let index = 0; index < 8; index++) expect(policy.observe([search(index)]).action).not.toBe("pause")
		expect(
			policy.observe([{ type: "tool_call", id: "inspect", name: "read_file", arguments: { path: "src/a.ts" } }]),
		).toMatchObject({ action: "continue", consecutiveSearchOnlySteps: 0, recoveryAttempts: 0 })
		for (let index = 0; index < 8; index++) expect(policy.observe([search(index + 8)]).action).not.toBe("pause")
		expect(policy.observe([search(16)])).toMatchObject({ action: "pause", recoveryAttempts: 2 })
	})

	it("allows 233 model steps when the host continues and no search pause applies", async () => {
		const policy = new SearchLoopRecoveryPolicy()
		let effects = 0
		const host: AgentTurnStagedHost<number> = {
			shouldAbort: () => false,
			sampleStep: async (index) => ({
				response:
					index === 232
						? response()
						: response({
								type: "tool_call",
								id: `read-${index}`,
								name: "read_file",
								arguments: { path: `file-${index}` },
							}),
			}),
			executeEffects: async ({ response: sampled }) => {
				effects += sampled.toolCalls.length
			},
			onStepComplete: async (sampled) => {
				expect(policy.observe(sampled.toolCalls).action).toBe("continue")
			},
			selectContinuation: async (_sample, step) => ({ nextInput: step === 233 ? "complete" : step }),
		}

		expect(await new AgentTurnEngine(host).run(0)).toMatchObject({ status: "completed", steps: 233 })
		expect(effects).toBe(232)
	})
})
