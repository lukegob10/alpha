import type { ParentVerificationObligation } from "@alpha-code/types"

import { Task, type CommandExecutionEvidence } from "../Task"
import { decideParentCompletion, type ParentCompletionDecision } from "../../agent/ParentVerification"

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
	const { blockingObligations = [obligation], ...runtimeDecision } = decision
	return Object.assign(Object.create(Task.prototype), {
		getOpenTodoCompletionDecision: () => undefined,
		commandExecutionEvidence: new Map(commands.map((item) => [item.toolCallId, item])),
		providerRef: {
			deref: () => ({
				getParentCompletionDecision: async () => ({
					...decideParentCompletion(allowed ? [] : blockingObligations),
					...runtimeDecision,
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
		"keeps review repair focused despite an optional %s diagnostic",
		async (code) => {
			const task = taskWith([command({ verificationDiagnostics: [{ code, message: `Correct ${code}.` }] })])
			expect(await task.getCompletionGateDecision()).toMatchObject({
				allowed: false,
				classification: "repairable",
				reasonCode: "review_pending",
				message: expect.stringContaining("an approved review"),
				modelCanResolveRejection: true,
			})
			expect((await task.getCompletionGateDecision()).message).not.toContain(`Correct ${code}.`)
			expect(task.getCompletionStageMetrics().rejectionCount).toBe(0)
		},
	)

	it("keeps a review repairable when an optional verifier is unavailable", async () => {
		const task = taskWith([
			command({
				verificationDiagnostics: [
					{ code: "unsupported_configuration", message: "The configured verifier cannot be resolved." },
				],
			}),
		])
		expect(await task.getCompletionGateDecision()).toMatchObject({
			allowed: false,
			classification: "repairable",
			modelCanResolveRejection: true,
			reasonCode: "review_pending",
		})
	})

	it("does not request more checks to repair an unrelated missing review", async () => {
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
		const decision = await task.getCompletionGateDecision()
		expect(decision).toMatchObject({
			reasonCode: "review_pending",
			message: expect.stringContaining("an approved review"),
		})
		expect(decision.message).not.toContain("Run only the remaining checks")
	})

	it("does not recycle a rejected recognizer diagnostic after a newer valid command", async () => {
		const old = command({
			verificationDiagnostics: [{ code: "unsupported_command", message: "Old unsupported command." }],
		})
		const task = taskWith([old, command({ toolCallId: "new-check", startedAt: 5 })])
		expect(await task.getCompletionGateDecision()).toMatchObject({ reasonCode: "review_pending" })
	})

	it("preserves the actual missing effect receipt instead of diagnosing optional checks", async () => {
		const task = taskWith(
			[command({ verificationDiagnostics: [{ code: "unsupported_command", message: "Optional check." }] })],
			false,
			{
				blockingObligations: [
					{
						...obligation,
						appliedAt: undefined,
						review: { decision: "approved", source: "apply", recordedAt: 1 },
					},
				],
			},
		)
		expect(await task.getCompletionGateDecision()).toMatchObject({
			allowed: false,
			classification: "repairable",
			reasonCode: "managed_results_pending",
			message: expect.stringContaining("a durable applied effect receipt"),
		})
	})

	it("keeps unavailable mutation scope blocked", async () => {
		const task = taskWith([], false, { blockingObligations: [{ ...obligation, scopeUnresolved: true }] })
		expect(await task.getCompletionGateDecision()).toMatchObject({
			allowed: false,
			classification: "blocked",
			reasonCode: "scope_unavailable",
			modelCanResolveRejection: false,
		})
	})

	it.each(["pending", "failed"] as const)(
		"accepts settled reviewed work with %s optional evidence",
		async (status) => {
			const task = taskWith([], false, {
				blockingObligations: [
					{
						...obligation,
						status,
						review: { decision: "approved", source: "apply", recordedAt: 1 },
					},
				],
			})
			expect(await task.getCompletionGateDecision()).toMatchObject({ allowed: true, classification: "ready" })
		},
	)

	it("accepts current durable evidence without reopening obsolete diagnostics", async () => {
		const task = taskWith(
			[command({ verificationDiagnostics: [{ code: "unsupported_command", message: "Old command." }] })],
			true,
		)
		expect(await task.getCompletionGateDecision()).toMatchObject({ allowed: true, classification: "ready" })
	})
})
