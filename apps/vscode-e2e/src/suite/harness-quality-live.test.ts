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
	test("repairs a failed declared check and persists reusable evidence", async () => {
		const command = "node live-acceptance/check.cjs"
		const oracle =
			"const a=require('node:assert/strict'); const {total}=require('./invoice.cjs'); a.equal(total([]),0); a.equal(total([{cents:200,quantity:0}]),0); a.equal(total([{cents:200,quantity:3},{cents:50,quantity:2}]),700); console.log('3 checks passed');\n"
		const workPlan = {
			objective: "Fix invoice quantities",
			constraints: ["Preserve the oracle"],
			notes: [],
			checks: [
				{
					id: "invoice",
					description: "Empty, zero quantity, and multiple items",
					command,
					cwd: null,
					paths: ["live-acceptance/invoice.cjs", "live-acceptance/check.cjs"],
					reusable: true,
				},
			],
		}
		await runLiveCase(
			"acceptance-repair",
			["update_todo_list", "shell", "apply_patch", "manage_command"],
			{
				"live-acceptance/invoice.cjs":
					"exports.total = items => items.reduce((sum, item) => sum + item.cents, 0)\n",
				"live-acceptance/check.cjs": oracle,
			},
			`Use update_todo_list to record this work_plan: ${JSON.stringify(workPlan)}. Run its command once to demonstrate the existing failure, fix only invoice.cjs using apply_patch, rerun the same check, and finish. Preserve the oracle. Do not run an additional successful verification command when the evidence already passes.`,
			async (calls, _messages, workspace, _answer, task) => {
				const commands = calls.filter((call) => call.name === "shell")
				assert.equal(commands.length, 2, "One failing baseline and one passing repair check")
				assert.ok(commands.every((call) => call.input.command === command))
				assert.equal(task.workContext?.receipts[0]?.status, "passed")
				assert.equal(task.workContext?.plan?.constraints[0], "Preserve the oracle")
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
				commands: ["node"],
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
				? ["shell", "manage_command", "open_browser_page", "click_element", "read_page"]
				: ["shell", "manage_command"],
			{
				[`${directory}/server.cjs`]: `const fs=require('node:fs'); const http=require('node:http'); const server=http.createServer((req,res)=>res.writeHead(200,{'Content-Type':'text/html'}).end('<h1>ALPHA_READY</h1><button onclick="this.textContent=String.fromCharCode(67,111,117,110,116,49)">Count0</button>')); setTimeout(()=>server.listen(0,'127.0.0.1',()=>{const url='http://127.0.0.1:'+server.address().port; fs.writeFileSync('${directory}/url.txt',url); console.log('READY '+url)}),1800);\n`,
				[`${directory}/check.cjs`]: `const fs=require('node:fs'); const assert=require('node:assert/strict'); fetch(fs.readFileSync('${directory}/url.txt','utf8')).then(r=>r.text()).then(body=>{assert.ok(body.includes('ALPHA_READY')); console.log('HTTP behavior passed')}).catch(e=>{console.error(e);process.exitCode=1});\n`,
			},
			`Start ${startCommand} using shell with timeout 1. Use manage_command with its returned execution_id to wait until READY is observed. Run ${checkCommand} once. ${browser ? "Open the observed URL with open_browser_page, click the Count0 button, and read_page to verify Count1. " : ""}Then stop the original server using manage_command and observe its terminal outcome. Do not edit files, start duplicate servers, or kill by PID.`,
			async (calls) => {
				if (browser)
					assert.ok(
						calls.some(
							(call) => call.name === "read_page" && !call.isError && call.result.includes("Count1"),
						),
					)
				const launches = calls.filter((call) => call.name === "shell" && call.input.command === startCommand)
				assert.equal(launches.length, 1)
				assert.ok(launches[0])
				const executionId = /execution_id: ([\w:-]+)\./.exec(launches[0].result)?.[1]
				assert.ok(executionId, "The background launch must expose its execution ID")
				const controls = calls.filter((call) => call.name === "manage_command")
				assert.ok(controls.every((call) => call.input.execution_id === executionId && !call.isError))
				assert.ok(
					calls.some(
						(call) => call.name === "manage_command" && call.input.action === "wait" && !call.isError,
					),
				)
				assert.ok(
					controls.some((call) => {
						const line = call.result.split("\n")[0]
						assert.ok(line)
						const outcome = record(JSON.parse(line))
						return outcome.status !== "running" && typeof outcome.exit_code === "number"
					}),
					"A stop request alone is not proof that the original server exited",
				)
				assert.ok(
					calls.some(
						(call) => call.name === "manage_command" && call.input.action === "stop" && !call.isError,
					),
				)
				assert.ok(calls.some((call) => call.name === "shell" && call.result.includes("HTTP behavior passed")))
			},
			{
				scope: "Control only commands started in this fixture. These test commands and stopping your own server are authorized. Do not load any skills for this explicit contract probe.",
				commands: ["node", "stop"],
				requestLimit: 24,
				timeoutMs: 420_000,
			},
		)
	}

	test("waits for a delayed server, checks its response, and stops its owned command", async () => {
		await runCommandSession(false)
	})

	test("interacts with the server through the host browser before stopping it", async () => {
		await withAutomatedBrowserApprovals(() => runCommandSession(true))
	})

	test("composes two skills and retains their identities and workflow constraints", async () => {
		await runLiveCase(
			"skill-composition",
			["skill", "update_todo_list", "write_to_file"],
			{
				".alpha/skills/harness-prepare/SKILL.md":
					"---\nname: harness-prepare\ndescription: First stage of the harness workflow fixture\n---\nRead seed.txt beside this skill. Create live-skills/prepared.txt with its exact content. Then use harness-finish for the next stage.\n",
				".alpha/skills/harness-prepare/seed.txt": "ALPHA_WORKFLOW_SEED\n",
				".alpha/skills/harness-finish/SKILL.md":
					"---\nname: harness-finish\ndescription: Final stage of the harness workflow fixture\n---\nRead live-skills/prepared.txt and create live-skills/final.txt containing its content followed by FINISHED on a new line. Read the final file before reporting completion.\n",
			},
			"Complete both stages of the harness workflow using harness-prepare then harness-finish. Record the objective and constraint 'Preserve both skill sources' through update_todo_list work_plan, with no command checks. Keep the resource and output paths in its notes. Follow both skills and finish only after checking final.txt.",
			async (calls, _messages, workspace, _answer, task) => {
				assert.deepEqual(
					calls.filter((call) => call.name === "skill").map((call) => call.input.skill),
					["harness-prepare", "harness-finish"],
				)
				assert.equal(
					(await fs.readFile(path.join(workspace, "live-skills/final.txt"), "utf8")).replaceAll("\r\n", "\n"),
					"ALPHA_WORKFLOW_SEED\nFINISHED\n",
				)
				assert.equal(task.workContext?.skills.length, 2)
				assert.ok(task.workContext?.plan?.constraints.includes("Preserve both skill sources"))
			},
			{
				scope: "Use only the fixture skills and live-skills outputs. Do not modify the skill sources or invoke any other skill.",
				requestLimit: 24,
				timeoutMs: 420_000,
			},
		)
	})
})
