import crypto from "crypto"

import { describe, expect, it } from "vitest"

import { executeRetryPolicy } from "../../orchestration/index"
import {
	InMemoryArtifactStore,
	HostileScenarioBuilder,
	ScriptedProcessError,
	ScriptedGrader,
	ScriptedObserver,
	ScriptedProcessRunner,
	SeededRandom,
	VirtualClock,
	createSecretCanary,
	findSecretCanaryLeaks,
	runHostileScenario,
	type HostileScenario,
} from "../hostileRuntime"

const baseScenario: HostileScenario = { id: "base", seed: 9412 }

describe("hostile attempt scenarios", () => {
	it("builds immutable typed scenarios", () => {
		const builder = new HostileScenarioBuilder("builder", 7)
			.stage("agent", { outcome: "fault", fault: { kind: "timeout", message: "hung" } })
			.grade({ outcome: "decision", decision: "outcome_failed" })
			.persistenceFailure("finalize")
			.eventFaults({ duplicate: ["attempt_started"] })
			.artifactFault("corrupt")
		const first = builder.build()
		first.id = "mutated"
		expect(builder.build()).toMatchObject({
			id: "builder",
			seed: 7,
			artifactFault: "corrupt",
			persistenceFailure: { eventType: "finalize", occurrence: 1 },
		})
	})
	it("runs a deterministic success through the production attempt orchestrator", async () => {
		const first = await runHostileScenario(baseScenario)
		const second = await runHostileScenario({ seed: 9412, id: "base" })
		expect(first.status).toBe("passed")
		expect(first.error).toBeUndefined()
		expect(first.attempt).toMatchObject({ phase: "grading", terminalStatus: "passed", version: 5 })
		expect(first.artifacts).toHaveLength(1)
		expect(first.reproduction).toBe(second.reproduction)
		expect(first.observations).toEqual(second.observations)
	})

	it.each([
		["setup", "infrastructure_error"],
		["agent", "agent_error"],
		["evidence", "infrastructure_error"],
	] as const)("classifies a %s fault as %s", async (stage, expected) => {
		const result = await runHostileScenario({
			...baseScenario,
			id: `${stage}-fault`,
			[stage]: { outcome: "fault", fault: { kind: "error", message: `${stage} exploded` } },
		})
		expect(result.status).toBe(expected)
		expect(result.error?.message).toContain(`${stage} exploded`)
	})

	it("classifies grader crashes and timeouts as grader errors", async () => {
		for (const kind of ["error", "timeout"] as const) {
			const result = await runHostileScenario({
				...baseScenario,
				id: `grader-${kind}`,
				grade: { outcome: "fault", fault: { kind, message: `grader ${kind}` } },
			})
			expect(result.status).toBe("grader_error")
		}
	})

	it.each(["upload_error", "interrupted"] as const)(
		"invalidates evidence when artifact storage is %s",
		async (artifactFault) => {
			const result = await runHostileScenario({ ...baseScenario, id: artifactFault, artifactFault })
			expect(result.status).toBe("infrastructure_error")
			expect(result.error?.message).toContain("artifact upload")
		},
	)

	it("invalidates rather than passes when retained artifact bytes are corrupt", async () => {
		const result = await runHostileScenario({ ...baseScenario, id: "corrupt-evidence", artifactFault: "corrupt" })
		expect(result.status).toBe("infrastructure_error")
		expect(result.error?.message).toContain("digest verification")
	})

	it("classifies persistence and event-publication failures as infrastructure errors", async () => {
		const persistence = await runHostileScenario({
			...baseScenario,
			id: "persistence",
			persistenceFailure: { eventType: "agent_completed" },
		})
		const publication = await runHostileScenario({
			...baseScenario,
			id: "publication",
			eventFaults: { fail: ["agent_completed"] },
		})
		expect(persistence.status).toBe("infrastructure_error")
		expect(publication.status).toBe("infrastructure_error")
	})

	it.each(["start", "finalize"] as const)("classifies persistence failure during %s", async (eventType) => {
		const result = await runHostileScenario({
			...baseScenario,
			id: `persistence-${eventType}`,
			persistenceFailure: { eventType },
		})
		expect(result.status).toBe("infrastructure_error")
	})

	it.each(["provider_before_tool", "provider_after_tool"] as const)("reproduces %s as agent error", async (code) => {
		const result = await runHostileScenario({
			...baseScenario,
			id: code,
			agent: { outcome: "fault", fault: { kind: "error", message: code, code } },
		})
		expect(result.status).toBe("agent_error")
		expect(result.reproduction).toContain(code)
	})

	it.each([
		["hidden-grader-access", "hidden_grader_access"],
		["forbidden-path", "forbidden_path_modified"],
	] as const)("makes %s a safety hard failure", async (id, code) => {
		const result = await runHostileScenario({
			...baseScenario,
			id,
			grade: {
				outcome: "fault",
				fault: { kind: "denied", message: id, status: "safety_failed", code },
			},
		})
		expect(result.status).toBe("safety_failed")
	})
})

describe("hostile event, artifact, process, and grader ports", () => {
	it("injects dropped, duplicate, malformed, and late observations", async () => {
		const observer = new ScriptedObserver({
			drop: ["attempt_started"],
			duplicate: ["setup_completed"],
			malformed: ["agent_completed"],
			late: ["evidence_collected"],
		})
		await observer.emit({ type: "attempt_started", attemptId: 1, attemptNumber: 1 })
		await observer.emit({ type: "setup_completed", attemptId: 1, attemptNumber: 1 })
		await observer.emit({ type: "agent_completed", attemptId: 1, attemptNumber: 1 })
		await observer.emit({ type: "evidence_collected", attemptId: 1, attemptNumber: 1 })
		expect(observer.records).toEqual([
			{ type: "setup_completed", attemptId: 1, attemptNumber: 1 },
			{ type: "setup_completed", attemptId: 1, attemptNumber: 1 },
			{ malformed: true, originalType: "agent_completed" },
		])
		observer.flushLate()
		expect(observer.records.at(-1)).toEqual({ type: "evidence_collected", attemptId: 1, attemptNumber: 1 })
	})

	it("recovers after a one-shot event publication disconnect", async () => {
		const observer = new ScriptedObserver({ failOnce: ["attempt_started"] })
		const event = { type: "attempt_started", attemptId: 1, attemptNumber: 1 } as const
		await expect(observer.emit(event)).rejects.toThrow("event sink failure")
		await observer.emit(event)
		expect(observer.records).toEqual([event])
	})

	it("detects deliberately corrupted artifact bytes", async () => {
		const store = new InMemoryArtifactStore("corrupt")
		const record = await store.put("diff", new TextEncoder().encode("valid"), "text/plain")
		expect(store.verify(record.id)).toBe(false)
		expect(`sha256:${crypto.createHash("sha256").update(record.bytes).digest("hex")}`).not.toBe(record.digest)
	})

	it("scripts partial output and timeouts without real processes", async () => {
		const runner = new ScriptedProcessRunner([
			{
				type: "result",
				result: {
					exitCode: null,
					stdout: "partial stdout",
					stderr: "timeout",
					durationMs: 1_000,
					timedOut: true,
					outputTruncated: false,
				},
			},
		])
		const result = await runner.run({ command: "fake", args: [], timeoutMs: 1_000, maxOutputBytes: 100 })
		expect(result).toMatchObject({ timedOut: true, stdout: "partial stdout", exitCode: null })
		expect(runner.calls).toHaveLength(1)
	})

	it("retains partial output on a scripted process-tree failure", async () => {
		const runner = new ScriptedProcessRunner([
			{
				type: "error",
				fault: { kind: "timeout", message: "descendant ignored termination", code: "unkillable_descendant" },
				stdout: "partial-before-timeout",
				stderr: "kill failed",
			},
		])
		try {
			await runner.run({ command: "fake", args: [], timeoutMs: 10, maxOutputBytes: 100 })
			expect.fail("expected scripted process error")
		} catch (error) {
			expect(error).toBeInstanceOf(ScriptedProcessError)
			expect(error).toMatchObject({
				code: "unkillable_descendant",
				stdout: "partial-before-timeout",
				stderr: "kill failed",
			})
		}
	})

	it("provides raw, nested, base64, and URL-encoded secret canaries", () => {
		const canary = createSecretCanary("sk-test+/secret")
		expect(findSecretCanaryLeaks(canary.nestedPayload, canary)).toEqual([canary.raw, canary.base64])
		expect(findSecretCanaryLeaks({ safe: "[redacted]" }, canary)).toEqual([])
	})

	it("detects a nondeterministic grader script", async () => {
		const grader = new ScriptedGrader([
			{ outcome: "decision", decision: "passed" },
			{ outcome: "decision", decision: "outcome_failed" },
		])
		expect(await grader.sample(2)).toEqual({
			decisions: ["passed", "outcome_failed"],
			deterministic: false,
		})
	})
})

describe("seeded retry execution", () => {
	it("replays backoff and retry-assisted success from a seed", async () => {
		async function run() {
			const clock = new VirtualClock(Date.UTC(2026, 0, 1))
			const random = new SeededRandom(77)
			const statuses = ["infrastructure_error", "grader_error", "passed"] as const
			return executeRetryPolicy(
				{ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
				{ clock, random, sleeper: clock },
				async (attemptNumber) => statuses[attemptNumber - 1]!,
				async () => undefined,
			)
		}
		const first = await run()
		const second = await run()
		expect(first).toEqual(second)
		expect(first).toMatchObject({ status: "passed", exhausted: false })
		expect(first.attempts.map(({ delayBeforeMs }) => delayBeforeMs)).toEqual([0, 50, 142])
	})

	it("settles exactly once after retryable outcomes exhaust", async () => {
		const clock = new VirtualClock()
		let settlements = 0
		const result = await executeRetryPolicy(
			{ maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 10 },
			{ clock, random: new SeededRandom(1), sleeper: clock },
			async () => "infrastructure_error",
			async () => {
				settlements++
			},
		)
		expect(result.exhausted).toBe(true)
		expect(settlements).toBe(1)
	})
})
