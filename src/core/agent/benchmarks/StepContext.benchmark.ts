/** Run from the repository root: pnpm exec tsx src/core/agent/benchmarks/StepContext.benchmark.ts */
import { performance } from "node:perf_hooks"

import type { ModelInfo } from "@alpha-code/types"
import { AgentStepContextBuilder } from "../AgentStepContextBuilder"
import { type CreateStepContextInput, digestValue } from "../StepContext"

// Fixed synthetic request: no provider, filesystem, credentials, or network.
const messages = Array.from({ length: 200 }, (_, index) => ({
	role: "user" as const,
	content: `${index}: ${"sample output ".repeat(600)}`,
}))
const input: CreateStepContextInput = {
	contextId: "benchmark-context",
	createdAt: 0,
	kind: "agent",
	retryAttempt: 0,
	task: { taskId: "benchmark-task", cwd: "/workspace" },
	mode: { slug: "code" },
	provider: { modelId: "fixture", modelInfo: { contextWindow: 1_000_000 } as ModelInfo, options: {} },
	instructions: { systemPrompt: "fixed instructions ".repeat(1000), sources: [] },
	environment: { roots: ["/workspace"], capabilities: [] },
	transcript: { messages, boundary: { startIndex: 0, endIndex: 200, messageCount: 200, digest: "" } },
	tools: { schemas: [], parallelToolCalls: false, digest: "" },
	policy: {
		visibleTools: [],
		allowedTools: [],
		disabledTools: [],
		approval: { autoApprovalEnabled: false, liveRevalidation: true },
		capabilities: {},
		outputLimits: {},
		execution: {
			sandboxMode: "workspace-write",
			workspaceRoots: ["/workspace"],
			command: { allowedPrefixes: [], deniedPrefixes: [], userTimeoutMs: 0, timeoutAllowlist: [] },
			cancellation: "abort-process",
		},
		summary: "fixture",
		digest: "fixture-policy",
	},
	budget: { contextWindow: 1_000_000, compaction: { action: "none", attempted: false } },
	request: { metadata: { taskId: "benchmark-task", mode: "code" } },
}
const builder = new AgentStepContextBuilder()
const samples: number[] = []
let contextDigest: string | undefined
for (let iteration = 0; iteration < 13; iteration++) {
	const start = performance.now()
	const snapshot = builder.build(input)
	const durationMs = performance.now() - start
	if (contextDigest !== undefined && snapshot.digests.context !== contextDigest) {
		throw new Error("The fixed request produced inconsistent context digests")
	}
	contextDigest = snapshot.digests.context
	if (iteration >= 3) samples.push(durationMs)
}
const sorted = [...samples].sort((a, b) => a - b)
console.log(
	JSON.stringify(
		{
			node: process.version,
			fixtureBytes: Buffer.byteLength(JSON.stringify(input)),
			fixtureDigest: digestValue(input),
			contextDigest,
			warmups: 3,
			samplesMs: samples,
			medianMs: (sorted[4] + sorted[5]) / 2,
		},
		null,
		2,
	),
)
