import { describe, expect, it } from "vitest"

import {
	InvalidLifecycleTransitionError,
	deriveTrialResult,
	initialAttemptState,
	isRetryableStatus,
	transitionAttempt,
	type AttemptLifecycleEvent,
	type TrialTerminalStatus,
} from "../index"

function advanceToGrading() {
	return (
		[
			{ type: "start" },
			{ type: "setup_completed" },
			{ type: "agent_completed" },
			{ type: "evidence_collected" },
		] satisfies AttemptLifecycleEvent[]
	).reduce(transitionAttempt, initialAttemptState())
}

describe("attempt lifecycle", () => {
	it("follows the complete successful path with monotonic versions", () => {
		const grading = advanceToGrading()
		expect(grading).toEqual({ phase: "grading", version: 4 })
		expect(transitionAttempt(grading, { type: "finalize", status: "passed" })).toEqual({
			phase: "grading",
			terminalStatus: "passed",
			failureCode: undefined,
			failureDetail: undefined,
			version: 5,
		})
	})

	it.each([
		["created", { type: "setup_completed" }],
		["setup", { type: "agent_completed" }],
		["agent_execution", { type: "evidence_collected" }],
		["evidence_collection", { type: "start" }],
	] as const)("rejects an illegal transition from %s", (phase, event) => {
		expect(() => transitionAttempt({ phase, version: 3 }, event)).toThrow(InvalidLifecycleTransitionError)
	})

	it.each(["passed", "outcome_failed"] as const)("only permits scored finalization from grading: %s", (status) => {
		expect(() => transitionAttempt(initialAttemptState(), { type: "finalize", status })).toThrow(
			InvalidLifecycleTransitionError,
		)
		expect(transitionAttempt(advanceToGrading(), { type: "finalize", status }).terminalStatus).toBe(status)
	})

	it("permits a safety hard gate from agent execution", () => {
		expect(
			transitionAttempt(
				{ phase: "agent_execution", version: 2 },
				{
					type: "finalize",
					status: "safety_failed",
					failureCode: "forbidden_path",
				},
			),
		).toMatchObject({ terminalStatus: "safety_failed", failureCode: "forbidden_path" })
	})

	it.each(["created", "setup", "agent_execution", "evidence_collection", "grading"] as const)(
		"permits cancellation during %s",
		(phase) => {
			expect(transitionAttempt({ phase, version: 2 }, { type: "finalize", status: "cancelled" })).toMatchObject({
				phase,
				terminalStatus: "cancelled",
				version: 3,
			})
		},
	)

	it("permits operational terminal failures from any active phase", () => {
		const result = transitionAttempt(
			{ phase: "agent_execution", version: 2 },
			{
				type: "finalize",
				status: "agent_error",
				failureCode: "provider_disconnect",
			},
		)
		expect(result).toMatchObject({ terminalStatus: "agent_error", failureCode: "provider_disconnect", version: 3 })
	})

	it("makes terminal attempts immutable", () => {
		const terminal = transitionAttempt(initialAttemptState(), {
			type: "reconcile_interrupted",
			failureCode: "controller_restart",
		})
		expect(() => transitionAttempt(terminal, { type: "start" })).toThrow(InvalidLifecycleTransitionError)
		expect(() => transitionAttempt(terminal, { type: "finalize", status: "infrastructure_error" })).toThrow(
			InvalidLifecycleTransitionError,
		)
	})

	it("reconciles an interrupted attempt with explicit evidence", () => {
		expect(
			transitionAttempt(
				{ phase: "evidence_collection", version: 3 },
				{
					type: "reconcile_interrupted",
					failureCode: "orphaned_runner",
					failureDetail: "heartbeat expired",
				},
			),
		).toEqual({
			phase: "evidence_collection",
			terminalStatus: "infrastructure_error",
			failureCode: "orphaned_runner",
			failureDetail: "heartbeat expired",
			version: 4,
		})
	})
})

describe("retry policy and trial derivation", () => {
	it.each([
		["agent_error", true],
		["infrastructure_error", true],
		["grader_error", true],
		["outcome_failed", false],
		["safety_failed", false],
		["budget_exhausted", false],
		["cancelled", false],
		["human_handoff", false],
		["passed", false],
	] satisfies Array<[TrialTerminalStatus, boolean]>)("classifies %s retryable=%s", (status, expected) => {
		expect(isRetryableStatus(status)).toBe(expected)
	})

	it("reports first-attempt success", () => {
		expect(deriveTrialResult(["passed"])).toEqual({
			status: "passed",
			firstAttemptStatus: "passed",
			retryAssisted: false,
			attemptCount: 1,
			terminalAttemptCount: 1,
			passed: true,
			finished: true,
		})
	})

	it("preserves first-attempt failure when a retry passes", () => {
		expect(deriveTrialResult(["infrastructure_error", "passed"])).toMatchObject({
			status: "passed",
			firstAttemptStatus: "infrastructure_error",
			retryAssisted: true,
			passed: true,
			finished: true,
		})
	})

	it("does not finish a retryable terminal result until retry policy is exhausted", () => {
		expect(deriveTrialResult(["infrastructure_error"])).toMatchObject({
			status: "infrastructure_error",
			passed: null,
			finished: false,
		})
	})

	it("finishes but does not score an exhausted infrastructure failure", () => {
		expect(
			deriveTrialResult(["infrastructure_error", "infrastructure_error"], { retryPolicyExhausted: true }),
		).toMatchObject({
			status: "infrastructure_error",
			firstAttemptStatus: "infrastructure_error",
			retryAssisted: false,
			passed: null,
			finished: true,
		})
	})

	it.each(["outcome_failed", "safety_failed", "budget_exhausted"] as const)(
		"finishes and scores %s as failed",
		(status) => {
			expect(deriveTrialResult([status])).toMatchObject({ status, passed: false, finished: true })
		},
	)

	it.each(["grader_error", "cancelled", "human_handoff"] as const)(
		"does not score %s as an agent failure",
		(status) => {
			const result = deriveTrialResult([status])
			expect(result.passed).toBeNull()
		},
	)

	it("keeps a nonterminal attempt unfinished", () => {
		expect(deriveTrialResult(["infrastructure_error", undefined])).toMatchObject({
			attemptCount: 2,
			terminalAttemptCount: 1,
			passed: null,
			finished: false,
		})
	})
})
