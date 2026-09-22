import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"

import { runLiveCase } from "./live-file-tool-support"

suite("Live Copilot GitHub CLI approval", function () {
	this.timeout(230_000)

	suiteSetup(function () {
		if (process.env.ALPHA_E2E_PROVIDER_MODE !== "live-copilot") {
			this.skip()
		}
		assert.ok(
			vscode.version === "1.122.1" || vscode.version === "1.136.1",
			"GitHub approval runs on the reference host or the live Copilot host",
		)
	})

	test("Auto auto-approves a read-only gh probe and does not mutate GitHub", async () => {
		await runLiveCase(
			"approval-github-live",
			["shell"],
			{},
			[
				"Use the shell tool exactly once.",
				"Run only `gh --version`.",
				"Do not run `gh auth login`, `gh api`, `gh pr create`, `gh issue create`, or any mutating GitHub command.",
				"Do not write files. Report the CLI version and finish.",
			].join(" "),
			async (calls, messages) => {
				const commands = calls.filter((call) => call.name === "shell" || call.name === "execute_command")
				assert.equal(commands.length, 1)
				const command = String(commands[0]!.input.command ?? "")
				assert.match(command, /^\s*gh\s+--version\b/)
				assert.doesNotMatch(command, /\bgh\s+(api|pr|issue|repo|auth\s+login)\b/)
				assert.equal(commands[0]!.isError, false)
				assert.match(commands[0]!.result, /gh version/i)
				assert.equal(
					messages.some(
						(message) =>
							message.type === "ask" &&
							message.ask === "command" &&
							message.partial !== true &&
							!message.text?.includes("completion"),
					),
					false,
					"Auto must not ask a human for gh --version",
				)
				const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
				assert.ok(artifacts)
				await fs.writeFile(
					path.join(artifacts, "approval-github-live.receipt.json"),
					JSON.stringify(
						{
							schemaVersion: 1,
							hostVersion: vscode.version,
							command,
							mutatedGitHub: false,
						},
						null,
						2,
					),
					{ flag: "wx" },
				)
			},
			{ commands: [], requestLimit: 6 },
		)
	})
})
