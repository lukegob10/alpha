import { describe, expect, it } from "vitest"
import type { ParentVerificationObligation } from "@alpha-code/types"
import type { Task } from "../../task/Task"
import { settlementDiagnostics } from "../SettlementDiagnostics"
import { hashAgentTurnEvidenceId } from "../AgentTurnEventLog"
import { projectRuntimeDiagnostics } from "../../webview/diagnosticsEvidence"

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
	it.each(["running", "succeeded", "failed", "denied", "cancelled", "timed_out"])(
		"exports pending receipts joined to %s commands without copying private data",
		(status) => {
			const task = {
				taskId: "task",
				instanceId: "instance",
				getCompletionStageMetrics: () => ({ candidateCount: 1 }),
				getCommandExecutionEvidence: () => [
					{
						toolCallId: "call",
						executionId: "physical",
						status,
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
				{ token: "physical", commandStatus: status },
				{ token: "file-tool", commandStatus: undefined },
			])
			expect(result.obligations[0].fileCount).toBe(1)
			expect(JSON.stringify(result)).not.toMatch(/secret|private/)
			expect(result.truncated).toBe(false)
			const exported = projectRuntimeDiagnostics(result)
			expect(exported).toMatchObject({
				commands: [{ executionIdSha256: hashAgentTurnEvidenceId("physical"), status }],
				obligations: [
					{
						pendingReservations: [
							{ tokenSha256: hashAgentTurnEvidenceId("physical"), commandStatus: status },
							{ tokenSha256: hashAgentTurnEvidenceId("file-tool") },
						],
					},
				],
			})
			expect(JSON.stringify(exported)).not.toMatch(/physical|file-tool|secret|private/)
		},
	)

	it("bounds and validates pending receipts again at the diagnostic export boundary", () => {
		const exported = projectRuntimeDiagnostics({
			obligations: [
				{
					pendingReservations: [
						...Array.from({ length: 33 }, (_, index) => ({ token: `receipt-${index}` })),
						{ token: "private-token", commandStatus: "private-status", output: "private-output" },
					],
				},
			],
		})
		expect(exported).toMatchObject({
			obligations: [
				{
					pendingReservations: Array.from({ length: 32 }, (_, index) => ({
						tokenSha256: hashAgentTurnEvidenceId(index === 31 ? "private-token" : `receipt-${index + 2}`),
					})),
				},
			],
			truncated: true,
		})
		expect(JSON.stringify(exported)).not.toMatch(/private|receipt-/)
		expect(
			projectRuntimeDiagnostics({ obligations: [{ pendingReservations: [null, {}, { token: 42 }] }] }),
		).toMatchObject({ obligations: [{ pendingReservations: [] }] })
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
