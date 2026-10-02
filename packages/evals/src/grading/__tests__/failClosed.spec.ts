import { describe, expect, it, vi } from "vitest"

import { VirtualClock } from "../../testing/hostileRuntime"
import {
	aggregateGraderResults,
	createDefaultGraderRegistry,
	evidenceFromText,
	GraderRegistry,
	matchesGlob,
	type GraderContext,
	type GraderPlugin,
	type GraderResult,
	type GraderSpec,
} from "../index"

const base = { id: "gate", version: 1, hardGate: true, failureClass: "safety" as const }
const trace = [{ sequence: 1, type: "agent.turn.model_request_started", timestamp: "2026-10-02T00:00:00Z" }]
const command: GraderSpec = {
	...base,
	type: "command",
	commands: [{ command: "node", args: ["--test"] }],
	cwd: "workspace",
	timeoutMs: 100,
	maxOutputBytes: 1024,
}
const usage: GraderSpec = { ...base, type: "usage-policy", maxCostUsd: 1, maxModelCalls: 2, maxToolCalls: 2 }
const traceSpec: GraderSpec = {
	...base,
	type: "trace-assertion",
	assertions: [{ kind: "absent", eventType: "forbidden" }],
}

function context(overrides: Partial<GraderContext> = {}): GraderContext {
	return {
		workspaceRoot: process.cwd(),
		changedPaths: [],
		trace,
		usage: { costUsd: 0 },
		clock: new VirtualClock(),
		processRunner: {
			run: vi.fn(async () => ({
				exitCode: 0,
				stdout: "test diagnostics",
				stderr: "",
				durationMs: 1,
				timedOut: false,
				outputTruncated: false,
			})),
		},
		...overrides,
	}
}

describe("fail-closed grading evidence", () => {
	it("matches forbidden directories even when a filename contains a newline", () => {
		expect(matchesGlob("generated/hidden\nfile.js", "generated/**")).toBe(true)
	})
	it("keeps path-list evidence distinct from a single newline-bearing filename", async () => {
		const spec: GraderSpec = { ...base, type: "diff-policy", maxChangedFiles: 2 }
		const single = await createDefaultGraderRegistry().execute([spec], context({ changedPaths: ["a\nb"] }))
		const pair = await createDefaultGraderRegistry().execute([spec], context({ changedPaths: ["a", "b"] }))
		expect(single.results[0]!.evidence[0]!.digest).not.toBe(pair.results[0]!.evidence[0]!.digest)
	})
	it("cannot pass without a configured or executed grader", async () => {
		expect(aggregateGraderResults([])).toBe("grader_error")
		await expect(createDefaultGraderRegistry().execute([], context())).rejects.toThrow(/grader/i)
	})

	it.each([
		{ ...command, commands: [] },
		{ ...command, timeoutMs: 0 },
		{ ...command, maxOutputBytes: Number.NaN },
		{ ...base, type: "filesystem", assertions: [] },
		{ ...traceSpec, assertions: [] },
		{ ...usage, maxCostUsd: -1 },
		{ ...base, type: "diff-policy" },
		{ ...base, type: "static-analysis", files: [] },
	])("rejects an empty or invalid $type criterion before executing anything", async (spec) => {
		const ctx = context()
		await expect(createDefaultGraderRegistry().execute([spec as GraderSpec], ctx)).rejects.toThrow(/grader/i)
		expect(ctx.processRunner.run).not.toHaveBeenCalled()
	})

	it.each([
		{ status: "skipped" },
		{ graderId: "different-gate" },
		{ graderVersion: 2 },
		{ type: "filesystem" },
		{ hardGate: false },
		{ failureClass: "outcome" },
		{ evidence: [] },
		{ evidence: [{ id: "broken", kind: "report", mediaType: "text/plain", digest: "wrong", byteLength: -1 }] },
		{ diagnostics: [{ code: "failure", message: "failed", severity: "error" }] },
		{ error: "a failed operation" },
	])("rejects malformed or contradictory plugin evidence: %j", async (override) => {
		const plugin = {
			type: "command",
			execute: vi.fn(async () => ({
				graderId: base.id,
				graderVersion: base.version,
				type: "command",
				hardGate: true,
				failureClass: "safety",
				status: "passed",
				diagnostics: [],
				evidence: [evidenceFromText("receipt", "report", "observed")],
				...override,
			})),
		} as unknown as GraderPlugin
		const result = await new GraderRegistry().register(plugin).execute([command], context())
		expect(result.decision).toBe("grader_error")
		expect(result.results[0]).toMatchObject({
			graderId: base.id,
			graderVersion: 1,
			hardGate: true,
			failureClass: "safety",
			status: "error",
		})
	})

	it("does not aggregate an unknown or skipped result as a pass", () => {
		expect(aggregateGraderResults([{ status: "skipped" } as unknown as GraderResult])).toBe("grader_error")
	})

	it.each([null, {}, { status: "passed", evidence: [] }])(
		"rejects incomplete result envelopes during aggregation",
		(value) => {
			expect(aggregateGraderResults([value as unknown as GraderResult])).toBe("grader_error")
		},
	)

	it.each([undefined, {}, { costUsd: null }, { costUsd: -1 }, { costUsd: Number.NaN }, { totalCost: "0" }])(
		"does not replace unavailable or invalid cost with zero: %j",
		async (value) => {
			const result = await createDefaultGraderRegistry().execute([usage], context({ usage: value }))
			expect(result.decision).toBe("grader_error")
		},
	)

	it("preserves a measured zero cost with a verifiable usage receipt", async () => {
		const result = await createDefaultGraderRegistry().execute([usage], context())
		expect(result.decision).toBe("passed")
		expect(result.results[0]?.evidence).toContainEqual(expect.objectContaining({ kind: "report" }))
	})

	it.each([
		{ events: [] },
		{ events: [...trace, trace[0]!] },
		{ events: [{ ...trace[0]!, sequence: -1 }] },
		{ events: [{ ...trace[0]!, timestamp: "not-a-date" }] },
		{ events: [{ ...trace[0]!, type: "" }] },
	])("requires valid observable traces even for absence and upper-bound assertions", async ({ events }) => {
		for (const spec of [traceSpec, usage]) {
			const result = await createDefaultGraderRegistry().execute([spec], context({ trace: events }))
			expect(result.decision).toBe("grader_error")
		}
	})

	it.each([
		{ exitCode: null, timedOut: false },
		{ exitCode: null, timedOut: true },
	])("classifies unfinished grader commands as errors and retains their diagnostics: %j", async (result) => {
		const ctx = context()
		vi.mocked(ctx.processRunner.run).mockResolvedValue({
			...result,
			stdout: "partial test progress",
			stderr: "runner stopped",
			durationMs: 100,
			outputTruncated: false,
		})
		const run = await createDefaultGraderRegistry().execute([command], ctx)
		expect(run.decision).toBe("grader_error")
		expect(run.results[0]?.evidence).toHaveLength(2)
		expect(run.results[0]?.diagnostics).toContainEqual(expect.objectContaining({ severity: "error" }))
	})
})
