import type { ParentVerificationObligation } from "@alpha-code/types"

import { Task, type CommandExecutionEvidence } from "../Task"
import type { ParentCompletionDecision } from "../../agent/ParentVerification"

const obligation: ParentVerificationObligation = {
	id: "change",
	changeSetId: "change",
	rootTaskId: "root",
	parentTaskId: "root",
	workerTaskId: "worker",
	workerNickname: "Worker",
	groupId: "group",
	status: "pending",
	createdAt: 1,
	updatedAt: 2,
	appliedAt: 2,
	contentVersion: 2,
	changedFiles: ["src/change.ts"],
	verificationRequirements: { "src/change.ts": ["types"] },
}

function command(overrides: Partial<CommandExecutionEvidence> = {}): CommandExecutionEvidence {
	return {
		toolCallId: "check",
		executionId: "execution",
		status: "succeeded",
		startedAt: 3,
		completedAt: 4,
		verificationChangeSetIds: ["change"],
		...overrides,
	}
}

function taskWith(
	commands: CommandExecutionEvidence[],
	allowed = false,
	decision: Partial<ParentCompletionDecision> = {},
): Task {
	return Object.assign(Object.create(Task.prototype), {
		getOpenTodoCompletionDecision: () => undefined,
		commandExecutionEvidence: new Map(commands.map((item) => [item.toolCallId, item])),
		providerRef: {
			deref: () => ({
				getParentCompletionDecision: async () => ({
					allowed,
					blockingObligations: allowed ? [] : [obligation],
					message: "Change change requires types for version 2.",
					...decision,
				}),
			}),
		},
	}) as Task
}

describe("completion verification diagnostics", () => {
	it.each(["uncovered_changes", "unsupported_configuration"] as const)(
		"waits for a pending receipt despite an earlier %s diagnostic",
		async (code) => {
			const task = taskWith(
				[command({ verificationDiagnostics: [{ code, message: "Earlier diagnostic." }] })],
				false,
				{
					blockingObligations: [{ ...obligation, mutationReservations: ["pending-receipt"] }],
				},
			)
			expect(await task.getCompletionGateDecision()).toMatchObject({
				classification: "waiting",
				reasonCode: "receipt_pending",
				modelCanResolveRejection: false,
			})
		},
	)

	it("waits for an active descendant before diagnosing its unfinished verification", async () => {
		const task = taskWith(
			[
				command({
					verificationDiagnostics: [{ code: "unsupported_configuration", message: "Earlier diagnostic." }],
				}),
			],
			false,
			{ activeDescendantCount: 1 },
		)
		expect(await task.getCompletionGateDecision()).toMatchObject({
			classification: "waiting",
			reasonCode: "descendants_running",
			modelCanResolveRejection: false,
		})
	})

	it.each([0, 1])(
		"allows sibling result consumption with %s active children despite an earlier diagnostic",
		async (activeDescendantCount) => {
			const task = taskWith(
				[
					command({
						verificationDiagnostics: [
							{ code: "unsupported_configuration", message: "Earlier diagnostic." },
						],
					}),
				],
				false,
				{ activeDescendantCount, unconsumedResultCount: 1 },
			)
			expect(await task.getCompletionGateDecision()).toMatchObject({
				classification: "repairable",
				reasonCode: "child_results_unconsumed",
				modelCanResolveRejection: true,
			})
		},
	)

	it.each(["missing_change_set", "uncovered_changes", "unsupported_command", "no_test_validation"] as const)(
		"reports the precise corrective %s diagnostic without claiming command success is evidence",
		async (code) => {
			const task = taskWith([command({ verificationDiagnostics: [{ code, message: `Correct ${code}.` }] })])
			expect(await task.getCompletionGateDecision()).toMatchObject({
				allowed: false,
				classification: "repairable",
				reasonCode: code,
				message: expect.stringContaining(`Correct ${code}.`),
			})
			expect(task.getCompletionStageMetrics().rejectionCount).toBe(0)
		},
	)

	it("settles unavailable verifier configuration as blocked", async () => {
		const task = taskWith([
			command({
				verificationDiagnostics: [
					{ code: "unsupported_configuration", message: "The configured verifier cannot be resolved." },
				],
			}),
		])
		expect(await task.getCompletionGateDecision()).toMatchObject({
			allowed: false,
			classification: "blocked",
			modelCanResolveRejection: false,
			reasonCode: "unsupported_configuration",
		})
	})

	it("identifies the exact stale captured content version", async () => {
		const task = taskWith([
			command({
				verificationVersions: {
					change: {
						contentVersion: 1,
						contentFingerprint: "v1",
						matchedFiles: ["src/change.ts"],
						scopePath: "/repo",
						kind: "types",
						commandDigest: "command",
						repositoryDigest: "repo",
					},
				},
			}),
		])
		expect(await task.getCompletionGateDecision()).toMatchObject({
			reasonCode: "stale_content",
			message: expect.stringContaining("requires content version 2; the command captured version 1"),
		})
	})

	it("does not recycle a rejected recognizer diagnostic after a newer valid command", async () => {
		const old = command({
			verificationDiagnostics: [{ code: "unsupported_command", message: "Old unsupported command." }],
		})
		const task = taskWith([old, command({ toolCallId: "new-check", startedAt: 5 })])
		expect(await task.getCompletionGateDecision()).toMatchObject({ reasonCode: "verification_missing" })
	})

	it("accepts current durable evidence without reopening obsolete diagnostics", async () => {
		const task = taskWith(
			[command({ verificationDiagnostics: [{ code: "unsupported_command", message: "Old command." }] })],
			true,
		)
		expect(await task.getCompletionGateDecision()).toMatchObject({ allowed: true, classification: "ready" })
	})
})
