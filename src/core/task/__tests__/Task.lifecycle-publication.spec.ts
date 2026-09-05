import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { Task } from "../Task"
import { createAgentResponse } from "../../agent/AgentResponse"
import { AgentLifecycleJournal, type AgentLifecycleEventInput } from "../../agent/lifecycle/AgentLifecycleJournal"

describe("Task lifecycle response publication", () => {
	it("bounds durable publication for the recorded 763-fragment shape and replays once", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-publication-"))
		const journal = new AgentLifecycleJournal("task", storage)
		const identity = { version: 1 as const, taskId: "task", runId: "run", turnId: "turn", occurredAt: 1 }
		try {
			await journal.append({ ...identity, eventId: "turn", type: "turn_started", payload: { phase: "starting" } })
			await journal.append({
				...identity,
				eventId: "step",
				stepId: "step",
				type: "step_started",
				payload: { phase: "working" },
			})
			let publications = 0
			const provider = {
				getAgentLifecycleSnapshot: () => journal.getSnapshot(),
				publishAgentLifecycleEvent: async (input: AgentLifecycleEventInput) => {
					await journal.append(input)
					publications++
					return { accepted: true }
				},
			}
			const task = Object.assign(Object.create(Task.prototype), {
				taskId: "task",
				agentRunId: "run",
				agentTurnId: "turn",
				providerRef: new WeakRef(provider),
				canonicalLifecycleQueue: Promise.resolve(),
			}) as {
				publishCanonicalLifecycleResponseItems: (
					response: ReturnType<typeof createAgentResponse>,
					step: { stepId: string },
				) => Promise<void>
			}
			const response = createAgentResponse([
				...Array.from({ length: 688 }, () => ({ type: "reasoning" as const, text: "reason. " })),
				...Array.from({ length: 74 }, () => ({ type: "text" as const, text: "answer. " })),
				{ type: "usage", inputTokens: 12096, outputTokens: 1770 },
			])
			const original = structuredClone(response)
			const started = performance.now()
			await task.publishCanonicalLifecycleResponseItems(response, { stepId: "step" })
			process.stdout.write(
				JSON.stringify({
					workload: "763-response-fragments",
					publications,
					elapsedMs: Math.round(performance.now() - started),
				}) + "\n",
			)
			expect(publications).toBeLessThanOrEqual(4)
			const snapshot = await journal.replay()
			expect(
				snapshot?.items
					.filter((item) => item.type === "assistant_reasoning")
					.map((item) => item.text)
					.join(""),
			).toBe(response.reasoning)
			expect(
				snapshot?.items
					.filter((item) => item.type === "assistant_text")
					.map((item) => item.text)
					.join(""),
			).toBe(response.text)
			await task.publishCanonicalLifecycleResponseItems(response, { stepId: "step" })
			expect(journal.getSequence()).toBe(publications + 2)
			expect(publications).toBeLessThanOrEqual(4)
			expect(response).toEqual(original)
		} finally {
			await journal.close()
			await fs.rm(storage, { recursive: true, force: true })
		}
	}, 60_000)
})
