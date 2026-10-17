import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { runInNewContext } from "node:vm"

import { parseArguments, prepareRun, runPortableRepro } from "./run-portable-alpha-repro.mjs"
import { writeReceipt } from "../apps/vscode-e2e/portable-automation/receipt.js"

const absolute = (name) => path.join(os.tmpdir(), name)

async function activatePortableTask(task) {
	const source = await fs.readFile(
		new URL("../apps/vscode-e2e/portable-automation/extension.js", import.meta.url),
		"utf8",
	)
	const operations = []
	const job = {
		runId: "fixture-run",
		mode: "task",
		workspace: absolute("alpha-portable-fixture"),
		promptFile: absolute("alpha-portable-prompt.md"),
		timeoutMs: 60_000,
	}
	let now = 0
	class FixtureDate extends Date {
		static now() {
			return now
		}
	}
	const result = Promise.withResolvers()
	const provider = {
		getState: async () => ({}),
		getLiveTask: () => task,
		setValues: async () => operations.push("restore-settings"),
		showTaskWithId: async () => operations.push("reopen"),
		startBlankTask: async () => operations.push("blank-chat"),
	}
	const configuration = { apiProvider: "vscode-lm", vsCodeLmModelSelector: { id: "fixture-model" } }
	const api = {
		sidebarProvider: provider,
		getConfiguration: () => configuration,
		startNewTask: async () => "fixture-task",
		isTaskInHistory: async () => true,
	}
	const vscode = {
		version: "1.125.0",
		extensions: {
			getExtension: () => ({
				packageJSON: { version: "fixture" },
				extensionPath: absolute("alpha"),
				activate: async () => api,
			}),
		},
		workspace: {
			workspaceFolders: [{ uri: { fsPath: job.workspace } }],
			textDocuments: [],
			getConfiguration: () => ({ inspect: () => undefined }),
		},
		commands: { executeCommand: async (command) => operations.push(command) },
		lm: { selectChatModels: async () => [{ id: "fixture-model", family: "fixture", vendor: "copilot" }] },
	}
	const fileSystem = {
		readFile: async (file) => {
			if (file.endsWith("run.json")) return JSON.stringify(job)
			if (file === job.promptFile) return "Complete the fixture task."
			if (file.endsWith("extension.js")) return Buffer.from("fixture bundle")
			throw new Error(`Unexpected sidecar read: ${file}`)
		},
		writeFile: async () => {},
		appendFile: async () => {},
	}
	const dependencies = {
		"node:fs/promises": fileSystem,
		"node:path": path,
		"node:crypto": { createHash },
		vscode,
		"./receipt": {
			writeReceipt: async (file, value) => {
				if (file.endsWith("task-result.json")) result.resolve(structuredClone(value))
			},
		},
	}
	const sandbox = {
		exports: {},
		require: (name) => {
			if (!(name in dependencies)) throw new Error(`Unexpected sidecar dependency: ${name}`)
			return dependencies[name]
		},
		Date: FixtureDate,
		performance: { now: () => now },
		console: { error: (error) => result.reject(new Error(String(error))) },
		setTimeout: (callback, delay) => {
			now += delay
			queueMicrotask(callback)
			return 0
		},
		clearTimeout: () => {},
	}
	runInNewContext(source, sandbox, { filename: "portable-automation/extension.js" })
	await sandbox.exports.activate({ extensionPath: absolute("alpha-portable-sidecar") })
	return { result: result.promise, operations }
}

function completedPortableTask(overrides = {}) {
	return {
		isCompleted: () => true,
		clineMessages: [{ type: "say", say: "completion_result", text: "Done", partial: false }],
		waitForTermination: async () => {},
		abortTask: async () => {},
		...overrides,
	}
}

test("portable sidecar accepts canonical completion without a completion ask", async () => {
	let aborted = 0
	const fixture = await activatePortableTask(completedPortableTask({ abortTask: async () => aborted++ }))
	const result = await fixture.result
	assert.equal(result.status, "completed")
	assert.equal(result.error, undefined)
	assert.equal(result.messageCount, 1)
	assert.equal(aborted, 0)
	assert.ok(fixture.operations.includes("alpha.plusButtonClicked"))
})

test("portable sidecar joins completion persistence before navigating", { timeout: 5_000 }, async () => {
	const termination = Promise.withResolvers()
	const waiting = Promise.withResolvers()
	const fixture = await activatePortableTask(
		completedPortableTask({
			waitForTermination: () => {
				waiting.resolve()
				return termination.promise
			},
		}),
	)
	try {
		assert.equal(
			await Promise.race([waiting.promise.then(() => "waiting"), fixture.result.then(() => "finished")]),
			"waiting",
		)
		assert.equal(fixture.operations.includes("alpha.plusButtonClicked"), false)
	} finally {
		termination.resolve()
	}
	assert.equal((await fixture.result).status, "completed")
})

test("portable sidecar rejects a completion ask without authoritative completion", async () => {
	let aborted = 0
	const fixture = await activatePortableTask(
		completedPortableTask({
			isCompleted: () => false,
			taskAsk: { type: "ask", ask: "completion_result" },
			abortTask: async () => aborted++,
		}),
	)
	const result = await fixture.result
	assert.equal(result.status, "failed")
	assert.match(result.error, /did not reach completion/)
	assert.equal(aborted, 1)
	assert.equal(fixture.operations.includes("alpha.plusButtonClicked"), false)
})

test("portable sidecar requires a complete visible final response", async () => {
	for (const clineMessages of [[], [{ type: "say", say: "completion_result", text: "Done", partial: true }]]) {
		const fixture = await activatePortableTask(completedPortableTask({ clineMessages }))
		const result = await fixture.result
		assert.equal(result.status, "failed")
		assert.match(result.error, /final response/)
		assert.equal(fixture.operations.includes("alpha.plusButtonClicked"), false)
	}
})

test("portable receipts are invisible until complete and cannot replace an existing result", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-portable-runner-"))
	let resumeWrite
	const writable = new Promise((resolve) => {
		resumeWrite = resolve
	})
	let opened
	const started = new Promise((resolve) => {
		opened = resolve
	})
	const target = path.join(root, "result.json")
	const value = { runId: "atomic-run", hostVersion: "1.125.0", status: "completed" }
	const publication = writeReceipt(target, value, {
		...fs,
		writeFile: async (file, bytes, options) => {
			const handle = await fs.open(file, options.flag, options.mode)
			opened()
			try {
				await writable
				await handle.writeFile(bytes)
			} finally {
				await handle.close()
			}
		},
	})
	try {
		await started
		await assert.rejects(fs.readFile(target, "utf8"), { code: "ENOENT" })
		resumeWrite()
		await publication
		assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), value)
		await assert.rejects(writeReceipt(target, { ...value, status: "failed" }), { code: "EEXIST" })
		assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), value)
		assert.deepEqual(await fs.readdir(root), ["result.json"])
	} finally {
		resumeWrite()
		await publication
		const actual = await fs.realpath(root)
		assert.equal(path.dirname(actual), await fs.realpath(os.tmpdir()))
		assert.match(path.basename(actual), /^alpha-portable-runner-/)
		await fs.rm(actual, { recursive: true, force: true })
	}
})

test("portable runner requires explicit, bounded run inputs", () => {
	assert.throws(() => parseArguments(["--host", absolute("Code.exe")]), /Missing --workspace/)
	assert.throws(
		() =>
			parseArguments([
				"--host",
				absolute("Code.exe"),
				"--workspace",
				absolute("workspace"),
				"--artifacts-dir",
				absolute("artifacts"),
				"--run-id",
				"valid",
				"--mode",
				"unknown",
			]),
		/Mode must be task or probe/,
	)
	assert.throws(
		() =>
			parseArguments([
				"--host",
				absolute("Code.exe"),
				"--workspace",
				absolute("workspace"),
				"--artifacts-dir",
				absolute("artifacts"),
				"--run-id",
				"../escape",
			]),
		/Run ID/,
	)
	assert.throws(
		() =>
			parseArguments([
				"--host",
				absolute("Code.exe"),
				"--workspace",
				absolute("workspace"),
				"--artifacts-dir",
				absolute("artifacts"),
				"--run-id",
				"valid",
				"--protected-writes",
				"maybe",
			]),
		/Protected writes must be allow or deny/,
	)
	assert.throws(
		() =>
			parseArguments([
				"--host",
				absolute("Code.exe"),
				"--workspace",
				absolute("workspace"),
				"--artifacts-dir",
				absolute("artifacts"),
				"--run-id",
				"valid",
				"--browser-approvals",
				"maybe",
			]),
		/Browser approvals must be allow or deny/,
	)
})

test("portable runner creates an isolated sidecar and validates a correlated receipt", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-portable-runner-"))
	try {
		const hostDirectory = path.join(root, "host")
		const workspace = path.join(root, "workspace")
		const artifactsDir = path.join(root, "artifacts")
		await fs.mkdir(path.join(hostDirectory, "data"), { recursive: true })
		await fs.mkdir(workspace)
		const host = path.join(hostDirectory, "Code.exe")
		await fs.writeFile(host, "stub")
		await fs.writeFile(path.join(workspace, "SPEC.md"), "# Fixture\n")
		const options = { host, workspace, artifactsDir, runId: "run-1", timeoutMs: 60_000 }
		const realWorkspace = await fs.realpath(workspace)
		await assert.rejects(
			prepareRun({ ...options, artifactsDir: path.join(workspace, "artifacts"), runId: "unsafe" }),
			/separate from the host, workspace, and repository/,
		)
		const prepared = await prepareRun(options)
		assert.equal((await fs.stat(path.join(prepared.sidecar, "extension.js"))).isFile(), true)
		assert.equal((await fs.stat(path.join(prepared.sidecar, "receipt.js"))).isFile(), true)
		const job = JSON.parse(await fs.readFile(path.join(prepared.sidecar, "run.json"), "utf8"))
		assert.equal(job.promptFile, await fs.realpath(path.join(workspace, "SPEC.md")))
		assert.equal(job.allowProtectedWrites, false)
		assert.equal(job.allowBrowserOpen, false)
		const genericPrompt = path.join(root, "project-task.md")
		await fs.writeFile(genericPrompt, "Review the project and run its tests.\n")
		const generic = await prepareRun({
			...options,
			runId: "generic-project",
			promptFile: genericPrompt,
			allowProtectedWrites: true,
			allowBrowserOpen: true,
		})
		const genericJob = JSON.parse(await fs.readFile(path.join(generic.sidecar, "run.json"), "utf8"))
		assert.equal(genericJob.promptFile, await fs.realpath(genericPrompt))
		assert.equal(genericJob.allowProtectedWrites, true)
		assert.equal(genericJob.allowBrowserOpen, true)
		const alphaDevelopmentPath = path.join(root, "alpha-development")
		await fs.mkdir(path.join(alphaDevelopmentPath, "dist"), { recursive: true })
		await fs.writeFile(
			path.join(alphaDevelopmentPath, "package.json"),
			JSON.stringify({ publisher: "AlphaInc", name: "alpha" }),
		)
		await fs.writeFile(path.join(alphaDevelopmentPath, "dist", "extension.js"), "module.exports = {}")
		const realAlphaDevelopmentPath = await fs.realpath(alphaDevelopmentPath)
		await assert.rejects(prepareRun(options), { code: "EEXIST" })
		const guardedPhases = []
		const run = await runPortableRepro(
			{ ...options, runId: "run-2" },
			{
				launch: (_executable, args) => {
					assert.equal(args[0], `--folder-uri=${pathToFileURL(realWorkspace).href}`)
					assert.equal(args[1], "--new-window")
					const sidecar = args[2].slice("--extensionDevelopmentPath=".length)
					void writeReceipt(path.join(sidecar, "run-2-task-result.json"), {
						runId: "run-2",
						hostVersion: "1.125.0",
						status: "completed",
						taskId: "task-1",
						workspaceAddedByAutomation: true,
						dirtyEditorsAtFinish: 0,
					})
					return { unref() {} }
				},
				windowGuard: async (phase, preparedRun, result) => {
					assert.equal(preparedRun.host, await fs.realpath(host))
					guardedPhases.push([phase, result?.workspaceAddedByAutomation, result?.dirtyEditorsAtFinish])
					return { status: phase === "close" ? "closed" : "snapshotted" }
				},
				sleep: async () => {},
			},
		)
		assert.equal(run.result.taskId, "task-1")
		assert.deepEqual(guardedPhases, [
			["snapshot", undefined, undefined],
			["close", true, 0],
		])
		assert.equal(run.windowCleanup.status, "closed")
		assert.equal(
			JSON.parse(await fs.readFile(path.join(run.runDirectory, "window-cleanup.json"), "utf8")).status,
			"closed",
		)
		const probe = await runPortableRepro(
			{ ...options, runId: "run-3", mode: "probe" },
			{
				launch: (_executable, args) => {
					assert.equal(args[0], `--folder-uri=${pathToFileURL(realWorkspace).href}`)
					assert.equal(args[1], "--new-window")
					const sidecar = args[2].slice("--extensionDevelopmentPath=".length)
					void writeReceipt(path.join(sidecar, "run-3-probe-result.json"), {
						runId: "run-3",
						hostVersion: "1.125.0",
						stage: "ready",
					})
					return { unref() {} }
				},
				sleep: async () => {},
			},
		)
		assert.equal(probe.result.stage, "ready")
		const overlay = await runPortableRepro(
			{ ...options, runId: "run-4", mode: "probe", alphaDevelopmentPath },
			{
				launch: (_executable, args) => {
					assert.equal(args[2], `--extensionDevelopmentPath=${realAlphaDevelopmentPath}`)
					const sidecar = args[3].slice("--extensionDevelopmentPath=".length)
					void writeReceipt(path.join(sidecar, "run-4-probe-result.json"), {
						runId: "run-4",
						hostVersion: "1.125.0",
						stage: "ready",
					})
					return { unref() {} }
				},
				sleep: async () => {},
			},
		)
		assert.equal(overlay.result.stage, "ready")
		for (const [runId, bytes, expected] of [
			["malformed", "{", SyntaxError],
			[
				"wrong-run",
				JSON.stringify({ runId: "another-run", hostVersion: "1.125.0", stage: "ready" }),
				/receipt identity/,
			],
			[
				"wrong-host",
				JSON.stringify({ runId: "wrong-host", hostVersion: "1.140.0", stage: "ready" }),
				/receipt identity/,
			],
		]) {
			let receiptPath
			await assert.rejects(
				runPortableRepro(
					{ ...options, runId, mode: "probe" },
					{
						launch: (_executable, args) => {
							receiptPath = path.join(
								args[2].slice("--extensionDevelopmentPath=".length),
								`${runId}-probe-result.json`,
							)
							return { unref() {} }
						},
						sleep: () => fs.writeFile(receiptPath, bytes, { flag: "wx" }),
					},
				),
				expected,
			)
		}
	} finally {
		const actual = await fs.realpath(root)
		const temporaryRoot = await fs.realpath(os.tmpdir())
		assert.equal(path.dirname(actual), temporaryRoot)
		assert.match(path.basename(actual), /^alpha-portable-runner-/)
		await fs.rm(actual, { recursive: true, force: true })
	}
})
