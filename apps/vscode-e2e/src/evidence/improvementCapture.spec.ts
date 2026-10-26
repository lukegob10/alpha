import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import { watch } from "node:fs"
import * as path from "node:path"
import { tmpdir } from "node:os"
import { test, type TestContext } from "node:test"

import { prepareEvidenceRun } from "./paths"
import {
	finalizeImprovementCapture,
	invokeImprovementCapture,
	ImprovementCaptureHelperError,
	prepareImprovementCapture,
	validateImprovementCaptureOptions,
	type ImprovementCaptureState,
} from "./improvementCapture"
import { readRunOptions, type ExtensionTestRunOptions, type ExtensionTestRunResult } from "../runTest"
import { prepareTestProfile, type TestProfile } from "../testProfile"
import { runOwnedProcess } from "../campaign/ownedProcess"

async function fixture(t: TestContext) {
	const temporary = await fs.realpath(tmpdir())
	const root = await fs.realpath(await fs.mkdtemp(path.join(temporary, "alpha-native-capture-")))
	assert.equal(path.dirname(root), temporary)
	t.after(async () => {
		assert.equal(path.dirname(await fs.realpath(root)), temporary)
		await fs.rm(root, { recursive: true, force: true })
	})
	const profile: TestProfile = {
		workspace: path.join(root, "workspace"),
		profileDir: path.join(root, "profile"),
		userDataDir: path.join(root, "profile", "user-data"),
		extensionsDir: path.join(root, "profile", "extensions"),
		artifactsDir: path.join(root, "artifacts"),
	}
	const { artifactDirectory } = await prepareEvidenceRun({ artifactsRoot: profile.artifactsDir, runId: "attempt-1" })
	const options: ExtensionTestRunOptions = {
		...profile,
		artifactsDir: profile.artifactsDir,
		providerMode: "scripted",
		vscodeVersion: "1.138.0",
		scenarioId: "problem-solving-attempt",
		improvementEvidence: true,
		improvementTaskId: "repo-cache-invalidation@1",
	}
	const prepareInput = {
		options,
		profile,
		hostRunId: "attempt-1",
		runDirectory: artifactDirectory,
		extensionId: "Alpha.alpha",
		extensionRoot: path.resolve("src"),
		startedAt: "2026-10-23T23:00:00.000Z",
	}
	const prepare = async () => {
		const state = await prepareImprovementCapture(prepareInput, async (phase, inputPath) => {
			assert.equal(phase, "prepare")
			const contextPath = path.join(path.dirname(inputPath), "context.json")
			await fs.writeFile(contextPath, JSON.stringify({ unitSeam: true }), { flag: "wx" })
			return { contextPath, contextDigest: `sha256:${"a".repeat(64)}` }
		})
		assert.ok(state)
		return state
	}
	return { profile, options, prepareInput, prepare, artifactDirectory }
}

function outcome(state: ImprovementCaptureState): ExtensionTestRunResult {
	return {
		runId: state.hostRunId,
		artifactsDir: state.runDirectory,
		workspace: state.workspace,
		userDataDir: state.userDataDir,
		extensionsDir: path.join(state.userDataDir, "extensions"),
		exitCode: 1,
		providerMode: "scripted",
		vscodeVersion: "1.138.0",
		status: "blocked",
		failure: "host-cancelled",
		execution: "test-seam",
		hostExitObserved: false,
		hostCleanupVerified: false,
		retained: true,
	}
}

test("rich evidence is explicit, attempt-scoped, and never enabled through inherited environment", () => {
	const defaults = readRunOptions([], { ALPHA_E2E_IMPROVEMENT_EVIDENCE: "1" })
	assert.equal(defaults.improvementEvidence, false)
	const selected = readRunOptions(
		["--improvement-evidence", "--improvement-task-id", "repo-cache-invalidation@1"],
		{},
	)
	assert.equal(selected.improvementEvidence, true)
	assert.equal(selected.improvementTaskId, "repo-cache-invalidation@1")
	const valid: ExtensionTestRunOptions = {
		...selected,
		providerMode: "scripted",
		scenarioId: "problem-solving-attempt",
		profileDir: "/owned/profile",
		workspace: "/owned/workspace",
		artifactsDir: "/owned/artifacts",
	}
	validateImprovementCaptureOptions(valid)
	for (const change of [
		{ improvementEvidence: false },
		{ improvementTaskId: undefined },
		{ scenarioId: "review-edit-test-commit-followup" },
		{ scenarioPhase: "continue" as const },
		{ providerMode: "live" as const },
		{ setup: true },
		{ workspace: undefined },
		{ testFile: "extension.test" },
		{ vscodeVersion: "1.125.0" },
		{ improvementTaskId: "repo-stream-backpressure@2" },
	])
		assert.throws(
			() => validateImprovementCaptureOptions({ ...valid, ...change }),
			/Improvement|source task|scripted/,
		)
})

test("the default projection does not create rich directories or invoke the collector", async (t) => {
	const f = await fixture(t)
	const result = await prepareImprovementCapture(
		{ ...f.prepareInput, options: { ...f.options, improvementEvidence: false, improvementTaskId: undefined } },
		async () => {
			throw new Error("Default execution must never invoke rich capture")
		},
	)
	assert.equal(result, undefined)
	await assert.rejects(fs.stat(path.join(f.artifactDirectory, "improvement")), { code: "ENOENT" })
})

test("prepare publishes private identity-only inputs before accepting the exact owned context", async (t) => {
	const f = await fixture(t)
	const state = await f.prepare()
	const input = JSON.parse(
		await fs.readFile(path.join(f.artifactDirectory, "improvement", "prepare-input.json"), "utf8"),
	)
	assert.equal(input.kind, "alpha-native-host-capture-prepare")
	assert.equal(input.hostRunId, "attempt-1")
	assert.equal(input.taskId, "repo-cache-invalidation@1")
	assert.equal(input.workspace, f.profile.workspace)
	assert.equal(input.userDataDir, f.profile.userDataDir)
	assert.equal(input.extensionId, "Alpha.alpha")
	assert.equal(state.contextPath, path.join(f.artifactDirectory, "improvement", "context.json"))
	assert.equal(JSON.stringify(input).includes("apiConversationHistory"), false)
	await assert.rejects(f.prepare(), { code: "EEXIST" })
})

test("a cancelled outcome preserves unknown cleanup and exact attempt identity in an incomplete capture", async (t) => {
	const f = await fixture(t)
	const state = await f.prepare()
	const result = outcome(state)
	const captured = await finalizeImprovementCapture(
		{ state, result, taskIds: [], workflowResultPath: path.join(f.artifactDirectory, "workflow-result.json") },
		async (phase, inputPath) => {
			assert.equal(phase, "finalize")
			const input = JSON.parse(await fs.readFile(inputPath, "utf8"))
			const observed = JSON.parse(
				await fs.readFile(path.join(path.dirname(inputPath), "host-outcome.json"), "utf8"),
			)
			assert.deepEqual(input.result, observed.result)
			assert.equal(input.finishedAt, observed.finishedAt)
			assert.equal(input.expectedContextDigest, state.contextDigest)
			assert.equal(observed.expectedContextDigest, state.contextDigest)
			assert.equal(input.result.failure, "host-cancelled")
			assert.equal(input.result.hostExitObserved, false)
			assert.equal(input.result.hostCleanupVerified, false)
			assert.equal(input.result.execution, "test-seam")
			const receipt = {
				schemaVersion: 1,
				kind: "alpha-native-host-capture-result",
				status: "incomplete",
				contextPath: state.contextPath,
				contextDigest: state.contextDigest,
				captureResultPath: path.join(path.dirname(inputPath), "capture-result.json"),
				missingArtifacts: ["transcript"],
			}
			await fs.writeFile(receipt.captureResultPath, JSON.stringify(receipt), { flag: "wx" })
			return receipt
		},
	)
	assert.equal(captured.status, "incomplete")
	assert.equal(captured.bundlePath, undefined)
	assert.equal(result.failure, "host-cancelled")
	assert.equal(result.hostExitObserved, false)
})

test("foreign attempt identities are rejected before invoking or writing a terminal capture", async (t) => {
	const f = await fixture(t)
	const state = await f.prepare()
	let invoked = false
	await assert.rejects(
		finalizeImprovementCapture(
			{
				state,
				result: { ...outcome(state), runId: "foreign" },
				taskIds: [],
				workflowResultPath: path.join(f.artifactDirectory, "workflow-result.json"),
			},
			async () => {
				invoked = true
			},
		),
		/identity changed/,
	)
	assert.equal(invoked, false)
	await assert.rejects(fs.stat(path.join(f.artifactDirectory, "improvement", "host-outcome.json")), {
		code: "ENOENT",
	})
})

test("the terminal capture cannot publish a returned bundle path outside the owned run", async (t) => {
	const f = await fixture(t)
	const state = await f.prepare()
	await assert.rejects(
		finalizeImprovementCapture(
			{
				state,
				result: outcome(state),
				taskIds: [],
				workflowResultPath: path.join(f.artifactDirectory, "workflow-result.json"),
			},
			async (_phase, inputPath) => {
				const receipt = {
					schemaVersion: 1,
					kind: "alpha-native-host-capture-result",
					status: "captured",
					contextPath: state.contextPath,
					contextDigest: state.contextDigest,
					captureResultPath: path.join(path.dirname(inputPath), "capture-result.json"),
					bundlePath: path.join(f.artifactDirectory, "foreign.json"),
				}
				await fs.writeFile(receipt.captureResultPath, JSON.stringify(receipt), { flag: "wx" })
				return receipt
			},
		),
		/does not belong/,
	)
})

test("the terminal receipt must retain the exact pre-agent context digest", async (t) => {
	const f = await fixture(t)
	const state = await f.prepare()
	await assert.rejects(
		finalizeImprovementCapture(
			{
				state,
				result: outcome(state),
				taskIds: [],
				workflowResultPath: path.join(f.artifactDirectory, "workflow-result.json"),
			},
			async (_phase, inputPath) => {
				const receipt = {
					schemaVersion: 1,
					kind: "alpha-native-host-capture-result",
					status: "incomplete",
					contextPath: state.contextPath,
					contextDigest: `sha256:${"b".repeat(64)}`,
					captureResultPath: path.join(path.dirname(inputPath), "capture-result.json"),
				}
				await fs.writeFile(receipt.captureResultPath, JSON.stringify(receipt), { flag: "wx" })
				return receipt
			},
		),
		/does not belong/,
	)
})

test("the actual default collector prepares a public fixture through the canonical persistent profile", async (t) => {
	const f = await fixture(t)
	const profile = await prepareTestProfile({ ...f.options, initializeProfile: true })
	assert.equal(profile.userDataDir, path.join(profile.profileDir!, "1.138.0", "user-data"))
	await fs.cp(path.resolve(__dirname, "../../../../evals/javascript/repo-cache-invalidation"), profile.workspace, {
		recursive: true,
	})
	const extensionRoot = path.join(path.dirname(profile.workspace), "extension")
	await fs.mkdir(path.join(extensionRoot, "dist"), { recursive: true })
	await fs.writeFile(path.join(extensionRoot, "dist", "extension.js"), "module.exports.activate = () => {}\n", {
		flag: "wx",
	})
	await fs.writeFile(path.join(extensionRoot, "package.json"), JSON.stringify({ name: "alpha", version: "1.0.0" }), {
		flag: "wx",
	})
	const prepared = await prepareImprovementCapture({ ...f.prepareInput, profile, extensionRoot })
	assert.ok(prepared)
	const context = JSON.parse(await fs.readFile(prepared.contextPath, "utf8"))
	assert.equal(context.scope, "owned-native-host-public-task")
	assert.equal(context.databaseIdentity, "not-applicable")
	assert.equal(context.sourceTask.id, "repo-cache-invalidation")
	assert.equal(context.sourceTask.version, 1)
	assert.equal(context.userDataDir, profile.userDataDir)
	assert.equal(context.digest, prepared.contextDigest)
	assert.match(context.baselineCommit, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
})

test("caller cancellation reaches the owned helper and waits for its terminal cleanup proof", async (t) => {
	const f = await fixture(t)
	for (const cleanupVerified of [false, true]) {
		const cancellation = new AbortController()
		let entered!: () => void
		const started = new Promise<void>((resolve) => (entered = resolve))
		let finishCleanup!: () => void
		const cleanup = new Promise<void>((resolve) => (finishCleanup = resolve))
		let settled = false
		const pending = invokeImprovementCapture(
			"prepare",
			path.join(f.artifactDirectory, "input.json"),
			cancellation.signal,
			{
				runProcess: async (_command, options) => {
					assert.ok(options.signal)
					const aborted = new Promise<void>((resolve) =>
						options.signal!.addEventListener("abort", () => resolve(), { once: true }),
					)
					entered()
					await aborted
					await cleanup
					return {
						exitCode: 1,
						signal: null,
						stdout: "",
						stderr: "",
						outputTruncated: false,
						cleanupVerified,
					}
				},
			},
		)
		void pending.then(
			() => (settled = true),
			() => (settled = true),
		)
		await started
		cancellation.abort()
		await Promise.resolve()
		assert.equal(settled, false, "abandonment must await the owned cleanup boundary")
		finishCleanup()
		await assert.rejects(pending, (error: unknown) => {
			assert.ok(error instanceof ImprovementCaptureHelperError)
			assert.equal(error.code, "host-cancelled")
			assert.equal(error.cleanupVerified, cleanupVerified)
			return true
		})
	}
})

test("a malformed successful helper protocol retains Windows cleanup uncertainty", async (t) => {
	const f = await fixture(t)
	const inputPath = path.join(f.artifactDirectory, "input.json")
	await fs.writeFile(inputPath, JSON.stringify({ hostRunId: "attempt-1" }))
	await assert.rejects(
		invokeImprovementCapture("prepare", inputPath, undefined, {
			runProcess: async () => ({
				exitCode: 0,
				signal: null,
				stdout: "{}",
				stderr: "",
				outputTruncated: false,
				cleanupVerified: false,
			}),
		}),
		(error: unknown) => {
			assert.ok(error instanceof ImprovementCaptureHelperError)
			assert.equal(error.cleanupVerified, false)
			return true
		},
	)
})

test("a complete on-disk helper protocol permits normal Windows close without inventing a tree proof", async (t) => {
	const f = await fixture(t)
	const inputPath = path.join(f.artifactDirectory, "input.json")
	const contextPath = path.join(f.artifactDirectory, "context.json")
	const contextDigest = `sha256:${"a".repeat(64)}`
	await fs.writeFile(inputPath, JSON.stringify({ hostRunId: "attempt-1" }))
	await fs.writeFile(
		contextPath,
		JSON.stringify({
			kind: "alpha-native-host-capture-context",
			scope: "owned-native-host-public-task",
			digest: contextDigest,
			hostRunId: "attempt-1",
		}),
	)
	const value = { contextPath, contextDigest }
	assert.deepEqual(
		await invokeImprovementCapture("prepare", inputPath, undefined, {
			runProcess: async () => ({
				exitCode: 0,
				signal: null,
				stdout: JSON.stringify(value),
				stderr: "",
				outputTruncated: false,
				cleanupVerified: false,
			}),
		}),
		value,
	)
})

test("the default terminal helper accepts canonical disk JSON with different returned key order", async (t) => {
	const f = await fixture(t)
	const state = await f.prepare()
	const captured = await finalizeImprovementCapture(
		{
			state,
			result: outcome(state),
			taskIds: [],
			workflowResultPath: path.join(f.artifactDirectory, "workflow-result.json"),
		},
		(phase, inputPath, signal) =>
			invokeImprovementCapture(phase, inputPath, signal, {
				runProcess: async () => {
					const receipt = {
						captureResultPath: path.join(path.dirname(inputPath), "capture-result.json"),
						contextDigest: state.contextDigest,
						contextPath: state.contextPath,
						integrity: { issues: [{ code: "artifact_missing", detail: "transcript" }], valid: false },
						kind: "alpha-native-host-capture-result",
						missingArtifacts: ["transcript"],
						schemaVersion: 1,
						status: "incomplete",
					}
					await fs.writeFile(receipt.captureResultPath, JSON.stringify(receipt), { flag: "wx" })
					const returned = Object.fromEntries(Object.entries(receipt).reverse())
					returned.integrity = { valid: false, issues: [{ detail: "transcript", code: "artifact_missing" }] }
					return {
						exitCode: 0,
						signal: null,
						stdout: JSON.stringify(returned),
						stderr: "",
						outputTruncated: false,
						cleanupVerified: false,
					}
				},
			}),
	)
	assert.equal(captured.status, "incomplete")
	assert.equal(captured.contextDigest, state.contextDigest)
})

test("structural terminal comparison still rejects changed nested receipt data", async (t) => {
	const f = await fixture(t)
	const state = await f.prepare()
	await assert.rejects(
		finalizeImprovementCapture(
			{
				state,
				result: outcome(state),
				taskIds: [],
				workflowResultPath: path.join(f.artifactDirectory, "workflow-result.json"),
			},
			(phase, inputPath, signal) =>
				invokeImprovementCapture(phase, inputPath, signal, {
					runProcess: async () => {
						const receipt = {
							schemaVersion: 1,
							kind: "alpha-native-host-capture-result",
							status: "incomplete",
							contextPath: state.contextPath,
							contextDigest: state.contextDigest,
							captureResultPath: path.join(path.dirname(inputPath), "capture-result.json"),
							integrity: { valid: false, issues: [{ code: "artifact_missing", detail: "transcript" }] },
						}
						await fs.writeFile(receipt.captureResultPath, JSON.stringify(receipt), { flag: "wx" })
						return {
							exitCode: 0,
							signal: null,
							stdout: JSON.stringify({ ...receipt, integrity: { ...receipt.integrity, valid: true } }),
							stderr: "",
							outputTruncated: false,
							cleanupVerified: false,
						}
					},
				}),
		),
		(error: unknown) => error instanceof ImprovementCaptureHelperError && !error.cleanupVerified,
	)
})

test("pre-aborted helpers never launch, and rejected owned cleanup remains a sanitized typed failure", async (t) => {
	const f = await fixture(t)
	const cancellation = new AbortController()
	cancellation.abort()
	let launches = 0
	await assert.rejects(
		invokeImprovementCapture("prepare", "unused", cancellation.signal, {
			runProcess: async () => {
				launches++
				throw new Error("must not launch")
			},
		}),
		(error: unknown) =>
			error instanceof ImprovementCaptureHelperError && error.cleanupVerified && error.code === "host-cancelled",
	)
	assert.equal(launches, 0)
	await assert.rejects(
		invokeImprovementCapture("prepare", path.join(f.artifactDirectory, "input.json"), undefined, {
			runProcess: async () => {
				throw Object.assign(new Error("RAW_PROVIDER_SECRET"), { cleanupVerified: false })
			},
		}),
		(error: unknown) => {
			assert.ok(error instanceof ImprovementCaptureHelperError)
			assert.equal(error.cleanupVerified, false)
			assert.equal(error.message.includes("RAW_PROVIDER_SECRET"), false)
			return true
		},
	)
})

test("prepare and terminal capture forward the caller signal without losing cleanup classification", async (t) => {
	const f = await fixture(t)
	const cancellation = new AbortController()
	const state = await prepareImprovementCapture(
		{ ...f.prepareInput, options: { ...f.options, signal: cancellation.signal } },
		async (_phase, inputPath, signal) => {
			assert.equal(signal, cancellation.signal)
			const contextPath = path.join(path.dirname(inputPath), "context.json")
			await fs.writeFile(contextPath, "{}")
			return { contextPath, contextDigest: `sha256:${"a".repeat(64)}` }
		},
	)
	assert.ok(state)
	await assert.rejects(
		finalizeImprovementCapture(
			{
				state,
				result: outcome(state),
				taskIds: [],
				workflowResultPath: path.join(f.artifactDirectory, "workflow-result.json"),
				signal: cancellation.signal,
			},
			async (_phase, _file, signal) => {
				assert.equal(signal, cancellation.signal)
				throw new ImprovementCaptureHelperError(false, true)
			},
		),
		(error: unknown) =>
			error instanceof ImprovementCaptureHelperError && !error.cleanupVerified && error.code === "host-cancelled",
	)
})

test("real owned helper cancellation awaits the helper and its spawned child", { timeout: 20_000 }, async (t) => {
	const f = await fixture(t)
	const cancellation = new AbortController()
	const readyPath = path.join(f.artifactDirectory, "helper-ready.json")
	let ready!: (value: { pid: number; childPid: number }) => void
	let failed!: (error: Error) => void
	const started = new Promise<{ pid: number; childPid: number }>((resolve, reject) => {
		ready = resolve
		failed = reject
	})
	const deadline = setTimeout(
		() => failed(new Error("Owned helper startup did not reach its readiness barrier")),
		10_000,
	)
	const watcher = watch(f.artifactDirectory, (_event, file) => {
		if (String(file) !== path.basename(readyPath)) return
		void fs.readFile(readyPath, "utf8").then(
			(value) => ready(JSON.parse(value)),
			() => undefined,
		)
	})
	const script = [
		"const { spawn } = require('node:child_process')",
		"const fs = require('node:fs')",
		"const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore',windowsHide:true})",
		// The fixture owns reaping its child; the runner can prove physical exit,
		// but cannot control when init reaps a deliberately orphaned descendant.
		"let cancelled = false",
		"child.once('close', () => { if (cancelled) process.exit(0) })",
		"process.once('SIGTERM', () => { cancelled = true; if (child.exitCode !== null || child.signalCode !== null) process.exit(0); else child.kill('SIGTERM') })",
		"child.once('spawn', () => { fs.writeFileSync(process.argv[1]+'.tmp', JSON.stringify({pid:process.pid,childPid:child.pid})); fs.renameSync(process.argv[1]+'.tmp', process.argv[1]) })",
		"setInterval(() => {}, 1000)",
	].join(";\n")
	const pending = invokeImprovementCapture(
		"prepare",
		path.join(f.artifactDirectory, "unused.json"),
		cancellation.signal,
		{
			runProcess: async (_command, options) =>
				runOwnedProcess(
					{ executable: process.execPath, args: ["-e", script, readyPath], cwd: f.artifactDirectory },
					options,
				),
		},
	).then(
		() => new Error("Cancelled helper unexpectedly completed"),
		(error: unknown) => error,
	)
	try {
		const owned = await started
		clearTimeout(deadline)
		cancellation.abort()
		const error = await pending
		assert.ok(error instanceof ImprovementCaptureHelperError)
		assert.equal(error.code, "host-cancelled")
		assert.equal(error.cleanupVerified, true)
		for (const pid of [owned.pid, owned.childPid])
			assert.throws(
				() => process.kill(pid, 0),
				(failure: unknown) => (failure as NodeJS.ErrnoException).code === "ESRCH",
			)
	} finally {
		clearTimeout(deadline)
		watcher.close()
		cancellation.abort()
		await pending
	}
})
