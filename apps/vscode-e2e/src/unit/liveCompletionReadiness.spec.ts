import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { getEventListeners } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { setImmediate as nextTurn } from "node:timers/promises"

import type { AlphaCodeAPI, ModelProbeResult } from "@alpha-code/types"
import type { LanguageModelChat } from "vscode"

import { discoverLiveCopilotModels } from "../liveModelSelection"
import {
	runLiveCopilotPreflight,
	runPersistentLiveSetup,
	type LiveSetupAction,
	type LiveSetupState,
} from "../suite/liveCopilot"

const model = { vendor: "copilot", family: "gpt-6-luna", id: "gpt-6-luna" } as LanguageModelChat
const completed: ModelProbeResult = {
	status: "completed",
	requests: 1,
	modelId: model.id,
	firstTextMs: 1,
	wallMs: 2,
	usage: null,
	failureCode: null,
}
const failed: ModelProbeResult = {
	...completed,
	status: "failed",
	firstTextMs: null,
	failureCode: "cancelled_or_deadline",
	requestPhase: "request-admission",
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => (resolve = done))
	return { promise, resolve }
}

function fixture(probe: (signal?: AbortSignal) => Promise<ModelProbeResult>) {
	let probes = 0
	let configurations = 0
	const vscode = {
		extensions: { getExtension: () => ({ isActive: true }) },
		lm: {
			onDidChangeChatModels: () => ({ dispose() {} }),
			selectChatModels: async () => [model],
		},
	} as unknown as typeof import("vscode")
	const api = {
		getConfiguration: () => ({}),
		setConfiguration: async () => configurations++,
		probeModel: (signal?: AbortSignal) => {
			probes++
			return probe(signal)
		},
	} as unknown as AlphaCodeAPI
	return {
		api,
		dependencies: { loadVsCode: async () => vscode, canSendRequest: () => true },
		state: () => ({ probes, configurations }),
	}
}

test("setup cannot trust the 1.138 access API when the actual Alpha request fails", async () => {
	const host = fixture(async () => failed)
	const result = await runLiveCopilotPreflight(host.api, { modelId: model.id, setup: true }, host.dependencies)
	assert.equal(result.auth.canSendRequest, true)
	assert.equal(result.ready, false)
	assert.equal(result.ok, false)
	assert.deepEqual(result.error, { code: "completion-unavailable" })
	assert.equal(host.state().probes, 1)
})

test("setup requires one completed request from the selected Alpha model", async () => {
	const host = fixture(async () => completed)
	const result = await runLiveCopilotPreflight(host.api, { modelId: model.id, setup: true }, host.dependencies)
	assert.equal(result.ready, true)
	assert.equal(host.state().probes, 1)
})

test("a completed request from another model cannot establish setup readiness", async () => {
	const host = fixture(async () => ({ ...completed, modelId: "another-model" }))
	const result = await runLiveCopilotPreflight(host.api, { modelId: model.id, setup: true }, host.dependencies)
	assert.equal(result.ready, false)
	assert.deepEqual(result.error, { code: "completion-unavailable" })
	assert.equal(host.state().probes, 1)
})

test("completion metadata without an executed request cannot establish setup readiness", async () => {
	const host = fixture(async () => ({ ...completed, requests: 0 }))
	const result = await runLiveCopilotPreflight(host.api, { modelId: model.id, setup: true }, host.dependencies)
	assert.equal(result.ready, false)
	assert.deepEqual(result.error, { code: "completion-unavailable" })
})

test("an older Alpha without the readiness API leaves setup unready", async () => {
	const host = fixture(async () => assert.fail("an absent probe cannot execute"))
	delete host.api.probeModel
	const result = await runLiveCopilotPreflight(host.api, { modelId: model.id, setup: true }, host.dependencies)
	assert.equal(result.ready, false)
	assert.deepEqual(result.error, { code: "completion-unavailable" })
	assert.equal(host.state().probes, 0)
})

test("automatic runs remain blocked on failed actual completion", async () => {
	const host = fixture(async () => failed)
	await assert.rejects(runLiveCopilotPreflight(host.api, { modelId: model.id }, host.dependencies), {
		code: "provider-unavailable",
	})
	assert.equal(host.state().probes, 1)
})

test("Continue admits a single actual Alpha request and Finish waits for its result", async () => {
	const probe = deferred<ModelProbeResult>()
	const host = fixture(() => probe.promise)
	let dispatch!: (action: LiveSetupAction) => void
	const states: LiveSetupState<{ ready: boolean }>[] = []
	const result = runPersistentLiveSetup(
		(signal) =>
			runLiveCopilotPreflight(host.api, { modelId: model.id, setup: true }, { ...host.dependencies, signal }),
		{
			onAction: (handler) => {
				dispatch = handler
				return { dispose() {} }
			},
			render: (state) => states.push(state),
		},
	)
	assert.equal(host.state().probes, 0)
	dispatch("finish")
	dispatch("continue")
	dispatch("continue")
	await nextTurn()
	assert.equal(host.state().probes, 1)
	dispatch("finish")
	assert.equal(states.at(-1)?.phase, "checking")
	probe.resolve(completed)
	await nextTurn()
	assert.equal(states.at(-1)?.phase, "ready")
	dispatch("finish")
	assert.equal((await result).status, "finished")
	assert.equal(host.state().probes, 1)
})

test("cancel aborts the Alpha probe and prevents late readiness or probe artifact writes", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "alpha-live-completion-"))
	context.after(() => rm(directory, { recursive: true, force: true }))
	const probe = deferred<ModelProbeResult>()
	const admitted = deferred<void>()
	let requestSignal: AbortSignal | undefined
	const host = fixture((signal) => {
		requestSignal = signal
		admitted.resolve()
		return probe.promise
	})
	let dispatch!: (action: LiveSetupAction) => void
	const states: LiveSetupState<{ ready: boolean }>[] = []
	let disposed = 0
	const lifetime = new AbortController()
	const result = runPersistentLiveSetup(
		(signal) =>
			runLiveCopilotPreflight(
				host.api,
				{ modelId: model.id, setup: true, artifactsDir: directory },
				{ ...host.dependencies, signal },
			),
		{
			signal: lifetime.signal,
			onAction: (handler) => {
				dispatch = handler
				return { dispose: () => disposed++ }
			},
			render: (state) => states.push(state),
		},
	)
	dispatch("continue")
	await admitted.promise
	dispatch("cancel")
	assert.equal(requestSignal?.aborted, true)
	probe.resolve(completed)
	assert.deepEqual(await result, { status: "cancelled" })
	assert.equal(states.at(-1)?.phase, "checking")
	assert.equal(disposed, 1)
	assert.equal(getEventListeners(lifetime.signal, "abort").length, 0)
	assert.equal((await readdir(directory)).includes("live-completion-probe.json"), false)
})

test("a cancelled setup cannot configure or admit an actual request", async () => {
	const host = fixture(async () => assert.fail("cancelled setup cannot request"))
	const cancellation = new AbortController()
	cancellation.abort()
	await assert.rejects(
		runLiveCopilotPreflight(
			host.api,
			{ modelId: model.id, setup: true },
			{ ...host.dependencies, signal: cancellation.signal },
		),
		{ name: "AbortError" },
	)
	assert.deepEqual(host.state(), { probes: 0, configurations: 0 })
})

test("failed setup persists completion evidence and a nonready preflight without provider text", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "alpha-live-completion-"))
	context.after(() => rm(directory, { recursive: true, force: true }))
	const host = fixture(async () => failed)
	const result = await runLiveCopilotPreflight(
		host.api,
		{ modelId: model.id, setup: true, artifactsDir: directory },
		host.dependencies,
	)
	assert.equal(result.ready, false)
	const evidence = JSON.parse(await readFile(join(directory, "live-completion-probe.json"), "utf8"))
	assert.equal(evidence.purpose, "readiness")
	assert.equal(evidence.requests, 1)
	assert.equal(evidence.status, "failed")
	assert.equal(evidence.requestPhase, "request-admission")
	assert.equal(evidence.countsAsSolving, false)
	const preflight = JSON.parse(await readFile(join(directory, "live-copilot-preflight.json"), "utf8"))
	assert.equal(preflight.ready, false)
	assert.deepEqual(preflight.error, { code: "completion-unavailable" })
})

test("discovery without an exact model remains metadata only", async () => {
	const host = fixture(async () => assert.fail("discovery cannot call the Alpha probe"))
	const result = await discoverLiveCopilotModels({ setup: true }, host.dependencies)
	assert.equal(result.status, "available")
	assert.equal(host.state().configurations, 0)
	assert.equal(host.state().probes, 0)
})
