import { describe, expect, it } from "vitest"

import { threadToolParamsSchemas } from "../thread-tool-params.js"

describe("thread tool parameter contracts", () => {
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
