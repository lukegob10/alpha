import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { glob } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { lanes, selectLane } from "./catalog.mjs"
import { expectedTestFiles } from "./lane-evidence.mjs"

test("tooling execution includes every Node test in its script owners", async () => {
	const root = fileURLToPath(new URL("../../", import.meta.url))
	const observed = await expectedTestFiles(root, { runner: "node" }, ["test:tooling"])
	const expected = []
	for await (const file of glob(
		["scripts/*.test.{js,mjs,ts}", "scripts/harness/*.test.{js,mjs,ts}", "scripts/evals/*.test.{js,mjs,ts}"],
		{ cwd: root },
	)) {
		expected.push(file.replaceAll("\\", "/"))
	}
	assert.deepEqual(observed, expected.sort())
})

test("every lane delegates to an existing package command", () => {
	for (const lane of Object.values(lanes)) {
		for (const args of lane.commands) {
			const packagePath =
				args[0] === "--dir"
					? `${args[1]}/package.json`
					: args[0] === "--filter"
						? args[1] === "@alpha-code/types"
							? "packages/types/package.json"
							: args[1] === "@alpha-code/evals"
								? "packages/evals/package.json"
								: args[1] === "@alpha-code/vscode-webview"
									? "webview-ui/package.json"
									: "apps/vscode-e2e/package.json"
						: "package.json"
			const script = args[0].startsWith("--") ? args[2] : args[0]
			const manifest = JSON.parse(readFileSync(new URL(`../../${packagePath}`, import.meta.url)))
			assert.ok(manifest.scripts[script], `${packagePath}: ${script}`)
		}
		assert.ok(lane.fidelity && lane.decisions && lane.proves)
	}
})
test("focused selection preserves argument boundaries and requires explicit test paths", () => {
	const path = "core/task/__tests__/a path.spec.ts"
	assert.deepEqual(selectLane("focused", [path]).commands[0].slice(-1), [path])
	assert.throws(() => selectLane("focused"), /requires/)
	assert.throws(() => selectLane("focused", ["--update"]), /requires/)
	assert.throws(() => selectLane("host", [path]), /does not accept/)
	assert.throws(() => selectLane("constructor"), /Unknown lane/)
})
test("offline selection cannot start services or provider campaigns", () => {
	assert.deepEqual(selectLane("offline").commands, [
		["--filter", "@alpha-code/types", "build"],
		["--filter", "@alpha-code/evals", "test:unit"],
		["--filter", "@alpha-code/evals", "test:contract"],
		["--filter", "@alpha-code/evals", "test:certification"],
	])
	assert.equal(lanes.offline.decisions, "scripted")
	assert.ok(lanes.services.prerequisites.length)
	assert.ok(lanes.services.commands.some((args) => args.includes("services:check")))
	assert.ok(lanes.services.commands.some((args) => args.includes("test:integration")))
	assert.ok(lanes.services.commands.some((args) => args.includes("test:redis")))
	assert.equal(
		lanes.services.commands.some((args) => args.includes("test:evals")),
		false,
	)
	assert.deepEqual(lanes.infrastructure.commands, [["test:evals:infrastructure"]])
})

test("hard offline and host lanes require explicit execution receipts", () => {
	assert.equal(lanes.unit.receipts.filter((receipt) => receipt?.runner === "vitest").length, 7)
	assert.ok(lanes.unit.commands.some((args) => args[1] === "packages/build" && args[2] === "test"))
	assert.ok(lanes.unit.receipts.some((receipt) => receipt?.packageDir === "packages/telemetry"))
	assert.ok(lanes.offline.receipts.slice(1).every((receipt) => receipt.requireAllTests))
	assert.equal(lanes.host.receipts[0].runner, "extension-host")
	assert.equal(lanes.outcomes.receipts[2].runner, "task-outcomes")
	assert.ok(lanes.outcomes.commands[2].includes("scripted"))
	assert.deepEqual(
		lanes.services.receipts.slice(2).map(({ config }) => config),
		["integration", "services"],
	)
	assert.ok(lanes.services.receipts.slice(2).every((receipt) => receipt.requireAllTests))
	assert.equal(lanes.infrastructure.receipts[0].config, "infrastructure")
	assert.equal(lanes.infrastructure.receipts[0].requireAllTests, true)
})

test("every evaluator test belongs to exactly one executable suite", async () => {
	const root = fileURLToPath(new URL("../../", import.meta.url))
	const discovered = []
	for await (const file of glob("packages/evals/src/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs,mts,cts}", {
		cwd: root,
		// Grader fixture repositories contain their own test programs, executed by localFixtures rather than Vitest.
		exclude: ["**/node_modules/**", "**/dist/**", "**/out/**", "**/__fixtures__/**"],
	}))
		discovered.push(file.replaceAll("\\", "/"))
	const owners = new Map()
	for (const config of ["unit", "contract", "certification", "integration", "services", "infrastructure"])
		for (const file of await expectedTestFiles(root, { runner: "vitest", config }, []))
			owners.set(file, [...(owners.get(file) ?? []), config])
	assert.ok(discovered.length > 0)
	assert.deepEqual(
		[...owners.keys()].sort(),
		discovered.sort(),
		"Evaluator files must not disappear from suite selection",
	)
	for (const [file, suites] of owners)
		assert.equal(suites.length, 1, `${file} is selected by multiple suites: ${suites.join(", ")}`)
})

test("extended exact-host coverage is mandatory in QA and both release workflows", async () => {
	assert.equal(lanes.extended.exclusiveBuild, true)
	assert.deepEqual(lanes.extended.commands, [["--filter", "@alpha-code/vscode-e2e", "test:extended:1250"]])
	assert.deepEqual(lanes.extended.receipts, [{ runner: "extension-host", suite: "extended" }])
	for (const file of ["code-qa.yml", "release-vsix.yml", "release-vsix-v2-preview.yml"]) {
		const workflow = readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8")
		assert.match(workflow, /run: pnpm harness run extended/, `${file} must execute the extended host lane`)
		assert.match(workflow, /--require extended/, `${file} must reject missing extended execution evidence`)
	}
})

test("platform unit and tooling checks retain Windows, Linux and macOS execution", () => {
	const workflow = readFileSync(new URL("../../.github/workflows/code-qa.yml", import.meta.url), "utf8")
	const platformJob = workflow.split("    unit-test:")[1]?.split("    offline-evaluator:")[0]
	assert.ok(platformJob)
	for (const platform of ["ubuntu-latest", "windows-latest", "macos-latest"])
		assert.ok(platformJob.includes(`os: ${platform}`), `Platform regressions must run on ${platform}`)
	assert.match(platformJob, /run: pnpm harness run unit/)
	assert.match(platformJob, /run: pnpm harness run tooling/)
})
