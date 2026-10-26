import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { EVALS_REPO_PATH } from "../../exercises/index"
import * as grading from "../../grading/index"
import * as orchestration from "../../orchestration/index"
import { certifySuite, loadCertificationSuite } from "../runner"

async function suite() {
	return loadCertificationSuite(path.join(EVALS_REPO_PATH, "certification", "suite.json"))
}

afterEach(() => vi.restoreAllMocks())

describe("active certification runtime controls", () => {
	it("labels real grader/orchestrator controls separately from historical classification fixtures", async () => {
		const result = await certifySuite(await suite(), { repetitions: 1, concurrency: 1 })
		expect(result).toHaveProperty("runtimeControls", {
			schemaVersion: 1,
			id: "harness-runtime-controls-v1",
			controls: [
				{ id: "forbidden-path-v1", scope: "diff-policy", passed: true },
				{ id: "hidden-boundary-v1", scope: "hidden-grader-boundary", passed: true },
				{ id: "retry-selection-v1", scope: "attempt-orchestration-and-retry", passed: true },
			],
			classificationOnlyKinds: ["network_violation"],
		})
	})

	it("rejects certification when the real diff policy accepts a forbidden change", async () => {
		const execute = grading.DiffPolicyGrader.prototype.execute
		vi.spyOn(grading.DiffPolicyGrader.prototype, "execute").mockImplementation(async function (
			this: grading.DiffPolicyGrader,
			spec,
			context,
		) {
			return { ...(await execute.call(this, spec, context)), status: "passed", diagnostics: [] }
		})
		await expect(certifySuite(await suite(), { repetitions: 1, concurrency: 1 })).rejects.toThrow(
			/forbidden-path-v1/,
		)
	})

	it("rejects certification when the owning hidden-root boundary accepts overlap", async () => {
		vi.spyOn(grading, "assertHiddenGraderBoundary").mockImplementation(() => undefined)
		await expect(certifySuite(await suite(), { repetitions: 1, concurrency: 1 })).rejects.toThrow(
			/hidden-boundary-v1/,
		)
	})

	it("rejects certification when retry selection stops after a retryable first attempt", async () => {
		vi.spyOn(orchestration, "executeRetryPolicy").mockImplementation(async (_policy, ports, execute) => {
			const status = await execute(1)
			return {
				status,
				exhausted: false,
				attempts: [
					{
						attemptNumber: 1,
						status,
						startedAt: ports.clock.now().toISOString(),
						finishedAt: ports.clock.now().toISOString(),
						delayBeforeMs: 0,
					},
				],
			}
		})
		await expect(certifySuite(await suite(), { repetitions: 1, concurrency: 1 })).rejects.toThrow(
			/retry-selection-v1/,
		)
	})

	it("rejects certification when retry selection retries a terminal outcome failure", async () => {
		const executeRetryPolicy = orchestration.executeRetryPolicy
		vi.spyOn(orchestration, "executeRetryPolicy").mockImplementation((policy, ports, execute, onExhausted) =>
			executeRetryPolicy(
				policy,
				ports,
				async (attemptNumber) => {
					const status = await execute(attemptNumber)
					return status === "outcome_failed" ? "agent_error" : status
				},
				onExhausted,
			),
		)
		await expect(certifySuite(await suite(), { repetitions: 1, concurrency: 1 })).rejects.toThrow(
			/retry-selection-v1/,
		)
	})

	it("rejects certification when retry exhaustion fails to finalize", async () => {
		const executeRetryPolicy = orchestration.executeRetryPolicy
		vi.spyOn(orchestration, "executeRetryPolicy").mockImplementation((policy, ports, execute) =>
			executeRetryPolicy(policy, ports, execute, async () => undefined),
		)
		await expect(certifySuite(await suite(), { repetitions: 1, concurrency: 1 })).rejects.toThrow(
			/retry-selection-v1/,
		)
	})

	it.each([
		{ repetitions: 0, concurrency: 1 },
		{ repetitions: 1, concurrency: 0 },
	])("rejects an empty execution request: %j", async (options) => {
		await expect(certifySuite(await suite(), options)).rejects.toThrow(/positive integer/)
	})
})
