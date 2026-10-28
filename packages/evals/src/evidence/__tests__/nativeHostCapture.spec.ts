import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { ImprovementArtifactStore, privateArtifactStore } from "../../improvement/store"
import { sealFeedback } from "../../improvement/feedback"
import { ExecaHarnessProcessRunner } from "../../orchestration/processRunner"
import { canonicalJson, sha256 } from "../canonical"
import { evidenceBundleDigest, validateEvidenceBundle } from "../integrity"
import {
	finalizeNativeHostCapture,
	prepareNativeHostCapture,
	readNativeHostCapture,
	type NativeHostCaptureContext,
} from "../nativeHostCapture"
import type { EvidenceBundle } from "../types"

const roots: string[] = []
const repositoryRoot = fileURLToPath(new URL("../../../../..", import.meta.url))
const catalogRoot = path.join(repositoryRoot, "evals")
const startedAt = "2026-10-23T12:00:00.000Z"
const finishedAt = "2026-10-23T12:05:00.000Z"
const selectedTask = "native-task-1"
const marker = { schemaVersion: 1, purpose: "alpha-vscode-e2e" }
const json = async (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value) + "\n")
const jsonl = async (file: string, values: unknown[]) =>
	fs.writeFile(file, values.map((value) => JSON.stringify(value)).join("\n") + "\n")

function lifecycleRecords(output: string, tools = true) {
	const records = [
		{ type: "turn_started", payload: {} },
		...(tools
			? [
					{
						type: "tool_call_accepted",
						payload: {
							item: {
								type: "tool_call",
								toolCallId: "actual-test-call",
								name: "exec_command",
								arguments: { cmd: "node --test test/behavior.test.js" },
								status: "accepted",
							},
						},
					},
					{ type: "tool_effect_started", payload: { toolCallId: "actual-test-call" } },
					{
						type: "tool_result_recorded",
						payload: {
							item: { type: "tool_result", toolCallId: "actual-test-call", status: "error", output },
						},
					},
				]
			: []),
		{ type: "turn_completed", payload: {} },
	]
	return records.map((event, index) => ({
		version: 1,
		eventId: `lifecycle-${index + 1}`,
		taskId: selectedTask,
		runId: "lifecycle-run",
		turnId: "native-turn",
		occurredAt: Date.parse(finishedAt),
		sequence: index + 1,
		...event,
	}))
}

afterEach(async () => {
	for (const root of roots.splice(0)) {
		if (!path.basename(root).startsWith("alpha-native-capture-test-")) throw new Error("Invalid test cleanup owner")
		await fs.rm(root, { recursive: true, force: true })
	}
})

async function fixture(canonicalRoot = true) {
	const allocated = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-native-capture-test-"))
	const root = canonicalRoot ? await fs.realpath(allocated) : allocated
	roots.push(root)
	const workspace = path.join(root, "workspace")
	const profile = path.join(root, "profile")
	const userDataDir = path.join(profile, "1.138.0", "user-data")
	const artifacts = path.join(root, "artifacts")
	const hostRunId = "owned-native-run"
	const runDirectory = path.join(artifacts, hostRunId)
	const extensionRoot = path.join(root, "extension")
	for (const directory of [userDataDir, runDirectory, path.join(extensionRoot, "dist")])
		await fs.mkdir(directory, { recursive: true })
	await fs.cp(path.join(catalogRoot, "javascript", "repo-cache-invalidation"), workspace, { recursive: true })
	await json(path.join(workspace, ".alpha-e2e-owned.json"), { ...marker, kind: "workspace" })
	await json(path.join(profile, ".alpha-e2e-owned.json"), { ...marker, kind: "profile" })
	await json(path.join(artifacts, ".alpha-vscode-e2e-evidence-root.json"), {
		kind: "alpha-vscode-e2e-evidence-root",
		version: 1,
	})
	await json(path.join(runDirectory, ".alpha-vscode-e2e-evidence-run.json"), {
		kind: "alpha-vscode-e2e-run",
		version: 1,
		runId: hostRunId,
	})
	await fs.writeFile(path.join(extensionRoot, "dist", "extension.js"), "module.exports.activate = () => {}\n")
	await json(path.join(extensionRoot, "package.json"), { name: "alpha", version: "1.0.0" })
	const prepare = {
		schemaVersion: 1,
		kind: "alpha-native-host-capture-prepare",
		hostRunId,
		runDirectory,
		workspace,
		catalogRoot,
		taskId: "repo-cache-invalidation@1",
		extensionRoot,
		repositoryRoot,
		userDataDir,
		extensionId: "Alpha.alpha",
		startedAt,
	}
	return { root, prepare, workspace, userDataDir, runDirectory, hostRunId, extensionRoot }
}

async function preparedFixture(
	beforePrepare?: (data: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
	canonicalRoot = true,
) {
	const data = await fixture(canonicalRoot)
	await beforePrepare?.(data)
	const runner = new ExecaHarnessProcessRunner()
	const prepared = await prepareNativeHostCapture(data.prepare, {
		processRunner: {
			run: async (spec) => {
				const result = await runner.run(spec)
				expect(result.exitCode, result.stderr).toBe(0)
				return result
			},
		},
	})
	const context = JSON.parse(await fs.readFile(prepared.contextPath, "utf8")) as NativeHostCaptureContext
	const storagePath = path.join(data.userDataDir, "User", "globalStorage", "alpha.alpha")
	const taskDirectory = path.join(storagePath, "tasks", selectedTask)
	const logsPath = path.join(data.userDataDir, "logs")
	await fs.mkdir(taskDirectory, { recursive: true })
	await fs.mkdir(logsPath, { recursive: true })
	const commandResult = await new ExecaHarnessProcessRunner().run({
		command: "node",
		args: ["--test", "test/behavior.test.js"],
		cwd: data.workspace,
		timeoutMs: 10_000,
		maxOutputBytes: 1024 * 1024,
	})
	expect(commandResult.exitCode).not.toBe(0)
	const history = [
		{ role: "user", content: "Observed public task prompt" },
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "actual-test-call",
					name: "exec_command",
					input: { cmd: "node --test test/behavior.test.js" },
				},
			],
		},
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "actual-test-call",
					content: commandResult.stdout + commandResult.stderr,
					is_error: true,
				},
			],
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "The original fixture test failed. This is retained harness evidence." }],
		},
	]
	await json(path.join(taskDirectory, "api_conversation_history.json"), history)
	await json(path.join(taskDirectory, "ui_messages.json"), [
		{ type: "say", say: "completion_result", text: "The original fixture test failed." },
	])
	await jsonl(
		path.join(taskDirectory, "agent_lifecycle_events.jsonl"),
		lifecycleRecords(commandResult.stdout + commandResult.stderr),
	)
	await jsonl(path.join(taskDirectory, "agent_turn_events.jsonl"), [
		{
			taskId: selectedTask,
			runId: "event-run",
			sequence: 1,
			timestamp: Date.parse(finishedAt),
			event: {
				type: "tool_result",
				callId: "actual-test-call",
				name: "exec_command",
				status: "error",
				output: commandResult.stdout + commandResult.stderr,
			},
		},
	])
	await fs.appendFile(path.join(logsPath, "exthost.log"), "Alpha extension host fixture test completed\n")
	const workflowResultPath = path.join(data.runDirectory, "workflow-result.json")
	const workflow = {
		schemaVersion: 1,
		runId: data.hostRunId,
		scenarioId: "problem-solving-attempt",
		phase: "run",
		status: "passed",
		taskIds: [selectedTask],
		hostVersion: "1.138.0",
		providerMode: "scripted",
		model: { id: "workflow-scripted-observed-id" },
		usage: { inputTokens: 123, outputTokens: 45, cost: null },
		checks: [{ name: "actual baseline test observed", passed: true }],
		requestsUsed: 2,
	}
	await json(workflowResultPath, workflow)
	const result = {
		status: "passed",
		execution: "extension-host",
		hostExitObserved: true,
		hostCleanupVerified: true,
		ownershipGate: "verified",
		actualVSCodeVersion: "1.138.0",
		providerMode: "scripted",
		userDataDir: data.userDataDir,
		extensionHostPid: 100,
		extensionHostParentPid: 99,
		hostCaptureClosure: {
			schemaVersion: 1,
			scope: "observed-owned-host-process-family",
			observedAt: finishedAt,
			cleanupVerified: true,
			source: "prior-owned-tree-cleanup",
			ownedPids: [99, 100],
			matchingProcessIds: [],
			unavailableCommandLines: 0,
		},
	}
	const finalize = {
		schemaVersion: 1,
		kind: "alpha-native-host-capture-finalize",
		contextPath: prepared.contextPath,
		expectedContextDigest: prepared.contextDigest,
		hostRunId: data.hostRunId,
		runDirectory: data.runDirectory,
		workspace: data.workspace,
		storagePath,
		logsPath,
		taskIds: [selectedTask],
		finishedAt,
		workflowResultPath,
		result,
	}
	const manifest = {
		kind: "alpha-vscode-e2e-run-evidence",
		version: 1,
		runId: data.hostRunId,
		finalized: true,
		metadata: {
			scenarioId: "problem-solving-attempt",
			hostVersion: "1.138.0",
			requestedHostVersion: "1.138.0",
			provider: "scripted",
			taskIds: [selectedTask],
			startedAt,
			finishedAt,
			outcome: "passed",
		},
		bundleSha256: context.build.bundleDigest.slice(7),
		captureComplete: true,
		artifacts: [],
		retainedSources: [],
		taskEvidence: [],
		warnings: [],
		summary: { category: "none", code: "PASS" },
	}
	const publishOutcome = async () =>
		json(path.join(data.runDirectory, "improvement", "host-outcome.json"), {
			schemaVersion: 1,
			kind: "alpha-native-host-outcome",
			hostRunId: data.hostRunId,
			contextPath: prepared.contextPath,
			expectedContextDigest: prepared.contextDigest,
			finishedAt,
			result,
		})
	await publishOutcome()
	await json(path.join(data.runDirectory, "manifest.json"), manifest)
	await json(path.join(data.runDirectory, "host-preflight.json"), {
		runId: data.hostRunId,
		actualVSCodeVersion: "1.138.0",
		status: "passed",
	})
	await json(path.join(data.runDirectory, "host-identity.json"), {
		runId: data.hostRunId,
		actualVSCodeVersion: "1.138.0",
		ownershipGate: "verified",
		pid: 100,
		ppid: 99,
	})
	await json(path.join(data.runDirectory, "improvement", "host-closure.json"), result.hostCaptureClosure)
	return {
		...data,
		prepared,
		context,
		storagePath,
		taskDirectory,
		logsPath,
		history,
		workflow,
		finalize,
		result,
		manifest,
		publishOutcome,
	}
}

describe("native host rich evidence capture", () => {
	it("keeps the private Git baseline settled before copying it into the agent workspace", async () => {
		const data = await fixture()
		const runner = new ExecaHarnessProcessRunner()
		const tracePath = path.join(data.root, "git-trace.jsonl")
		const prepared = await prepareNativeHostCapture(data.prepare, {
			processRunner: {
				run: (spec) => runner.run({ ...spec, env: { ...spec.env, GIT_TRACE2_EVENT: tracePath } }),
			},
		})
		const events = (await fs.readFile(tracePath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
		const automaticMaintenance = events.filter(
			(event) =>
				event.event === "child_start" &&
				Array.isArray(event.argv) &&
				event.argv.includes("--auto") &&
				(event.argv.includes("maintenance") || event.argv.includes("gc")),
		)
		expect(automaticMaintenance).toEqual([])
		const context = JSON.parse(await fs.readFile(prepared.contextPath, "utf8")) as NativeHostCaptureContext
		for (const directory of [context.baselineGitDirectory, path.join(data.workspace, ".git")]) {
			const identity = await runner.run({
				command: context.gitExecutable,
				args: ["--git-dir", directory, "rev-parse", "HEAD", "HEAD^{tree}"],
				cwd: data.workspace,
				timeoutMs: 10_000,
				maxOutputBytes: 4096,
			})
			expect(identity.exitCode, identity.stderr).toBe(0)
			expect(identity.stdout.trim().split(/\r?\n/)).toEqual([context.baselineCommit, context.baselineGitTree])
			expect(sha256(await fs.readFile(path.join(directory, "config")))).toBe(context.baselineConfigDigest)
		}
	})

	it("recognizes the bounded native history index without attributing its cached task IDs", async () => {
		const data = await preparedFixture(async (initial) => {
			const taskRoot = path.join(initial.userDataDir, "User", "globalStorage", "alpha.alpha", "tasks")
			await fs.mkdir(taskRoot, { recursive: true })
			await json(path.join(taskRoot, "_index.json"), {
				version: 1,
				updatedAt: Date.parse(startedAt),
				entries: [{ id: "cached-id-without-a-task-directory" }],
			})
		})
		expect(data.context.taskIdsBefore).toEqual([])
		const capture = await finalizeNativeHostCapture(data.finalize)
		expect(capture.status).toBe("captured")
		expect(capture.sources.some((source) => source.path.startsWith(`tasks/${selectedTask}/`))).toBe(true)
		expect(capture.sources.some((source) => source.path.includes("cached-id-without-a-task-directory"))).toBe(false)
		await expect(
			readNativeHostCapture({
				captureResultPath: capture.captureResultPath,
				sourceRoot: data.runDirectory,
			}),
		).resolves.toHaveProperty("bundle")
	})

	it.each(["unknown-file", "index-directory", "oversized-index", "linked-index", "hardlinked-index"] as const)(
		"rejects %s in the native task inventory",
		async (kind) => {
			const data = await fixture()
			const taskRoot = path.join(data.userDataDir, "User", "globalStorage", "alpha.alpha", "tasks")
			await fs.mkdir(taskRoot, { recursive: true })
			const index = path.join(taskRoot, "_index.json")
			if (kind === "unknown-file") await json(path.join(taskRoot, "unexpected.json"), {})
			else if (kind === "index-directory") await fs.mkdir(index)
			else if (kind === "oversized-index") await fs.writeFile(index, Buffer.alloc(1024 * 1024 + 1))
			else {
				const outside = path.join(data.root, "outside-index.json")
				await json(outside, { entries: [] })
				if (kind === "linked-index") await fs.symlink(outside, index, "file")
				else await fs.link(outside, index)
			}
			await expect(prepareNativeHostCapture(data.prepare)).rejects.toThrow()
			await expect(fs.stat(path.join(data.runDirectory, "improvement", "context.json"))).rejects.toMatchObject({
				code: "ENOENT",
			})
		},
	)

	it("captures and imports evidence through the platform's default temporary path spelling", async () => {
		const data = await preparedFixture(undefined, false)
		const capture = await finalizeNativeHostCapture(data.finalize)
		expect(capture.status).toBe("captured")
		await expect(
			readNativeHostCapture({ captureResultPath: capture.captureResultPath, sourceRoot: data.runDirectory }),
		).resolves.toHaveProperty("bundle")
	})

	it("accepts Git's canonical spelling of the same owned workspace", async () => {
		// Windows TEMP can use an 8.3 alias while Git reports the long filesystem name.
		const data = await fixture(false)
		const runner = new ExecaHarnessProcessRunner()
		let reportedRoot: string | undefined
		await expect(
			prepareNativeHostCapture(data.prepare, {
				processRunner: {
					run: async (spec) => {
						const result = await runner.run(spec)
						if (spec.args.includes("--show-toplevel")) reportedRoot = result.stdout.trim()
						return result
					},
				},
			}),
		).resolves.toHaveProperty("contextPath")
		expect(await fs.realpath(reportedRoot!)).toBe(await fs.realpath(data.workspace))
	})

	it("rejects an existing different directory reported as the Git workspace", async () => {
		const data = await fixture()
		const runner = new ExecaHarnessProcessRunner()
		await expect(
			prepareNativeHostCapture(data.prepare, {
				processRunner: {
					run: async (spec) => {
						const result = await runner.run(spec)
						return spec.args.includes("--show-toplevel")
							? { ...result, stdout: data.extensionRoot + "\n" }
							: result
					},
				},
			}),
		).rejects.toThrow(/clean isolated pre-agent baseline/)
	})

	it("composes actual failing test output, sealed original sources, private CAS, and feedback without a success-grade claim", async () => {
		const data = await preparedFixture()
		const capture = await finalizeNativeHostCapture(data.finalize)
		expect(capture).toMatchObject({
			status: "captured",
			missingArtifacts: [],
			integrity: { valid: true, issues: [] },
		})
		const imported = await readNativeHostCapture({
			captureResultPath: capture.captureResultPath,
			sourceRoot: data.runDirectory,
		})
		expect(imported.bundle).toMatchObject({
			runId: `native-host:${data.hostRunId}`,
			trialId: `native-host-trial:${data.hostRunId}`,
			attemptId: `native-host-attempt:${data.hostRunId}`,
		})
		expect(imported.runtimeManifest.fixtureDigest).toBe(imported.sourceTask.fixtureDigest)
		expect(imported.bundle.artifacts.every(({ access }) => access === "private")).toBe(true)
		const store = privateArtifactStore(imported.artifactsRoot)
		expect((await validateEvidenceBundle(imported.bundle, store, { requireWorkspaceSnapshot: true })).valid).toBe(
			true,
		)
		const test = imported.bundle.artifacts.find(({ kind }) => kind === "test_output")!
		const testOutput = JSON.parse(Buffer.from((await store.get(test))!).toString("utf8")) as {
			origin: string
			independentGrade: boolean
			receipts: Array<{ result: { content: string; is_error: boolean } }>
		}
		expect(testOutput).toMatchObject({ origin: "agent-tool-output", independentGrade: false })
		expect(testOutput.receipts[0]!.result).toMatchObject({ is_error: true })
		expect(testOutput.receipts[0]!.result.content).toContain("fail")
		const improvement = await ImprovementArtifactStore.open({
			root: path.join(data.root, "feedback-store"),
			iterationId: "native-original",
		})
		const bundle = await improvement.importEvidence(imported.bundle, imported.artifactsRoot)
		const feedback = await sealFeedback(
			{
				schemaVersion: 1,
				recordType: "feedback",
				id: "observed-failure",
				createdAt: finishedAt,
				source: { type: "human", reviewerId: "operator" },
				finding: "The retained test observes a stale derived value.",
				expectedBehavior: "The derived value updates after its source changes.",
				severity: "high",
				classification: "implementation-defect",
				evidence: {
					runId: bundle.runId,
					trialId: bundle.trialId,
					attemptId: bundle.attemptId,
					bundleDigest: bundle.bundleDigest!,
					artifactDigest: test.digest,
				},
			},
			{ bundle, store: improvement.artifacts },
		)
		expect(feedback.evidence.bundleDigest).toBe(capture.bundleDigest)
	})

	it("rejects fixture drift before baseline creation or any model can run", async () => {
		const data = await fixture()
		await fs.appendFile(path.join(data.workspace, "prompt.md"), "\nchanged instructions")
		await expect(prepareNativeHostCapture(data.prepare)).rejects.toThrow(/fixture/)
		await expect(fs.stat(path.join(data.workspace, ".git"))).rejects.toMatchObject({ code: "ENOENT" })
	})

	it.each([
		["minimum host profile", ["profile", "1.125.0", "user-data"]],
		["direct unversioned profile", ["profile", "user-data"]],
		["extra nested profile", ["profile", "1.138.0", "nested", "user-data"]],
		["sibling outside the owned profile", ["outside-profile", "1.138.0", "user-data"]],
	] as const)("rejects %s instead of searching arbitrary ancestors for ownership", async (_name, parts) => {
		const data = await fixture()
		const userDataDir = path.join(data.root, ...parts)
		await fs.mkdir(userDataDir, { recursive: true })
		await expect(prepareNativeHostCapture({ ...data.prepare, userDataDir })).rejects.toThrow()
		await expect(fs.stat(path.join(data.runDirectory, "improvement", "context.json"))).rejects.toMatchObject({
			code: "ENOENT",
		})
	})

	it("rejects a generic task or a lying pre-agent inventory", async () => {
		const data = await fixture()
		await expect(prepareNativeHostCapture({ ...data.prepare, taskId: "not-in-public-catalog" })).rejects.toThrow(
			/public benchmark/,
		)
		await expect(
			prepareNativeHostCapture({ ...data.prepare, taskIdsBefore: ["nonexistent-task"] }),
		).rejects.toThrow(/inventory/)
	})

	it.each(["hostExitObserved", "hostCleanupVerified", "ownershipGate", "actualVSCodeVersion"] as const)(
		"fails closed before source capture when %s differs from actual ownership",
		async (field) => {
			const data = await preparedFixture()
			const changed = {
				...data.result,
				[field]: ["hostExitObserved", "hostCleanupVerified"].includes(field)
					? false
					: field === "ownershipGate"
						? "unverified"
						: "1.125.0",
			}
			const capture = await finalizeNativeHostCapture({ ...data.finalize, result: changed })
			expect(capture).toMatchObject({ status: "failed", sources: [] })
			expect(capture.bundlePath).toBeUndefined()
		},
	)

	it("rejects post-exit task identity substitution instead of reading another persisted task", async () => {
		const data = await preparedFixture()
		data.workflow.taskIds = ["old-profile-task"]
		await json(data.finalize.workflowResultPath, data.workflow)
		const capture = await finalizeNativeHostCapture(data.finalize)
		expect(capture.status).toBe("failed")
		expect(capture.sources.map(({ path: file }) => file)).toEqual(["workflow-result.json"])
	})

	it("retains missing original transcript bytes as incomplete and refuses offline import", async () => {
		const data = await preparedFixture()
		await fs.unlink(path.join(data.taskDirectory, "api_conversation_history.json"))
		const capture = await finalizeNativeHostCapture(data.finalize)
		expect(capture.status).toBe("incomplete")
		expect(capture.missingArtifacts).toContain("transcript")
		expect(capture.sources).toContainEqual({
			path: `tasks/${selectedTask}/api_conversation_history.json`,
			status: "missing",
		})
		await expect(
			readNativeHostCapture({ captureResultPath: capture.captureResultPath, sourceRoot: data.runDirectory }),
		).rejects.toThrow(/incomplete/)
	})

	it("does not substitute ordinary command output for a trusted validation receipt", async () => {
		const data = await preparedFixture()
		;(data.history[1]!.content as Array<{ input: { cmd: string } }>)[0]!.input.cmd = "node -p process.version"
		await json(path.join(data.taskDirectory, "api_conversation_history.json"), data.history)
		const capture = await finalizeNativeHostCapture(data.finalize)
		expect(capture.status).toBe("incomplete")
		expect(capture.missingArtifacts).toContain("test_output")
	})

	it("preserves cancellation and missing workflow attribution without making a completed-attempt claim", async () => {
		const data = await preparedFixture()
		await fs.unlink(data.finalize.workflowResultPath)
		const result = {
			...data.result,
			status: "cancelled",
			failure: "host-cancelled",
			actualModelId: "observed-model-before-cancel",
		}
		await json(path.join(data.runDirectory, "host-preflight.json"), {
			runId: data.hostRunId,
			actualVSCodeVersion: "1.138.0",
			status: "passed",
			actualModelId: result.actualModelId,
		})
		await json(path.join(data.runDirectory, "manifest.json"), {
			...data.manifest,
			metadata: { ...data.manifest.metadata, taskIds: [], outcome: "cancelled", modelId: result.actualModelId },
		})
		await json(path.join(data.runDirectory, "improvement", "host-outcome.json"), {
			schemaVersion: 1,
			kind: "alpha-native-host-outcome",
			hostRunId: data.hostRunId,
			contextPath: data.prepared.contextPath,
			expectedContextDigest: data.prepared.contextDigest,
			finishedAt,
			result,
		})
		const capture = await finalizeNativeHostCapture({ ...data.finalize, taskIds: [], result })
		expect(capture.status).toBe("incomplete")
		expect(capture.missingArtifacts).toContain("workflow-result.json")
		const bundle = JSON.parse(await fs.readFile(capture.bundlePath!, "utf8")) as EvidenceBundle
		const stop = await privateArtifactStore(capture.artifactsRoot!).get(
			bundle.artifacts.find(({ kind }) => kind === "stop_reason")!,
		)
		expect(Buffer.from(stop!).toString("utf8")).toContain("host-cancelled")
	})

	it("redacts known and credential-shaped secrets before writing any rich artifact", async () => {
		const data = await preparedFixture()
		const secret = "private-observed-tool-result-secret"
		const credential = `sk-proj-${"s".repeat(32)}`
		await fs.writeFile(
			path.join(data.logsPath, "exthost.log"),
			`Authorization: Bearer ${"a".repeat(24)} ${secret} ${credential}`,
		)
		;(data.history[3]!.content as Array<{ text: string }>)[0]!.text += ` ${secret} ${credential}`
		await json(path.join(data.taskDirectory, "api_conversation_history.json"), data.history)
		const capture = await finalizeNativeHostCapture(data.finalize, { secrets: [secret] })
		expect(capture.status).toBe("captured")
		const imported = await readNativeHostCapture({
			captureResultPath: capture.captureResultPath,
			sourceRoot: data.runDirectory,
			secrets: [secret],
		})
		for (const artifact of imported.bundle.artifacts) {
			const bytes = await privateArtifactStore(imported.artifactsRoot, [secret]).get(artifact)
			const text = Buffer.from(bytes!).toString("utf8")
			expect(text).not.toContain(secret)
			expect(text).not.toContain(credential)
		}
	})

	it("does not hide a workspace secret in base64 snapshot bytes", async () => {
		const data = await preparedFixture()
		const secret = "workspace-private-secret-material"
		await fs.writeFile(path.join(data.workspace, "sensitive.txt"), secret)
		const capture = await finalizeNativeHostCapture(data.finalize, { secrets: [secret] })
		expect(capture.status).toBe("incomplete")
		expect(capture.missingArtifacts).toContain("tree_digest")
		const bundle = JSON.parse(await fs.readFile(capture.bundlePath!, "utf8")) as EvidenceBundle
		expect(bundle.artifacts.some(({ kind }) => kind === "workspace_snapshot")).toBe(false)
	})

	it("rejects modified context seals, private CAS bytes, and manifest artifact hashes", async () => {
		const data = await preparedFixture()
		const capture = await finalizeNativeHostCapture(data.finalize)
		const context = JSON.parse(await fs.readFile(data.prepared.contextPath, "utf8")) as NativeHostCaptureContext
		await json(data.prepared.contextPath, { ...context, hostRunId: "substituted-host" })
		await expect(
			readNativeHostCapture({ captureResultPath: capture.captureResultPath, sourceRoot: data.runDirectory }),
		).rejects.toThrow(/seal/)
		await json(data.prepared.contextPath, context)
		const bundle = JSON.parse(await fs.readFile(capture.bundlePath!, "utf8")) as EvidenceBundle
		const artifact = bundle.artifacts.find(({ kind }) => kind === "transcript")!
		const hex = artifact.digest.slice(7)
		await fs.writeFile(path.join(capture.artifactsRoot!, "sha256", hex.slice(0, 2), hex), "tampered private bytes")
		await expect(
			readNativeHostCapture({ captureResultPath: capture.captureResultPath, sourceRoot: data.runDirectory }),
		).rejects.toThrow()
	})

	it("checks retained manifest bytes and a same-run journal's exact task ID", async () => {
		const data = await preparedFixture()
		await fs.writeFile(
			path.join(data.taskDirectory, "agent_turn_events.jsonl"),
			JSON.stringify({ taskId: "other-task", sequence: 1 }) + "\n",
		)
		const capture = await finalizeNativeHostCapture(data.finalize)
		expect(capture.status).toBe("failed")
		const second = await preparedFixture()
		await fs.writeFile(path.join(second.runDirectory, "retained.json"), "observed retained data")
		await json(path.join(second.runDirectory, "manifest.json"), {
			...second.manifest,
			artifacts: [{ path: "retained.json", bytes: 22, sha256: sha256("different bytes").slice(7) }],
		})
		expect((await finalizeNativeHostCapture(second.finalize)).status).toBe("failed")
	})

	it("aborts before reads or publication and rejects an external result path", async () => {
		const data = await fixture()
		const controller = new AbortController()
		controller.abort(new Error("operator capture cancelled"))
		await expect(prepareNativeHostCapture(data.prepare, { signal: controller.signal })).rejects.toThrow(/cancelled/)
		await expect(
			readNativeHostCapture({
				captureResultPath: path.join(data.root, "other.json"),
				sourceRoot: data.runDirectory,
			}),
		).rejects.toThrow(/escaped/)
	})

	it("seals every result's completeness state", async () => {
		const data = await preparedFixture()
		const capture = await finalizeNativeHostCapture(data.finalize)
		const { digest, ...body } = capture
		expect(digest).toBe(sha256(canonicalJson(body)))
		await json(capture.captureResultPath, { ...capture, missingArtifacts: ["transcript"] })
		await expect(
			readNativeHostCapture({ captureResultPath: capture.captureResultPath, sourceRoot: data.runDirectory }),
		).rejects.toThrow(/seal/)
		const inconsistent = { ...body, missingArtifacts: ["transcript"] }
		await json(capture.captureResultPath, { ...inconsistent, digest: sha256(canonicalJson(inconsistent)) })
		await expect(
			readNativeHostCapture({ captureResultPath: capture.captureResultPath, sourceRoot: data.runDirectory }),
		).rejects.toThrow(/incomplete/)
	})

	it("rejects a replaced and resealed pre-agent context against the retained parent anchor", async () => {
		const data = await preparedFixture()
		const { digest: oldDigest, ...body } = data.context
		expect(oldDigest).toBe(data.prepared.contextDigest)
		const changed = { ...body, startedAt: "2026-10-23T11:59:00.000Z" }
		await json(data.prepared.contextPath, { ...changed, digest: sha256(canonicalJson(changed)) })
		await expect(finalizeNativeHostCapture(data.finalize)).rejects.toThrow(/pre-agent context/)
		await expect(fs.stat(path.join(data.runDirectory, "improvement", "artifacts"))).rejects.toMatchObject({
			code: "ENOENT",
		})
	})

	it("does not execute model-supplied Git config or a workspace Git shadow executable", async () => {
		const data = await preparedFixture()
		const sentinel = path.join(data.workspace, "capture-side-effect.txt")
		const payload = "node -e \"require('fs').writeFileSync('capture-side-effect.txt','unauthorized')\""
		await fs.writeFile(
			path.join(data.workspace, ".git", "config"),
			`[core]\n\tfsmonitor = ${payload}\n[diff "capture-test"]\n\ttextconv = ${payload}\n[filter "capture-test"]\n\tclean = ${payload}\n`,
		)
		await fs.writeFile(
			path.join(data.workspace, ".gitattributes"),
			"src/*.js diff=capture-test filter=capture-test\n",
		)
		await fs.writeFile(
			path.join(data.workspace, "git.cmd"),
			"@echo unauthorized>capture-side-effect.txt\r\n@exit /b 0\r\n",
		)
		const capture = await finalizeNativeHostCapture(data.finalize)
		expect(capture.status).toBe("captured")
		await expect(fs.stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("captures only the attributable append tail of a pre-existing extension log", async () => {
		const canary = "prior-run-private-log-canary"
		const data = await preparedFixture(async (fixture) => {
			const logs = path.join(fixture.userDataDir, "logs")
			await fs.mkdir(logs)
			await fs.writeFile(path.join(logs, "exthost.log"), canary + "\n")
		})
		const capture = await finalizeNativeHostCapture(data.finalize)
		expect(capture.status).toBe("captured")
		const imported = await readNativeHostCapture({
			captureResultPath: capture.captureResultPath,
			sourceRoot: data.runDirectory,
		})
		const log = await privateArtifactStore(imported.artifactsRoot).get(
			imported.bundle.artifacts.find(({ kind }) => kind === "extension_log")!,
		)
		expect(Buffer.from(log!).toString("utf8")).toContain("fixture test completed")
		expect(Buffer.from(log!).toString("utf8")).not.toContain(canary)
	})

	it("marks replaced pre-existing logs incomplete instead of attributing prior content", async () => {
		const data = await preparedFixture(async (fixture) => {
			const logs = path.join(fixture.userDataDir, "logs")
			await fs.mkdir(logs)
			await fs.writeFile(path.join(logs, "exthost.log"), "earlier run\n")
		})
		await fs.writeFile(path.join(data.logsPath, "exthost.log"), "replaced log content\n")
		const capture = await finalizeNativeHostCapture(data.finalize)
		expect(capture.status).toBe("incomplete")
		expect(capture.missingArtifacts).toContain("extension_log")
	})

	it("bounds a model-created deep empty directory tree before snapshot enumeration", async () => {
		const data = await preparedFixture()
		await fs.mkdir(path.join(data.workspace, ...Array.from({ length: 35 }, () => "deep")), { recursive: true })
		const capture = await finalizeNativeHostCapture(data.finalize)
		expect(capture.status).toBe("incomplete")
		expect(capture.missingArtifacts).toContain("tree_digest")
	})

	it("rejects an inconsistent positive process closure receipt before raw source reads", async () => {
		const data = await preparedFixture()
		await json(path.join(data.runDirectory, "improvement", "host-closure.json"), {
			...data.result.hostCaptureClosure,
			cleanupVerified: false,
		})
		const capture = await finalizeNativeHostCapture(data.finalize)
		expect(capture).toMatchObject({ status: "failed", sources: [] })
	})

	it.each(["agent_lifecycle_events.jsonl", "agent_turn_events.jsonl", "ui_messages.json"])(
		"retains empty %s privately without declaring a complete trace",
		async (file) => {
			const data = await preparedFixture()
			await fs.writeFile(path.join(data.taskDirectory, file), file.endsWith("jsonl") ? "\n" : "[]")
			const capture = await finalizeNativeHostCapture(data.finalize)
			expect(capture.status).toBe("incomplete")
			expect(capture.missingArtifacts.some((kind) => kind.startsWith("native_trace:"))).toBe(true)
			await expect(
				readNativeHostCapture({ captureResultPath: capture.captureResultPath, sourceRoot: data.runDirectory }),
			).rejects.toThrow(/incomplete/)
		},
	)

	it("retains an unpaired tool call as incomplete trace evidence", async () => {
		const data = await preparedFixture()
		data.history.splice(3, 0, {
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "unreceipted-call",
					name: "exec_command",
					input: { cmd: "node -p process.version" },
				},
			],
		})
		await json(path.join(data.taskDirectory, "api_conversation_history.json"), data.history)
		const capture = await finalizeNativeHostCapture(data.finalize)
		expect(capture.status).toBe("incomplete")
		expect(capture.missingArtifacts).toContain("native_trace:missing_tool_result")
	})

	it("rejects a missing lifecycle transition and a turn journal sequence gap as complete traces", async () => {
		const data = await preparedFixture()
		await jsonl(
			path.join(data.taskDirectory, "agent_lifecycle_events.jsonl"),
			lifecycleRecords("observed output").slice(1),
		)
		await jsonl(path.join(data.taskDirectory, "agent_turn_events.jsonl"), [
			{ taskId: selectedTask, runId: "event-run", sequence: 2, event: { type: "model_request_started" } },
		])
		const capture = await finalizeNativeHostCapture(data.finalize)
		expect(capture.status).toBe("incomplete")
		expect(capture.missingArtifacts).toContain("native_trace:turn_journal_sequence_invalid")
	})

	it("accepts a text-only terminal trace without inventing tool transactions or validation output", async () => {
		const data = await preparedFixture()
		await json(path.join(data.taskDirectory, "api_conversation_history.json"), [data.history[0], data.history[3]])
		await jsonl(path.join(data.taskDirectory, "agent_lifecycle_events.jsonl"), lifecycleRecords("", false))
		await jsonl(path.join(data.taskDirectory, "agent_turn_events.jsonl"), [
			{ taskId: selectedTask, runId: "event-run", sequence: 1, event: { type: "task_completed" } },
		])
		const capture = await finalizeNativeHostCapture(data.finalize)
		expect(capture.status).toBe("incomplete")
		expect(capture.missingArtifacts).toEqual(["test_output"])
		const bundle = JSON.parse(await fs.readFile(capture.bundlePath!, "utf8")) as EvidenceBundle
		expect(bundle.artifacts.find(({ kind }) => kind === "final_response")?.captureStatus).toBe("captured")
	})

	it("binds observed reasoning effort to the native runtime variant identity", async () => {
		const variants: string[] = []
		for (const effort of ["low", "high"]) {
			const data = await preparedFixture()
			await json(data.finalize.workflowResultPath, {
				...data.workflow,
				model: { ...data.workflow.model, reasoningEffort: effort },
			})
			const capture = await finalizeNativeHostCapture(data.finalize)
			expect(capture.status).toBe("captured")
			variants.push(
				(JSON.parse(await fs.readFile(capture.bundlePath!, "utf8")) as EvidenceBundle).variantIdentity,
			)
		}
		expect(variants[0]).not.toBe(variants[1])
	})

	it("rejects contradictory observed task and host reasoning effort", async () => {
		const data = await preparedFixture()
		await json(data.finalize.workflowResultPath, {
			...data.workflow,
			model: { ...data.workflow.model, reasoningEffort: "high" },
		})
		const result = { ...data.result, actualReasoningEffort: "low" }
		await json(path.join(data.runDirectory, "host-preflight.json"), {
			runId: data.hostRunId,
			actualVSCodeVersion: "1.138.0",
			status: "passed",
			actualReasoningEffort: "low",
		})
		await json(path.join(data.runDirectory, "improvement", "host-outcome.json"), {
			schemaVersion: 1,
			kind: "alpha-native-host-outcome",
			hostRunId: data.hostRunId,
			contextPath: data.prepared.contextPath,
			expectedContextDigest: data.prepared.contextDigest,
			finishedAt,
			result,
		})
		expect((await finalizeNativeHostCapture({ ...data.finalize, result })).status).toBe("failed")
	})

	it("distinguishes observed provider builds and approval policies without making profile paths into variants", async () => {
		const variants: string[] = []
		for (const [build, policy] of [
			["a", "a"],
			["b", "a"],
			["a", "b"],
			["a", "a"],
		]) {
			const data = await preparedFixture()
			const snapshot = { id: "github.copilot-chat", version: "1.0.0", entrypointSha256: build!.repeat(64) }
			const result = {
				...data.result,
				providerMode: "live-copilot",
				actualModelId: "observed-copilot-model",
				actualReasoningEffort: "high",
				providerIdentity: { schemaVersion: 1, before: snapshot, after: snapshot, status: "unchanged" },
			}
			await json(data.finalize.workflowResultPath, {
				...data.workflow,
				providerMode: result.providerMode,
				model: { id: result.actualModelId, reasoningEffort: result.actualReasoningEffort },
				e2eApprovalPolicySha256: policy!.repeat(64),
			})
			await json(path.join(data.runDirectory, "manifest.json"), {
				...data.manifest,
				metadata: { ...data.manifest.metadata, provider: result.providerMode, modelId: result.actualModelId },
			})
			await json(path.join(data.runDirectory, "host-preflight.json"), { ...result, runId: data.hostRunId })
			await json(path.join(data.runDirectory, "improvement", "host-outcome.json"), {
				schemaVersion: 1,
				kind: "alpha-native-host-outcome",
				hostRunId: data.hostRunId,
				contextPath: data.prepared.contextPath,
				expectedContextDigest: data.prepared.contextDigest,
				finishedAt,
				result,
			})
			const capture = await finalizeNativeHostCapture({ ...data.finalize, result })
			expect(capture.status).toBe("captured")
			variants.push(
				(JSON.parse(await fs.readFile(capture.bundlePath!, "utf8")) as EvidenceBundle).variantIdentity,
			)
		}
		expect(new Set(variants).size).toBe(3)
		expect(variants[3]).toBe(variants[0])
	}, 60_000) // Four complete Git/Node captures; one Windows capture measured 9.1s.

	it("revalidates historical raw trace bytes even when generic seals and capture labels are consistent", async () => {
		const data = await preparedFixture()
		const capture = await finalizeNativeHostCapture(data.finalize)
		const bundle = JSON.parse(await fs.readFile(capture.bundlePath!, "utf8")) as EvidenceBundle
		const store = privateArtifactStore(capture.artifactsRoot!)
		const previous = bundle.artifacts.find(({ kind }) => kind === "other")!
		const raw = JSON.parse(Buffer.from((await store.get(previous))!).toString("utf8")) as Record<string, unknown>
		delete raw.traceInspection
		const replacement = await store.put({
			attemptId: bundle.attemptId,
			kind: "other",
			bytes: Buffer.from(canonicalJson({ ...raw, lifecycle: [] })),
			mediaType: "application/json",
			access: "private",
			captureStatus: "captured",
		})
		bundle.artifacts = bundle.artifacts.map((artifact) => (artifact === previous ? replacement : artifact))
		bundle.bundleDigest = evidenceBundleDigest(bundle)
		expect((await validateEvidenceBundle(bundle, store)).valid).toBe(true)
		await json(capture.bundlePath!, bundle)
		const { digest: _oldDigest, ...body } = capture
		const resealed = { ...body, bundleDigest: bundle.bundleDigest }
		await json(capture.captureResultPath, { ...resealed, digest: sha256(canonicalJson(resealed)) })
		await expect(
			readNativeHostCapture({ captureResultPath: capture.captureResultPath, sourceRoot: data.runDirectory }),
		).rejects.toThrow(/retained trace is incomplete/)
	})
})
