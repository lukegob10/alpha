import * as assert from "node:assert/strict"
import * as path from "node:path"
import { test } from "node:test"
import { main } from "../../runCampaign"
import { runNestedRestartCampaign } from "../nestedRestartCampaign"

test("nested restart rejects ambiguous modes before launching or initializing a fixture", async () => {
	for (const conflicting of [
		"--shared-storage-root",
		"--storage-recovery-root",
		"--root",
		"--config",
		"--profile-dir",
	]) {
		await assert.rejects(
			main(["--nested-restart-root", path.resolve("unused-fixture"), conflicting, path.resolve("other")]),
			/Conflicting/,
		)
	}
	await assert.rejects(
		main(["--nested-restart-root", path.resolve("unused-fixture"), "--suite", "core"]),
		/Conflicting/,
	)
})

test("nested restart admits only the exact host and an explicit executable", async () => {
	await assert.rejects(
		main(["--nested-restart-root", path.resolve("unused-fixture"), "--vscode-version", "stable"]),
		/exact reference/,
	)
	await assert.rejects(
		runNestedRestartCampaign({ fixtureRoot: path.resolve("unused-fixture"), host: { version: "1.122.1" } }),
	)
})
