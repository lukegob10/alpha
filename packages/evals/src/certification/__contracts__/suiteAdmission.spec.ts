import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { EVALS_REPO_PATH } from "../../exercises/index"
import * as grading from "../../grading/index"
import { certifySuite, loadCertificationSuite } from "../runner"
import { certificationSuiteSchema } from "../types"

const suitePath = path.join(EVALS_REPO_PATH, "certification", "suite.json")

afterEach(() => vi.restoreAllMocks())

describe("certification suite admission", () => {
	it("accepts the complete versioned control roster", async () => {
		const suite = await loadCertificationSuite(suitePath)
		expect(certificationSuiteSchema.safeParse(suite).success).toBe(true)
	})

	it("rejects repeated passing controls before issuing a certification result", async () => {
		const suite = await loadCertificationSuite(suitePath)
		const passing = suite.scenarios.find(({ kind }) => kind === "known_pass")!
		const repeated = {
			...suite,
			scenarios: suite.scenarios.map((_, index) => ({ ...passing, id: `passing-${index}` })),
		}
		await expect(certifySuite(repeated, { repetitions: 1, concurrency: 1 })).rejects.toThrow(
			/required certification control/,
		)
	})

	it("rejects duplicate scenario identities even when every control kind is present", async () => {
		const suite = await loadCertificationSuite(suitePath)
		suite.scenarios[1]!.id = suite.scenarios[0]!.id
		expect(() => certificationSuiteSchema.parse(suite)).toThrow(/Duplicate certification scenario ID/)
	})

	it("rejects a suite with an omitted negative control", async () => {
		const suite = await loadCertificationSuite(suitePath)
		suite.scenarios = suite.scenarios.filter(({ kind }) => kind !== "cancellation")
		expect(() => certificationSuiteSchema.parse(suite)).toThrow(/required certification control/)
	})

	it("validates direct callers before running runtime controls or accepting an empty result", async () => {
		const suite = await loadCertificationSuite(suitePath)
		const execute = vi.spyOn(grading.DiffPolicyGrader.prototype, "execute")
		await expect(certifySuite({ ...suite, scenarios: [] }, { repetitions: 1, concurrency: 1 })).rejects.toThrow(
			/required certification control/,
		)
		expect(execute).not.toHaveBeenCalled()
	})
})
