import assert from "node:assert/strict"
import { glob } from "node:fs/promises"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { lanes } from "./catalog.mjs"
import { expectedTestFiles } from "./lane-evidence.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))

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
