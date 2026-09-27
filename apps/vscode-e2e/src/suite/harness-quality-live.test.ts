import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as vscode from "vscode"
import { waitFor } from "./utils"
import { record, runLiveCase } from "./live-file-tool-support"
import { withAutomatedBrowserApprovals } from "./host-browser-approvals"

suite("Live Copilot harness quality", function () {
	this.timeout(600_000)
	let originalBrowserTools: boolean | undefined
	suiteSetup(async () => {
		const config = vscode.workspace.getConfiguration("workbench.browser")
		originalBrowserTools = config.inspect<boolean>("enableChatTools")?.globalValue
		await config.update("enableChatTools", true, vscode.ConfigurationTarget.Global)
	})
	suiteTeardown(async () => {
		await vscode.workspace
			.getConfiguration("workbench.browser")
			.update("enableChatTools", originalBrowserTools, vscode.ConfigurationTarget.Global)
	})
	test("repairs a failing check with the current plan, command, and patch tools", async () => {
		const command = "node live-acceptance/check.cjs"
		const oracle =
			"const a=require('node:assert/strict'); const {total}=require('./invoice.cjs'); a.equal(total([]),0); a.equal(total([{cents:200,quantity:0}]),0); a.equal(total([{cents:200,quantity:3},{cents:50,quantity:2}]),700); console.log('3 checks passed');\n"
		const planSteps = ["Run the invoice baseline check", "Fix invoice quantities", "Rerun the invoice check"]
		await runLiveCase(
			"acceptance-repair",
			["update_plan", "exec_command", "apply_patch"],
			{
				"live-acceptance/invoice.cjs":
					"exports.total = items => items.reduce((sum, item) => sum + item.cents, 0)\n",
				"live-acceptance/check.cjs": oracle,
			},
			`Use update_plan to track these steps: ${JSON.stringify(planSteps)}. Run ${command} once with exec_command to demonstrate the existing failure, fix only invoice.cjs using apply_patch, then run the same check once more. Mark every plan step completed before finishing. Preserve the oracle.`,
			async (calls, _messages, workspace) => {
				const plans = calls.filter((call) => call.name === "update_plan")
				assert.ok(plans.length > 0, "The model must record its plan through the advertised tool")
				assert.equal(plans.at(-1)?.isError, false)
				assert.match(plans.at(-1)?.result ?? "", /Plan updated successfully/)
				const recordedSteps = plans.at(-1)?.input.plan
				assert.ok(Array.isArray(recordedSteps))
				assert.deepEqual(
					recordedSteps.map((step) => record(step).step),
					planSteps,
				)
				assert.ok(recordedSteps.every((step) => record(step).status === "completed"))
				const commands = calls.filter((call) => call.name === "exec_command")
				assert.equal(commands.length, 2, "One failing baseline and one passing repair check")
				assert.ok(commands.every((call) => call.input.cmd === command))
				assert.deepEqual(
					commands.map((call) => /Process exited with code (\d+)/.exec(call.result)?.[1]),
					["1", "0"],
					"Persisted tool results must show the failing baseline and passing repair",
				)
				assert.ok(commands[0] && commands[1])
				assert.match(commands[0].result, /AssertionError/)
				assert.match(commands[1].result, /3 checks passed/)
				const patches = calls.filter((call) => call.name === "apply_patch")
				assert.ok(patches.length > 0, "The repair must use apply_patch")
				assert.ok(
					patches.some(
						(call) =>
							typeof call.input.patch === "string" &&
							call.input.patch.includes("live-acceptance/invoice.cjs"),
					),
					"The patch must target the invoice fixture",
				)
				const source = await fs.readFile(path.join(workspace, "live-acceptance/invoice.cjs"), "utf8")
				assert.match(source, /quantity/)
				assert.equal(await fs.readFile(path.join(workspace, "live-acceptance/check.cjs"), "utf8"), oracle)
				await promisify(execFile)("node", ["live-acceptance/check.cjs"], {
					cwd: workspace,
					timeout: 10_000,
					windowsHide: true,
				})
			},
			{
				scope: "Work only on the specified invoice fixture. The test program is immutable. Do not load any skills for this explicit contract probe.",
				commands: ["node", "rg"],
				requestLimit: 24,
				timeoutMs: 420_000,
			},
		)
	})

	async function runCommandSession(browser: boolean) {
		const directory = browser ? "live-browser" : "live-server"
		const startCommand = `node ${directory}/server.cjs`
		const checkCommand = `node ${directory}/check.cjs`
		if (browser)
			await waitFor(() => vscode.lm.tools.some((tool) => tool.name === "open_browser_page"), {
				timeout: 15_000,
				description: "VS Code 1.122.1 browser tools",
			})
		await runLiveCase(
			browser ? "browser-session" : "command-session",
			browser
				? ["exec_command", "write_stdin", "open_browser_page", "click_element", "read_page"]
				: ["exec_command", "write_stdin"],
			{
				[`${directory}/server.cjs`]: `const fs=require('node:fs'); const http=require('node:http'); const server=http.createServer((req,res)=>{if(req.url==='/__shutdown'){res.writeHead(200,{'Content-Type':'text/plain'}).end('shutdown requested'); console.log('SHUTDOWN_REQUESTED'); server.close(()=>console.log('SERVER_STOPPED')); return} res.writeHead(200,{'Content-Type':'text/html'}).end('<!doctype html><h1>ALPHA_READY</h1><button onclick="this.textContent=\\'Count1\\';fetch(\\'/__shutdown\\')">Count0</button>')}); setTimeout(()=>server.listen(0,'127.0.0.1',()=>{const url='http://127.0.0.1:'+server.address().port; fs.writeFileSync('${directory}/url.txt',url); console.log('READY '+url)}),2500); setTimeout(()=>{if(server.listening){console.log('SERVER_FAILSAFE_STOP');server.close(()=>console.log('SERVER_STOPPED'))}},90000).unref();\n`,
				[`${directory}/check.cjs`]: `const fs=require('node:fs'); const assert=require('node:assert/strict'); const url=fs.readFileSync('${directory}/url.txt','utf8'); fetch(url).then(r=>r.text()).then(async body=>{assert.ok(body.includes('ALPHA_READY')); ${browser ? "console.log('HTTP behavior passed')" : "const stopped=await fetch(url+'/__shutdown'); assert.equal(await stopped.text(),'shutdown requested'); console.log('HTTP behavior passed; shutdown requested')"}}).catch(e=>{console.error(e);process.exitCode=1});\n`,
			},
			`Start ${startCommand} with exec_command and yield_time_ms 1000. Use write_stdin with the returned numeric session_id until READY is observed. Run ${checkCommand} once. ${browser ? "Open the observed URL with open_browser_page, click the Count0 button, and read_page to verify Count1; the button requests graceful server shutdown. " : ""}Then use write_stdin with the same session_id until you observe SERVER_STOPPED and exit code 0. Do not edit files or start duplicate servers.`,
			async (calls) => {
				if (browser)
					assert.ok(
						calls.some(
							(call) => call.name === "read_page" && !call.isError && call.result.includes("Count1"),
						),
					)
				const commands = calls.filter((call) => call.name === "exec_command")
				const launches = commands.filter((call) => call.input.cmd === startCommand)
				assert.equal(launches.length, 1)
				assert.ok(launches[0])
				const sessionId = /Process running with session ID (\d+)/.exec(launches[0].result)?.[1]
				assert.ok(sessionId, "The background launch must expose a numeric session ID")
				assert.equal(commands.length, 2, "Only the fixture start and one HTTP check command may run")
				assert.ok(
					commands.some(
						(call) => call.input.cmd === checkCommand && /HTTP behavior passed/.test(call.result),
					),
				)
				const polls = calls.filter((call) => call.name === "write_stdin")
				assert.ok(polls.length > 0, "The model must use write_stdin to observe its command session")
				assert.ok(polls.every((call) => call.input.session_id === Number(sessionId) && !call.isError))
				assert.ok(
					polls.some((call) => call.result.includes("READY ")),
					"The session poll must observe the server readiness output",
				)
				assert.ok(
					polls.some(
						(call) =>
							/Process exited with code 0/.test(call.result) && call.result.includes("SERVER_STOPPED"),
					),
					"The final session poll must observe the owned server exit successfully",
				)
			},
			{
				scope: "Control only commands started in this fixture. These test commands and a graceful shutdown of the fixture server are authorized. Do not load any skills for this explicit contract probe.",
				commands: ["node"],
				requestLimit: 24,
				timeoutMs: 420_000,
			},
		)
	}

	test("waits for a delayed server, checks its response, and observes its exit", async () => {
		await runCommandSession(false)
	})

	test("interacts with the server through the host browser before observing its exit", async () => {
		await withAutomatedBrowserApprovals(() => runCommandSession(true))
	})

	test("composes two skills and retains their identities and workflow constraints", async () => {
		await runLiveCase(
			"skill-composition",
			["skill", "update_plan", "apply_patch", "exec_command"],
			{
				".alpha/skills/harness-prepare/SKILL.md":
					"---\nname: harness-prepare\ndescription: First stage of the harness workflow fixture\n---\nRead seed.txt beside this skill. Create live-skills/prepared.txt with its exact content. Then use harness-finish for the next stage.\n",
				".alpha/skills/harness-prepare/seed.txt": "ALPHA_WORKFLOW_SEED\n",
				".alpha/skills/harness-finish/SKILL.md":
					"---\nname: harness-finish\ndescription: Final stage of the harness workflow fixture\n---\nRead live-skills/prepared.txt and create live-skills/final.txt containing its content followed by FINISHED on a new line. Read the final file before reporting completion.\n",
			},
			"Complete both stages of the harness workflow using harness-prepare then harness-finish. Use update_plan to track preparing the first output, creating the final output, and verifying final.txt; mark every step completed. Follow both skills and use exec_command to read final.txt before finishing.",
			async (calls, _messages, workspace, _answer, task) => {
				assert.deepEqual(
					calls.filter((call) => call.name === "skill").map((call) => call.input.skill),
					["harness-prepare", "harness-finish"],
				)
				const patches = calls.filter((call) => call.name === "apply_patch")
				assert.ok(patches.length > 0, "Skill outputs must be created through apply_patch")
				assert.ok(patches.every((call) => !call.isError))
				assert.ok(
					patches.some((call) => String(call.input.patch).includes("live-skills/prepared.txt")) &&
						patches.some((call) => String(call.input.patch).includes("live-skills/final.txt")),
					"Both skill outputs must be present in successful patch transactions",
				)
				assert.ok(
					calls.some(
						(call) =>
							call.name === "exec_command" &&
							typeof call.input.cmd === "string" &&
							call.input.cmd.replaceAll("\\", "/").includes("live-skills/final.txt") &&
							!call.isError &&
							call.result.includes("ALPHA_WORKFLOW_SEED") &&
							call.result.includes("FINISHED"),
					),
					"The model must read back the final output before completion",
				)
				const plans = calls.filter((call) => call.name === "update_plan")
				assert.ok(plans.length > 0, "The model must maintain the visible task plan")
				assert.ok(Array.isArray(plans.at(-1)?.input.plan))
				assert.ok((plans.at(-1)?.input.plan as unknown[]).every((step) => record(step).status === "completed"))
				assert.equal(plans.at(-1)?.isError, false)
				assert.equal(
					(await fs.readFile(path.join(workspace, "live-skills/final.txt"), "utf8")).replaceAll("\r\n", "\n"),
					"ALPHA_WORKFLOW_SEED\nFINISHED\n",
				)
				assert.equal(task.workContext?.skills.length, 2)
			},
			{
				scope: "Use only the fixture skills and live-skills outputs. Do not modify the skill sources or invoke any other skill.",
				commands: ["node"],
				requestLimit: 24,
				timeoutMs: 420_000,
			},
		)
	})
})
