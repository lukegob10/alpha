import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as path from "node:path"

import { WORKFLOW_SCENARIO_IDS } from "../../scenarios/contracts"
import { createDevelopmentSuite, DEVELOPMENT_SUITE_NAMES, type DevelopmentSuiteOptions } from "../developmentSuites"
import { parseCampaignConfig } from "../config"
import type { CampaignConfig } from "../types"

const options = (overrides: Partial<DevelopmentSuiteOptions> = {}): DevelopmentSuiteOptions => ({
	suite: "smoke",
	id: "development-suite-test",
	provider: "scripted",
	...overrides,
})

test("exposes the three suites and their requested scenario catalog", () => {
	assert.deepEqual(DEVELOPMENT_SUITE_NAMES, ["smoke", "development", "soak"])
	assert.deepEqual(createDevelopmentSuite(options()).scenarioIds, [
		"dev-git-inspect",
		"dev-repo-bootstrap",
		"review-edit-test-commit-followup",
	])
	assert.deepEqual(createDevelopmentSuite(options({ suite: "development" })).scenarioIds, WORKFLOW_SCENARIO_IDS)
	assert.deepEqual(createDevelopmentSuite(options({ suite: "soak" })).scenarioIds, WORKFLOW_SCENARIO_IDS)

	for (const scenarioId of WORKFLOW_SCENARIO_IDS) {
		assert.ok(createDevelopmentSuite(options({ suite: "development" })).scenarioIds.includes(scenarioId))
	}
})

test("uses bounded matrix budgets and scales iterations to the selected host count", () => {
	const expected = {
		smoke: { samples: 1, maxIterations: 18, maxRequests: 300, maxDurationMs: 30 * 60 * 1_000 },
		development: { samples: 1, maxIterations: 72, maxRequests: 1_200, maxDurationMs: 2 * 60 * 60 * 1_000 },
		soak: { samples: 3, maxIterations: 216, maxRequests: 3_000, maxDurationMs: 6 * 60 * 60 * 1_000 },
	} as const

	for (const suite of DEVELOPMENT_SUITE_NAMES) {
		const config = createDevelopmentSuite(options({ suite }))
		assert.equal(config.samples, expected[suite].samples)
		assert.deepEqual(config.budgets, {
			maxIterations: expected[suite].maxIterations,
			maxRequests: expected[suite].maxRequests,
			maxDurationMs: expected[suite].maxDurationMs,
			attemptTimeoutMs: 10 * 60 * 1_000,
		})
		assert.equal(config.maxReproductions, 2)
	}

	const singleHost = createDevelopmentSuite(options({ suite: "development", host: { version: "1.136.1" } }))
	assert.equal(singleHost.budgets.maxIterations, 36)
})

test("defaults to the exact supported hosts in compatibility order and accepts one host", () => {
	assert.deepEqual(createDevelopmentSuite(options()).hosts, [{ version: "1.122.1" }, { version: "1.136.1" }])
	assert.deepEqual(createDevelopmentSuite(options({ host: { version: "1.122.1" } })).hosts, [{ version: "1.122.1" }])
})

test("requires an exact live model and an explicit supported effort", () => {
	assert.throws(() => createDevelopmentSuite(options({ provider: "live-copilot", effort: "high" })), /exact model ID/)
	assert.throws(
		() => createDevelopmentSuite(options({ provider: "live-copilot", modelId: "copilot-exact" })),
		/explicit supported effort/,
	)
	assert.throws(
		() =>
			createDevelopmentSuite(
				options({ provider: "live-copilot", modelId: "copilot-exact", effort: "provider-default" }),
			),
		/explicit supported effort/,
	)

	const config = createDevelopmentSuite(
		options({ provider: "live-copilot", modelId: "copilot-exact", effort: "max" }),
	)
	assert.deepEqual(config.provider, { mode: "live-copilot", modelId: "copilot-exact", effort: "max" })
})

test("scripted suites reject live-only model and effort parameters", () => {
	assert.throws(() => createDevelopmentSuite(options({ modelId: "copilot-exact" })), /do not accept model or effort/)
	assert.throws(() => createDevelopmentSuite(options({ effort: "high" })), /do not accept model or effort/)
})

test("rejects invalid suite, provider, host, and path inputs", () => {
	assert.throws(() => createDevelopmentSuite(options({ suite: "nightly" })), /Invalid development suite/)
	assert.throws(
		() => createDevelopmentSuite(options({ provider: "unknown" as DevelopmentSuiteOptions["provider"] })),
		/Invalid development suite provider/,
	)
	assert.throws(
		() => createDevelopmentSuite(options({ host: { version: "stable" as "1.122.1" } })),
		/Unsupported host version/,
	)
	assert.throws(
		() => createDevelopmentSuite(options({ host: { version: "1.122.1", executable: "relative/vscode" } })),
		/Host executable must be absolute/,
	)
	assert.throws(() => createDevelopmentSuite(options({ id: "../outside-campaign" })), /Invalid campaign identifier/)

	const absoluteExecutable = createDevelopmentSuite(
		options({ host: { version: "1.122.1", executable: path.resolve("vscode.exe") } }),
	)
	assert.equal(absoluteExecutable.hosts[0]?.executable, path.resolve("vscode.exe"))
})

test("returns an existing parser-compatible campaign config without source repair", () => {
	const config = createDevelopmentSuite(options({ suite: "development" }))
	assert.deepEqual(parseCampaignConfig(config), config)
	assert.equal("repair" in config, false)

	const existing: CampaignConfig = {
		id: "existing-campaign",
		hosts: [{ version: "1.122.1" }],
		scenarioIds: ["review-edit-test-commit-followup"],
		samples: 1,
		provider: { mode: "scripted" },
		budgets: { maxIterations: 3, maxRequests: 10, maxDurationMs: 60_000, attemptTimeoutMs: 10_000 },
		maxReproductions: 2,
	}
	assert.deepEqual(parseCampaignConfig(existing), existing)
})
