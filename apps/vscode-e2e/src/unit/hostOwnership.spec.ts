import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { execFile } from "child_process"
import { promisify } from "util"
import { acquireProfileLease, assertRunnerAncestry, verifyTestHostOwnership } from "../hostOwnership"

test("verifies a real child process through the operating system ancestry inspector", { timeout: 45_000 }, async () => {
	const executeFile = promisify(execFile)
	await executeFile(
		process.execPath,
		[
			"--require",
			"tsx/cjs",
			"--eval",
			"require(process.argv[1]).assertRunnerAncestry(Number(process.argv[2])).catch(error => { console.error(error.message); process.exitCode = 1 })",
			require.resolve("../hostOwnership"),
			String(process.pid),
		],
		{ timeout: 40_000, maxBuffer: 64 * 1024, windowsHide: true },
	)
})

test("verifies disposable runner-managed hosts through the same ancestry gate as persistent profiles", async () => {
	for (const profile of [undefined, "owned-profile"]) {
		let inspected = false
		const result = await verifyTestHostOwnership(
			{ ALPHA_E2E_RUNNER_PID: "10", ALPHA_E2E_PROFILE_DIR: profile },
			async (runnerPid) => {
				inspected = true
				await assertRunnerAncestry(runnerPid, 40, async () => new Map([[40, 10]]))
			},
		)
		assert.equal(inspected, true)
		assert.equal(result, "verified")
	}
})

test("never verifies managed hosts with missing, invalid, foreign or unavailable runner ancestry", async () => {
	for (const profile of [undefined, "owned-profile"]) {
		for (const runnerPid of ["", "not-a-pid", "40", "50"]) {
			await assert.rejects(
				verifyTestHostOwnership({ ALPHA_E2E_RUNNER_PID: runnerPid, ALPHA_E2E_PROFILE_DIR: profile }, (pid) =>
					assertRunnerAncestry(pid, 40, async () => new Map([[40, 10]])),
				),
				/Invalid|not owned/,
			)
		}
		await assert.rejects(
			verifyTestHostOwnership({ ALPHA_E2E_RUNNER_PID: "10", ALPHA_E2E_PROFILE_DIR: profile }, () =>
				Promise.reject(new Error("unavailable")),
			),
			/unavailable/,
		)
	}
	await assert.rejects(verifyTestHostOwnership({ ALPHA_E2E_PROFILE_DIR: "owned-profile" }), /Invalid/)
	assert.equal(await verifyTestHostOwnership({}), undefined)
})

test("accepts only an extension host descended from the campaign runner", async () => {
	const parents = async () =>
		new Map([
			[40, 30],
			[30, 20],
			[20, 10],
		])
	await assertRunnerAncestry(10, 40, parents)
	await assert.rejects(assertRunnerAncestry(50, 40, parents), /not owned/)
	await assert.rejects(assertRunnerAncestry(40, 40, parents), /Invalid/)
	await assert.rejects(assertRunnerAncestry(Number.NaN, 40, parents), /Invalid/)
})

test("does not accept incomplete or cyclic ancestry and propagates unavailable inspection", async () => {
	await assert.rejects(
		assertRunnerAncestry(
			10,
			40,
			async () =>
				new Map([
					[40, 30],
					[30, 40],
				]),
		),
		/not owned/,
	)
	await assert.rejects(
		assertRunnerAncestry(10, 40, async () => new Map()),
		/not owned/,
	)
	await assert.rejects(
		assertRunnerAncestry(10, 40, async () => {
			throw new Error("unavailable")
		}),
		/unavailable/,
	)
})

test("profile launch lease serializes runners and releases only its own token", async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-e2e-lease-test-")))
	try {
		const userData = path.join(root, "user-data")
		await fs.mkdir(userData)
		const release = await acquireProfileLease(userData)
		await assert.rejects(acquireProfileLease(userData), { code: "profile-busy" })
		await release()
		const secondRelease = await acquireProfileLease(userData)
		const leasePath = path.join(root, ".alpha-e2e-launch.json")
		await fs.writeFile(leasePath, "foreign owner")
		await assert.rejects(secondRelease(), /ownership was lost/)
		assert.equal(await fs.readFile(leasePath, "utf8"), "foreign owner")
		assert.deepEqual((await fs.readdir(root)).sort(), [".alpha-e2e-launch.json", "user-data"])
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("an empty or crashed launch lease is retained rather than stolen by age", async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-e2e-lease-test-")))
	try {
		await fs.writeFile(path.join(root, ".alpha-e2e-launch.json"), "")
		await assert.rejects(acquireProfileLease(path.join(root, "user-data")), { code: "profile-busy" })
		assert.equal(await fs.readFile(path.join(root, ".alpha-e2e-launch.json"), "utf8"), "")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})
