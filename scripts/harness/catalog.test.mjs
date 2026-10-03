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
	assert.equal(lanes.unit.receipts.filter((receipt) => receipt?.runner === "vitest").length, 5)
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
