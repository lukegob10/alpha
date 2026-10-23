import { describe, expect, it, vi } from "vitest"

import { BoundedDelegationManager } from "../BoundedDelegationManager"
import { buildInternalTaskEnvelope } from "../InternalTaskEnvelope"

describe("Codex subagent lifetime", () => {
	it("keeps working past a legacy execution timeout until explicitly stopped", async () => {
		vi.useFakeTimers()
		try {
			let signal!: AbortSignal
			let started!: () => void
			const entered = new Promise<void>((resolve) => (started = resolve))
			const manager = new BoundedDelegationManager(async (_envelope, cancellation) => {
				signal = cancellation
				started()
				return await new Promise<never>((_resolve, reject) => {
					cancellation.addEventListener("abort", () => reject(cancellation.reason), { once: true })
				})
			})
			const envelope = buildInternalTaskEnvelope({
				id: "long-running",
				parentTaskId: "parent",
				objective: "Complete the implementation",
				parentPolicy: {
					read: true,
					execute: false,
					mutate: false,
					delegate: false,
					network: false,
					externalSideEffects: false,
					requireApproval: true,
				},
				requestedPolicy: {},
				workspaceRoots: [process.cwd()],
				budget: { timeoutMs: 10_000 },
			})
			const run = manager.run(envelope)
			await entered
			await vi.advanceTimersByTimeAsync(3_600_001)
			const abortedByTimer = signal.aborted
			manager.cancel(envelope.id)
			const result = await run
			expect(abortedByTimer).toBe(false)
			expect(result).toMatchObject({ status: "cancelled", stopReason: "cancelled" })
		} finally {
			vi.useRealTimers()
		}
	})
})
