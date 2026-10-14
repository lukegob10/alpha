import path from "node:path"

import { describe, expect, it } from "vitest"

import { EVALS_REPO_PATH } from "../../exercises/index"
import { certifySuite, loadCertificationSuite, runCertificationScenario } from "../runner"
import { certifyHarness } from "../preflight"

const suitePath = path.join(EVALS_REPO_PATH, "certification", "suite.json")

describe("golden harness certification", () => {
	it("contains every required versioned scenario and rejects schema drift", async () => {
		const suite = await loadCertificationSuite(suitePath)
		expect(suite.scenarios).toHaveLength(16)
		expect(new Set(suite.scenarios.map(({ kind }) => kind))).toEqual(
			new Set([
				"known_pass",
				"functional_failure",
				"forbidden_path",
				"hidden_grader_access",
				"agent_timeout",
				"grader_timeout",
				"setup_failure",
				"artifact_corruption",
				"missing_event",
				"duplicate_event",
				"infrastructure_retry",
				"agent_retry",
				"cancellation",
				"network_violation",
				"secret_redaction",
				"nondeterministic_grader",
			]),
		)
		await expect(runCertificationScenario({ ...suite.scenarios[0]!, kind: "known_pass" })).resolves.toEqual(
			suite.scenarios[0]!.expected,
		)
	})

	it("passes twenty consecutive serial runs without drift or misclassification", async () => {
		const suite = await loadCertificationSuite(suitePath)
		const result = await certifySuite(suite, { repetitions: 20, concurrency: 1 })
		expect(result.runs).toHaveLength(20)
		expect(new Set(result.runs.map((run) => JSON.stringify(run))).size).toBe(1)
	})

	it("passes five consecutive production-concurrency runs without drift", async () => {
		const suite = await loadCertificationSuite(suitePath)
		const result = await certifySuite(suite, { repetitions: 5, concurrency: suite.concurrency })
		expect(result.runs).toHaveLength(5)
		expect(new Set(result.runs.map((run) => JSON.stringify(run))).size).toBe(1)
	})

	it("emits a scenario reproduction bundle when an expectation is weakened", async () => {
		const suite = await loadCertificationSuite(suitePath)
		const broken = structuredClone(suite)
		broken.scenarios[0]!.expected.terminalStatus = "outcome_failed"
		await expect(certifySuite(broken, { repetitions: 1, concurrency: 1 })).rejects.toThrow(
			/Certification mismatch for known-pass.*reproduction/,
		)
	})

	it("is a cached mandatory preflight for model-backed runs", async () => {
		const first = certifyHarness()
		const second = certifyHarness()
		expect(second).toBe(first)
		await first
	})
})
