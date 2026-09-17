import { describe, expect, it } from "vitest"
import type { ParentVerificationObligation } from "@alpha-code/types"
import type { Task } from "../../task/Task"
import { settlementDiagnostics } from "../SettlementDiagnostics"

function obligation(overrides: Partial<ParentVerificationObligation>): ParentVerificationObligation {
	return {
		id: "change",
		changeSetId: "change",
		rootTaskId: "task",
		parentTaskId: "task",
		workerTaskId: "task",
		workerNickname: "Primary",
		groupId: "change",
		origin: "primary",
		status: "pending",
		createdAt: 1,
		updatedAt: 1,
		changedFiles: [],
		...overrides,
	}
}

describe("settlement diagnostics", () => {
	it("correlates pending receipts with physical commands without copying private command or file data", () => {
		const task = {
			taskId: "task",
			instanceId: "instance",
			getCompletionStageMetrics: () => ({ candidateCount: 1 }),
			getCommandExecutionEvidence: () => [
				{
					toolCallId: "call",
					executionId: "physical",
					status: "failed",
					startedAt: 1,
					command: "secret command",
					cwd: "private path",
				},
			],
		} as unknown as Task
		const pending = obligation({
			changeSetId: "change",
			changedFiles: ["private-file"],
			mutationReservations: ["physical", "file-tool"],
			fileVersions: { "private-file": "private-hash" },
		})
		const result = settlementDiagnostics(task, [pending])
		expect(result.obligations[0].pendingReservations).toEqual([
			{ token: "physical", commandStatus: "failed" },
			{ token: "file-tool", commandStatus: undefined },
		])
		expect(result.obligations[0].fileCount).toBe(1)
		expect(JSON.stringify(result)).not.toMatch(/secret|private/)
		expect(result.truncated).toBe(false)
	})

	it("bounds diagnostic arrays independently of long conversation size", () => {
		const task = {
			getCompletionStageMetrics: () => ({}),
			getCommandExecutionEvidence: () =>
				Array.from({ length: 128 }, (_, i) => ({ executionId: String(i), status: "succeeded" })),
		} as unknown as Task
		const obligations = Array.from({ length: 40 }, () =>
			obligation({
				changedFiles: [],
				mutationReservations: Array.from({ length: 40 }, (_, i) => String(i)),
			}),
		)
		const result = settlementDiagnostics(task, obligations)
		expect(result.commands).toHaveLength(32)
		expect(result.obligations).toHaveLength(16)
		expect(result.obligations[0].pendingReservations).toHaveLength(32)
		expect(result.truncated).toBe(true)
	})
})
