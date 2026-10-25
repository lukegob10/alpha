import fs from "node:fs/promises"
import path from "node:path"

import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import { z } from "zod"

import {
	aggregateHoldoutTrials,
	evaluateHoldoutConfirmation,
	frontierHoldoutPolicyV1,
	holdoutConfirmationSchema,
} from "../holdout"
import { holdoutEvidence } from "./fixtures/holdoutEvidence"

describe("versioned manual holdout confirmation", () => {
	it("requires explicit policy review when the public versioned holdout roster changes", async () => {
		const suite = z
			.object({
				id: z.string(),
				version: z.number(),
				tasks: z.array(
					z.object({
						id: z.string(),
						version: z.number(),
						partition: z.string(),
					}),
				),
			})
			.parse(
				parse(
					await fs.readFile(
						path.resolve(process.cwd(), "../../evals/archive/manifests/frontier-v1@1.yaml"),
						"utf8",
					),
				),
			)
		expect(suite.id).toBe(frontierHoldoutPolicyV1.suiteId)
		expect(suite.version).toBe(frontierHoldoutPolicyV1.suiteVersion)
		expect(
			suite.tasks
				.filter(({ partition }) => partition === "holdout")
				.map(({ id, version }) => `${id}@${version}`)
				.sort(),
		).toEqual([...frontierHoldoutPolicyV1.requiredTaskIdentities].sort())
	})

	it("does not reuse the historical policy for a new suite version", () => {
		const { confirmation } = holdoutEvidence()
		expect(() => holdoutConfirmationSchema.parse({ ...confirmation, suiteVersion: 2 })).toThrow()
	})

	it("derives confirmation from the complete unique roster and matching successful receipts", () => {
		const { confirmation, aggregate } = holdoutEvidence()
		expect(evaluateHoldoutConfirmation(confirmation, aggregate)).toEqual({ confirmed: true, reasons: [] })
		expect(frontierHoldoutPolicyV1.minimumPassRate).toBe(1)
	})

	it.each(["duplicate-task", "wrong-version", "unknown-task", "missing-task"])(
		"rejects incomplete roster evidence: %s",
		(fault) => {
			const { confirmation, aggregate } = holdoutEvidence()
			if (fault === "duplicate-task") confirmation.receipts[1]!.taskId = confirmation.receipts[0]!.taskId
			if (fault === "wrong-version") confirmation.receipts[0]!.taskVersion = 2
			if (fault === "unknown-task") confirmation.receipts[0]!.taskId = "other-task"
			if (fault === "missing-task") confirmation.receipts.pop()
			expect(evaluateHoldoutConfirmation(confirmation, aggregate)).toMatchObject({
				confirmed: false,
				reasons: expect.arrayContaining([expect.stringContaining("unique task roster")]),
			})
		},
	)

	it.each(["trialId", "evidenceDigest"] as const)("rejects reused %s receipts", (key) => {
		const { confirmation, aggregate } = holdoutEvidence()
		confirmation.receipts[1]![key] = confirmation.receipts[0]![key]
		expect(evaluateHoldoutConfirmation(confirmation, aggregate).confirmed).toBe(false)
	})

	it.each(["outcome_failed", "safety_failed", "grader_error"] as const)(
		"does not count %s as successful quality confirmation",
		(graderDecision) => {
			const { confirmation } = holdoutEvidence()
			for (const receipt of confirmation.receipts) receipt.graderDecision = graderDecision
			const aggregate = aggregateHoldoutTrials(
				confirmation.receipts.map((receipt) => ({
					...receipt,
					passed: false,
					safetyFailed: graderDecision === "safety_failed",
				})),
			)
			expect(evaluateHoldoutConfirmation(confirmation, aggregate)).toMatchObject({
				confirmed: false,
				reasons: expect.arrayContaining([expect.stringContaining("quality rule")]),
			})
		},
	)

	it("rejects a forged aggregate even when the declared receipts are otherwise complete", () => {
		const { confirmation, aggregate } = holdoutEvidence()
		aggregate.costUsd = 0
		expect(evaluateHoldoutConfirmation(confirmation, aggregate)).toMatchObject({
			confirmed: false,
			reasons: [expect.stringContaining("does not match its receipts")],
		})
	})

	it("validates receipt evidence without exposing private task identity in diagnostics", () => {
		const { confirmation, aggregate } = holdoutEvidence()
		confirmation.receipts[0]!.taskId = "private-task-name"
		const result = evaluateHoldoutConfirmation(confirmation, aggregate)
		expect(JSON.stringify(result)).not.toContain("private-task-name")
		confirmation.receipts[0]!.evidenceDigest = "missing"
		expect(() => evaluateHoldoutConfirmation(confirmation, aggregate)).toThrow()
	})
})
