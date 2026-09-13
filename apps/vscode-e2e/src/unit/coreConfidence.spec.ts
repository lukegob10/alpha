import { strict as assert } from "node:assert"
import { test, type TestContext } from "node:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { runCoreConfidence } from "../runCoreConfidence"
import type { ExtensionTestRunOptions } from "../runTest"

async function fixture(context: TestContext) {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-core-confidence-unit-")))
	context.after(async () => {
		assert.equal(await fs.realpath(root), root)
		assert.match(path.basename(root), /^alpha-core-confidence-unit-/)
		await fs.rm(root, { recursive: true, force: true })
	})
	const hosts: ExtensionTestRunOptions[] = []
	let certificationEvidence: string | undefined
	const dependencies: NonNullable<Parameters<typeof runCoreConfidence>[3]> = {
		prepareLiveGate: async (_root, _pnpm, _directory, _signal, _runProcess, coverage) => {
			assert.equal(coverage, "regressions")
			return true
		},
		fingerprintGateArtifacts: async () => "unchanged",
		runExtensionTests: async (options) => {
			hosts.push(options)
			return {
				runId: options.testFile!,
				exitCode: 0,
				providerMode: options.providerMode,
				vscodeVersion: options.vscodeVersion!,
				actualVSCodeVersion: "1.122.1",
				workspace: options.workspace!,
				userDataDir: "unused",
				extensionsDir: "unused",
				artifactsDir: path.join(options.artifactsDir!, options.testFile!),
				retained: true,
				status: "passed",
				execution: "extension-host",
				hostExitObserved: true,
				captureComplete: true,
				retention: {
					schemaVersion: 1,
					runId: options.testFile!,
					eligibility: "not-eligible",
					status: "complete",
				},
			}
		},
		runOwnedProcess: async (command) => {
			certificationEvidence = command.env?.ALPHA_COMPLETION_IDLE_EVIDENCE
			assert.deepEqual(command.args, [path.join(root, "pnpm.cjs"), "certify:managed-agents"])
			await fs.mkdir(path.join(root, "artifacts/certification"), { recursive: true })
			await fs.writeFile(
				path.join(root, "artifacts/certification/managed-agent-milestone-evidence.json"),
				JSON.stringify({
					schemaVersion: 1,
					scope: "deterministic-offline-only",
					outcome: { status: "PASS-DETERMINISTIC" },
					source: { stableDuringRun: true },
				}),
			)
			return {
				exitCode: 0,
				signal: null,
				stdout: "passed",
				stderr: "",
				outputTruncated: false,
				cleanupVerified: true,
			}
		},
	}
	return {
		dependencies,
		root,
		hosts,
		get certificationEvidence() {
			return certificationEvidence
		},
		run: () => runCoreConfidence(root, path.join(root, "pnpm.cjs"), new AbortController().signal, dependencies),
		report: async () => {
			const directories = await fs.readdir(path.join(root, "artifacts/core-confidence"))
			const id = directories.find((entry) => entry.startsWith("core-"))!
			return JSON.parse(
				await fs.readFile(path.join(root, "artifacts/core-confidence", id, "gate-result.json"), "utf8"),
			)
		},
	}
}

test("core confidence composes offline owners and replays this run's completion evidence", async (context) => {
	const run = await fixture(context)
	assert.equal(await run.run(), 0)
	assert.deepEqual(
		run.hosts.map((host) => host.testFile),
		["core-loop.test", "completion-idle.test", "managed-agents.acceptance.test"],
	)
	assert.ok(
		run.hosts.every((host) => host.providerMode === "scripted" && host.vscodeVersion === "1.122.1" && host.signal),
	)
	assert.equal(
		run.certificationEvidence,
		path.join(run.hosts[1]!.artifactsDir!, "completion-idle.test", "completion-idle.json"),
	)
	assert.equal((await run.report()).status, "passed")
	assert.ok(run.hosts.every((host) => path.relative(run.root, host.profileDir!).startsWith("..")))
	assert.ok(run.hosts.every((host) => path.relative(run.root, host.workspace!).startsWith("..")))
	assert.ok(run.hosts.every((host) => path.relative(run.root, host.artifactsDir!).startsWith("..")))
	assert.ok(run.hosts.every((host) => /^[a-f0-9]{8}$/.test(path.basename(path.dirname(host.profileDir!)))))
	assert.ok(run.hosts.every((host) => path.basename(host.profileDir!) === "p"))
})

test("failed preparation stops before host tests and preserves a failed verdict", async (context) => {
	const run = await fixture(context)
	run.dependencies.prepareLiveGate = async () => false
	assert.equal(await run.run(), 1)
	assert.equal(run.hosts.length, 0)
	assert.equal(run.certificationEvidence, undefined)
	assert.equal((await run.report()).stage, "prepare")
	assert.equal((await run.report()).status, "failed")
})

test("wrong host or incomplete evidence cannot reach certification", async (context) => {
	for (const alter of [
		{ actualVSCodeVersion: "1.136.1" },
		{ captureComplete: false },
		{ providerMode: "live-copilot" as const },
	]) {
		const run = await fixture(context)
		const original = run.dependencies.runExtensionTests
		run.dependencies.runExtensionTests = async (options) => ({ ...(await original(options)), ...alter })
		assert.equal(await run.run(), 1)
		assert.equal(run.hosts.length, 1)
		assert.equal(run.certificationEvidence, undefined)
		assert.equal((await run.report()).status, "failed")
	}
})

test("a build changed during the run invalidates otherwise passing results", async (context) => {
	const run = await fixture(context)
	let reads = 0
	run.dependencies.fingerprintGateArtifacts = async () => String(++reads)
	assert.equal(await run.run(), 1)
	const report = await run.report()
	assert.equal(report.status, "failed")
	assert.equal(report.artifactsUnchanged, false)
})

test("a host exception retains the failure stage and prevents downstream success", async (context) => {
	const run = await fixture(context)
	run.dependencies.runExtensionTests = async () => {
		throw new Error("host unavailable")
	}
	assert.equal(await run.run(), 1)
	assert.equal((await run.report()).stage, "core-loop.test")
	assert.equal((await run.report()).status, "failed")
})

test("a zero process exit cannot hide missing or failed certification evidence", async (context) => {
	const run = await fixture(context)
	const original = run.dependencies.runOwnedProcess
	run.dependencies.runOwnedProcess = async (command, options) => {
		const result = await original(command, options)
		await fs.writeFile(path.join(run.root, "artifacts/certification/managed-agent-milestone-evidence.json"), "{}")
		return result
	}
	assert.equal(await run.run(), 1)
	assert.equal((await run.report()).status, "failed")
	assert.equal((await run.report()).stage, "certify:managed-agents")
})
