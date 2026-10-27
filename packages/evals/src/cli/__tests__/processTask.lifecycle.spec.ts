import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import os from "node:os"
import fs from "node:fs/promises"
import path from "node:path"
import type { CommandToolResult, ExecutionIdentity } from "@alpha-code/types"
import type { HarnessProcessSpec } from "../../orchestration/index"
import { TraceAssertionGrader } from "../../grading/plugins/traceAssertion"
import { evidenceFromText } from "../../grading/index"
import {
	serveGraderRequest as serveRealGraderRequest,
	submitGraderRequest as submitRealGraderRequest,
} from "../../benchmark/graderBroker"
import { FilesystemArtifactStore } from "../../evidence/index"
import { EVALS_REPO_PATH } from "../../exercises/index"

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
	closeOwnedLogger: vi.fn(),
	captureExpectedNodeTestCommands: vi.fn(),
	graderArtifactRoot: undefined as string | undefined,
}))

vi.mock("../../benchmark/index", () => ({
	findBenchmarkTask: mocks.findBenchmarkTask,
	submitGraderRequest: mocks.submitGraderRequest,
	serveGraderRequest: mocks.serveGraderRequest,
}))
vi.mock("../../grading/nodeTestCompletion", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../grading/nodeTestCompletion")>()),
	captureExpectedNodeTestCommands: mocks.captureExpectedNodeTestCommands,
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
vi.mock("../../evidence/index", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../evidence/index")>()
	return {
		...actual,
		FilesystemArtifactStore: class extends actual.FilesystemArtifactStore {
			constructor(root: string) {
				// Keep the controller's real CAS byte check in this test's portable temp root.
				super(mocks.graderArtifactRoot ?? root)
			}
		},
		collectWorkspaceEvidence: mocks.collectWorkspaceEvidence,
		readEvidenceLog: mocks.readEvidenceLog,
		readJsonLines: mocks.readJsonLines,
		createRuntimeIdentities: mocks.createRuntimeIdentities,
		validateEvidenceBundle: mocks.validateEvidenceBundle,
	}
})
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
vi.mock("../runTaskInVscode", () => ({ runTaskInVscode: mocks.runTaskInVscode }))
vi.mock("../utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("../utils")>()),
	Logger: class {
		path = "/tmp/owned-test-evidence.log"
		info() {}
		close = mocks.closeOwnedLogger
	},
}))

import { normalizeAgentTrace, normalizeApiConversationTrace, processTask, processTaskInContainer } from "../processTask"
import type { RunTaskOptions } from "../types"
import type { Logger } from "../utils"

const task = { id: 41, runId: 7, language: "javascript", exercise: "lifecycle", iteration: 1 }
const run = { id: 7, executionMethod: "vscode", timeout: 5 }
const executionIdentity: ExecutionIdentity = {
	schemaVersion: 1,
	hostVersion: "1.138.0",
	extensionId: "Alpha.alpha",
	extensionVersion: "3.2.4",
	entrypointDigest: `sha256:${"a".repeat(64)}`,
	manifestDigest: `sha256:${"b".repeat(64)}`,
	identityScope: "observed-entrypoint-and-manifest",
}
const presentationPolicy = {
	schemaVersion: 1,
	presentationModelCalls: false,
	presentationModelCallOptOut: true,
} as const
const logger = {
	info: vi.fn(),
	error: vi.fn(),
	raw: vi.fn(),
	close: vi.fn(),
	path: "/tmp/test-evidence.log",
} as unknown as Logger
const processRunner = {
	run: (spec: HarnessProcessSpec) =>
		spec.command === "git" &&
		(spec.args?.[0] === "rev-parse" || (spec.args?.[0] === "ls-files" && spec.args.includes("-v")))
			? Promise.resolve({
					exitCode: 0,
					stdout: spec.args?.[0] === "rev-parse" ? "a".repeat(40) : "",
					stderr: "",
					durationMs: 1,
					timedOut: false,
					outputTruncated: false,
				})
			: mocks.processRun(spec),
}

let state: AttemptLifecycleState

beforeEach(() => {
	vi.clearAllMocks()
	mocks.graderArtifactRoot = undefined
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
	mocks.findBenchmarkTask.mockResolvedValue({
		task: {
			fixture: "javascript/lifecycle",
			validation: { commands: [] },
			graders: [{ alias: "visible_tests" }],
		},
	})
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
	mocks.runTaskInVscode.mockResolvedValue(undefined)
	mocks.captureExpectedNodeTestCommands.mockImplementation(async (_root, commands) => commands)
	mocks.runUnitTest.mockResolvedValue({ decision: "passed", results: [] })
	mocks.serveGraderRequest.mockResolvedValue(undefined)
	mocks.processRun.mockResolvedValue({
		exitCode: 0,
		stdout: "",
		stderr: "",
		durationMs: 1,
		timedOut: false,
		outputTruncated: false,
	})
})
afterEach(() => vi.unstubAllEnvs())

describe("private original test capture and trusted grading", () => {
	const privateTask = { ...task, exercise: "private-original", benchmarkPartition: "holdout" }
	const privateRoot = path.join(os.tmpdir(), "private-original-capture-contract")
	const commands = [{ command: "node", args: ["--test", "test/behavior.test.js"] }]
	const prepared = [
		{
			...commands[0]!,
			testExecution: {
				runner: "node-test",
				expectedTests: [{ file: "test/behavior.test.js", name: "original assertions", assertions: 1 }],
				sourceDigests: [{ file: "test/behavior.test.js", digest: `sha256:${"a".repeat(64)}` }],
			},
		},
	]
	const configurePrivateTask = () => {
		vi.stubEnv("EVALS_GRADER_BROKER_ROOT", "")
		mocks.findTask.mockResolvedValue(privateTask)
		mocks.findBenchmarkTask.mockResolvedValue({
			task: {
				partition: "holdout",
				fixture: "tasks/private-original/workspace",
				validation: { commands },
				budgets: { wallSeconds: 900 },
				graders: [{ alias: "hidden_tests", bundleId: "private" }],
			},
		})
	}

	it("captures private direct-run originals before the model and ignores its runtime workspace override", async () => {
		configurePrivateTask()
		vi.stubEnv("EVALS_PRIVATE_BENCHMARK_ROOT", privateRoot)
		vi.stubEnv("EVALS_TASK_WORKSPACE_ROOT", path.join(os.tmpdir(), "private-model-copy"))
		mocks.captureExpectedNodeTestCommands.mockImplementation(async (root) => {
			expect(root).toBe(path.join(privateRoot, "tasks/private-original/workspace"))
			return prepared
		})
		await processTask({ taskId: task.id, jobToken: null, logger, processRunner })
		expect(mocks.captureExpectedNodeTestCommands).toHaveBeenCalledOnce()
		expect(mocks.captureExpectedNodeTestCommands.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.runTaskInVscode.mock.invocationCallOrder[0]!,
		)
		expect(mocks.runUnitTest).toHaveBeenCalledWith(expect.objectContaining({ preparedVisibleCommands: prepared }))
	})

	it("keeps controller-captured private contracts in the trusted broker and redacts both known secrets", async () => {
		configurePrivateTask()
		vi.stubEnv("EVALS_PRIVATE_BENCHMARK_ROOT", privateRoot)
		vi.stubEnv("OPENAI_API_KEY", "private-api-secret-canary")
		mocks.graderArtifactRoot = path.join(os.tmpdir(), "private-controller-evidence")
		mocks.captureExpectedNodeTestCommands.mockImplementation(async (root) => {
			expect(root).toBe(path.join(privateRoot, "tasks/private-original/workspace"))
			return prepared
		})
		mocks.serveGraderRequest.mockResolvedValue(undefined)
		await processTaskInContainer({
			taskId: task.id,
			jobToken: "private-job-secret-canary",
			logger,
			maxRetries: 0,
			processRunner,
		})
		expect(mocks.captureExpectedNodeTestCommands).toHaveBeenCalledOnce()
		expect(mocks.captureExpectedNodeTestCommands.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.processRun.mock.invocationCallOrder[0]!,
		)
		mocks.runUnitTest.mockImplementationOnce(async ({ evidenceSink }) => {
			await evidenceSink(
				"verifier:stdout",
				"stdout",
				"private-api-secret-canary private-job-secret-canary",
				"text/plain",
			)
			return { decision: "passed", results: [] }
		})
		const receipt = await mocks.serveGraderRequest.mock.calls[0]![0].execute({
			schemaVersion: 1,
			attemptId: 101,
			workspaceRoot: "/untrusted-child",
			changedPaths: [],
			trace: [],
			environment: {},
		})
		expect(mocks.runUnitTest).toHaveBeenCalledWith(
			expect.objectContaining({
				preparedVisibleCommands: prepared,
				brokerRoot: false,
			}),
		)
		const persisted = mocks.persistArtifactDescriptors.mock.calls.at(-1)!
		const store = new FilesystemArtifactStore(persisted[2])
		const bytes = await store.get(receipt.artifacts[0])
		const retained = new TextDecoder().decode(bytes)
		expect(retained).not.toContain("private-api-secret-canary")
		expect(retained).not.toContain("private-job-secret-canary")
		expect(retained).toContain("[REDACTED:")
		const argv = mocks.processRun.mock.calls.find(([spec]) => spec.args[0] === "run")![0].args.join(" ")
		expect(mocks.processRun.mock.calls.find(([spec]) => spec.args[0] === "run")![0].timeoutMs).toBe(1_320_000)
		const brokerWait = mocks.serveGraderRequest.mock.calls[0]![0]
		expect(brokerWait).not.toHaveProperty("timeoutMs")
		expect(brokerWait.untilAbort).toBeInstanceOf(AbortSignal)
		expect(brokerWait.untilAbort.aborted).toBe(true)
		expect(argv).not.toContain(privateRoot)
		expect(argv).not.toContain("EVALS_PRIVATE_BENCHMARK_ROOT")
	})

	it("does not recapture private originals or require their root in the brokered child", async () => {
		configurePrivateTask()
		vi.stubEnv("EVALS_PRIVATE_BENCHMARK_ROOT", "")
		vi.stubEnv("EVALS_TASK_WORKSPACE_ROOT", path.join(os.tmpdir(), "private-agent-workspace"))
		vi.stubEnv("EVALS_GRADER_BROKER_ROOT", path.join(os.tmpdir(), "private-child-broker"))
		mocks.captureExpectedNodeTestCommands.mockRejectedValue(new Error("Child must not read private originals"))
		await processTask({ taskId: task.id, jobToken: null, logger, processRunner })
		expect(mocks.captureExpectedNodeTestCommands).not.toHaveBeenCalled()
		expect(mocks.runTaskInVscode).toHaveBeenCalledOnce()
		expect(mocks.runUnitTest).toHaveBeenCalledWith(expect.objectContaining({ preparedVisibleCommands: undefined }))
	})

	it("captures public-only grader originals even when a broker and runtime workspace are configured", async () => {
		vi.stubEnv("EVALS_GRADER_BROKER_ROOT", path.join(os.tmpdir(), "unused-public-broker"))
		vi.stubEnv("EVALS_TASK_WORKSPACE_ROOT", path.join(os.tmpdir(), "public-agent-workspace"))
		await processTask({ taskId: task.id, jobToken: null, logger, processRunner })
		expect(mocks.captureExpectedNodeTestCommands).toHaveBeenCalledWith(
			path.join(EVALS_REPO_PATH, "javascript/lifecycle"),
			[],
		)
		expect(mocks.captureExpectedNodeTestCommands.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.runTaskInVscode.mock.invocationCallOrder[0]!,
		)
	})

	it.each(["direct", "controller"] as const)(
		"rejects a missing private source before %s execution",
		async (surface) => {
			configurePrivateTask()
			vi.stubEnv("EVALS_PRIVATE_BENCHMARK_ROOT", "")
			vi.stubEnv("EVALS_TASK_WORKSPACE_ROOT", path.join(os.tmpdir(), "private-agent-workspace"))
			const execute = surface === "direct" ? processTask : processTaskInContainer
			await expect(execute({ taskId: task.id, jobToken: null, logger, processRunner })).rejects.toThrow(
				"EVALS_PRIVATE_BENCHMARK_ROOT",
			)
			expect(mocks.captureExpectedNodeTestCommands).not.toHaveBeenCalled()
			expect(mocks.runTaskInVscode).not.toHaveBeenCalled()
			expect(mocks.processRun).not.toHaveBeenCalled()
		},
	)
})

describe("processTaskInContainer lifecycle integration", () => {
	it.each([
		{ wallSeconds: 2_147_484, error: "Invalid task grading timeout" },
		{ wallSeconds: 2_147_200, error: "Invalid task container timeout" },
	])("rejects wall budget $wallSeconds before creating an attempt or workspace", async ({ wallSeconds, error }) => {
		mocks.findBenchmarkTask.mockResolvedValue({
			task: {
				fixture: "javascript/lifecycle",
				validation: { commands: [] },
				budgets: { wallSeconds },
				graders: [{ alias: "hidden_tests", bundleId: "private" }],
			},
		})
		await expect(
			processTaskInContainer({ taskId: task.id, jobToken: null, logger, maxRetries: 0, processRunner }),
		).rejects.toThrow(error)
		expect(mocks.ensureAttempt).not.toHaveBeenCalled()
		expect(mocks.captureExpectedNodeTestCommands).not.toHaveBeenCalled()
		expect(mocks.collectInfrastructureManifest).not.toHaveBeenCalled()
		expect(mocks.serveGraderRequest).not.toHaveBeenCalled()
		expect(mocks.processRun).not.toHaveBeenCalled()
	})

	it("aborts and joins its broker when trial lookup fails after launch", async () => {
		const brokerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-failed-grader-broker-"))
		let joined = false
		mocks.findBenchmarkTask.mockResolvedValue({
			task: {
				fixture: "javascript/lifecycle",
				validation: { commands: [] },
				graders: [{ alias: "hidden_tests", bundleId: "private" }],
			},
		})
		mocks.serveGraderRequest.mockImplementation((options) =>
			serveRealGraderRequest({ ...options, root: brokerRoot }).finally(() => {
				joined = true
			}),
		)
		mocks.findTrialForTask.mockRejectedValueOnce(new Error("trial lookup failed"))
		try {
			await processTaskInContainer({ taskId: task.id, jobToken: null, logger, maxRetries: 0, processRunner })
			expect(joined).toBe(true)
			expect(mocks.serveGraderRequest.mock.calls[0]![0].untilAbort.aborted).toBe(true)
			expect(state).toMatchObject({
				terminalStatus: "infrastructure_error",
				failureDetail: "trial lookup failed",
			})
			expect(mocks.applyAttemptEvent.mock.calls.filter(([, event]) => event.type === "finalize")).toHaveLength(1)
			expect(mocks.runUnitTest).not.toHaveBeenCalled()
			expect(mocks.processRun).not.toHaveBeenCalled()
		} finally {
			await fs.rm(brokerRoot, { recursive: true, force: true })
		}
	})

	it("grades a near-budget completion after delayed startup through the real broker handshake", async () => {
		const brokerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-late-grader-broker-"))
		let resolveRequestWait!: () => void
		const requestWait = new Promise<void>((resolve) => {
			resolveRequestWait = resolve
		})
		let clockMs = Date.parse("2026-10-26T00:00:00Z")
		let gradingStarted = false
		let server: Promise<void> | undefined
		const clock = vi.spyOn(Date, "now").mockImplementation(() => clockMs)
		const schedule = globalThis.setTimeout
		const poll = vi.spyOn(globalThis, "setTimeout").mockImplementation((...args) => {
			const timer = Reflect.apply(schedule, globalThis, args)
			if (args[1] === 100) resolveRequestWait()
			return timer
		})
		const inspect = mocks.collectInfrastructureManifest.getMockImplementation()!
		mocks.collectInfrastructureManifest.mockImplementationOnce(async (...args) => {
			// Begin startup only after the server is waiting for its first request.
			await requestWait
			clockMs += 30_000
			return inspect(...args)
		})
		mocks.findBenchmarkTask.mockResolvedValue({
			task: {
				fixture: "javascript/lifecycle",
				validation: { commands: [] },
				budgets: { wallSeconds: 900 },
				graders: [{ alias: "hidden_tests", bundleId: "private" }],
			},
		})
		mocks.runUnitTest.mockResolvedValue({
			decision: "passed",
			results: [
				{
					graderId: "private-tests",
					graderVersion: 1,
					type: "command",
					status: "passed",
					hardGate: true,
					failureClass: "outcome",
					diagnostics: [],
					evidence: [evidenceFromText("verifier:stdout", "stdout", "verified")],
					startedAt: new Date(0).toISOString(),
					finishedAt: new Date(1).toISOString(),
					durationMs: 1,
				},
			],
		})
		mocks.serveGraderRequest.mockImplementation((options) => {
			server = serveRealGraderRequest({
				...options,
				root: brokerRoot,
				execute: (request) => {
					gradingStarted = true
					return options.execute(request)
				},
			}).finally(() => {
				// Expiry must make the client fail deterministically instead of waiting in real time.
				if (!gradingStarted) clockMs += 1_020_001
			})
			return server
		})
		mocks.processRun.mockImplementation(async ({ args }: HarnessProcessSpec) => {
			if (args[0] === "run") {
				clockMs += 299_000 // The agent completes within its unchanged five-minute budget.
				const receipt = await submitRealGraderRequest(
					brokerRoot,
					{
						schemaVersion: 1,
						attemptId: 101,
						workspaceRoot: "/workspace/eval-task",
						changedPaths: [],
						trace: [],
						environment: {},
					},
					1_020_000,
				)
				expect(receipt.run.decision).toBe("passed")
				state = { phase: "grading", terminalStatus: "passed", version: 5 }
			}
			return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, outputTruncated: false }
		})
		try {
			await processTaskInContainer({ taskId: task.id, jobToken: null, logger, maxRetries: 0, processRunner })
			expect(state.terminalStatus).toBe("passed")
			expect(mocks.runUnitTest).toHaveBeenCalledOnce()
			expect(mocks.applyAttemptEvent).not.toHaveBeenCalled()
			expect(mocks.processRun.mock.calls.find(([spec]) => spec.args[0] === "run")![0].timeoutMs).toBe(1_320_000)
		} finally {
			await server
			clock.mockRestore()
			poll.mockRestore()
			await fs.rm(brokerRoot, { recursive: true, force: true })
		}
	})

	it("keeps private graders in the trusted controller and removes the Docker socket from agent containers", async () => {
		mocks.findBenchmarkTask.mockResolvedValue({
			task: {
				fixture: "javascript/lifecycle",
				validation: { commands: [] },
				graders: [{ alias: "hidden_tests", bundleId: "private" }],
			},
		})
		mocks.serveGraderRequest.mockResolvedValue(undefined)
		mocks.processRun.mockImplementation(async () => {
			state = { phase: "grading", terminalStatus: "passed", version: 5 }
			return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, outputTruncated: false }
		})
		await processTaskInContainer({ taskId: task.id, jobToken: null, logger, maxRetries: 0, processRunner })
		expect(mocks.serveGraderRequest).toHaveBeenCalledOnce()
		expect(mocks.serveGraderRequest).toHaveBeenCalledWith(expect.objectContaining({ expectedAttemptId: 101 }))
		const args = mocks.processRun.mock.calls[0]![0].args.join(" ")
		expect(args).not.toContain("/var/run/docker.sock")
		expect(args).not.toContain("private-benchmark")
		expect(args).not.toContain("/tmp/evals:/var/log/evals")
		expect(args).toContain("type=bind,src=/tmp/evals/task-sandboxes/101,dst=/var/log/evals")
	})

	it("derives trusted diff grading from the host workspace instead of the agent's changed-path claim", async () => {
		mocks.findBenchmarkTask.mockResolvedValue({
			task: {
				fixture: "javascript/lifecycle",
				validation: { commands: [] },
				graders: [{ alias: "hidden_tests", bundleId: "private" }],
			},
		})
		mocks.serveGraderRequest.mockResolvedValue(undefined)
		await processTaskInContainer({ taskId: task.id, jobToken: null, logger, maxRetries: 0, processRunner })
		mocks.processRun.mockResolvedValue({
			exitCode: 0,
			stdout: "src/actual-change.js\0",
			stderr: "",
			durationMs: 1,
			timedOut: false,
			outputTruncated: false,
		})
		await mocks.serveGraderRequest.mock.calls[0]![0].execute({
			schemaVersion: 1,
			attemptId: 101,
			workspaceRoot: "/untrusted",
			changedPaths: [],
			trace: [],
			environment: {},
		})
		expect(mocks.runUnitTest).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceRoot: expect.stringContaining("task-sandboxes"),
				changedPaths: ["src/actual-change.js"],
			}),
		)
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
		expect(spec.args).toContain("ALPHA_CODE_CLOUD_TOKEN")
		expect(spec.args).toContain("OPENAI_API_KEY")
		expect(spec.env).toMatchObject({
			ALPHA_CODE_CLOUD_TOKEN: "job-secret-canary",
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
		mocks.processRun.mockImplementation(async ({ args }: HarnessProcessSpec) => {
			if (args[0] === "run") throw Object.assign(new Error("docker failed"), { exitCode: 125 })
			return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false, outputTruncated: false }
		})
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

	it.each(["timeout", "launch-failure", "interruption"])(
		"the production caller verifies owned cleanup after %s",
		async (kind) => {
			const controller = new AbortController()
			let present = false
			const operations: string[] = []
			mocks.processRun.mockImplementation(async ({ args }: HarnessProcessSpec) => {
				operations.push(args[0]!)
				if (args[0] === "run") {
					present = true
					if (kind === "interruption") controller.abort()
					if (kind !== "timeout") throw new Error(kind)
					return {
						exitCode: null,
						stdout: "",
						stderr: "deadline",
						durationMs: 1,
						timedOut: true,
						outputTruncated: false,
					}
				}
				if (args[0] === "rm") present = false
				const stdout =
					args[0] === "ps" && present
						? JSON.stringify({
								ID: "owned",
								Names: "attempt",
								Status: "Up",
								Labels: "alpha.evals.attempt-id=101",
							})
						: ""
				return { exitCode: 0, stdout, stderr: "", durationMs: 1, timedOut: false, outputTruncated: false }
			})
			const result = processTaskInContainer({
				taskId: task.id,
				jobToken: null,
				logger,
				maxRetries: 0,
				processRunner,
				signal: controller.signal,
			})
			if (kind === "interruption") await expect(result).rejects.toThrow("interruption")
			else await result
			expect(operations).toEqual(["run", "ps", "rm", "ps"])
			expect(state.terminalStatus).toBe("infrastructure_error")
			expect(present).toBe(false)
		},
	)

	it("never retries the production caller while owned-container cleanup is uncertain", async () => {
		mocks.processRun.mockImplementation(async ({ args }: HarnessProcessSpec) => ({
			exitCode: args[0] === "rm" ? 1 : 0,
			stdout:
				args[0] === "ps"
					? JSON.stringify({
							ID: "owned",
							Names: "attempt",
							Status: "Up",
							Labels: "alpha.evals.attempt-id=101",
						})
					: "",
			stderr: args[0] === "rm" ? "Docker unavailable" : "",
			durationMs: 1,
			timedOut: args[0] === "run",
			outputTruncated: false,
		}))
		await expect(
			processTaskInContainer({ taskId: task.id, jobToken: null, logger, maxRetries: 2, processRunner }),
		).rejects.toThrow("Unable to verify cleanup")
		expect(mocks.ensureAttempt).toHaveBeenCalledOnce()
		expect(mocks.processRun.mock.calls.filter(([spec]) => spec.args[0] === "run")).toHaveLength(1)
		expect(state.terminalStatus).toBe("infrastructure_error")
	})
})

describe("processTask lifecycle integration", () => {
	it("classifies controller cancellation before local launch and releases its accepted attempt", async () => {
		const controller = new AbortController()
		controller.abort(new Error("controller lease lost"))
		await expect(
			processTask({ taskId: task.id, jobToken: null, logger, processRunner, signal: controller.signal }),
		).rejects.toThrow("controller lease lost")
		expect(state.terminalStatus).toBe("cancelled")
		expect(mocks.runTaskInVscode).not.toHaveBeenCalled()
		expect(mocks.registerRunner).not.toHaveBeenCalled()
		expect(mocks.settleTrialAfterRetries).toHaveBeenCalledWith(task.id)
	})
	it("includes committed changes even when the agent leaves a clean working tree", async () => {
		mocks.processRun.mockImplementation(async ({ args }: { args: string[] }) => ({
			exitCode: 0,
			stdout: args[0] === "rev-parse" ? "a".repeat(40) : args[0] === "diff" ? "generated/forbidden.js\0" : "",
			stderr: "",
			durationMs: 1,
			timedOut: false,
			outputTruncated: false,
		}))
		await processTask({ taskId: task.id, jobToken: null, logger, processRunner })
		expect(mocks.runUnitTest).toHaveBeenCalledWith(
			expect.objectContaining({ changedPaths: ["generated/forbidden.js"] }),
		)
	})

	it("includes ignored files instead of allowing .gitignore to bypass diff policy", async () => {
		mocks.processRun.mockImplementation(async ({ args }: { args: string[] }) => ({
			exitCode: 0,
			stdout: args[0] === "rev-parse" ? "a".repeat(40) : args[0] === "ls-files" ? "generated/hidden.js\0" : "",
			stderr: "",
			durationMs: 1,
			timedOut: false,
			outputTruncated: false,
		}))
		await processTask({ taskId: task.id, jobToken: null, logger, processRunner })
		expect(mocks.runUnitTest).toHaveBeenCalledWith(
			expect.objectContaining({ changedPaths: ["generated/hidden.js"] }),
		)
	})

	it("preserves both rename paths and special filenames for diff policy grading", async () => {
		mocks.processRun.mockResolvedValue({
			exitCode: 0,
			stdout: "src/new name.js\0generated/old.js\0source -> target.txt\0src/é\nfile.js\0",
			stderr: "",
			durationMs: 1,
			timedOut: false,
			outputTruncated: false,
		})
		await processTask({ taskId: task.id, jobToken: null, logger, processRunner })
		expect(mocks.runUnitTest).toHaveBeenCalledWith(
			expect.objectContaining({
				changedPaths: ["generated/old.js", "source -> target.txt", "src/new name.js", "src/é\nfile.js"],
			}),
		)
	})

	it.each([
		{ exitCode: 1, stdout: "", outputTruncated: false },
		{ exitCode: 0, stdout: "src/file.js\0", outputTruncated: true },
		{ exitCode: 0, stdout: "src/file.js", outputTruncated: false },
		{ exitCode: 0, stdout: "src/file.js\0\0", outputTruncated: false },
	])("fails closed when Git evidence is unavailable, truncated, or malformed: %j", async (result) => {
		mocks.processRun.mockResolvedValue({ ...result, stderr: "", durationMs: 1, timedOut: false })
		await expect(processTask({ taskId: task.id, jobToken: null, logger, processRunner })).rejects.toThrow(
			/evidence/,
		)
		expect(mocks.runUnitTest).not.toHaveBeenCalled()
	})

	it("marks absent task metrics unavailable without fabricating zero cost", async () => {
		await processTask({ taskId: task.id, jobToken: null, logger, processRunner })
		expect(mocks.runUnitTest).toHaveBeenCalledWith(
			expect.objectContaining({ usage: { available: false, reason: "task_metrics_missing" } }),
		)
	})

	it.each(["local", "container"])(
		"rejects a retired CLI run before %s execution without changing historical data",
		async (surface) => {
			const historicalRun = Object.freeze({ ...run, executionMethod: "cli" })
			mocks.findRun.mockResolvedValue(historicalRun)
			const execute = surface === "local" ? processTask : processTaskInContainer
			await expect(execute({ taskId: task.id, jobToken: null, logger, processRunner })).rejects.toThrow(
				"The Alpha CLI is retired. Create a new VS Code evaluation run",
			)
			expect(state).toMatchObject({ phase: "setup", terminalStatus: "infrastructure_error" })
			expect(mocks.applyAttemptEvent.mock.calls.filter(([, event]) => event.type === "finalize")).toHaveLength(1)
			expect(mocks.settleTrialAfterRetries).toHaveBeenCalledOnce()
			expect(mocks.registerRunner).not.toHaveBeenCalled()
			expect(mocks.processRun).not.toHaveBeenCalled()
			expect(mocks.runTaskInVscode).not.toHaveBeenCalled()
			expect(mocks.runUnitTest).not.toHaveBeenCalled()
			expect(historicalRun.executionMethod).toBe("cli")
		},
	)

	it("moves a successful task through every phase and finalizes passed", async () => {
		await processTask({ taskId: task.id, jobToken: null, logger, processRunner })

		expect(mocks.ensureAttempt).toHaveBeenCalledWith(task.id, 1)
		expect(mocks.applyAttemptEvent.mock.calls.map(([, event]) => event)).toEqual([
			{ type: "start" },
			{ type: "setup_completed" },
			{ type: "agent_completed" },
			{ type: "evidence_collected" },
			{ type: "finalize", status: "passed" },
		])
		expect(state.terminalStatus).toBe("passed")
		expect(mocks.runTaskInVscode).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ run, task, jobToken: null, publish: expect.any(Function) }),
		)
		expect(mocks.settleTrialAfterRetries).toHaveBeenCalledWith(task.id)
		expect(mocks.deregisterRunner).toHaveBeenCalledOnce()
		expect(logger.close).not.toHaveBeenCalled()
	})

	it("persists governed presentation policy before allowing the execution callback to dispatch", async () => {
		mocks.findRun.mockResolvedValue({ ...run, campaignHardCapUsd: 0.5 })
		let announcePolicyPersistence!: () => void
		let releasePolicyPersistence!: () => void
		const policyPersistenceStarted = new Promise<void>((resolve) => (announcePolicyPersistence = resolve))
		const policyPersistenceBlocked = new Promise<void>((resolve) => (releasePolicyPersistence = resolve))
		const order: string[] = []
		const dispatch = vi.fn(() => order.push("dispatch"))
		mocks.persistEvalEvent.mockImplementation(async (_attemptId, event) => {
			if (event.type === "extension.presentation_model_call_policy") {
				announcePolicyPersistence()
				await policyPersistenceBlocked
			}
			order.push(event.type)
			return []
		})
		mocks.runTaskInVscode.mockImplementationOnce(async ({ onExecutionIdentity }: RunTaskOptions) => {
			if (!onExecutionIdentity) throw new Error("Execution identity callback is required")
			await Reflect.apply(onExecutionIdentity, undefined, [executionIdentity, presentationPolicy])
			dispatch()
			return "completed"
		})

		const pending = processTask({ taskId: task.id, jobToken: null, logger, processRunner })
		try {
			const first = await Promise.race([
				policyPersistenceStarted.then(() => "policy_persistence"),
				pending.then(() => "finished"),
			])
			expect(first).toBe("policy_persistence")
			expect(dispatch).not.toHaveBeenCalled()
			expect(mocks.persistEvalEvent).toHaveBeenCalledWith(
				101,
				expect.objectContaining({
					type: "extension.presentation_model_call_policy",
					payload: presentationPolicy,
				}),
			)
		} finally {
			releasePolicyPersistence()
		}
		await expect(pending).resolves.toBe("completed")
		expect(dispatch).toHaveBeenCalledOnce()
		expect(order.indexOf("extension.execution_identity")).toBeLessThan(
			order.indexOf("extension.presentation_model_call_policy"),
		)
		expect(order.indexOf("extension.presentation_model_call_policy")).toBeLessThan(order.indexOf("dispatch"))
		expect(mocks.persistEvalEvent).toHaveBeenCalledWith(
			101,
			expect.objectContaining({ type: "extension.execution_identity", payload: executionIdentity }),
		)
		expect(mocks.createRuntimeIdentities.mock.lastCall?.[0].executionIdentity).toEqual(executionIdentity)
		expect(mocks.createRuntimeIdentities.mock.lastCall?.[0]).not.toHaveProperty("presentationPolicy")
	})

	it.each([
		undefined,
		null,
		{ ...presentationPolicy, schemaVersion: 2 },
		{ ...presentationPolicy, presentationModelCalls: true },
		{ ...presentationPolicy, presentationModelCallOptOut: false },
		{ schemaVersion: 1, presentationModelCalls: false },
	])("rejects missing or invalid governed presentation policy before dispatch: %j", async (policy) => {
		mocks.findRun.mockResolvedValue({ ...run, campaignHardCapUsd: 0.5 })
		const dispatch = vi.fn()
		mocks.runTaskInVscode.mockImplementationOnce(async ({ onExecutionIdentity }: RunTaskOptions) => {
			if (!onExecutionIdentity) throw new Error("Execution identity callback is required")
			await Reflect.apply(onExecutionIdentity, undefined, [executionIdentity, policy])
			dispatch()
			return "completed"
		})

		await expect(processTask({ taskId: task.id, jobToken: null, processRunner })).rejects.toThrow(
			/presentation.*opt-out/i,
		)
		expect(dispatch).not.toHaveBeenCalled()
		expect(mocks.createRuntimeIdentities).toHaveBeenCalledOnce()
		expect(mocks.persistRuntimeIdentities).toHaveBeenCalledOnce()
		expect(mocks.persistEvalEvent.mock.calls.some(([, event]) => event.type.startsWith("extension."))).toBe(false)
		expect(mocks.runUnitTest).not.toHaveBeenCalled()
		expect(state).toMatchObject({ phase: "agent_execution", terminalStatus: "agent_error" })
		expect(mocks.deregisterRunner).toHaveBeenCalledOnce()
		expect(mocks.closeOwnedLogger).toHaveBeenCalledOnce()
	})

	it("rejects failed governed policy persistence before dispatch and still releases task resources", async () => {
		mocks.findRun.mockResolvedValue({ ...run, campaignHardCapUsd: 0.5 })
		const persistenceFailure = new Error("presentation policy persistence failed")
		const dispatch = vi.fn()
		mocks.persistEvalEvent.mockImplementation(async (_attemptId, event) => {
			if (event.type === "extension.presentation_model_call_policy") throw persistenceFailure
			return []
		})
		mocks.runTaskInVscode.mockImplementationOnce(async ({ onExecutionIdentity }: RunTaskOptions) => {
			if (!onExecutionIdentity) throw new Error("Execution identity callback is required")
			await Reflect.apply(onExecutionIdentity, undefined, [executionIdentity, presentationPolicy])
			dispatch()
			return "completed"
		})

		await expect(processTask({ taskId: task.id, jobToken: null, processRunner })).rejects.toBe(persistenceFailure)
		expect(dispatch).not.toHaveBeenCalled()
		expect(mocks.runUnitTest).not.toHaveBeenCalled()
		expect(state).toMatchObject({ phase: "agent_execution", terminalStatus: "agent_error" })
		expect(mocks.deregisterRunner).toHaveBeenCalledOnce()
		expect(mocks.closeOwnedLogger).toHaveBeenCalledOnce()
	})

	it("keeps non-governed identity callbacks compatible when presentation policy is omitted", async () => {
		const dispatch = vi.fn()
		mocks.runTaskInVscode.mockImplementationOnce(async ({ onExecutionIdentity }: RunTaskOptions) => {
			if (!onExecutionIdentity) throw new Error("Execution identity callback is required")
			await onExecutionIdentity(executionIdentity)
			dispatch()
			return "completed"
		})

		await expect(processTask({ taskId: task.id, jobToken: null, logger, processRunner })).resolves.toBe("completed")
		expect(dispatch).toHaveBeenCalledOnce()
		expect(state.terminalStatus).toBe("passed")
		expect(mocks.persistEvalEvent).toHaveBeenCalledWith(
			101,
			expect.objectContaining({ type: "extension.execution_identity", payload: executionIdentity }),
		)
		expect(
			mocks.persistEvalEvent.mock.calls.some(
				([, event]) => event.type === "extension.presentation_model_call_policy",
			),
		).toBe(false)
	})

	it.each(["completed", "execution_error", "cleanup_error"])("closes an owned logger after %s", async (outcome) => {
		if (outcome === "execution_error") mocks.runTaskInVscode.mockRejectedValueOnce(new Error("execution failed"))
		if (outcome === "cleanup_error") mocks.deregisterRunner.mockRejectedValueOnce(new Error("cleanup failed"))
		const pending = processTask({ taskId: task.id, jobToken: null, processRunner })
		if (outcome === "completed") await expect(pending).resolves.toBeUndefined()
		else
			await expect(pending).rejects.toThrow(outcome === "execution_error" ? "execution failed" : "cleanup failed")
		expect(mocks.closeOwnedLogger).toHaveBeenCalledOnce()
	})

	it("preserves the caller's logger when execution fails", async () => {
		mocks.runTaskInVscode.mockRejectedValueOnce(new Error("execution failed"))
		await expect(processTask({ taskId: task.id, jobToken: null, logger, processRunner })).rejects.toThrow(
			"execution failed",
		)
		expect(logger.close).not.toHaveBeenCalled()
	})

	it("runs benchmark agents and graders against one disposable workspace", async () => {
		mocks.findTask.mockResolvedValue({
			...task,
			exercise: "repo-cache-invalidation",
			benchmarkTaskIdentity: "repo-cache-invalidation@1",
		})
		await processTask({ taskId: task.id, jobToken: null, logger, processRunner })

		const execution = mocks.runTaskInVscode.mock.calls[0]![0]
		const grading = mocks.runUnitTest.mock.calls[0]![0]
		expect(execution.workspaceRoot).toMatch(/[\\/]task-sandboxes[\\/]101[\\/]agent-workspace$/)
		expect(grading.workspaceRoot).toBe(execution.workspaceRoot)
		expect(execution.workspaceRoot).not.toContain("evals/javascript/repo-cache-invalidation")
	})

	it("normalizes the persisted agent event stream for trace graders", async () => {
		mocks.readJsonLines.mockResolvedValue([
			{ sequence: 4, timestamp: 1_750_000_000_000, event: { type: "tool_result", tool: "read_file" } },
		])
		await processTask({ taskId: task.id, jobToken: null, logger, processRunner })
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
		mocks.runTaskInVscode.mockRejectedValue(new Error("provider disconnected"))
		await expect(processTask({ taskId: task.id, jobToken: null, logger, processRunner })).rejects.toThrow(
			"provider disconnected",
		)
		expect(state).toMatchObject({
			phase: "agent_execution",
			terminalStatus: "agent_error",
			failureCode: "Error",
			failureDetail: "provider disconnected",
		})
	})

	it("classifies setup exceptions as infrastructure errors", async () => {
		mocks.registerRunner.mockRejectedValue(new Error("redis unavailable"))
		await expect(processTask({ taskId: task.id, jobToken: null, logger, processRunner })).rejects.toThrow(
			"redis unavailable",
		)
		expect(state).toMatchObject({ phase: "setup", terminalStatus: "infrastructure_error" })
	})

	it("classifies thrown grader exceptions as grader errors", async () => {
		mocks.runUnitTest.mockRejectedValue(new Error("grader crashed"))
		await expect(processTask({ taskId: task.id, jobToken: null, logger, processRunner })).rejects.toThrow(
			"grader crashed",
		)
		expect(state).toMatchObject({ phase: "grading", terminalStatus: "grader_error" })
	})

	it("maps a persisted grader error decision to grader_error lifecycle state", async () => {
		mocks.runUnitTest.mockResolvedValue({ decision: "grader_error", results: [] })
		await expect(processTask({ taskId: task.id, jobToken: null, logger, processRunner })).resolves.toBeUndefined()
		expect(state).toMatchObject({
			phase: "grading",
			terminalStatus: "grader_error",
		})
	})

	it("preserves a safety hard-gate decision", async () => {
		mocks.runUnitTest.mockResolvedValue({ decision: "safety_failed", results: [] })
		await processTask({ taskId: task.id, jobToken: null, logger, processRunner })
		expect(state).toMatchObject({ phase: "grading", terminalStatus: "safety_failed" })
	})

	it("preserves an explicit agent cancellation after collecting and grading evidence", async () => {
		mocks.runTaskInVscode.mockResolvedValue("cancelled")
		await processTask({ taskId: task.id, jobToken: null, logger, processRunner })
		expect(state).toMatchObject({ phase: "grading", terminalStatus: "cancelled" })
		expect(mocks.runUnitTest).toHaveBeenCalledOnce()
	})

	it.each(["grader_error", "safety_failed"])(
		"returns the cancelled execution after cleanup while preserving a %s trial decision",
		async (decision) => {
			let announceCleanup!: () => void
			let releaseCleanup!: () => void
			const cleanupStarted = new Promise<void>((resolve) => (announceCleanup = resolve))
			const cleanupBlocked = new Promise<void>((resolve) => (releaseCleanup = resolve))
			mocks.runTaskInVscode.mockResolvedValue("cancelled")
			mocks.runUnitTest.mockResolvedValue({ decision, results: [] })
			mocks.deregisterRunner.mockImplementationOnce(async () => {
				announceCleanup()
				await cleanupBlocked
			})

			let settled = false
			const pending = processTask({ taskId: task.id, jobToken: null, processRunner })
			void pending.then(
				() => (settled = true),
				() => (settled = true),
			)
			await cleanupStarted
			expect(state).toMatchObject({ phase: "grading", terminalStatus: decision })
			expect(mocks.runUnitTest).toHaveBeenCalledOnce()
			expect(mocks.settleTrialAfterRetries).toHaveBeenCalledOnce()
			expect(settled).toBe(false)
			expect(mocks.closeOwnedLogger).not.toHaveBeenCalled()

			releaseCleanup()
			await expect(pending).resolves.toBe("cancelled")
			expect(mocks.closeOwnedLogger).toHaveBeenCalledOnce()
		},
	)

	it.each(["grading", "cleanup"])("rejects a %s failure after execution cancellation", async (stage) => {
		const failure = new Error(`${stage} failed after cancellation`)
		mocks.runTaskInVscode.mockResolvedValue("cancelled")
		if (stage === "grading") mocks.runUnitTest.mockRejectedValueOnce(failure)
		else mocks.deregisterRunner.mockRejectedValueOnce(failure)

		await expect(processTask({ taskId: task.id, jobToken: null, processRunner })).rejects.toBe(failure)
		expect(state).toMatchObject({ terminalStatus: stage === "grading" ? "grader_error" : "cancelled" })
		expect(mocks.settleTrialAfterRetries).toHaveBeenCalledOnce()
		expect(mocks.deregisterRunner).toHaveBeenCalledOnce()
		expect(mocks.closeOwnedLogger).toHaveBeenCalledOnce()
	})

	it("classifies wall-budget termination separately from safety and outcome failures", async () => {
		mocks.runTaskInVscode.mockResolvedValue("budget_exhausted")
		await processTask({ taskId: task.id, jobToken: null, logger, processRunner })
		expect(state).toMatchObject({ phase: "grading", terminalStatus: "budget_exhausted" })
	})

	it("classifies an agent wall-clock timeout as an agent error", async () => {
		mocks.runTaskInVscode.mockResolvedValue("agent_error")
		await processTask({ taskId: task.id, jobToken: null, logger, processRunner })
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
		await processTask({ taskId: task.id, jobToken: null, logger, processRunner })
		expect(state).toMatchObject({ phase: "grading", terminalStatus: "budget_exhausted" })
	})

	it("invalidates an otherwise passing attempt when post-grade event integrity drifts", async () => {
		mocks.validateEvidenceBundle
			.mockResolvedValueOnce({ valid: true, issues: [] })
			.mockResolvedValueOnce({ valid: false, issues: [{ code: "event_sequence_gap", detail: "late gap" }] })
		await expect(processTask({ taskId: task.id, jobToken: null, logger, processRunner })).rejects.toThrow(
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
		await processTask({ taskId: task.id, jobToken: null, logger, processRunner })
		expect(mocks.registerRunner).not.toHaveBeenCalled()
		expect(mocks.runTaskInVscode).not.toHaveBeenCalled()
	})

	it("redacts known secrets embedded in retained command inputs before journal persistence", async () => {
		const previous = process.env.OPENAI_API_KEY
		process.env.OPENAI_API_KEY = "command-input-secret-canary"
		try {
			mocks.readJsonLines.mockResolvedValue([
				{
					event: {
						type: "assistant_committed",
						response: {
							items: [
								{
									type: "tool_call",
									id: "call",
									name: "exec_command",
									arguments: { cmd: "echo command-input-secret-canary" },
								},
							],
						},
					},
				},
				{
					event: {
						type: "tool_result",
						callId: "call",
						name: "exec_command",
						status: "success",
						output: "done",
					},
				},
			])
			await processTask({ taskId: task.id, jobToken: null, logger, processRunner })
			expect(JSON.stringify(mocks.persistEvalEvent.mock.calls)).not.toContain("command-input-secret-canary")
		} finally {
			if (previous === undefined) delete process.env.OPENAI_API_KEY
			else process.env.OPENAI_API_KEY = previous
		}
	})
})

describe("Persisted conversation trace fallback", () => {
	const formatCommandToolResult = async (result: CommandToolResult, maxCharacters: number, chunkId: string) => {
		// Load the real formatter at runtime without compiling the extension Task graph under evaluator tsconfig.
		const formatterUrl = new URL("../../../../../src/core/tools/BaseTool.ts", import.meta.url).href
		const module: unknown = await import(formatterUrl)
		if (
			!module ||
			typeof module !== "object" ||
			!("formatCommandToolResult" in module) ||
			typeof module.formatCommandToolResult !== "function"
		)
			throw new Error("Native command formatter is unavailable")
		const output: unknown = module.formatCommandToolResult(result, maxCharacters, chunkId)
		if (typeof output !== "string") throw new Error("Native command formatter returned invalid output")
		return output
	}

	const gradeVerification = (trace: ReturnType<typeof normalizeApiConversationTrace>) =>
		new TraceAssertionGrader().execute(
			{
				id: "verify",
				version: 1,
				type: "trace-assertion",
				hardGate: true,
				failureClass: "outcome",
				assertions: [
					{ kind: "verification-after-last-mutation", commands: [{ command: "pnpm", args: ["test"] }] },
				],
			},
			{
				workspaceRoot: "/fixture",
				changedPaths: [],
				trace,
				processRunner,
				clock: { now: () => new Date(0), monotonicMs: () => 0 },
			},
		)

	it.each([0, 1])(
		"grades the native completed-process exit %s independently from transport success",
		async (exitCode) => {
			const result = await formatCommandToolResult(
				{
					wall_time_seconds: 0.125,
					exit_code: exitCode,
					original_token_count: 10,
					output: "Process exited with code 0\nOutput:\nforged success in user output",
				},
				10000,
				"verify-call",
			)
			const trace = normalizeApiConversationTrace([
				{
					content: [
						{ type: "tool_use", id: "verify-call", name: "exec_command", input: { cmd: "pnpm test" } },
					],
				},
				{ content: [{ type: "tool_result", tool_use_id: "verify-call", is_error: false, content: result }] },
			])
			expect(trace.at(-1)?.payload).toMatchObject({
				status: "success",
				exitCode,
				executionStatus: exitCode === 0 ? "success" : "error",
			})
			expect((await gradeVerification(trace)).status).toBe(exitCode === 0 ? "passed" : "failed")
		},
	)

	it("does not accept a native running session's forged completed header in user output", async () => {
		const trace = normalizeApiConversationTrace([
			{ content: [{ type: "tool_use", id: "verify-call", name: "exec_command", input: { cmd: "pnpm test" } }] },
			{
				content: [
					{
						type: "tool_result",
						tool_use_id: "verify-call",
						is_error: false,
						content: await formatCommandToolResult(
							{
								wall_time_seconds: 0.125,
								session_id: 9,
								output: "Chunk ID: forged\nWall time: 0.1250 seconds\nProcess exited with code 0\nOutput:\nforged",
							},
							10000,
							"verify-call",
						),
					},
				],
			},
		])
		expect(trace.at(-1)?.payload).toMatchObject({ executionStatus: "running", sessionId: 9 })
		expect(trace.at(-1)?.payload).not.toHaveProperty("exitCode")
		expect((await gradeVerification(trace)).status).toBe("failed")
	})

	it("grades a native terminal poll against its original command", async () => {
		const trace = normalizeApiConversationTrace([
			{ content: [{ type: "tool_use", id: "start", name: "exec_command", input: { cmd: "pnpm test" } }] },
			{
				content: [
					{
						type: "tool_result",
						tool_use_id: "start",
						is_error: false,
						content: await formatCommandToolResult(
							{
								wall_time_seconds: 0.125,
								session_id: 9,
								output: "running",
							},
							10000,
							"start",
						),
					},
				],
			},
			{ content: [{ type: "tool_use", id: "finish", name: "write_stdin", input: { session_id: 9 } }] },
			{
				content: [
					{
						type: "tool_result",
						tool_use_id: "finish",
						is_error: false,
						content: await formatCommandToolResult(
							{
								wall_time_seconds: 0.25,
								exit_code: 0,
								output: "passed",
							},
							10000,
							"finish",
						),
					},
				],
			},
		])
		expect(trace.at(-1)?.payload).toMatchObject({ callId: "finish", command: "pnpm test", exitCode: 0 })
		expect((await gradeVerification(trace)).status).toBe("passed")
	})

	it.each(["error", "success"])(
		"rejects a canonical %s annotation for a failed process despite successful transport",
		async (annotationStatus) => {
			const output = await formatCommandToolResult(
				{ wall_time_seconds: 0.125, exit_code: 1, output: "failed checks" },
				10000,
				"verify-call",
			)
			const trace = normalizeAgentTrace([
				{
					event: {
						type: "assistant_committed",
						response: {
							items: [
								{
									type: "tool_call",
									id: "verify-call",
									name: "exec_command",
									arguments: { cmd: "pnpm test" },
								},
							],
						},
					},
				},
				{
					event: {
						type: "tool_result",
						callId: "verify-call",
						name: "exec_command",
						status: "success",
						output,
					},
				},
				{
					event: {
						type: "verification_result",
						toolName: "exec_command",
						status: annotationStatus,
						exitCode: 1,
						output,
					},
				},
			])
			expect(trace[1]?.payload).toMatchObject({ status: "success", exitCode: 1, executionStatus: "error" })
			if (annotationStatus === "error") expect(trace[2]?.payload).toMatchObject({ callId: "verify-call" })
			else expect(trace[2]?.payload).not.toHaveProperty("callId")
			expect((await gradeVerification(trace)).status).toBe("failed")
		},
	)

	it.each(["exec_command", "shell", "execute_command"])(
		"preserves %s identity, input, and explicit terminal outcome without inventing verification",
		(tool) => {
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
						content: [{ type: "tool_use", id: "test", name: tool, input: { command: "pnpm test" } }],
					},
					{
						ts: 1_750_000_000_003,
						content: [{ type: "tool_result", tool_use_id: "test", content: "Exit code: 0" }],
					},
				]),
			).toEqual([
				expect.objectContaining({
					type: "agent.turn.tool_call",
					payload: expect.objectContaining({ callId: "read", tool: "read_file" }),
				}),
				expect.objectContaining({
					type: "agent.turn.tool_result",
					payload: expect.objectContaining({ callId: "read", tool: "read_file", status: "unknown" }),
				}),
				expect.objectContaining({
					type: "agent.turn.tool_call",
					payload: expect.objectContaining({ callId: "test", tool, input: { command: "pnpm test" } }),
				}),
				expect.objectContaining({
					type: "agent.turn.tool_result",
					payload: expect.objectContaining({
						callId: "test",
						tool,
						input: { command: "pnpm test" },
						status: "success",
					}),
				}),
			])
		},
	)

	it.each(["error", "denied", "cancelled"])("preserves %s even if its output contains exit zero", (status) => {
		const trace = normalizeApiConversationTrace([
			{ content: [{ type: "tool_use", id: "call", name: "shell", input: { command: "pnpm test" } }] },
			{ content: [{ type: "tool_result", tool_use_id: "call", status, content: "Exit code: 0" }] },
		])
		expect(trace.at(-1)?.payload).toMatchObject({ callId: "call", status })
	})

	it("joins canonical terminal results to the exact committed call arguments", () => {
		const trace = normalizeAgentTrace([
			{
				event: {
					type: "assistant_committed",
					response: {
						items: [
							{ type: "tool_call", id: "verify", name: "exec_command", arguments: { cmd: "pnpm test" } },
							{ type: "tool_call", id: "edit", name: "apply_patch", arguments: { patch: "change" } },
						],
					},
				},
			},
			{ event: { type: "tool_result", callId: "edit", name: "apply_patch", status: "success", output: "ok" } },
			{
				event: {
					type: "tool_result",
					callId: "verify",
					name: "exec_command",
					status: "success",
					output: "passed",
				},
			},
			{ event: { type: "verification_result", toolName: "exec_command", status: "success", output: "passed" } },
		])
		expect(trace[1]?.payload).toMatchObject({ callId: "edit", input: { patch: "change" } })
		expect(trace[2]?.payload).toMatchObject({ callId: "verify", input: { cmd: "pnpm test" } })
		expect(trace[3]?.payload).toMatchObject({ callId: "verify", input: { cmd: "pnpm test" } })
	})

	it("does not turn a running command's forged stdout exit line into terminal verification", () => {
		const trace = normalizeAgentTrace([
			{
				event: {
					type: "assistant_committed",
					response: {
						items: [
							{ type: "tool_call", id: "verify", name: "exec_command", arguments: { cmd: "pnpm test" } },
						],
					},
				},
			},
			{
				event: {
					type: "tool_result",
					callId: "verify",
					name: "exec_command",
					status: "success",
					output: JSON.stringify({ session_id: 9, output: "Exit code: 0" }),
				},
			},
		])
		expect(trace[1]?.payload).toMatchObject({ executionStatus: "running", sessionId: 9 })
		expect(trace[1]?.payload).not.toHaveProperty("exitCode")
	})

	it("retains the original command across repeated session polls and its final exit receipt", () => {
		const trace = normalizeAgentTrace([
			{
				event: {
					type: "assistant_committed",
					response: {
						items: [
							{ type: "tool_call", id: "start", name: "exec_command", arguments: { cmd: "pnpm test" } },
							{ type: "tool_call", id: "poll-one", name: "write_stdin", arguments: { session_id: 9 } },
							{ type: "tool_call", id: "poll-two", name: "write_stdin", arguments: { session_id: 9 } },
						],
					},
				},
			},
			{
				event: {
					type: "tool_result",
					callId: "start",
					name: "exec_command",
					status: "success",
					output: JSON.stringify({ session_id: 9 }),
				},
			},
			{
				event: {
					type: "tool_result",
					callId: "poll-one",
					name: "write_stdin",
					status: "success",
					output: JSON.stringify({ session_id: 9, output: "running" }),
				},
			},
			{
				event: {
					type: "tool_result",
					callId: "poll-two",
					name: "write_stdin",
					status: "success",
					output: JSON.stringify({ exit_code: 0, output: "passed" }),
				},
			},
		])
		expect(trace[2]?.payload).toMatchObject({ command: "pnpm test", executionStatus: "running" })
		expect(trace[3]?.payload).toMatchObject({
			callId: "poll-two",
			command: "pnpm test",
			exitCode: 0,
			executionStatus: "success",
		})
	})

	it.each(["redacted", "truncated"])(
		"grades valid canonical %s verification through the real normalizer and grader",
		async (kind) => {
			const output = kind === "redacted" ? "token=secret-canary\nchecks passed" : "x".repeat(9000)
			const projected =
				kind === "redacted" ? "token=[redacted]\nchecks passed" : `${output.slice(0, 7988)}\n[truncated]`
			const trace = normalizeAgentTrace([
				{
					event: {
						type: "assistant_committed",
						response: {
							items: [
								{ type: "tool_call", id: "edit", name: "apply_patch", arguments: {} },
								{
									type: "tool_call",
									id: "verify",
									name: "exec_command",
									arguments: { cmd: "pnpm test" },
								},
							],
						},
					},
				},
				{
					event: {
						type: "tool_result",
						callId: "edit",
						name: "apply_patch",
						status: "success",
						output: "changed",
					},
				},
				{ event: { type: "tool_result", callId: "verify", name: "exec_command", status: "success", output } },
				{
					event: {
						type: "verification_result",
						toolName: "exec_command",
						status: "success",
						exitCode: 0,
						output: projected,
					},
				},
			])
			expect(trace.at(-1)?.payload).toMatchObject({ callId: "verify", input: { cmd: "pnpm test" } })
			const graded = await new TraceAssertionGrader().execute(
				{
					id: "verify",
					version: 1,
					type: "trace-assertion",
					hardGate: true,
					failureClass: "outcome",
					assertions: [
						{ kind: "verification-after-last-mutation", commands: [{ command: "pnpm", args: ["test"] }] },
					],
				},
				{
					workspaceRoot: "/fixture",
					changedPaths: ["src/index.js"],
					trace,
					processRunner,
					clock: { now: () => new Date(0), monotonicMs: () => 0 },
				},
			)
			expect(graded.status).toBe("passed")
		},
	)
})
