import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { launchExtensionHost, HostLaunchCancelledError } from "../hostLaunch"
import { LIVE_HOST_STARTUP_TIMEOUT_MS } from "../liveHostProtocol"
import { randomUUID } from "node:crypto"

test("a startup deadline returns unknown close and leaves its owned child alive for inspection", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-unknown-close-"))
	const cancellation = new AbortController()
	let ownedPid: number | undefined
	try {
		await assert.rejects(
			launchExtensionHost(
				{
					launchKind: "development-sidecar",
					vscodeExecutablePath: process.execPath,
					extensionDevelopmentPath: root,
					launchArgs: ["-e", "setInterval(() => {}, 1000)", "--"],
					liveHost: {
						artifactsDir: root,
						expected: { runId: "unknown-close", nonce: randomUUID(), actualVSCodeVersion: "1.122.1" },
					},
				},
				(pid) => {
					ownedPid = pid
					context.mock.timers.tick(LIVE_HOST_STARTUP_TIMEOUT_MS)
				},
				cancellation.signal,
			),
			{
				code: "host-startup-timeout",
			},
		)
		assert.ok(ownedPid)
		assert.doesNotThrow(() => process.kill(ownedPid!, 0))
	} finally {
		// Only this fixture's freshly spawned Node child is cancelled, not a VS Code host.
		cancellation.abort()
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("normal hosts do not retain campaign console pipes; deterministic hosts keep console output", async () => {
	for (const kind of ["development-sidecar", "extension-test"] as const) {
		const options = {
			launchKind: kind,
			vscodeExecutablePath: process.execPath,
			extensionDevelopmentPath: os.tmpdir(),
			...(kind === "extension-test" ? { extensionTestsPath: "unused-tests" } : {}),
			launchArgs: ["-e", "process.stdout.write('HOST_CONSOLE')", "--"],
		}
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				"-e",
				"require(process.argv[1]).launchExtensionHost(JSON.parse(process.argv[2])).then(()=>process.stdout.write('RUNNER_CONSOLE'))",
				path.resolve(__dirname, "../hostLaunch.js"),
				JSON.stringify(options),
			],
			{ timeout: 5000, windowsHide: true },
		)
		assert.equal(stdout.includes("HOST_CONSOLE"), kind === "extension-test")
		assert.ok(stdout.includes("RUNNER_CONSOLE"))
	}
})

test("normal sidecar hosts never receive extensionTestsPath, including undefined", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-sidecar-args-"))
	try {
		const output = path.join(root, "arguments.json")
		const options = {
			launchKind: "development-sidecar",
			vscodeExecutablePath: process.execPath,
			extensionDevelopmentPath: [path.join(root, "alpha"), path.join(root, "sidecar")],
			launchArgs: [
				"-e",
				"require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))",
				"--",
				output,
			],
		} as unknown as Parameters<typeof launchExtensionHost>[0]
		assert.equal(await launchExtensionHost(options), 0)
		const args: string[] = JSON.parse(await fs.readFile(output, "utf8"))
		assert.equal(
			args.some((arg) => arg.startsWith("--extensionTestsPath")),
			false,
		)
		assert.equal(args.filter((arg) => arg.startsWith("--extensionDevelopmentPath=")).length, 2)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("real child preserves paths with spaces and shell metacharacters and reports a failing numeric exit", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha launch %ALPHA_ARG_TEST% & $value "))
	try {
		const output = path.join(root, "received.json")
		const development = path.join(root, "extension development")
		const tests = path.join(root, "tests (integration)")
		const code = await launchExtensionHost({
			vscodeExecutablePath: process.execPath,
			extensionDevelopmentPath: development,
			extensionTestsPath: tests,
			launchArgs: [
				"-e",
				"require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2))); process.exitCode = 7",
				"--",
				output,
				`--user-data-dir=${path.join(root, "user data")}`,
			],
			extensionTestsEnv: { ALPHA_ARG_TEST: "must-not-expand" },
		})
		assert.equal(code, 7)
		const received: string[] = JSON.parse(await fs.readFile(output, "utf8"))
		assert.ok(received.includes(`--extensionDevelopmentPath=${development}`))
		assert.ok(received.includes(`--extensionTestsPath=${tests}`))
		assert.ok(received.includes(`--user-data-dir=${path.join(root, "user data")}`))
		assert.ok(received.every((argument) => !argument.includes("must-not-expand")))
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("a spawn error is a closed host failure without leaking executable contents", async () => {
	await assert.rejects(
		launchExtensionHost({
			vscodeExecutablePath: path.join(os.tmpdir(), "alpha-nonexistent-host", "Code.exe"),
			extensionDevelopmentPath: os.tmpdir(),
			extensionTestsPath: os.tmpdir(),
		}),
		{ code: "host-failed" },
	)
})

test("pre-aborted launches create no child and cancellation waits for the owned child to close", async () => {
	const preAborted = new AbortController()
	preAborted.abort()
	await assert.rejects(
		launchExtensionHost(
			{
				vscodeExecutablePath: process.execPath,
				extensionDevelopmentPath: os.tmpdir(),
				extensionTestsPath: os.tmpdir(),
			},
			() => assert.fail("must not launch"),
			preAborted.signal,
		),
		{ code: "host-cancelled" },
	)

	const control = new AbortController()
	let childPid: number | undefined
	await assert.rejects(
		launchExtensionHost(
			{
				vscodeExecutablePath: process.execPath,
				extensionDevelopmentPath: os.tmpdir(),
				extensionTestsPath: os.tmpdir(),
				launchArgs: ["-e", "setInterval(() => {}, 1000)", "--"],
			},
			(pid) => {
				childPid = pid
				control.abort()
			},
			control.signal,
		),
		(error: unknown) => {
			assert.ok(error instanceof HostLaunchCancelledError)
			return true
		},
	)
	const observedPid = childPid
	assert.ok(observedPid)
	assert.throws(() => process.kill(observedPid, 0), { code: "ESRCH" })
})
