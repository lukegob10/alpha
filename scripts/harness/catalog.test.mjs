import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { glob } from "node:fs/promises"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { lanes, selectLane } from "./catalog.mjs"
import { expectedTestFiles } from "./lane-evidence.mjs"

test(
	"canonical bundle prepares one cached webview build without duplicate host preparation",
	{ timeout: 25_000 },
	() => {
		const root = fileURLToPath(new URL("../../", import.meta.url))
		const require = createRequire(import.meta.url)
		const manifest = (file) => JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"))
		assert.match(manifest("package.json").scripts.bundle, /^turbo bundle --filter=\.\/src(?:\s|$)/u)
		const graph = JSON.parse(
			execFileSync(
				process.execPath,
				[require.resolve("turbo/bin/turbo"), "run", "bundle", "--filter=./src", "--dry=json"],
				{
					cwd: root,
					encoding: "utf8",
					timeout: 20_000,
					maxBuffer: 4 * 1024 * 1024,
					windowsHide: true,
					env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" },
				},
			),
		)
		const webview = manifest("webview-ui/package.json")
		const webviewTasks = graph.tasks.filter((task) => task.taskId === `${webview.name}#build`)
		assert.equal(webviewTasks.length, 1, "The actual Turbo graph must build the webview exactly once")
		assert.equal(webviewTasks[0].command, webview.scripts.build)
		assert.deepEqual(webviewTasks[0].outputs, ["../src/webview-ui/build/**"])
		const bundle = graph.tasks.find((task) => task.taskId === `${manifest("src/package.json").name}#bundle`)
		assert.ok(bundle?.dependencies.includes(webviewTasks[0].taskId), "Bundle must await its cached webview output")
		const redundantBuild = "pnpm --filter @alpha-code/vscode-webview build"
		for (const [name, command] of Object.entries(manifest("apps/vscode-e2e/package.json").scripts)) {
			const steps = command.split(" && ")
			if (steps[0] === "pnpm -w bundle")
				assert.notEqual(steps[1], redundantBuild, `${name} must use the bundle's prepared webview`)
		}
		for (const [name, lane] of Object.entries(lanes)) {
			if (lane.commands[0]?.[0] === "bundle")
				assert.notDeepEqual(
					lane.commands[1],
					["--filter", webview.name, "build"],
					`${name} repeats webview preparation`,
				)
		}
	},
)

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

test("the VS Code 1.125 minimum is independent from the exact 1.138 reference host", () => {
	const manifest = (file) => JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"))
	const extension = manifest("src/package.json")
	const runner = manifest("apps/vscode-e2e/package.json")
	const fixture = manifest("apps/vscode-e2e/fixtures/vscode-lm-provider/package.json")
	assert.equal(extension.engines.vscode, "^1.125.0")
	assert.equal(extension.devDependencies["@types/vscode"], "1.125.0")
	assert.equal(fixture.engines.vscode, "^1.125.0")
	assert.equal(runner.devDependencies["@types/vscode"], "1.138.0")
	for (const name of [
		"test:compatibility:1250",
		"test:compatibility:1250:run",
		"test:smoke:1380",
		"test:smoke:1380:run",
	]) {
		assert.ok(runner.scripts[name], `${name} must remain available`)
	}
	for (const [name, command] of Object.entries(runner.scripts)) {
		const expectedVersion = name.includes(":1380") ? "1.138.0" : name.includes(":1250") ? "1.125.0" : undefined
		if (!expectedVersion) continue
		for (const [, version] of command.matchAll(/--vscode-version (\S+)/g)) {
			assert.equal(version, expectedVersion, `${name} selected a different host`)
		}
	}
})

test("every lane delegates to an existing package command", () => {
	for (const lane of Object.values(lanes)) {
		for (const args of lane.commands) {
			if (args[0] === "exec") {
				assert.equal(args[1], "node")
				assert.ok(
					["scripts/harness/audit-benchmarks.mjs", "scripts/verify-vsix-contents.mjs"].includes(args[2]),
				)
				assert.ok(readFileSync(new URL(`../../${args[2]}`, import.meta.url)).length)
				continue
			}
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
	assert.equal(lanes.outcomes.receipts[1].runner, "task-outcomes")
	assert.ok(lanes.outcomes.commands[1].includes("scripted"))
	assert.deepEqual(
		lanes.services.receipts.slice(2).map(({ config }) => config),
		["integration", "services"],
	)
	assert.ok(lanes.services.receipts.slice(2).every((receipt) => receipt.requireAllTests))
	assert.equal(lanes.infrastructure.receipts[0].config, "infrastructure")
	assert.equal(lanes.infrastructure.receipts[0].requireAllTests, true)
	for (const suite of ["rendered", "stress"]) {
		assert.equal(lanes[suite].exclusiveBuild, true)
		assert.deepEqual(lanes[suite].receipts, [
			...Array(lanes[suite].commands.length - 1).fill(null),
			{ runner: "extension-host", suite },
		])
		assert.equal(lanes[suite].decisions, "scripted")
		assert.ok(lanes[suite].prerequisites.length)
	}
	assert.ok(lanes.stress.commands.some((args) => args[1] === "@alpha-code/vscode-e2e" && args[2] === "compile"))
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

test("minimum-host compatibility and extended reference-host coverage are mandatory in QA and release", async () => {
	assert.equal(lanes.extended.exclusiveBuild, true)
	assert.deepEqual(lanes.extended.commands, [["--filter", "@alpha-code/vscode-e2e", "test:extended:1380"]])
	assert.deepEqual(lanes.extended.receipts, [{ runner: "extension-host", suite: "extended" }])
	for (const file of ["code-qa.yml", "release-vsix.yml"]) {
		const workflow = readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8")
		assert.match(
			workflow,
			/run: pnpm --filter @alpha-code\/vscode-e2e test:compatibility:1250:run/,
			`${file} must execute the separate minimum-host compatibility gate`,
		)
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
