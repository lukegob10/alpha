import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"

import { LiveResponseProbe } from "../scenarios/liveResponseProbe"
import { runLiveCase } from "./live-file-tool-support"

/** Opt-in observation: valid tool transactions are a gate; stochastic batch counts are evidence. */
suite("Live Claude independent command batching", function () {
	this.timeout(540_000)

	test("records three identical workloads through the actual selected Copilot model", async () => {
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "live-copilot")
		assert.equal(vscode.version, "1.138.0")
		assert.match(process.env.ALPHA_E2E_ACTUAL_MODEL_FAMILY ?? "", /^claude-/i)
		const samples: Array<{
			taskId: string
			commandsPerResponse: number[]
			taskRequests: number
			elapsedMs: number
		}> = []
		let passed = false
		try {
			for (let index = 0; index < 3; index++) {
				const directory = `live-claude-batching-${index}`
				const expected = ["ALPHA_BATCH_RED=17", "ALPHA_BATCH_GREEN=23", "ALPHA_BATCH_BLUE=41"]
				const commands = ["red", "green", "blue"].map((color) => `node ${directory}/${color}.cjs`)
				const files = Object.fromEntries(
					["red", "green", "blue"].map((color, position) => [
						`${directory}/${color}.cjs`,
						`console.log(${JSON.stringify(expected[position])})\n`,
					]),
				)
				const commandCounts = new Map<number, number>()
				const probe = new LiveResponseProbe((part, request) => {
					if (part instanceof vscode.LanguageModelToolCallPart && part.name === "exec_command")
						commandCounts.set(request, (commandCounts.get(request) ?? 0) + 1)
				})
				const started = Date.now()
				await runLiveCase(
					`claude-batching-${index}`,
					["exec_command"],
					files,
					`Report the red, green, and blue values and their sum. Obtain each value by running its corresponding command exactly once: ${commands.map((command) => JSON.stringify(command)).join(", ")}. Each script reports an independent value.`,
					async (calls, _messages, _workspace, answer, task) => {
						const inspections = calls.filter((call) => call.name === "exec_command")
						assert.equal(inspections.length, 3)
						assert.deepEqual(inspections.map((call) => call.input.cmd).sort(), [...commands].sort())
						assert.ok(calls.every((call) => !call.isError))
						for (const value of expected) assert.ok(inspections.some((call) => call.result.includes(value)))
						assert.match(answer, /\b81\b/)
						assert.ok(probe.observations.length > 0)
						assert.ok(probe.observations.every((response) => response.ended))
						assert.equal(
							[...commandCounts.values()].reduce((sum, count) => sum + count, 0),
							3,
						)
						samples.push({
							taskId: task.taskId,
							commandsPerResponse: probe.observations.map(
								(response) => commandCounts.get(response.request) ?? 0,
							),
							taskRequests: probe.observations.length,
							elapsedMs: Date.now() - started,
						})
					},
					{
						scope: `Work only in ${directory}. Use exec_command for the requested inspections. Do not edit, create files, or delegate.`,
						commands,
						requestLimit: 12,
						responseProbe: probe,
						onTaskRequest: (client) => {
							assert.equal(client.id, process.env.ALPHA_E2E_ACTUAL_MODEL_ID)
							assert.equal(client.vendor, "copilot")
						},
					},
				)
			}
			passed = true
		} finally {
			await fs.writeFile(
				path.join(process.env.ALPHA_E2E_ARTIFACTS_DIR!, "claude-copilot-batching-live.json"),
				JSON.stringify(
					{
						schemaVersion: 1,
						passed,
						hostVersion: vscode.version,
						modelId: process.env.ALPHA_E2E_ACTUAL_MODEL_ID,
						family: process.env.ALPHA_E2E_ACTUAL_MODEL_FAMILY,
						effort: process.env.ALPHA_E2E_ACTUAL_REASONING_EFFORT,
						profile: process.env.ALPHA_E2E_PROFILE_DIR,
						samples,
					},
					null,
					2,
				),
				{ flag: "wx" },
			)
		}
	})
})
