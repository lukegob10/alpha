import { strict as assert } from "node:assert"
import * as vscode from "vscode"

import { record, runLiveCase } from "./live-file-tool-support"

suite("Live Copilot Alpha Tickets", function () {
	this.timeout(230_000)

	suiteSetup(function () {
		if (process.env.ALPHA_E2E_PROVIDER_MODE !== "live-copilot") this.skip()
		const expectedVersion = process.env.ALPHA_E2E_EXPECTED_VSCODE_VERSION
		if (expectedVersion) assert.equal(vscode.version, expectedVersion)
	})

	test("uses the eager list_tickets tool and persists its result", async () => {
		await runLiveCase(
			"alpha-tickets-live",
			["list_tickets"],
			{},
			"Call list_tickets exactly once with status in-progress. Report the returned total and finish.",
			async (calls, _messages, _workspace, answer) => {
				const lists = calls.filter((call) => call.name === "list_tickets")
				assert.equal(lists.length, 1, "The real model must use the Alpha Tickets tool once")
				assert.equal(lists[0]!.input.status, "in-progress")
				assert.equal(lists[0]!.isError, false)
				const output = record(JSON.parse(lists[0]!.result))
				assert.equal(output.status, "success")
				const result = record(output.result)
				assert.ok(Array.isArray(result.tickets))
				assert.equal(typeof result.total, "number")
				assert.match(answer, new RegExp(String(result.total)))
			},
			{
				requestLimit: 6,
				scope: "Use Alpha Tickets only. Do not inspect files, execute commands, create or edit Tickets, or delegate.",
			},
		)
	})
})
