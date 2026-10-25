import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { loadHostProbeDrivers, probeHostReceipt, runHostProbes, stressCases } from "./host-probes.mjs"
import { hostReceipt } from "./fixtures/evidence.mjs"

const options = () => ({
	directory: path.resolve("unused-owned-hosts"),
	executable: path.resolve("Code.exe"),
	signal: new AbortController().signal,
})
const result = (testFile) => ({
	...hostReceipt(testFile),
	actualVSCodeVersion: "1.138.0",
	userDataDir: path.resolve("unused-owned-profile"),
	profileDir: path.resolve("unused-owned-profile"),
	retention: { status: "complete" },
})

test("probe selection loads the compiled canonical runner so its host suite entrypoint resolves to out", () => {
	const repositoryRoot = path.resolve("unused-repository")
	const loaded = []
	const runExtensionTests = () => {}
	const runRenderedUiProbe = () => {}
	const drivers = loadHostProbeDrivers(repositoryRoot, (file) => {
		loaded.push(file)
		return file.endsWith(`${path.sep}runTest.js`) ? { runExtensionTests } : { runRenderedUiProbe }
	})
	assert.deepEqual(drivers, { runExtensionTests, runRenderedUiProbe })
	assert.deepEqual(loaded, [
		path.join(repositoryRoot, "apps/vscode-e2e/out/runTest.js"),
		path.join(repositoryRoot, "apps/vscode-e2e/out/campaign/renderedUiProbe.js"),
	])
	assert.throws(() => loadHostProbeDrivers(repositoryRoot, () => ({})), /Compile/)
})

test("bounded stress selection runs existing acceptance serially with explicit flags and complete execution", async () => {
	const selected = []
	let active = false
	const report = await runHostProbes("stress", options(), {
		runExtensionTests: async (launch) => {
			assert.equal(active, false)
			active = true
			assert.equal(launch.providerMode, "scripted")
			assert.equal(launch.vscodeVersion, "1.138.0")
			assert.equal(launch.requireAllTests, true)
			assert.equal(launch.retainEvidenceForCampaign, true)
			assert.equal(launch.signal.aborted, false)
			selected.push({ testFile: launch.testFile, env: launch.extensionTestsEnv })
			await Promise.resolve()
			active = false
			return result(launch.testFile)
		},
	})
	assert.deepEqual(selected, stressCases)
	assert.equal(report.status, "passed")
	assert.equal(report.receipts.length, 2)
	assert.equal(report.liveRequests, 0)
})

test("stress cannot continue after an incomplete or cancelled first host", async () => {
	for (const change of [
		{ hostExitObserved: false },
		{ hostCleanupVerified: false },
		{ requireAllTests: false },
		{ testCounts: { total: 2, passed: 1, pending: 1, executed: 1, failed: 0 } },
		{ testSelection: { testFile: stressCases[0].testFile, grep: "subset", forbidOnly: true } },
		{ execution: "test-seam" },
		{ retention: { status: "failed" } },
	]) {
		let launches = 0
		await assert.rejects(
			runHostProbes("stress", options(), {
				runExtensionTests: async (launch) => {
					launches++
					return { ...result(launch.testFile), ...change }
				},
			}),
			/receipt/,
		)
		assert.equal(launches, 1)
	}
	const abort = new AbortController()
	let launches = 0
	await assert.rejects(
		runHostProbes(
			"stress",
			{ ...options(), signal: abort.signal },
			{
				runExtensionTests: async (launch) => {
					launches++
					abort.abort()
					return result(launch.testFile)
				},
			},
		),
	)
	assert.equal(launches, 1)
})

test("rendered approval/settings mode retains its independent renderer verdict and strict host receipt", async () => {
	for (const [rendererStatus, hostChange] of [
		["passed", {}],
		["failed", {}],
		["passed", { testCounts: { total: 2, passed: 1, pending: 1, executed: 1, failed: 0 } }],
	]) {
		const execution = runHostProbes("rendered-acceptance", options(), {
			runRenderedUiProbe: async (_executable, _directory, mode, signal) => {
				assert.equal(mode, "acceptance")
				assert.equal(signal.aborted, false)
				return { status: rendererStatus, host: { ...result("managed-agents.acceptance.test"), ...hostChange } }
			},
		})
		if (rendererStatus === "passed" && !Object.keys(hostChange).length)
			assert.equal((await execution).status, "passed")
		else await assert.rejects(execution)
	}
})

test("unknown selections, relative roots and pre-cancelled probes cannot dispatch a host", async () => {
	await assert.rejects(runHostProbes("all", options(), {}), /selection/)
	await assert.rejects(runHostProbes("stress", { ...options(), directory: "relative" }, {}), /absolute/)
	const abort = new AbortController()
	abort.abort()
	await assert.rejects(runHostProbes("rendered-acceptance", { ...options(), signal: abort.signal }, {}))
	const fixture = result("composer-ui.test")
	assert.throws(
		() => probeHostReceipt({ ...fixture, ownershipGate: null }, "composer-ui.test", "invalid", "invalid"),
		/receipt/,
	)
})
