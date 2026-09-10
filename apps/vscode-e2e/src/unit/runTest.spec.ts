import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import { readRunOptions, runExtensionTests, type ExtensionTestRunResult } from "../runTest"
import { prepareEvidenceRun, captureRunEvidence, markRunRetentionEligible } from "../evidence"
import { EVIDENCE_RETENTION_ELIGIBLE } from "../evidence/retention"
import { finalizeRunRetention } from "../runEvidence"
import { prepareTestProfile } from "../testProfile"
import type { HostLaunchOptions } from "../hostLaunch"
import { writeLiveHostReceipt, LIVE_HOST_COMPLETION, type LiveHostReceipt } from "../liveHostProtocol"

const writeHostPreflight = async (options: HostLaunchOptions, version = "1.122.1", code?: string) => {
	const env = options.extensionTestsEnv!
	await fs.writeFile(
		path.join(env.ALPHA_E2E_ARTIFACTS_DIR!, "host-preflight.json"),
		JSON.stringify({
			schemaVersion: 1,
			runId: env.ALPHA_E2E_RUN_ID,
			actualVSCodeVersion: version,
			status: code ? "blocked" : "passed",
			ownershipGate: env.ALPHA_E2E_PROFILE_DIR ? "verified" : undefined,
			code,
		}),
	)
}

async function writeNormalCompletion(options: HostLaunchOptions, status: "passed" | "failed" = "passed") {
	const { artifactsDir, expected } = options.liveHost!
	const receipt: LiveHostReceipt = {
		...expected,
		schemaVersion: 1,
		launchKind: "development-sidecar",
		pid: 123,
		ppid: 45,
		status,
		...(status === "failed" ? { failure: "host-failed" as const } : {}),
	}
	await fs.writeFile(
		path.join(artifactsDir, "host-identity.json"),
		JSON.stringify({
			schemaVersion: 1,
			runId: expected.runId,
			actualVSCodeVersion: expected.actualVSCodeVersion,
			pid: receipt.pid,
			ppid: receipt.ppid,
			ownershipGate: "verified",
		}),
	)
	await writeLiveHostReceipt(artifactsDir, { ...receipt, status: "started", failure: undefined })
	await writeLiveHostReceipt(artifactsDir, receipt)
}

test("installed artifact runs load only the test sidecar, preserve identity, and reject paths outside the owned profile", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-installed-runner-"))
	try {
		const options = {
			providerMode: "scripted" as const,
			vscodeVersion: "1.122.1",
			profileDir: path.join(root, "profile"),
			workspace: path.join(root, "workspace"),
			artifactsDir: path.join(root, "artifacts"),
			initializeProfile: true,
		}
		const profile = await prepareTestProfile(options)
		const installed = path.join(profile.extensionsDir, "alphainc.alpha-2.1.28")
		await fs.mkdir(installed)
		await fs.writeFile(
			path.join(installed, "package.json"),
			JSON.stringify({ publisher: "AlphaInc", name: "alpha", version: "2.1.28" }),
		)
		let launches = 0
		const result = await runExtensionTests(
			{ ...options, installedExtensionPath: installed },
			{
				launch: async (launch) => {
					launches++
					assert.equal(launch.launchKind, "development-sidecar")
					const paths = Array.isArray(launch.extensionDevelopmentPath)
						? launch.extensionDevelopmentPath
						: [launch.extensionDevelopmentPath]
					assert.equal(paths.length, 1)
					assert.ok(!paths.includes(installed))
					assert.equal(launch.extensionTestsEnv?.ALPHA_E2E_INSTALLED_EXTENSION_DIR, installed)
					assert.equal(launch.extensionTestsEnv?.ALPHA_E2E_EXTENSION_ID, "AlphaInc.alpha")
					await writeHostPreflight(launch)
					await writeNormalCompletion(launch)
					return 0
				},
			},
		)
		assert.equal(result.status, "passed")
		assert.equal(launches, 1)
		await assert.rejects(
			runExtensionTests({ ...options, installedExtensionPath: installed }, { launchKind: "extension-test" }),
			/Invalid persistent host launch mode/,
		)
		const outside = path.join(root, "outside")
		await fs.mkdir(outside)
		await fs.copyFile(path.join(installed, "package.json"), path.join(outside, "package.json"))
		await assert.rejects(
			runExtensionTests({ ...options, installedExtensionPath: outside }),
			/inside the owned profile/,
		)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("live Copilot and explicit scripted diagnostics use the normal sidecar with protected correlation and shared storage", async () => {
	for (const providerMode of ["live-copilot", "scripted"] as const) {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-normal-runner-"))
		try {
			const result = await runExtensionTests(
				{
					providerMode,
					vscodeVersion: "1.122.1",
					modelId: "exact-model-id",
					profileDir: path.join(root, "profile"),
					workspace: path.join(root, "workspace"),
					artifactsDir: path.join(root, "artifacts"),
					initializeProfile: true,
					testFile: "profile-persistence.test",
					extensionTestsEnv: {
						ALPHA_E2E_LAUNCH_KIND: "extension-test",
						ALPHA_E2E_LAUNCH_NONCE: "forged",
						ALPHA_E2E_SHARED_DATA_DIR: "outside",
					},
				},
				{
					...(providerMode === "scripted" ? { launchKind: "development-sidecar" as const } : {}),
					launch: async (options) => {
						assert.equal(options.launchKind, "development-sidecar")
						assert.equal(options.extensionTestsPath, undefined)
						assert.equal(
							Array.isArray(options.extensionDevelopmentPath) && options.extensionDevelopmentPath.length,
							2,
						)
						assert.equal(options.extensionTestsEnv?.ALPHA_E2E_LAUNCH_KIND, "development-sidecar")
						assert.equal(
							options.extensionTestsEnv?.ALPHA_E2E_LAUNCH_NONCE,
							options.liveHost?.expected.nonce,
						)
						const shared = await fs.realpath(path.join(root, "profile", "1.122.1", "shared-data"))
						assert.equal(options.extensionTestsEnv?.ALPHA_E2E_SHARED_DATA_DIR, shared)
						assert.ok(options.launchArgs?.includes(`--shared-data-dir=${shared}`))
						await writeHostPreflight(options)
						await writeNormalCompletion(options)
						return 0
					},
				},
			)
			assert.equal(result.status, "passed", `Synthetic run failed: ${result.failure}`)
			assert.equal(result.completionStatus, "passed")
			assert.equal(result.execution, "test-seam")
			assert.equal(result.hostExitObserved, false)
			assert.equal(result.completionReceiptPath, path.join(result.artifactsDir, LIVE_HOST_COMPLETION))
			await assert.rejects(fs.stat(path.join(root, "profile", "1.122.1", ".alpha-e2e-launch.json")), {
				code: "ENOENT",
			})
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	}
})

test("normal-mode missing, stale, and failed receipts cannot pass a zero exit; primary provider failure is preserved", async () => {
	for (const scenario of [
		"missing",
		"stale",
		"wrong-process",
		"failed",
		"nonzero",
		"blocked",
		"before-preflight",
	] as const) {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-normal-receipt-"))
		try {
			const result = await runExtensionTests(
				{
					providerMode: "scripted",
					vscodeVersion: "1.122.1",
					profileDir: path.join(root, "profile"),
					workspace: path.join(root, "workspace"),
					artifactsDir: path.join(root, "artifacts"),
					initializeProfile: true,
				},
				{
					launchKind: "development-sidecar",
					launch: async (options) => {
						if (scenario !== "before-preflight")
							await writeHostPreflight(
								options,
								"1.122.1",
								scenario === "blocked" ? "authentication-required" : undefined,
							)
						if (scenario !== "missing" && scenario !== "blocked") {
							await writeNormalCompletion(
								options,
								scenario === "failed" || scenario === "before-preflight" ? "failed" : "passed",
							)
							if (scenario === "stale" || scenario === "wrong-process") {
								const file = path.join(options.liveHost!.artifactsDir, LIVE_HOST_COMPLETION)
								const receipt = JSON.parse(await fs.readFile(file, "utf8"))
								if (scenario === "stale") receipt.nonce = "00000000-0000-0000-0000-000000000000"
								else receipt.pid = 999
								await fs.writeFile(file, JSON.stringify(receipt))
							}
						}
						return scenario === "nonzero" ? 7 : 0
					},
				},
			)
			assert.notEqual(result.status, "passed")
			assert.notEqual(result.exitCode, 0)
			assert.equal(
				result.failure,
				scenario === "missing"
					? "host-completion-missing"
					: scenario === "stale" || scenario === "wrong-process"
						? "host-completion-invalid"
						: scenario === "blocked"
							? "authentication-required"
							: "host-failed",
			)
			await fs.stat(result.artifactsDir)
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	}
})

test("mode overrides cannot restore live in-memory tests or bypass the dedicated profile", async () => {
	await assert.rejects(
		runExtensionTests({ providerMode: "live-copilot", vscodeVersion: "1.122.1" }, { launchKind: "extension-test" }),
		{ code: "invalid-options" },
	)
	await assert.rejects(
		runExtensionTests(
			{ providerMode: "scripted", vscodeVersion: "1.122.1" },
			{ launchKind: "development-sidecar" },
		),
		{ code: "invalid-options" },
	)
})

test("retains legacy provider and host environment defaults, with explicit options taking precedence", () => {
	assert.equal(readRunOptions([], {}).providerMode, "live")
	assert.equal(readRunOptions([], {}).vscodeVersion, "1.122.1")
	const result = readRunOptions(["--provider", "scripted", "--request-limit", "8", "--scenario-phase", "run"], {
		ALPHA_E2E_PROVIDER_MODE: "live",
		VSCODE_VERSION: "1.136.1",
		VSCODE_EXECUTABLE_PATH: "/test/Code",
		TEST_FILE: "task.test",
	})
	assert.equal(result.providerMode, "scripted")
	assert.equal(result.requestLimit, 8)
	assert.equal(result.scenarioPhase, "run")
	assert.equal(result.vscodeVersion, "1.136.1")
	assert.equal(result.vscodeExecutablePath, "/test/Code")
	assert.equal(result.testFile, "task.test")
})

test("rejects ambiguous and invalid options", () => {
	for (const args of [
		["--provider"],
		["--provider", "scripted", "--provider", "live"],
		["--typo"],
		["--request-limit", "0"],
		["--request-limit", "1.5"],
		["--scenario-phase", "anything"],
	])
		assert.throws(() => readRunOptions(args, {}))
})

test("interactive setup has no implicit timeout and accepts only explicit bounded deadlines", async () => {
	assert.equal(readRunOptions(["--setup"], {}).setupTimeoutMs, undefined)
	assert.equal(readRunOptions(["--setup", "--setup-timeout-ms", "60000"], {}).setupTimeoutMs, 60000)
	for (const timeout of ["0", "-1", "1.5", "NaN", "Infinity", "86400001", "9007199254740992"]) {
		assert.throws(() => readRunOptions(["--setup", "--setup-timeout-ms", timeout], {}), { code: "invalid-options" })
	}
	assert.throws(() => readRunOptions(["--setup-timeout-ms", "1000"], {}), { code: "invalid-options" })
	for (const setupTimeoutMs of [0, -1, 0.5, NaN, Infinity, 86_400_001]) {
		await assert.rejects(
			runExtensionTests({ providerMode: "live-copilot", vscodeVersion: "1.122.1", setup: true, setupTimeoutMs }),
			{ code: "invalid-options" },
		)
	}
})

test("campaign retention holds are explicit and invalid maintenance limits cannot launch a host", async () => {
	assert.equal(readRunOptions(["--retain-evidence-for-campaign"], {}).retainEvidenceForCampaign, true)
	assert.equal(readRunOptions([], {}).retainEvidenceForCampaign, false)
	await assert.rejects(
		runExtensionTests(
			{ providerMode: "scripted", vscodeVersion: "1.122.1", evidenceRetention: { maxRuns: 0 } },
			{
				launch: async () => {
					assert.fail("invalid retention options must not launch")
				},
			},
		),
		{ code: "invalid-options" },
	)
})

async function seedRetentionCandidate(
	artifactsRoot: string,
	runId: string,
	state: "eligible" | "active" | "incomplete" | "failed",
) {
	const prepared = await prepareEvidenceRun({ artifactsRoot, runId })
	await captureRunEvidence({
		artifactsRoot,
		runId,
		metadata: {
			scenarioId: "synthetic-retention-fixture",
			hostVersion: "1.122.1",
			provider: "scripted",
			taskIds: [],
			startedAt: "2020-01-01T00:00:00Z",
			finishedAt: "2020-01-01T00:00:01Z",
			outcome: state === "failed" ? "failed" : "passed",
		},
	})
	if (state === "incomplete") {
		const manifest = JSON.parse(await fs.readFile(prepared.manifestPath, "utf8"))
		await fs.writeFile(prepared.manifestPath, JSON.stringify({ ...manifest, captureComplete: false }))
	}
	// Synthetic historical receipts exercise retention policy; they are not a live-host acceptance claim.
	await fs.writeFile(
		path.join(prepared.artifactDirectory, "run-result.json"),
		JSON.stringify({
			runId,
			status: state === "failed" ? "failed" : "passed",
			execution: "extension-host",
			exitCode: state === "failed" ? 1 : 0,
			hostExitObserved: true,
			ownershipGate: "verified",
			captureComplete: state !== "incomplete",
			actualVSCodeVersion: "1.122.1",
			launchedHostPid: 101,
			extensionHostPid: 102,
			extensionHostParentPid: 101,
		}),
	)
	if (state === "eligible") await markRunRetentionEligible({ artifactsRoot, runId })
	return prepared.artifactDirectory
}

test("runner really prunes eligible artifacts while preserving active, incomplete, failed, current and raw sources", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-retention-integration-"))
	try {
		const artifactsRoot = path.join(root, "artifacts")
		const eligible = await seedRetentionCandidate(artifactsRoot, "older-eligible", "eligible")
		const protectedPaths = await Promise.all(
			["active", "incomplete", "failed"].map((state) =>
				seedRetentionCandidate(artifactsRoot, `older-${state}`, state as "active" | "incomplete" | "failed"),
			),
		)
		const result = await runExtensionTests(
			{
				providerMode: "scripted",
				vscodeVersion: "1.122.1",
				runId: "current-campaign",
				profileDir: path.join(root, "profiles"),
				workspace: path.join(root, "workspace"),
				artifactsDir: artifactsRoot,
				initializeProfile: true,
				evidenceRetention: { maxRuns: 1 },
			},
			{
				launch: async (options) => {
					await fs.writeFile(
						path.join(options.extensionTestsEnv!.ALPHA_E2E_WORKSPACE!, "source.txt"),
						"raw-source-must-stay",
					)
					await writeHostPreflight(options)
					return 0
				},
				afterRun: async () => {
					await fs.stat(eligible)
				},
			},
		)
		await assert.rejects(fs.stat(eligible), { code: "ENOENT" })
		for (const protectedPath of protectedPaths) await fs.stat(protectedPath)
		assert.equal(await fs.readFile(path.join(result.workspace, "source.txt"), "utf8"), "raw-source-must-stay")
		await fs.stat(result.userDataDir)
		const primary = JSON.parse(await fs.readFile(path.join(result.artifactsDir, "run-result.json"), "utf8"))
		const report = JSON.parse(await fs.readFile(primary.retentionResultPath, "utf8"))
		assert.equal(primary.status, "passed", "the primary task receipt remains unchanged")
		assert.equal(report.eligibility, "not-eligible")
		assert.equal(report.status, "blocked", "protected runs can keep the retention target unmet")
		assert.ok(report.result.removedRunIds.includes("older-eligible"))
		assert.equal(result.exitCode, 1)
		assert.equal(result.failure, "evidence-retention-failed")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("standalone retention quota failure preserves the primary provider failure and durable phase evidence", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-retention-failure-"))
	try {
		const result = await runExtensionTests(
			{
				providerMode: "scripted",
				vscodeVersion: "1.122.1",
				profileDir: path.join(root, "profiles"),
				workspace: path.join(root, "workspace"),
				artifactsDir: path.join(root, "artifacts"),
				initializeProfile: true,
				evidenceRetention: { maxBytes: 1 },
			},
			{
				launch: async (options) => {
					await writeHostPreflight(options, "1.122.1", "authentication-required")
					return 1
				},
			},
		)
		assert.equal(result.failure, "authentication-required")
		assert.equal(result.retention?.status, "blocked")
		assert.equal(result.retention?.eligibility, "not-eligible")
		const report = JSON.parse(await fs.readFile(result.retentionResultPath!, "utf8"))
		assert.equal(report.failure, "evidence-retention-failed")
		assert.equal(report.result.overBudget, true)
		assert.ok(report.result.retainedBytes > 1)
		await fs.stat(result.evidenceManifestPath!)
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("campaign holds preserve older evidence and a 22-launch matrix without applying standalone pruning limits", async () => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-campaign-hold-")))
	try {
		const artifactsRoot = path.join(root, "artifacts")
		const older = await seedRetentionCandidate(artifactsRoot, "older-eligible", "eligible")
		for (let index = 0; index < 21; index++) await seedRetentionCandidate(artifactsRoot, `held-${index}`, "active")
		const result = await runExtensionTests(
			{
				providerMode: "scripted",
				vscodeVersion: "1.122.1",
				runId: "matrix-last-host",
				profileDir: path.join(root, "profiles"),
				workspace: path.join(root, "workspace"),
				artifactsDir: artifactsRoot,
				initializeProfile: true,
				retainEvidenceForCampaign: true,
			},
			{
				launch: async (options) => {
					await writeHostPreflight(options)
					return 0
				},
			},
		)
		assert.equal(result.exitCode, 0)
		assert.equal(result.retention?.status, "complete")
		assert.equal(result.retention?.eligibility, "held")
		const receipt = JSON.parse(await fs.readFile(result.retentionResultPath!, "utf8"))
		assert.equal(receipt.maintenance, "campaign-owned")
		assert.equal(receipt.result, undefined, "holding evidence is not a standalone quota verdict")
		assert.ok(await fs.stat(older))
		for (let index = 0; index < 21; index++) assert.ok(await fs.stat(path.join(artifactsRoot, `held-${index}`)))
		await assert.rejects(fs.stat(path.join(result.artifactsDir, EVIDENCE_RETENTION_ELIGIBLE)), { code: "ENOENT" })
	} finally {
		assert.equal(await fs.realpath(root), root)
		assert.match(path.basename(root), /^alpha-campaign-hold-/)
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("standalone finalizer writes a report then releases only a complete synthetic owned-close receipt", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-retention-release-"))
	try {
		const profile = await prepareTestProfile({
			vscodeVersion: "1.122.1",
			profileDir: path.join(root, "profiles"),
			workspace: path.join(root, "workspace"),
			artifactsDir: path.join(root, "artifacts"),
			initializeProfile: true,
		})
		for (const verified of [true, false]) {
			const runId = verified ? "verified" : "missing-identity"
			const artifactsDir = await seedRetentionCandidate(profile.artifactsDir, runId, "active")
			const result: ExtensionTestRunResult = {
				...profile,
				artifactsDir,
				runId,
				exitCode: 0,
				providerMode: "scripted",
				vscodeVersion: "1.122.1",
				actualVSCodeVersion: "1.122.1",
				status: "passed",
				retained: true,
				execution: "extension-host",
				captureComplete: true,
				hostExitObserved: true,
				ownershipGate: "verified",
				launchedHostPid: 101,
				extensionHostPid: verified ? 102 : undefined,
				extensionHostParentPid: 101,
			}
			await fs.writeFile(path.join(artifactsDir, "run-result.json"), JSON.stringify(result))
			const report = await finalizeRunRetention(
				{
					providerMode: "scripted",
					vscodeVersion: "1.122.1",
					evidenceRetention: { maxAgeMs: 100 * 365 * 24 * 60 * 60 * 1000 },
				},
				profile,
				result,
			)
			assert.equal(report.status, verified ? "complete" : "failed")
			await fs.stat(path.join(artifactsDir, "retention-result.json"))
			if (verified) await fs.stat(path.join(artifactsDir, EVIDENCE_RETENTION_ELIGIBLE))
			else {
				await assert.rejects(fs.stat(path.join(artifactsDir, EVIDENCE_RETENTION_ELIGIBLE)), { code: "ENOENT" })
				const error = JSON.parse(await fs.readFile(path.join(artifactsDir, "retention-error.json"), "utf8"))
				assert.equal(error.failure, "evidence-retention-failed")
			}
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("uses the same launch seam with isolated paths and checks exact version for executable overrides", async () => {
	let run: ExtensionTestRunResult | undefined
	const result = await runExtensionTests(
		{
			providerMode: "scripted",
			vscodeVersion: "1.122.1",
			vscodeExecutablePath: "/fixture/Code",
			requestLimit: 4,
			scenarioId: "example",
			scenarioPhase: "run",
			extensionTestsEnv: {
				ALPHA_E2E_EXPECTED_VSCODE_VERSION: "forged",
				ALPHA_E2E_SCENARIO_ID: "forged",
				ALPHA_E2E_SETUP_TIMEOUT_MS: "1",
			},
		},
		{
			launch: async (options) => {
				assert.equal(options.reuseMachineInstall, false)
				assert.equal(options.extensionTestsEnv?.ALPHA_E2E_EXPECTED_VSCODE_VERSION, "1.122.1")
				assert.equal(options.extensionTestsEnv?.ALPHA_E2E_SCENARIO_ID, "example")
				assert.equal(options.extensionTestsEnv?.ALPHA_E2E_REQUEST_LIMIT, "4")
				assert.equal(options.extensionTestsEnv?.ALPHA_E2E_SETUP_TIMEOUT_MS, undefined)
				assert.ok(options.launchArgs?.includes("--disable-extension=vscode.git"))
				assert.ok(options.launchArgs?.some((arg) => arg.startsWith("--user-data-dir=")))
				await writeHostPreflight(options)
				return 0
			},
			afterRun: async (result) => {
				run = result
				await fs.stat(result.artifactsDir)
			},
		},
	)
	assert.equal(run?.status, "passed")
	assert.equal(result.status, "passed")
	assert.equal(result.actualVSCodeVersion, "1.122.1")
	assert.equal(result.retained, false)
	await assert.rejects(fs.stat(result.temporaryRoot!), { code: "ENOENT" })
})

test("retains failed sources and carries safe host-preflight classification, never raw errors", async () => {
	const result = await runExtensionTests(
		{ providerMode: "scripted", vscodeVersion: "1.122.1" },
		{
			launch: async (options) => {
				await writeHostPreflight(options, "1.122.1", "authentication-required")
				throw new Error("Authorization: secret-token private request body")
			},
		},
	)
	try {
		assert.equal(result.failure, "authentication-required")
		assert.equal(result.status, "blocked")
		assert.equal(result.retained, true)
		const report = await fs.readFile(path.join(result.artifactsDir, "run-result.json"), "utf8")
		assert.ok(!report.includes("secret-token"))
		assert.equal(JSON.parse(report).exitCode, 1)
		await fs.stat(result.userDataDir)
	} finally {
		await fs.rm(result.temporaryRoot!, { recursive: true, force: true })
	}
})

test("a zero host exit cannot pass mismatched or missing host evidence", async () => {
	for (const version of ["1.136.1", undefined]) {
		const result = await runExtensionTests(
			{ providerMode: "scripted", vscodeVersion: "1.122.1" },
			{
				launch: async (options) => {
					if (version) await writeHostPreflight(options, version)
					return 0
				},
			},
		)
		try {
			assert.equal(result.exitCode, 1)
			assert.equal(result.retained, true)
			if (version) assert.equal(result.failure, "host-version-mismatch")
		} finally {
			await fs.rm(result.temporaryRoot!, { recursive: true, force: true })
		}
	}
})

test("failed evidence capture preserves sources and cannot leave a successful runner report", async () => {
	const result = await runExtensionTests(
		{ providerMode: "scripted", vscodeVersion: "1.122.1" },
		{
			launch: async (options) => {
				await writeHostPreflight(options)
				return 0
			},
			afterRun: async () => {
				throw new Error("capture failed")
			},
		},
	)
	try {
		assert.equal(result.failure, "evidence-failed")
		assert.equal(result.exitCode, 1)
		assert.equal(result.retained, true)
		assert.equal(
			JSON.parse(await fs.readFile(path.join(result.artifactsDir, "run-result.json"), "utf8")).status,
			"failed",
		)
	} finally {
		await fs.rm(result.temporaryRoot!, { recursive: true, force: true })
	}
})

test("normal nonzero host close and even a zero exit preserve a blocked preflight classification", async () => {
	for (const exitCode of [0, 3]) {
		const result = await runExtensionTests(
			{ providerMode: "scripted", vscodeVersion: "1.122.1" },
			{
				launch: async (options) => {
					await writeHostPreflight(options, "1.122.1", "authentication-required")
					return exitCode
				},
			},
		)
		try {
			assert.equal(result.status, "blocked")
			assert.equal(result.failure, "authentication-required")
			assert.equal(result.exitCode, exitCode || 1)
			assert.equal(result.hostExitObserved, false, "an injected launch is not real host exit evidence")
		} finally {
			await fs.rm(result.temporaryRoot!, { recursive: true, force: true })
		}
	}
})

test("secondary evidence failure cannot obscure a known provider blocker", async () => {
	const result = await runExtensionTests(
		{ providerMode: "scripted", vscodeVersion: "1.122.1" },
		{
			launch: async (options) => {
				await writeHostPreflight(options, "1.122.1", "authentication-required")
				return 1
			},
			afterRun: async () => {
				throw new Error("secondary failure")
			},
		},
	)
	try {
		assert.equal(result.status, "blocked")
		assert.equal(result.failure, "authentication-required")
		assert.equal(result.evidenceFailure, "evidence-failed")
		assert.equal(result.captureComplete, false)
		const manifest = JSON.parse(await fs.readFile(result.evidenceManifestPath!, "utf8"))
		assert.deepEqual(manifest.summary, { category: "provider", code: "AUTH_REQUIRED" })
	} finally {
		await fs.rm(result.temporaryRoot!, { recursive: true, force: true })
	}
})
