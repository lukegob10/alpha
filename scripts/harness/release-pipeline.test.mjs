import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import test from "node:test"
import { lanes } from "./catalog.mjs"
import { releaseTargets, releaseValidationPlatforms } from "./release-evidence.mjs"

const require = createRequire(import.meta.url)
const yaml = createRequire(require.resolve("eslint/package.json"))("js-yaml")
const workflow = yaml.load(await readFile(new URL("../../.github/workflows/release-vsix.yml", import.meta.url), "utf8"))
const validationLanes = [
	"static",
	"turns",
	"unit",
	"tooling",
	"offline",
	"host",
	"minimum",
	"extended",
	"confidence",
	"rendered",
	"stress",
	"outcomes",
	"command-approval",
]

test("every independent release validation has its own runner after live preflight", () => {
	const validation = workflow.jobs.validation
	assert.ok(validation, "release validation must be split across isolated matrix jobs")
	assert.equal(validation.needs, "live-quality")
	assert.equal(validation.strategy["fail-fast"], false)
	assert.deepEqual(validation.strategy.matrix.include.map(({ lane }) => lane).sort(), [...validationLanes].sort())
	assert.equal(validation["runs-on"], "${{ matrix.os }}")
	assert.ok(validation.steps.some((step) => step.uses?.startsWith("actions/checkout@")))
})

test("all six native packages overlap validation immediately after live preflight", () => {
	const packaging = workflow.jobs["package-vsix"]
	assert.equal(packaging.needs, "live-quality")
	assert.equal(packaging.strategy["max-parallel"], 6)
	assert.equal(packaging.strategy["fail-fast"], false)
	assert.equal(packaging.strategy.matrix.include.length, 6)
})

test("publication requires successful live, validation, package and aggregate barriers", () => {
	const gate = workflow.jobs["release-gate"]
	assert.ok(gate, "a complete evidence aggregation barrier is required")
	assert.equal(gate.if, "${{ always() }}")
	assert.deepEqual(gate.needs, ["live-quality", "validation", "package-vsix"])
	assert.deepEqual(workflow.jobs["publish-release"].needs, [
		"live-quality",
		"validation",
		"package-vsix",
		"release-gate",
	])
})

test("the matrix selects complete existing lanes, preserves native checks, and retains failure evidence", () => {
	const validation = workflow.jobs.validation
	assert.deepEqual(Object.keys(releaseValidationPlatforms).sort(), [...validationLanes].sort())
	for (const entry of validation.strategy.matrix.include)
		assert.equal(entry.os, releaseValidationPlatforms[entry.lane] === "win32" ? "windows-latest" : "ubuntu-latest")
	const run = validation.steps.find((step) => step.run === 'pnpm harness run "${{ matrix.lane }}"')
	assert.ok(run)
	assert.equal(run.if, undefined)
	assert.equal(run["continue-on-error"], undefined)
	for (const command of ["pnpm --filter @alpha-code/evals lint", "pnpm --filter @alpha-code/evals check-types"])
		assert.equal(validation.steps.find((step) => step.run === command)?.if, "matrix.lane == 'offline'")
	assert.ok(validation.steps.some((step) => step.uses === "./.github/actions/setup-node-pnpm"))
	assert.equal(validation.steps.find((step) => step.run?.includes("record-validation"))?.if, "${{ always() }}")
	assert.equal(
		validation.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))?.if,
		"${{ always() }}",
	)
	const packaging = workflow.jobs["package-vsix"]
	assert.deepEqual(packaging.strategy.matrix.include.map(({ target }) => target).sort(), [...releaseTargets].sort())
	for (const target of packaging.strategy.matrix.include) {
		assert.equal(target.native_index, target.target !== "darwin-x64")
		assert.equal(
			target.os,
			{
				"win32-x64": "windows-latest",
				"win32-arm64": "windows-11-arm",
				"darwin-arm64": "macos-15",
				"darwin-x64": "macos-15-intel",
				"linux-x64": "ubuntu-latest",
				"linux-arm64": "ubuntu-24.04-arm",
			}[target.target],
		)
	}
	for (const command of [
		"pnpm vsix",
		"pnpm --dir src test __tests__/lancedb-native.spec.mjs services/code-index/vector-store/__tests__/lancedb-loading.spec.ts",
		"pnpm --dir src test services/code-index/vector-store/__tests__/lancedb-native.spec.ts",
	])
		assert.ok(
			packaging.steps.some((step) => step.run === command),
			command,
		)
	assert.ok(
		packaging.steps.some((step) =>
			step.run?.includes('--check-source --require-clean-build --target "${{ matrix.target }}"'),
		),
	)
	assert.ok(packaging.steps.some((step) => step.run?.includes("record-package")))
	assert.equal(lanes["command-approval"].exclusiveBuild, true)
	assert.deepEqual(lanes["command-approval"].commands, [
		["bundle"],
		["--filter", "@alpha-code/vscode-e2e", "test:command-paths:1410:run"],
	])
	for (const lane of validationLanes) assert.equal(lanes[lane].exclusiveBuild, true)
})

test("aggregation and publication bind current attempt artifacts and recheck bytes before release creation", () => {
	const gate = workflow.jobs["release-gate"]
	const aggregate = gate.steps.find((step) => step.run?.includes("release-evidence.mjs aggregate"))
	assert.equal(aggregate.if, "${{ always() }}")
	assert.equal(aggregate.env.RELEASE_NEEDS, "${{ toJSON(needs) }}")
	for (const step of gate.steps.filter((step) => step.uses?.startsWith("actions/download-artifact@")))
		assert.match(step.with.pattern, /\$\{\{ github.run_attempt \}\}/u)
	const publish = workflow.jobs["publish-release"]
	for (const job of ["live-quality", "validation", "package-vsix", "release-gate"])
		assert.ok(publish.if.includes(`needs.${job}.result == 'success'`))
	const verifyIndex = publish.steps.findIndex((step) => step.run?.includes("verify-publication"))
	const createIndex = publish.steps.findIndex((step) => step.run?.includes("gh release create"))
	assert.ok(verifyIndex > 0 && createIndex > verifyIndex)
	assert.equal(publish.steps[verifyIndex].env.RELEASE_NEEDS, "${{ toJSON(needs) }}")
	for (const job of Object.values(workflow.jobs)) assert.equal(job["continue-on-error"], undefined)
})
