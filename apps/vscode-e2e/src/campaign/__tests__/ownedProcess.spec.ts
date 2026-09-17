import { ChildProcess, spawn, type ChildProcess as ChildProcessHandle } from "node:child_process"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { watch } from "node:fs"
import * as assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import * as os from "node:os"
import * as path from "node:path"

import { runOwnedProcess, type OwnedProcessCommand } from "../ownedProcess"

const temporaryRoots: string[] = []
const disposableChildren: ChildProcessHandle[] = []

afterEach(async () => {
	for (const child of disposableChildren.splice(0)) await disposeChild(child)
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test("runs a directly-spawned child and captures both output streams", async () => {
	const root = await makeRoot()
	const result = await runOwnedProcess(
		nodeCommand(root, 'process.stdout.write("stdout"); process.stderr.write("stderr")'),
		{},
	)

	assert.deepEqual(result, {
		exitCode: 0,
		signal: null,
		stdout: "stdout",
		stderr: "stderr",
		outputTruncated: false,
		cleanupVerified: process.platform !== "win32",
	})
})

test("bounds each output stream in bytes while continuing to drain the child", async () => {
	const root = await makeRoot()
	const result = await runOwnedProcess(
		nodeCommand(root, 'process.stdout.write("😀x"); process.stderr.write("ééé")'),
		{ maxOutputBytes: 4 },
	)

	assert.equal(result.stdout, "😀")
	assert.equal(result.stderr, "éé")
	assert.equal(Buffer.byteLength(result.stdout), 4)
	assert.equal(Buffer.byteLength(result.stderr), 4)
	assert.equal(result.outputTruncated, true)
	assert.equal(result.cleanupVerified, process.platform !== "win32")
})

test("rejects without spawning when already aborted", async () => {
	const root = await makeRoot()
	const readyFile = path.join(root, "must-not-start")
	const signal = AbortSignal.abort()

	await assert.rejects(
		() =>
			runOwnedProcess(
				nodeCommand(root, `require("node:fs").writeFileSync(${JSON.stringify(readyFile)}, "started")`),
				{ signal },
			),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	)
	await assert.rejects(() => access(readyFile), { code: "ENOENT" })
})

test("aborts a live child, escalates after the grace period, and verifies cleanup", async () => {
	const root = await makeRoot()
	const readyFile = path.join(root, "ready")
	const pidFile = path.join(root, "pid")
	const descendantPidFile = path.join(root, "descendant-pid")
	const controller = new AbortController()
	const running = runOwnedProcess(
		nodeCommand(
			root,
			[
				'const fs = require("node:fs")',
				'const { spawn } = require("node:child_process")',
				'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { detached: false, stdio: "ignore" })',
				`fs.writeFileSync(${JSON.stringify(descendantPidFile)}, String(descendant.pid))`,
				`fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
				`fs.writeFileSync(${JSON.stringify(readyFile)}, "ready")`,
				'process.on("SIGTERM", () => {})',
				"setInterval(() => {}, 1_000)",
			].join(";"),
		),
		{ signal: controller.signal, killGraceMs: 25 },
	)

	await waitForFile(readyFile)
	controller.abort()
	const result = await running

	if (process.platform !== "win32") assert.equal(result.exitCode, null)
	assert.equal(result.cleanupVerified, true)
	if (process.platform === "win32") assert.equal(result.signal, null)
	else assert.equal(result.signal, "SIGKILL")
	assert.equal(await isLive(Number(await readFile(pidFile, "utf8"))), false)
	assert.equal(await isLive(Number(await readFile(descendantPidFile, "utf8"))), false)
})

test("does not terminate an unrelated disposable child", async () => {
	const root = await makeRoot()
	const unrelatedReady = path.join(root, "unrelated-ready")
	const unrelated = spawn(
		process.execPath,
		[
			"-e",
			[
				'const fs = require("node:fs")',
				`fs.writeFileSync(${JSON.stringify(unrelatedReady)}, "ready")`,
				"setInterval(() => {}, 1_000)",
			].join(";"),
		],
		{
			cwd: root,
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "ignore", "ignore"],
		},
	)
	disposableChildren.push(unrelated)

	try {
		await waitForFile(unrelatedReady)
		const controller = new AbortController()
		const ownedReady = path.join(root, "owned-ready")
		const running = runOwnedProcess(
			nodeCommand(
				root,
				[
					'const fs = require("node:fs")',
					`fs.writeFileSync(${JSON.stringify(ownedReady)}, "ready")`,
					'process.on("SIGTERM", () => {})',
					"setInterval(() => {}, 1_000)",
				].join(";"),
			),
			{ signal: controller.signal, killGraceMs: 25 },
		)
		await waitForFile(ownedReady)
		controller.abort()
		const result = await running

		assert.equal(result.cleanupVerified, true)
		assert.equal(await isLive(unrelated.pid), true)
	} finally {
		await disposeChild(unrelated)
		const index = disposableChildren.indexOf(unrelated)
		if (index >= 0) disposableChildren.splice(index, 1)
	}
})

test("marks cleanup unverifiable when a root exits with a live descendant", async () => {
	const root = await makeRoot()
	const readyFile = path.join(root, "root-ready")
	const pidFile = path.join(root, "descendant-pid")
	const descendantSource = ["setInterval(() => {}, 1_000)"].join(";")
	const running = runOwnedProcess(
		nodeCommand(
			root,
			[
				'const fs = require("node:fs")',
				'const { spawn } = require("node:child_process")',
				`const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { cwd: ${JSON.stringify(root)}, detached: ${process.platform === "win32"}, stdio: "ignore" })`,
				`fs.writeFileSync(${JSON.stringify(pidFile)}, String(descendant.pid))`,
				`fs.writeFileSync(${JSON.stringify(readyFile)}, "ready")`,
				"process.exit(0)",
			].join(";"),
		),
		{},
	)

	await waitForFile(readyFile)
	const result = await running
	const descendantPid = Number(await readFile(pidFile, "utf8"))

	try {
		assert.equal(result.cleanupVerified, false)
		assert.equal(await isLive(descendantPid), true)
	} finally {
		await terminateTestPid(descendantPid)
	}
})

test(
	"reports failed process-group termination as unverifiable after the owned-root fallback",
	{ skip: process.platform === "win32" },
	async () => {
		const root = await makeRoot()
		const readyFile = path.join(root, "ready")
		const controller = new AbortController()
		const originalKill = process.kill
		process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
			if (pid < 0 && signal !== 0) throw Object.assign(new Error("group termination denied"), { code: "EPERM" })
			return originalKill.call(process, pid, signal)
		}) as typeof process.kill

		try {
			const running = runOwnedProcess(
				nodeCommand(
					root,
					[
						'const fs = require("node:fs")',
						`fs.writeFileSync(${JSON.stringify(readyFile)}, "ready")`,
						'process.on("SIGTERM", () => {})',
						"setInterval(() => {}, 1_000)",
					].join(";"),
				),
				{ signal: controller.signal, killGraceMs: 25 },
			)
			await waitForFile(readyFile)
			controller.abort()
			const result = await running

			assert.equal(result.cleanupVerified, false)
			assert.equal(result.signal, "SIGKILL")
		} finally {
			process.kill = originalKill
		}
	},
)

test(
	"bounds an unkillable termination failure and exposes cleanupVerified=false",
	{ skip: process.platform === "win32" },
	async () => {
		const root = await makeRoot()
		const readyFile = path.join(root, "ready")
		const pidFile = path.join(root, "pid")
		const controller = new AbortController()
		const originalKill = process.kill
		const originalChildKill = ChildProcess.prototype.kill
		process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
			if (pid < 0 && signal !== 0) throw Object.assign(new Error("group termination denied"), { code: "EPERM" })
			return originalKill.call(process, pid, signal)
		}) as typeof process.kill
		ChildProcess.prototype.kill = (() => false) as typeof originalChildKill

		try {
			const running = runOwnedProcess(
				nodeCommand(
					root,
					[
						'const fs = require("node:fs")',
						`fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
						`fs.writeFileSync(${JSON.stringify(readyFile)}, "ready")`,
						'process.on("SIGTERM", () => {})',
						"setInterval(() => {}, 1_000)",
					].join(";"),
				),
				{ signal: controller.signal, killGraceMs: 25 },
			)
			await waitForFile(readyFile)
			controller.abort()
			await assert.rejects(
				running,
				(error: unknown) =>
					error instanceof Error &&
					error.name === "OwnedProcessCleanupError" &&
					(error as Error & { cleanupVerified?: boolean }).cleanupVerified === false,
			)
		} finally {
			ChildProcess.prototype.kill = originalChildKill
			process.kill = originalKill
			const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"))
			await terminateTestPid(pid)
			await waitUntilDead(pid)
		}
	},
)

test("removes the abort listener after a normal close", async () => {
	const root = await makeRoot()
	const controller = new AbortController()
	const result = await runOwnedProcess(nodeCommand(root, 'process.stdout.write("done")'), {
		signal: controller.signal,
	})

	controller.abort()
	assert.equal(result.cleanupVerified, process.platform !== "win32")
	assert.equal(result.stdout, "done")
})

test("waits for a launch error and rejects it", async () => {
	const root = await makeRoot()
	const command: OwnedProcessCommand = {
		executable: path.join(root, "does-not-exist"),
		args: [],
		cwd: root,
	}

	await assert.rejects(
		() => runOwnedProcess(command, {}),
		(error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT",
	)
})

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "alpha-owned-process-"))
	temporaryRoots.push(root)
	return root
}

function nodeCommand(root: string, source: string): OwnedProcessCommand {
	return { executable: process.execPath, args: ["-e", source], cwd: root }
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
	try {
		await access(filePath)
		return
	} catch {
		// Install the watcher after the first check, then check again below to
		// close the create-before-watch race without polling or sleeping.
	}

	await new Promise<void>((resolve, reject) => {
		let settled = false
		const finish = (error?: unknown) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			watcher.close()
			if (error) reject(error)
			else resolve()
		}
		const watcher = watch(path.dirname(filePath), (_event, filename) => {
			if (filename === null || path.basename(String(filename)) !== path.basename(filePath)) return
			void access(filePath)
				.then(finish)
				.catch(() => undefined)
		})
		const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${filePath}`)), timeoutMs)

		void access(filePath)
			.then(() => finish())
			.catch(() => undefined)
	})
}

async function disposeChild(child: ChildProcessHandle): Promise<void> {
	if (child.exitCode === null && child.signalCode === null) {
		try {
			child.kill()
		} catch {
			// The child may have exited between the state check and kill request.
		}
	}
	await waitForClose(child)
}

async function waitForClose(child: ChildProcessHandle): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return
	await new Promise<void>((resolve) => child.once("close", () => resolve()))
}

async function waitUntilDead(pid: number, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (await isLive(pid)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for PID ${pid} to exit`)
		await new Promise<void>((resolve) => setTimeout(resolve, 10))
	}
}

async function isLive(pid: number | undefined): Promise<boolean> {
	if (!pid || !Number.isSafeInteger(pid)) return false
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH"
	}
}

async function terminateTestPid(pid: number): Promise<void> {
	if (!Number.isSafeInteger(pid) || pid <= 0) return
	if (process.platform === "win32") {
		const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "ignore", "ignore"],
		})
		await waitForClose(killer)
		return
	}
	try {
		process.kill(pid, "SIGKILL")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
	}
}
