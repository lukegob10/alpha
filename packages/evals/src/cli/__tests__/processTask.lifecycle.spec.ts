import { beforeEach, describe, expect, it, vi } from "vitest"

import {
	initialAttemptState,
	transitionAttempt,
	type AttemptLifecycleEvent,
	type AttemptLifecycleState,
} from "../../lifecycle/index"

const mocks = vi.hoisted(() => ({
	findTask: vi.fn(),
	findRun: vi.fn(),
	ensureAttempt: vi.fn(),
	applyAttemptEvent: vi.fn(),
	findTrialForTask: vi.fn(),
	getTasks: vi.fn(),
	settleTrialAfterRetries: vi.fn(),
	registerRunner: vi.fn(),
	deregisterRunner: vi.fn(),
	publish: vi.fn(),
	runUnitTest: vi.fn(),
	runTaskWithCli: vi.fn(),
	runTaskInVscode: vi.fn(),
	processRun: vi.fn(),
	persistEvalEvent: vi.fn(),
	persistArtifactDescriptors: vi.fn(),
	collectWorkspaceEvidence: vi.fn(),
	readEvidenceLog: vi.fn(),
	readJsonLines: vi.fn(),
	validateEvidenceBundle: vi.fn(),
	recordEvidenceIntegrity: vi.fn(),
	persistRuntimeIdentities: vi.fn(),
	createRuntimeIdentities: vi.fn(),
	collectInfrastructureManifest: vi.fn(),
	findBenchmarkTask: vi.fn(),
	submitGraderRequest: vi.fn(),
	serveGraderRequest: vi.fn(),
}))

vi.mock("../../benchmark/index", () => ({
	findBenchmarkTask: mocks.findBenchmarkTask,
	submitGraderRequest: mocks.submitGraderRequest,
	serveGraderRequest: mocks.serveGraderRequest,
}))

vi.mock("../../db/index", () => ({
	findTask: mocks.findTask,
	findRun: mocks.findRun,
	ensureAttempt: mocks.ensureAttempt,
	applyAttemptEvent: mocks.applyAttemptEvent,
	findTrialForTask: mocks.findTrialForTask,
	getTasks: mocks.getTasks,
	settleTrialAfterRetries: mocks.settleTrialAfterRetries,
	persistEvalEvent: mocks.persistEvalEvent,
	persistArtifactDescriptors: mocks.persistArtifactDescriptors,
	recordEvidenceIntegrity: mocks.recordEvidenceIntegrity,
	persistRuntimeIdentities: mocks.persistRuntimeIdentities,
}))
vi.mock("../../evidence/index", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../evidence/index")>()),
	collectWorkspaceEvidence: mocks.collectWorkspaceEvidence,
	readEvidenceLog: mocks.readEvidenceLog,
	readJsonLines: mocks.readJsonLines,
	createRuntimeIdentities: mocks.createRuntimeIdentities,
	validateEvidenceBundle: mocks.validateEvidenceBundle,
}))
vi.mock("../../infrastructure/index", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../infrastructure/index")>()),
	collectInfrastructureManifest: mocks.collectInfrastructureManifest,
}))
vi.mock("../redis", () => ({
	registerRunner: mocks.registerRunner,
	deregisterRunner: mocks.deregisterRunner,
	redisClient: vi.fn(async () => ({ publish: mocks.publish })),
	getPubSubKey: vi.fn(() => "eval:test"),
}))
vi.mock("../runUnitTest", () => ({ runUnitTest: mocks.runUnitTest }))
vi.mock("../runTaskInCli", () => ({ runTaskWithCli: mocks.runTaskWithCli }))
vi.mock("../runTaskInVscode", () => ({ runTaskInVscode: mocks.runTaskInVscode }))

import { normalizeApiConversationTrace, processTask, processTaskInContainer } from "../processTask"
import type { Logger } from "../utils"

const task = { id: 41, runId: 7, language: "javascript", exercise: "lifecycle", iteration: 1 }
const run = { id: 7, executionMethod: "cli", timeout: 5 }
const logger = {
	info: vi.fn(),
	error: vi.fn(),
	raw: vi.fn(),
	close: vi.fn(),
	path: "/tmp/test-evidence.log",
} as unknown as Logger
const processRunner = { run: mocks.processRun }

let state: AttemptLifecycleState

beforeEach(() => {
	vi.clearAllMocks()
	delete process.env.EVALS_ATTEMPT
	state = initialAttemptState()
	mocks.findTask.mockResolvedValue(task)
	mocks.findRun.mockResolvedValue(run)
	mocks.getTasks.mockResolvedValue([{ ...task, taskMetrics: undefined }])
	mocks.ensureAttempt.mockImplementation(async (_taskId: number, attemptNumber: number) => ({
		id: 101,
		attemptNumber,
		...state,
		terminalStatus: state.terminalStatus ?? null,
	}))
	mocks.applyAttemptEvent.mockImplementation(async (_attemptId: number, event: AttemptLifecycleEvent) => {
		state = transitionAttempt(state, event)
		return {
			attempt: { id: 101, attemptNumber: 1, ...state, terminalStatus: state.terminalStatus ?? null },
			trial: {},
		}
	})
	mocks.findTrialForTask.mockImplementation(async () => ({
		id: 55,
		attempts: [{ id: 101, attemptNumber: 1, ...state, terminalStatus: state.terminalStatus ?? null }],
	}))
	mocks.persistEvalEvent.mockResolvedValue([])
	mocks.persistArtifactDescriptors.mockResolvedValue([])
	mocks.collectWorkspaceEvidence.mockResolvedValue([])
	mocks.readEvidenceLog.mockResolvedValue("")
	mocks.readJsonLines.mockResolvedValue([])
	mocks.validateEvidenceBundle.mockResolvedValue({ valid: true, issues: [] })
	mocks.recordEvidenceIntegrity.mockResolvedValue({})
	mocks.persistRuntimeIdentities.mockResolvedValue({ taskIdentity: "task@1", variantIdentity: "variant@1" })
	mocks.createRuntimeIdentities.mockResolvedValue({
		taskIdentity: "task@1",
		variantIdentity: "variant@1",
		taskManifest: {
			schemaVersion: 1,
			id: "task",
			version: 1,
			fixtureDigest: `sha256:${"a".repeat(64)}`,
			capabilities: ["coding"],
			risk: "medium",
			network: "disabled",
			graders: [{ id: "tests", version: 1 }],
		},
		variantManifest: {
			schemaVersion: 1,
			id: "variant",
			extensionCommit: "abc",
			workingTreeDigest: `sha256:${"b".repeat(64)}`,
			model: "test",
			promptDigest: `sha256:${"c".repeat(64)}`,
			toolSchemaDigest: `sha256:${"d".repeat(64)}`,
			runnerImageDigest: `sha256:${"e".repeat(64)}`,
		},
	})
	mocks.findBenchmarkTask.mockResolvedValue({ task: { graders: [{ alias: "visible_tests" }] } })
	mocks.collectInfrastructureManifest.mockImplementation(async (spec, _runner, concurrency) => ({
		schemaVersion: 1,
		imageReference: spec.image,
		imageId: "sha256:test-image",
		repoDigests: ["evals-runner@sha256:test"],
		architecture: "amd64",
		os: "linux",
		dockerVersion: "test",
		networkMode: spec.network,
		limits: spec.limits,
		owner: spec.owner,
		concurrency,
		permissionProfileDigest: "sha256:test-permissions",
	}))
	mocks.registerRunner.mockResolvedValue(undefined)
	mocks.deregisterRunner.mockResolvedValue(undefined)
	mocks.runTaskWithCli.mockResolvedValue(undefined)
	mocks.runUnitTest.mockResolvedValue({ decision: "passed", results: [] })
	mocks.processRun.mockResolvedValue({
		exitCode: 0,
		stdout: "",
		stderr: "",
		durationMs: 1,
		timedOut: false,
		outputTruncated: false,
	})
})

describe("processTaskInContainer lifecycle integration", () => {
	it("keeps private graders in the trusted controller and removes the Docker socket from agent containers", async () => {
		mocks.findBenchmarkTask.mockResolvedValue({
			task: { graders: [{ alias: "hidden_tests", bundleId: "private" }] },
		})
		mocks.serveGraderRequest.mockResolvedValue(undefined)
		mocks.processRun.mockImplementation(async () => {
			state = { phase: "grading", terminalStatus: "passed", version: 5 }
			return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, outputTruncated: false }
		})
		await processTaskInContainer({ taskId: task.id, jobToken: null, logger, maxRetries: 0, processRunner })
		expect(mocks.serveGraderRequest).toHaveBeenCalledOnce()
		const args = mocks.processRun.mock.calls[0]![0].args.join(" ")
		expect(args).not.toContain("/var/run/docker.sock")
		expect(args).not.toContain("private-benchmark")
		expect(args).not.toContain("/tmp/evals:/var/log/evals")
		expect(args).toContain("/tmp/evals/task-sandboxes/101:/var/log/evals:rw")
	})

	it("keeps secret values out of Docker arguments and exposes only environment names", async () => {
		process.env.OPENAI_API_KEY = "nested-secret-canary"
		await processTaskInContainer({
			taskId: task.id,
			jobToken: "job-secret-canary",
			logger,
			maxRetries: 0,
			processRunner,
		})
		const spec = mocks.processRun.mock.calls[0]![0]
		expect(JSON.stringify(spec.args)).not.toContain("secret-canary")
		expect(spec.args).toContain("ROO_CODE_CLOUD_TOKEN")
		expect(spec.args).toContain("OPENAI_API_KEY")
		expect(spec.env).toMatchObject({
			ROO_CODE_CLOUD_TOKEN: "job-secret-canary",
			OPENAI_API_KEY: "nested-secret-canary",
			EVALS_RUNNER_IMAGE_ID: "sha256:test-image",
			EVALS_NETWORK_MODE: "evals_default",
			EVALS_PERMISSION_PROFILE_DIGEST: "sha256:test-permissions",
		})
		expect(mocks.collectInfrastructureManifest).toHaveBeenCalledOnce()
		expect(spec.args.join(" ")).not.toContain("/var/run/docker.sock")
		expect(spec.args.join(" ")).not.toContain("private-benchmark")
		delete process.env.OPENAI_API_KEY
	})

	it("classifies runner-image inspection failures as setup infrastructure errors", async () => {
		mocks.collectInfrastructureManifest.mockRejectedValue(new Error("image unavailable"))
		await processTaskInContainer({ taskId: task.id, jobToken: null, logger, maxRetries: 0, processRunner })
		expect(state).toMatchObject({
			terminalStatus: "infrastructure_error",
			failureCode: "container_setup_failed",
			failureDetail: "image unavailable",
		})
		expect(mocks.processRun).not.toHaveBeenCalled()
		expect(mocks.settleTrialAfterRetries).toHaveBeenCalledWith(task.id)
	})

	it("settles retry exhaustion after a container process failure", async () => {
		mocks.processRun.mockRejectedValue(Object.assign(new Error("docker failed"), { exitCode: 125 }))
		await processTaskInContainer({ taskId: task.id, jobToken: null, logger, maxRetries: 0, processRunner })

		expect(state).toMatchObject({ terminalStatus: "infrastructure_error", failureCode: "container_process_failed" })
		expect(mocks.settleTrialAfterRetries).toHaveBeenCalledWith(task.id)
	})

	it("invalidates a zero exit that omitted a terminal lifecycle result", async () => {
		await processTaskInContainer({ taskId: task.id, jobToken: null, logger, maxRetries: 0, processRunner })

		expect(state).toMatchObject({
			terminalStatus: "infrastructure_error",
			failureCode: "container_missing_terminal_result",
		})
		expect(mocks.settleTrialAfterRetries).toHaveBeenCalledWith(task.id)
	})

	it("returns without settlement when the child finalized a scored result", async () => {
		mocks.processRun.mockImplementation(async () => {
			state = { phase: "grading", terminalStatus: "passed", version: 5 }
			return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, outputTruncated: false }
		})
		await processTaskInContainer({ taskId: task.id, jobToken: null, logger, maxRetries: 0, processRunner })
		expect(mocks.settleTrialAfterRetries).not.toHaveBeenCalled()
	})
})

describe("processTask lifecycle integration", () => {
	it("moves a successful task through every phase and finalizes passed", async () => {
		await processTask({ taskId: task.id, jobToken: null, logger })

		expect(mocks.ensureAttempt).toHaveBeenCalledWith(task.id, 1)
		expect(mocks.applyAttemptEvent.mock.calls.map(([, event]) => event)).toEqual([
			{ type: "start" },
			{ type: "setup_completed" },
			{ type: "agent_completed" },
			{ type: "evidence_collected" },
			{ type: "finalize", status: "passed" },
		])
		expect(state.terminalStatus).toBe("passed")
		expect(mocks.settleTrialAfterRetries).toHaveBeenCalledWith(task.id)
		expect(mocks.deregisterRunner).toHaveBeenCalledOnce()
	})

	it("runs benchmark agents and graders against one disposable workspace", async () => {
		mocks.findTask.mockResolvedValue({
			...task,
			exercise: "repo-cache-invalidation",
			benchmarkTaskIdentity: "repo-cache-invalidation@1",
		})
		await processTask({ taskId: task.id, jobToken: null, logger, processRunner })

		const execution = mocks.runTaskWithCli.mock.calls[0]![0]
		const grading = mocks.runUnitTest.mock.calls[0]![0]
		expect(execution.workspaceRoot).toMatch(/[\\/]task-sandboxes[\\/]101[\\/]agent-workspace$/)
		expect(grading.workspaceRoot).toBe(execution.workspaceRoot)
		expect(execution.workspaceRoot).not.toContain("evals/javascript/repo-cache-invalidation")
	})

	it("normalizes the persisted agent event stream for trace graders", async () => {
		mocks.readJsonLines.mockResolvedValue([
			{ sequence: 4, timestamp: 1_750_000_000_000, event: { type: "tool_result", tool: "read_file" } },
		])
		await processTask({ taskId: task.id, jobToken: null, logger })
		expect(mocks.runUnitTest).toHaveBeenCalledWith(
			expect.objectContaining({
				trace: [
					{
						sequence: 4,
						timestamp: "2025-06-15T15:06:40.000Z",
						type: "agent.turn.tool_result",
						payload: { tool: "read_file" },
					},
				],
			}),
		)
	})

	it("classifies runner execution exceptions as agent errors", async () => {
		mocks.runTaskWithCli.mockRejectedValue(new Error("provider disconnected"))
		await expect(processTask({ taskId: task.id, jobToken: null, logger })).rejects.toThrow("provider disconnected")
		expect(state).toMatchObject({
			phase: "agent_execution",
			terminalStatus: "agent_error",
			failureCode: "Error",
			failureDetail: "provider disconnected",
		})
	})

	it("classifies setup exceptions as infrastructure errors", async () => {
		mocks.registerRunner.mockRejectedValue(new Error("redis unavailable"))
		await expect(processTask({ taskId: task.id, jobToken: null, logger })).rejects.toThrow("redis unavailable")
		expect(state).toMatchObject({ phase: "setup", terminalStatus: "infrastructure_error" })
	})

	it("classifies thrown grader exceptions as grader errors", async () => {
		mocks.runUnitTest.mockRejectedValue(new Error("grader crashed"))
		await expect(processTask({ taskId: task.id, jobToken: null, logger })).rejects.toThrow("grader crashed")
		expect(state).toMatchObject({ phase: "grading", terminalStatus: "grader_error" })
	})

	it("maps a persisted grader error decision to grader_error lifecycle state", async () => {
		mocks.runUnitTest.mockResolvedValue({ decision: "grader_error", results: [] })
		await expect(processTask({ taskId: task.id, jobToken: null, logger })).resolves.toBeUndefined()
		expect(state).toMatchObject({
			phase: "grading",
			terminalStatus: "grader_error",
		})
	})

	it("preserves a safety hard-gate decision", async () => {
		mocks.runUnitTest.mockResolvedValue({ decision: "safety_failed", results: [] })
		await processTask({ taskId: task.id, jobToken: null, logger })
		expect(state).toMatchObject({ phase: "grading", terminalStatus: "safety_failed" })
	})

	it("preserves an explicit agent cancellation after collecting and grading evidence", async () => {
		mocks.runTaskWithCli.mockResolvedValue("cancelled")
		await processTask({ taskId: task.id, jobToken: null, logger })
		expect(state).toMatchObject({ phase: "grading", terminalStatus: "cancelled" })
		expect(mocks.runUnitTest).toHaveBeenCalledOnce()
	})

	it("classifies wall-budget termination separately from safety and outcome failures", async () => {
		mocks.runTaskWithCli.mockResolvedValue("budget_exhausted")
		await processTask({ taskId: task.id, jobToken: null, logger })
		expect(state).toMatchObject({ phase: "grading", terminalStatus: "budget_exhausted" })
	})

	it("classifies an agent wall-clock timeout as an agent error", async () => {
		mocks.runTaskWithCli.mockResolvedValue("agent_error")
		await processTask({ taskId: task.id, jobToken: null, logger })
		expect(state).toMatchObject({ phase: "grading", terminalStatus: "agent_error" })
	})

	it("maps usage-policy diagnostics to budget exhaustion", async () => {
		mocks.runUnitTest.mockResolvedValue({
			decision: "safety_failed",
			results: [
				{
					status: "failed",
					failureClass: "safety",
					diagnostics: [{ code: "cost_budget_exceeded" }],
				},
			],
		})
		await processTask({ taskId: task.id, jobToken: null, logger })
		expect(state).toMatchObject({ phase: "grading", terminalStatus: "budget_exhausted" })
	})

	it("invalidates an otherwise passing attempt when post-grade event integrity drifts", async () => {
		mocks.validateEvidenceBundle
			.mockResolvedValueOnce({ valid: true, issues: [] })
			.mockResolvedValueOnce({ valid: false, issues: [{ code: "event_sequence_gap", detail: "late gap" }] })
		await expect(processTask({ taskId: task.id, jobToken: null, logger })).rejects.toThrow(
			"Final evidence integrity failed",
		)
		expect(state).toMatchObject({
			terminalStatus: "infrastructure_error",
			failureCode: "final_evidence_integrity_failed",
		})
		expect(mocks.recordEvidenceIntegrity).toHaveBeenCalledWith(expect.objectContaining({ status: "invalid" }))
	})

	it("does not rerun an already terminal attempt", async () => {
		state = { phase: "grading", terminalStatus: "passed", version: 5 }
		await processTask({ taskId: task.id, jobToken: null, logger })
		expect(mocks.registerRunner).not.toHaveBeenCalled()
		expect(mocks.runTaskWithCli).not.toHaveBeenCalled()
	})
})

describe("CLI conversation trace fallback", () => {
	it("classifies command completion as a verification result", () => {
		expect(
			normalizeApiConversationTrace([
				{
					ts: 1_750_000_000_000,
					content: [{ type: "tool_use", id: "read", name: "read_file" }],
				},
				{
					ts: 1_750_000_000_001,
					content: [{ type: "tool_result", tool_use_id: "read", content: "source" }],
				},
				{
					ts: 1_750_000_000_002,
					content: [{ type: "tool_use", id: "test", name: "execute_command" }],
				},
				{
					ts: 1_750_000_000_003,
					content: [{ type: "tool_result", tool_use_id: "test", content: "Exit code: 0" }],
				},
			]),
		).toEqual([
			expect.objectContaining({ type: "agent.turn.tool_call", payload: { tool: "read_file" } }),
			expect.objectContaining({ type: "agent.turn.tool_result", payload: { tool: "read_file" } }),
			expect.objectContaining({ type: "agent.turn.verification_started", payload: { tool: "execute_command" } }),
			expect.objectContaining({
				type: "agent.turn.verification_result",
				payload: { tool: "execute_command", ok: true },
			}),
		])
	})
})
