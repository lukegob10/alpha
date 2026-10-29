import { describe, expect, it } from "vitest"

import { threadToolParamsSchemas } from "../thread-tool-params.js"

describe("thread tool parameter contracts", () => {
	it.each(["create_thread", "fork_thread", "send_message_to_thread"] as const)(
		"accepts independent provider, saved profile, model, and effort controls for %s",
		(name) => {
			const required = name === "fork_thread" ? {} : { prompt: "Inspect" }
			const target = name === "send_message_to_thread" ? { threadId: "peer" } : {}
			const selection = {
				provider: "openai-native",
				profile: " Saved OpenAI ",
				model: " gpt-6-sol ",
				reasoning_effort: "high",
			}
			expect(threadToolParamsSchemas[name].parse({ ...required, ...target, ...selection })).toEqual({
				...required,
				...target,
				...selection,
				profile: "Saved OpenAI",
				model: "gpt-6-sol",
			})
			for (const invalid of [
				{ provider: "OpenAI" },
				{ provider: "fake-ai" },
				{ profile: " " },
				{ model: " " },
				{ reasoning_effort: "disable" },
				{ reasoning_effort: "unsupported" },
				{ apiKey: "secret" },
				{ mode: "code" },
			]) {
				expect(threadToolParamsSchemas[name].safeParse({ ...required, ...target, ...invalid }).success).toBe(
					false,
				)
			}
		},
	)

	it("limits delegated prompts by UTF-8 bytes before dispatch", () => {
		for (const name of ["create_thread", "send_message_to_thread"] as const) {
			const required = name === "send_message_to_thread" ? { threadId: "peer" } : {}
			expect(threadToolParamsSchemas[name].safeParse({ ...required, prompt: "é".repeat(500) }).success).toBe(true)
			expect(threadToolParamsSchemas[name].safeParse({ ...required, prompt: "é".repeat(501) }).success).toBe(
				false,
			)
			expect(threadToolParamsSchemas[name].safeParse({ ...required, prompt: "   " }).success).toBe(false)
		}
	})

	it("rejects invented authority fields and active-list pagination", () => {
		expect(threadToolParamsSchemas.create_thread.safeParse({ prompt: "Inspect", mode: "code" }).success).toBe(false)
		expect(threadToolParamsSchemas.list_threads.safeParse({ cursor: "opaque" }).success).toBe(false)
		expect(threadToolParamsSchemas.fork_thread.safeParse({ workspace_mode: "worktree" }).success).toBe(false)
	})

	it("accepts immediate bounded waits and rejects excess targets or malformed target objects", () => {
		expect(
			threadToolParamsSchemas.wait_threads.safeParse({ targets: [{ threadId: "peer" }], timeoutMs: 0 }).success,
		).toBe(true)
		expect(
			threadToolParamsSchemas.wait_threads.safeParse({
				targets: Array.from({ length: 9 }, (_, index) => ({ threadId: `peer-${index}` })),
			}).success,
		).toBe(false)
		expect(
			threadToolParamsSchemas.wait_threads.safeParse({ targets: [{ threadId: "peer", force: true }] }).success,
		).toBe(false)
	})
})
