import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

import { parseArguments, prepareRun, runPortableRepro } from "./run-portable-alpha-repro.mjs"

const absolute = (name) => path.join(os.tmpdir(), name)

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
					void fs.writeFile(
						path.join(sidecar, "run-2-task-result.json"),
						JSON.stringify({
							runId: "run-2",
							hostVersion: "1.122.1",
							status: "completed",
							taskId: "task-1",
							workspaceAddedByAutomation: true,
							dirtyEditorsAtFinish: 0,
						}),
					)
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
					void fs.writeFile(
						path.join(sidecar, "run-3-probe-result.json"),
						JSON.stringify({ runId: "run-3", hostVersion: "1.122.1", stage: "ready" }),
					)
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
					void fs.writeFile(
						path.join(sidecar, "run-4-probe-result.json"),
						JSON.stringify({ runId: "run-4", hostVersion: "1.122.1", stage: "ready" }),
					)
					return { unref() {} }
				},
				sleep: async () => {},
			},
		)
		assert.equal(overlay.result.stage, "ready")
	} finally {
		const actual = await fs.realpath(root)
		const temporaryRoot = await fs.realpath(os.tmpdir())
		assert.equal(path.dirname(actual), temporaryRoot)
		assert.match(path.basename(actual), /^alpha-portable-runner-/)
		await fs.rm(actual, { recursive: true, force: true })
	}
})
