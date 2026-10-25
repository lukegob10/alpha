import assert from "node:assert/strict"
import { glob, readFile } from "node:fs/promises"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { lanes } from "./catalog.mjs"
import { expectedTestFiles } from "./lane-evidence.mjs"
import { evidenceInventory, hostDriverInventory, hostTestInventory } from "./inventory.mjs"
import { hostSuites } from "./host-evidence.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))

test("every authored host file has one explicit cadence and owner, including optional and live cases", async () => {
	const authored = []
	for await (const file of glob("apps/vscode-e2e/src/suite/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs,mts,cts}", {
		cwd: root,
	}))
		authored.push(file.replaceAll("\\", "/"))
	const inventoried = hostTestInventory.map((entry) => entry.path)
	assert.deepEqual(
		inventoried.toSorted(),
		authored.toSorted(),
		"New or retired host tests need an explicit cadence decision",
	)
	assert.equal(new Set(inventoried).size, inventoried.length)
	for (const entry of hostTestInventory) {
		assert.ok(["pr", "release", "scheduled", "live", "manual", "retired"].includes(entry.cadence), entry.path)
		assert.ok(entry.owner && entry.reason, entry.path)
		assert.ok(
			entry.providers.length > 0 &&
				entry.providers.every((provider) =>
					["scripted", "vscode-lm-fixture", "live-copilot", "live"].includes(provider),
				),
			entry.path,
		)
		for (const lane of entry.lanes) assert.ok(Object.hasOwn(lanes, lane), entry.path)
	}
	for (const definition of evidenceInventory.filter((entry) => entry.kind === "scripted-host-test")) {
		for (const file of definition.tests) {
			const entry = hostTestInventory.find((entry) => entry.path === file)
			assert.ok(
				entry?.providers.some((provider) => ["scripted", "vscode-lm-fixture"].includes(provider)),
				`${definition.id} cannot admit a live-only test as scripted execution`,
			)
		}
	}
	for (const [suite, files] of Object.entries(hostSuites)) {
		const lane = suite === "smoke" ? "host" : suite
		for (const file of files)
			assert.ok(
				hostTestInventory
					.find((entry) => entry.path === `apps/vscode-e2e/src/suite/${file}.ts`)
					?.lanes.includes(lane),
			)
	}
})

test("every E2E entrypoint and phased host driver has an explicit cadence rather than implied CI coverage", async () => {
	const authored = [
		"apps/vscode-e2e/src/campaign/renderedUiProbe.ts",
		"scripts/harness/local-acceptance.mjs",
		"scripts/harness/host-probes.mjs",
	]
	for await (const file of glob("apps/vscode-e2e/src/run*.ts", { cwd: root })) {
		const normalized = file.replaceAll("\\", "/")
		const source = await readFile(new URL(`../../${normalized}`, import.meta.url), "utf8")
		if (/\bfunction main\b|require\.main\s*===\s*module|\bvoid main\(/.test(source)) authored.push(normalized)
	}
	for await (const file of glob("apps/vscode-e2e/src/campaign/*Campaign.ts", { cwd: root }))
		authored.push(file.replaceAll("\\", "/"))
	assert.deepEqual(hostDriverInventory.map((entry) => entry.path).toSorted(), authored.toSorted())
	assert.equal(new Set(hostDriverInventory.map((entry) => entry.path)).size, hostDriverInventory.length)
	for (const entry of hostDriverInventory) assert.ok(entry.owner && entry.reason && entry.cadence, entry.path)
})

for (const descriptor of lanes.unit.receipts.filter((receipt) => receipt?.runner === "vitest")) {
	test(`unit discovery selects every authored test in ${descriptor.packageDir}`, async () => {
		const directory = descriptor.packageDir
		const source = directory === "src" ? directory : `${directory}/src`
		const discovered = []
		for await (const file of glob(`${source}/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs,mts,cts}`, {
			cwd: root,
			// Fixture repositories and copied document examples are separate executable inputs.
			exclude: ["**/node_modules/**", "**/dist/**", "**/out/**", "**/__fixtures__/**", "src/webview-ui/build/**"],
		}))
			discovered.push(file.replaceAll("\\", "/"))
		assert.ok(discovered.length > 0, `${directory} must contain authored tests`)
		const selected = await expectedTestFiles(root, descriptor, ["--dir", directory, "test"])
		const selectedPaths = new Set(selected)
		const discoveredPaths = new Set(discovered)
		assert.deepEqual(
			{
				missing: discovered.filter((file) => !selectedPaths.has(file)).sort(),
				unexpected: selected.filter((file) => !discoveredPaths.has(file)).sort(),
			},
			{ missing: [], unexpected: [] },
			`${directory} must not silently omit authored test files`,
		)
		assert.equal(selected.length, discovered.length, `${directory} must select each test exactly once`)
	})
}
