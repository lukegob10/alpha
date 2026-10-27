import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import childProcess, { ChildProcess, execFile, type SpawnOptions } from "node:child_process"
import { promisify } from "node:util"
import { launchExtensionHost, HostLaunchCancelledError, HostLaunchFailureError } from "../hostLaunch"
import { LIVE_HOST_STARTUP_TIMEOUT_MS } from "../liveHostProtocol"
import { randomUUID } from "node:crypto"

test("user-home isolation changes only GUI children for both launch kinds", async (context) => {
	for (const platform of ["win32", "linux"] as const) {
		for (const launchKind of ["extension-test", "development-sidecar"] as const) {
			await context.test(`${platform}/${launchKind}`, async (fixture) => {
				const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!
				Object.defineProperty(process, "platform", { value: platform })
				fixture.after(() => Object.defineProperty(process, "platform", platformDescriptor))
				const previousOverride = process.env.ALPHA_E2E_USER_HOME
				fixture.after(() => {
					if (previousOverride === undefined) delete process.env.ALPHA_E2E_USER_HOME
					else process.env.ALPHA_E2E_USER_HOME = previousOverride
				})
				const isolatedHome = path.resolve(os.tmpdir(), "alpha-owned-host-home")
				process.env.ALPHA_E2E_USER_HOME = isolatedHome
				const homeKey = platform === "win32" ? "USERPROFILE" : "HOME"
				const otherHomeKey = platform === "win32" ? "HOME" : "USERPROFILE"
				const runnerHome = process.env[homeKey]
				const runnerAlphaHome = process.env.ALPHA_HOME
				const extensionTestsEnv = {
					ALPHA_HOME: "fixture-memory-home",
					ALPHA_HOST_ENV_FIXTURE: "preserved",
					[otherHomeKey]: "fixture-other-home",
				}
				const child = new ChildProcess()
				let spawned: SpawnOptions | undefined
				fixture.mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
					spawned = args[2]
					return child
				})
				const options = {
					vscodeExecutablePath: process.execPath,
					extensionDevelopmentPath: process.cwd(),
					extensionTestsEnv,
				}
				const pending = launchExtensionHost(
					launchKind === "extension-test"
						? { ...options, launchKind, extensionTestsPath: "fixture-tests" }
						: { ...options, launchKind },
				)
				child.emit("close", 0, null)
				assert.equal(await pending, 0)
				assert.equal(spawned?.env?.[homeKey], isolatedHome)
				assert.equal(spawned?.env?.[otherHomeKey], "fixture-other-home")
				assert.equal(spawned?.env?.ALPHA_HOME, "fixture-memory-home")
				assert.equal(spawned?.env?.ALPHA_HOST_ENV_FIXTURE, "preserved")
				assert.equal(process.env[homeKey], runnerHome, "The runner must keep its toolchain home")
				assert.equal(process.env.ALPHA_HOME, runnerAlphaHome)
				assert.equal(extensionTestsEnv[homeKey], undefined, "Caller environment options must not be mutated")
			})
		}
	}
})

test("unset user-home isolation preserves explicit child home values", async (context) => {
	const child = new ChildProcess()
	let spawned: SpawnOptions | undefined
	context.mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
		spawned = args[2]
		return child
	})
	const pending = launchExtensionHost({
		vscodeExecutablePath: process.execPath,
		extensionDevelopmentPath: process.cwd(),
		extensionTestsPath: "fixture-tests",
		extensionTestsEnv: {
			ALPHA_E2E_USER_HOME: undefined,
			USERPROFILE: "fixture-user-profile",
			HOME: "fixture-home",
		},
	})
	child.emit("close", 0, null)
	assert.equal(await pending, 0)
	assert.equal(spawned?.env?.USERPROFILE, "fixture-user-profile")
	assert.equal(spawned?.env?.HOME, "fixture-home")
})

test("invalid user-home isolation paths fail before launching either host kind", async (context) => {
	const spawning = context.mock.method(childProcess, "spawn", () => assert.fail("Invalid home must not launch"))
	for (const launchKind of ["extension-test", "development-sidecar"] as const) {
		for (const home of ["relative-home", "", `${path.resolve(os.tmpdir())}\0invalid`]) {
			const options = {
				vscodeExecutablePath: process.execPath,
				extensionDevelopmentPath: process.cwd(),
				extensionTestsEnv: { ALPHA_E2E_USER_HOME: home },
			}
			await assert.rejects(
				launchExtensionHost(
					launchKind === "extension-test"
						? { ...options, launchKind, extensionTestsPath: "fixture-tests" }
						: { ...options, launchKind },
				),
				{ code: "invalid-options" },
			)
		}
	}
	assert.equal(spawning.mock.callCount(), 0)
})

test("host cancellation joins its still-live POSIX group after the root closes", async (context) => {
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!
	Object.defineProperty(process, "platform", { value: "linux" })
	context.after(() => Object.defineProperty(process, "platform", originalPlatform))
	context.mock.timers.enable({ apis: ["Date", "setTimeout"] })
	const child = new ChildProcess()
	Object.defineProperty(child, "pid", { value: 12345 })
	context.mock.method(childProcess, "spawn", () => child)
	context.mock.method(child, "kill", () => assert.fail("the closed root must not be killed"))
	let groupStopped = false
	const signals: (NodeJS.Signals | number | undefined)[] = []
	context.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
		assert.equal(pid, -12345)
		if (signal !== 0) signals.push(signal)
		if (groupStopped) throw Object.assign(new Error("gone"), { code: "ESRCH" })
		return true
	})
	const controller = new AbortController()
	let finished = false
	const pending = launchExtensionHost(
		{
			launchKind: "development-sidecar",
			vscodeExecutablePath: "fixture-host",
			extensionDevelopmentPath: process.cwd(),
		},
		() => controller.abort(),
		controller.signal,
	).then(
		() => assert.fail("cancelled host unexpectedly succeeded"),
		(error: unknown) => {
			finished = true
			return error
		},
	)
	child.emit("close", 1, null)
	await new Promise<void>((resolve) => setImmediate(resolve))
	assert.equal(finished, false)
	context.mock.timers.tick(1_000)
	await new Promise<void>((resolve) => setImmediate(resolve))
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
	assert.equal(finished, false)
	groupStopped = true
	context.mock.timers.tick(10)
	const failure = await pending
	assert.ok(failure instanceof HostLaunchCancelledError)
	assert.equal(failure.cleanupVerified, true)
	assert.equal(failure.hostExitObserved, true)
})

test("a startup deadline terminates its owned child and reports verified cleanup", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-unknown-close-")))
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
						expected: { runId: "unknown-close", nonce: randomUUID(), actualVSCodeVersion: "1.138.0" },
					},
				},
				(pid) => {
					ownedPid = pid
					context.mock.timers.tick(LIVE_HOST_STARTUP_TIMEOUT_MS)
				},
				cancellation.signal,
			),
			(error: unknown) => {
				assert.ok(error instanceof HostLaunchFailureError)
				assert.equal(error.code, "host-startup-timeout")
				assert.equal(error.hostExitObserved, true)
				assert.equal(error.cleanupVerified, true)
				return true
			},
		)
		assert.ok(ownedPid)
		assert.throws(() => process.kill(ownedPid!, 0), { code: "ESRCH" })
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
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-sidecar-args-")))
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
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha launch %ALPHA_ARG_TEST% & $value ")))
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

test("GUI hosts discard inherited Electron Node mode while preserving extension test environment", async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-host-environment-")))
	const previous = process.env.ELECTRON_RUN_AS_NODE
	try {
		process.env.ELECTRON_RUN_AS_NODE = "1"
		const output = path.join(root, "environment.json")
		assert.equal(
			await launchExtensionHost({
				vscodeExecutablePath: process.execPath,
				extensionDevelopmentPath: root,
				extensionTestsPath: root,
				launchArgs: [
					"-e",
					"require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ electronNodeMode: process.env.ELECTRON_RUN_AS_NODE, fixture: process.env.ALPHA_HOST_ENV_FIXTURE }))",
					"--",
					output,
				],
				extensionTestsEnv: { ELECTRON_RUN_AS_NODE: "1", ALPHA_HOST_ENV_FIXTURE: "preserved" },
			}),
			0,
		)
		assert.deepEqual(JSON.parse(await fs.readFile(output, "utf8")), { fixture: "preserved" })
		assert.equal(process.env.ELECTRON_RUN_AS_NODE, "1")
	} finally {
		if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE
		else process.env.ELECTRON_RUN_AS_NODE = previous
		await fs.rm(root, { recursive: true, force: true })
	}
})
