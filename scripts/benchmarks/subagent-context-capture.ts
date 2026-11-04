import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"

import { captureSubagentContext, type CaptureSubagentContextInput } from "../../src/core/agent/SubagentContextCapture"
import type { ApiMessage } from "../../src/core/task-persistence/apiMessages"

// Run: pnpm exec tsx scripts/benchmarks/subagent-context-capture.ts
// This offline workload measures synchronous none-fork capture and transcript
// content reads. It does not include task admission, provider calls or token use.
const samples = 5
const capturesPerSample = 2
const messageCharacters = 4_096
const modelRoute = {
	source: "parent" as const,
	resolution: "selected" as const,
	profileName: "Fixture profile",
	provider: "openai",
	modelId: "fixture-model",
}
const base: Omit<CaptureSubagentContextInput, "history"> = {
	parentTaskId: "fixture-parent",
	capturedAt: 1,
	forkTurns: "none",
	instructions: {
		effectiveText: "Frozen fixture instructions",
		sources: [{ kind: "fixture", ref: "fixture:instructions", text: "Frozen fixture instructions" }],
	},
	skills: [],
	cwd: process.cwd(),
	workspaceRoots: [process.cwd()],
	modelRoute,
	runtimePolicy: {
		role: "review",
		read: true,
		execute: false,
		mutate: false,
		delegate: false,
		network: false,
		externalSideEffects: false,
		requireApproval: true,
		allowedTools: ["read_file"],
		workspaceRoots: [process.cwd()],
	},
}
const expected = captureSubagentContext({ ...base, history: [] })
const observations = []

for (const native of [false, true]) {
	for (const turns of [0, 100, 1_000]) {
		let contentReads = 0
		const history: ApiMessage[] = Array.from({ length: turns * 2 }, (_, index) => {
			const content = `Fixture evidence ${index} `.padEnd(messageCharacters, "x")
			return {
				role: index % 2 === 0 ? "user" : "assistant",
				get content() {
					contentReads++
					return content
				},
			}
		})
		const parentUtf8Bytes = Buffer.byteLength(JSON.stringify(history))
		const input: CaptureSubagentContextInput = {
			...base,
			history,
			...(native ? { historyInheritance: { parentModelRoute: modelRoute, preservePrefix: true } } : {}),
		}
		for (let warmup = 0; warmup < 2; warmup++) captureSubagentContext(input)
		contentReads = 0
		const sampleMs = []
		let result = expected
		for (let sample = 0; sample < samples; sample++) {
			const started = performance.now()
			for (let capture = 0; capture < capturesPerSample; capture++) result = captureSubagentContext(input)
			sampleMs.push((performance.now() - started) / capturesPerSample)
		}
		assert.deepEqual(result, expected, "Unselected history must not affect captured context or integrity refs")
		observations.push({
			native,
			turns,
			messages: history.length,
			parentUtf8Bytes,
			contentReads,
			captures: samples * capturesPerSample,
			meanCaptureMs: sampleMs.reduce((sum, duration) => sum + duration, 0) / samples,
			medianCaptureMs: [...sampleMs].sort((left, right) => left - right)[Math.floor(samples / 2)],
			manifestDigest: result.manifest.manifestDigest,
		})
	}
}

console.log(
	JSON.stringify(
		{
			benchmark: "subagent-none-context-capture",
			node: process.version,
			provider: "none",
			cache: "two warmup captures; no result cache",
			messageCharacters,
			samples,
			capturesPerSample,
			observations,
		},
		null,
		2,
	),
)
