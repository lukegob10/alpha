import assert from "node:assert/strict"
import { test } from "node:test"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { executedExperimentCaptureSchema, NATIVE_BUILD_SOURCE_ASSOCIATION_SCOPE } from "@alpha-code/types"
import {
	NativeExperimentCapture,
	observedFinalExperimentResponse,
	observedModelSettingsDigest,
	readExperimentTaskLabel,
	readNativeExperimentContext,
	snapshotExperimentWorkspace,
	writeExperimentArtifact,
} from "./experimentIdentity"
import { prepareEvidenceRun } from "./paths"
import { guardVsCodeLmHandler, WorkflowRequestBudget } from "../scenarios/requestBudget"
import { readProblemPrompt, validateProblemPromptPath } from "../scenarios/problemPrompt"

const digest = (character: string) => `sha256:${character.repeat(64)}`
const proof = () => ({
	status: "verified" as const,
	manifestDigest: "a".repeat(64),
	sourceRevision: "b".repeat(40),
	sourceTreeDigest: "c".repeat(64),
	artifactTreeDigest: "d".repeat(64),
	entrypointSha256: "e".repeat(64),
	packageJsonSha256: "f".repeat(64),
	sourceAssociation: NATIVE_BUILD_SOURCE_ASSOCIATION_SCOPE,
	missing: [],
})

async function fixture(t: { after(callback: () => Promise<void>): void }) {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "native-experiment-"))
	t.after(async () => {
		assert(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep))
		await fs.rm(temporary, { recursive: true, force: true })
	})
	const workspace = path.join(temporary, "workspace")
	await fs.mkdir(workspace)
	await fs.writeFile(path.join(workspace, "README.md"), "Public task prompt\n")
	await fs.mkdir(path.join(workspace, "src"))
	await fs.writeFile(path.join(workspace, "src", "main.js"), "export const value = 1\n")
	const snapshot = await snapshotExperimentWorkspace(workspace)
	await fs.writeFile(
		path.join(workspace, ".alpha-e2e-owned.json"),
		JSON.stringify({ schemaVersion: 1, purpose: "alpha-vscode-e2e", kind: "workspace" }),
	)
	const run = await prepareEvidenceRun({ artifactsRoot: path.join(temporary, "artifacts"), runId: "attempt" })
	const options = {
		runDirectory: run.artifactDirectory,
		attemptId: "attempt",
		task: { id: "sample", version: 1, digest: snapshot.fixtureDigest },
		assignmentDigest: digest("0"),
		pairDigest: digest("1"),
		extensionPath: temporary,
		hostVersion: "1.138.0",
		prelaunchBuildManifestDigest: digest("a"),
		providerMode: "live-copilot" as const,
		requestLimit: 10,
		scenarioTimeoutMs: 60_000,
		workspace,
	}
	return { temporary, workspace, snapshot, options }
}

const capturePorts = {
	verifyBuild: async () => proof(),
	captureRunnerDigest: async () => digest("3"),
	captureProviderDigest: async () => digest("5"),
}

function observe(capture: NativeExperimentCapture) {
	capture.onConfiguration(
		{ mode: "code", apiKey: "must-not-be-retained", requestDelaySeconds: 0, commandExecutionTimeout: 60 },
		"2".repeat(64),
	)
	capture.onTaskPrompt("Public task prompt\n")
	const messages = Object.freeze([
		Object.freeze({ role: 1, content: Object.freeze([Object.freeze({ value: "Private actual wire content" })]) }),
	])
	const options = Object.freeze({
		tools: Object.freeze([Object.freeze({ name: "exec_command", inputSchema: Object.freeze({ type: "object" }) })]),
		modelOptions: Object.freeze({ reasoningEffort: "high", temperature: 0.2 }),
	})
	capture.onTaskRequest(Object.freeze({ id: "observed-model" }), messages, options)
	assert.equal(messages[0]!.content[0]!.value, "Private actual wire content")
}

test("task labels and process context are bounded public declarations, not inferred identity", () => {
	assert.deepEqual(
		readExperimentTaskLabel({
			ALPHA_E2E_EXPERIMENT_TASK_JSON: JSON.stringify({ id: "sample", version: 2, digest: digest("a") }),
		}),
		{ id: "sample", version: 2, digest: digest("a") },
	)
	for (const value of [
		undefined,
		"{}",
		JSON.stringify({ id: "sample", version: 1.5, digest: digest("a") }),
		JSON.stringify({ id: "sample", version: 1, digest: digest("a"), observedVariant: {} }),
	])
		assert.throws(() => readExperimentTaskLabel({ ALPHA_E2E_EXPERIMENT_TASK_JSON: value }))
	assert.equal(readNativeExperimentContext({}), undefined)
	assert.throws(() => readNativeExperimentContext({ ALPHA_E2E_EXPERIMENT_CONTEXT_JSON: "{}" }))
})

test("actual generation options participate in the model settings identity", () => {
	assert.notEqual(
		observedModelSettingsDigest("model", "high", digest("a")),
		observedModelSettingsDigest("model", "high", digest("b")),
	)
	assert.notEqual(
		observedModelSettingsDigest("model", "high", digest("a")),
		observedModelSettingsDigest("model", "low", digest("a")),
	)
})

test("native capture binds real request observations and source-bound artifact closure without retaining content", async (t) => {
	const f = await fixture(t)
	const capture = new NativeExperimentCapture(f.options, capturePorts)
	await capture.prepare()
	observe(capture)
	const result = await capture.finalize()
	assert.equal(result.status, "captured")
	assert.equal(result.identityScope, "conservative-whole-source")
	assert.equal(result.conditionScopes?.alphaRuntimeRetries, "treatment")
	assert.equal(result.conditionScopes?.resourceEnvelope, "observed-native-host-without-os-envelope")
	assert.equal(result.observedVariant?.extensionBuildDigest, digest("d"))
	assert.equal(result.observedVariant?.model, "observed-model")
	assert.equal(result.observedVariant?.modelSettingsDigest, result.requests[0]?.modelSettingsDigest)
	assert.equal(result.observed.stagedFixtureDigest, f.snapshot.fixtureDigest)
	assert.equal(result.observed.initialWorkspaceDigest, f.snapshot.workspaceDigest)
	assert.equal(result.observed.stagedFixtureAlgorithm, "source-tree-pretty-json-v1")
	assert.equal(result.taskLabelAuthority, "controller-public-task-label")
	assert.equal(result.assignmentDigest, digest("0"))
	assert.equal(result.pairDigest, digest("1"))
	assert(!JSON.stringify(result).includes("Private actual wire content"))
	assert(!JSON.stringify(result).includes("must-not-be-retained"))
	assert.equal(result.processCoverage.sourceVersions, "unavailable")
	assert.deepEqual(
		executedExperimentCaptureSchema.parse(
			JSON.parse(await fs.readFile(path.join(f.options.runDirectory, "experiment-capture.json"), "utf8")),
		),
		result,
	)
	await assert.rejects(capture.persist(result), /exist/i)
})

test("missing build association, changed artifacts and source mismatch retain incomplete identity", async (t) => {
	for (const kind of ["missing", "changed", "workspace", "prelaunch"]) {
		const f = await fixture(t)
		let calls = 0
		const capture = new NativeExperimentCapture(
			{
				...f.options,
				...(kind === "workspace" ? { expectedWorkspaceDigest: digest("4") } : {}),
				...(kind === "prelaunch" ? { prelaunchBuildManifestDigest: undefined } : {}),
			},
			{
				...capturePorts,
				verifyBuild: async () =>
					kind === "missing"
						? { status: "unavailable", missing: ["build-provenance-unavailable"] }
						: {
								...proof(),
								...(kind === "changed" && calls++ > 0 ? { artifactTreeDigest: "0".repeat(64) } : {}),
							},
				captureRunnerDigest: async () => digest("3"),
			},
		)
		await capture.prepare()
		observe(capture)
		const result = await capture.finalize()
		assert.equal(result.status, "incomplete", kind)
		assert.equal(result.observedVariant, null)
		assert(result.missing.length > 0)
		assert.equal(result.observed.model, "observed-model")
	}
})

test("request settings drift, unobserved dispatch and scripted providers cannot mint live comparative identity", async (t) => {
	for (const kind of ["drift", "absent", "scripted"]) {
		const f = await fixture(t)
		const capture = new NativeExperimentCapture(
			{ ...f.options, ...(kind === "scripted" ? { providerMode: "scripted" as const } : {}) },
			capturePorts,
		)
		await capture.prepare()
		if (kind === "absent") {
			capture.onConfiguration({ commandExecutionTimeout: 60, requestDelaySeconds: 0 }, "2".repeat(64))
			capture.onTaskPrompt("Public task prompt\n")
		} else observe(capture)
		if (kind === "drift")
			capture.onTaskRequest({ id: "observed-model" }, [], { tools: [], modelOptions: { reasoningEffort: "low" } })
		const result = await capture.finalize()
		assert.equal(result.status, "incomplete")
		assert.equal(result.observedVariant, null)
		assert(
			result.missing.includes(
				kind === "drift"
					? "model-settings-changed-during-attempt"
					: kind === "absent"
						? "actual-provider-request-observation"
						: "live-provider-not-observed",
			),
		)
	}
})

test("identical executed harness settings retain one variant across different task and workspace instances", async (t) => {
	const variants = []
	for (const id of ["first-task", "second-task"]) {
		const f = await fixture(t)
		await fs.writeFile(path.join(f.workspace, "README.md"), id)
		const capture = new NativeExperimentCapture(
			{
				...f.options,
				task: { ...f.options.task, id },
				expectedWorkspaceDigest: (await snapshotExperimentWorkspace(f.workspace)).workspaceDigest,
			},
			capturePorts,
		)
		await capture.prepare()
		observe(capture)
		const result = await capture.finalize()
		assert.equal(result.status, "captured")
		variants.push(result.observedVariant)
	}
	assert.deepEqual(variants[0], variants[1])
})

test("provider or runner changes cannot preserve captured variant identity", async (t) => {
	for (const field of ["captureProviderDigest", "captureRunnerDigest"] as const) {
		const f = await fixture(t)
		let calls = 0
		const capture = new NativeExperimentCapture(f.options, {
			...capturePorts,
			[field]: async () => digest(calls++ === 0 ? "3" : "4"),
		})
		await capture.prepare()
		observe(capture)
		const result = await capture.finalize()
		assert.equal(result.status, "incomplete")
		assert.equal(result.observedVariant, null)
	}
})

test("product source treatments preserve measured external trial conditions while host budget changes do not", async (t) => {
	const variants = []
	for (const kind of ["baseline", "source-treatment", "host-budget"]) {
		const f = await fixture(t)
		const build =
			kind === "source-treatment"
				? {
						...proof(),
						sourceRevision: "1".repeat(40),
						sourceTreeDigest: "2".repeat(64),
						artifactTreeDigest: "3".repeat(64),
						manifestDigest: "4".repeat(64),
					}
				: proof()
		const capture = new NativeExperimentCapture(
			{
				...f.options,
				prelaunchBuildManifestDigest: `sha256:${build.manifestDigest}`,
				...(kind === "host-budget" ? { requestLimit: 11 } : {}),
			},
			{ ...capturePorts, verifyBuild: async () => build },
		)
		await capture.prepare()
		observe(capture)
		const result = await capture.finalize()
		assert.equal(result.status, "captured")
		variants.push(result.observedVariant!)
	}
	assert.notEqual(variants[0]!.toolImplementationDigest, variants[1]!.toolImplementationDigest)
	assert.equal(variants[0]!.resourceProfileDigest, variants[1]!.resourceProfileDigest)
	assert.equal(variants[0]!.retryPolicyDigest, variants[1]!.retryPolicyDigest)
	assert.notEqual(variants[0]!.resourceProfileDigest, variants[2]!.resourceProfileDigest)
	assert.notEqual(variants[0]!.retryPolicyDigest, variants[2]!.retryPolicyDigest)
})

test("source snapshots exclude only validated runner metadata and retain directory changes", async (t) => {
	const f = await fixture(t)
	assert.deepEqual(await snapshotExperimentWorkspace(f.workspace), f.snapshot)
	await fs.mkdir(path.join(f.workspace, "empty-directory"))
	assert.notEqual((await snapshotExperimentWorkspace(f.workspace)).workspaceDigest, f.snapshot.workspaceDigest)
	await fs.writeFile(
		path.join(f.workspace, ".alpha-e2e-owned.json"),
		JSON.stringify({ kind: "workspace", schemaVersion: 1, purpose: "alpha-vscode-e2e", hidden: "not-ignored" }),
	)
	await assert.rejects(snapshotExperimentWorkspace(f.workspace), /Invalid owned/)
})

test("prompt path selection accepts a protected public README and rejects portable path escapes", async (t) => {
	const f = await fixture(t)
	assert.equal(await readProblemPrompt(f.workspace, "README.md"), "Public task prompt\n")
	for (const file of [
		"../outside.md",
		"/absolute.md",
		"C:/outside.md",
		"folder\\README.md",
		"./README.md",
		"folder//README.md",
		"README.md:stream",
	])
		assert.throws(() => validateProblemPromptPath(file))
})

test("final answers come only from observed assistant text, without tool or commentary substitution", () => {
	assert.deepEqual(observedFinalExperimentResponse([{ role: "user", content: "A suggested answer" }]), {
		status: "unavailable",
	})
	assert.deepEqual(
		observedFinalExperimentResponse([{ role: "assistant", phase: "commentary", content: "Working" }]),
		{ status: "unavailable" },
	)
	assert.deepEqual(
		observedFinalExperimentResponse([
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Before tool" },
					{ type: "tool_use", id: "call" },
				],
			},
		]),
		{ status: "unavailable" },
	)
	assert.equal(
		observedFinalExperimentResponse([
			{ role: "assistant", phase: "final_answer", content: [{ type: "text", text: "Grounded answer" }] },
		]).status,
		"captured",
	)
})

test("dispatch observation runs only after budget admission, preserves the wire and cannot veto execution", async () => {
	let sent = 0,
		observed = 0
	const budget = new WorkflowRequestBudget(1, "model", "high")
	budget.onTaskDispatch = () => {
		observed++
		throw new Error("Observer must not affect dispatch")
	}
	const client = Object.freeze({
		id: "model",
		sendRequest: () => {
			sent++
			return {}
		},
	})
	const handler = { getClient: async () => client }
	const restore = guardVsCodeLmHandler(handler, budget)
	try {
		const guarded = await handler.getClient()
		const options = { modelOptions: { reasoningEffort: "high" } }
		;(guarded.sendRequest as (...args: unknown[]) => unknown)([], options)
		assert.equal(sent, 1)
		assert.equal(observed, 1)
		assert.equal(budget.dispatchObservationFailures, 1)
		assert.throws(
			() => (guarded.sendRequest as (...args: unknown[]) => unknown)([], options),
			/request_limit_reached/,
		)
		assert.equal(sent, 1)
		assert.equal(observed, 1)
	} finally {
		restore()
	}
})

test("native artifact writers never adopt foreign roots or overwrite prior results", async (t) => {
	const f = await fixture(t)
	await assert.rejects(writeExperimentArtifact(f.workspace, "attempt", "final-response.json", {}))
	await assert.rejects(writeExperimentArtifact(f.options.runDirectory, "attempt", "foreign.json", {}), /Unknown/)
	await writeExperimentArtifact(f.options.runDirectory, "attempt", "final-response.json", { status: "unavailable" })
	await assert.rejects(
		writeExperimentArtifact(f.options.runDirectory, "attempt", "final-response.json", {}),
		/exist/i,
	)
})
