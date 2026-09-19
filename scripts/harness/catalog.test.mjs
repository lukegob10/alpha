import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { lanes, selectLane } from "./catalog.mjs"

test("every lane delegates to an existing package command", () => {
	for (const lane of Object.values(lanes)) {
		for (const args of lane.commands) {
			const packagePath =
				args[0] === "--dir"
					? `${args[1]}/package.json`
					: args[0] === "--filter"
						? args[1] === "@alpha-code/types"
							? "packages/types/package.json"
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
		["test:evals:offline"],
	])
	assert.equal(lanes.offline.decisions, "scripted")
	assert.ok(lanes.services.prerequisites.length)
	assert.ok(lanes.services.commands.some((args) => args.includes("test:evals:services")))
	assert.equal(
		lanes.services.commands.some((args) => args.includes("test:evals")),
		false,
	)
	assert.deepEqual(lanes.infrastructure.commands, [["test:evals:infrastructure"]])
})
