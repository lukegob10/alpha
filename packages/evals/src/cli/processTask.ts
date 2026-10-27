import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { type TaskEvent, AlphaCodeEventName } from "@alpha-code/types"

import {
	findBenchmarkTask,
	serveGraderRequest,
	type BenchmarkTaskManifest,
	type GraderBrokerRequest,
} from "../benchmark/index"
import {
	applyAttemptEvent,
	ensureAttempt,
	findRun,
	findTask,
	findTrialForTask,
	getTasks,
	persistArtifactDescriptors,
	persistEvalEvent,
	persistRuntimeIdentities,
	recordEvidenceIntegrity,
	settleTrialAfterRetries,
	type Run,
	type Task,
} from "../db/index"
import { EVALS_REPO_PATH, getTaskWorkspacePath } from "../exercises/index"
import {
	createRuntimeIdentities,
	EventJournal,
	extractFinalResponse,
	FilesystemArtifactStore,
	readJsonLines,
	collectWorkspaceEvidence,
	evidenceBundleDigest,
	redact,
	readOptionalEvidenceLog,
	validateEvidenceBundle,
	type ArtifactDescriptor,
	type EvidenceBundle,
} from "../evidence/index"
import type { EvalTraceEvent, GraderEvidence, GraderRunResult } from "../grading/index"
import { taskGradingTimeoutMs } from "../grading/catalog"
import type { CommandGraderSpec } from "../grading/types"
import { captureExpectedNodeTestCommands } from "../grading/nodeTestCompletion"
import {
	collectInfrastructureManifest,
	ContainerCleanupError,
	DockerCliAdapter,
	type ContainerSpec,
} from "../infrastructure/index"
import { isRetryableStatus, type AttemptPhase, type TrialTerminalStatus } from "../lifecycle/index"
import {
	calculateBackoffMs,
	ExecaHarnessProcessRunner,
	systemRandom,
	systemSleeper,
	type HarnessProcessRunner,
	type HarnessSleeper,
} from "../orchestration/index"

import { Logger, getTag, isDockerContainer } from "./utils"
import { redisClient, getPubSubKey, registerRunner, deregisterRunner } from "./redis"
import { runUnitTest } from "./runUnitTest"
import { runTaskInVscode } from "./runTaskInVscode"
import { presentationModelCallPolicySchema } from "./types"
import { captureWorkspaceBaseline, collectChangedPaths } from "./workspaceChanges"

type ProcessTaskOptions = {
	taskId: number
	jobToken: string | null
	logger?: Logger
	processRunner?: HarnessProcessRunner
	signal?: AbortSignal
}

export const processTask = async ({
	taskId,
	jobToken,
	logger,
	processRunner = new ExecaHarnessProcessRunner(),
	signal,
}: ProcessTaskOptions) => {
	if (signal) {
		const runner = processRunner
		processRunner = {
			run: (spec) =>
				runner.run({ ...spec, signal: spec.signal ? AbortSignal.any([spec.signal, signal]) : signal }),
		}
	}
	const task = await findTask(taskId)
	const run = await findRun(task.runId)
	const attemptNumber = parseAttemptNumber(process.env.EVALS_ATTEMPT)
	const attempt = await ensureAttempt(task.id, attemptNumber)
	if (attempt.terminalStatus) return

	const trial = await findTrialForTask(task.id)
	if (!trial) throw new Error(`Trial was not created for task ${task.id}`)
	const containerized = isDockerContainer()
	const artifactRoot = containerized ? "/var/log/evals/artifacts" : path.join(os.tmpdir(), "evals", "artifacts")
	const store = new FilesystemArtifactStore(artifactRoot)
	const journal = new EventJournal(
		{
			runId: String(run.id),
			trialId: String(trial.id),
			attemptId: String(attempt.id),
		},
		{ secrets: secretValues(jobToken) },
	)
	let phase: AttemptPhase = attempt.phase
	let finalized = false
	let registered = false
	let settled = false
	let localSandboxRoot: string | undefined
	let descriptors: ArtifactDescriptor[] = []
	let executionOutcome: Awaited<ReturnType<typeof runTaskInVscode>> | undefined
	const ownsLogger = logger === undefined

	logger ??= new Logger({
		logDir: containerized
			? `/var/log/evals/runs/${run.id}`
			: path.join(os.tmpdir(), "evals", "runs", String(run.id)),
		filename: `${task.language}-${task.exercise}.log`,
		tag: getTag("runTask", { run, task }),
	})

	const record = async (type: string, payload: unknown) => {
		const event = journal.append(type, payload)
		await persistEvalEvent(attempt.id, event)
	}
	const transition = async (event: Parameters<typeof applyAttemptEvent>[1]) => {
		const result = await applyAttemptEvent(attempt.id, event)
		phase = result.attempt.phase
		finalized = Boolean(result.attempt.terminalStatus)
		await record(`lifecycle.${event.type}`, event)
		return result
	}

	try {
		await transition({ type: "start" })
		signal?.throwIfAborted()
		if (run.executionMethod !== "vscode") {
			throw new Error(
				"The Alpha CLI is retired. Create a new VS Code evaluation run; historical results are preserved.",
			)
		}
		await registerRunner({ runId: run.id, taskId, timeoutSeconds: (run.timeout || 5) * 60 })
		registered = true
		const benchmark = await findBenchmarkTask(EVALS_REPO_PATH, `${task.language}/${task.exercise}`)
		const brokered =
			Boolean(process.env.EVALS_GRADER_BROKER_ROOT) &&
			benchmark.task.graders.some(({ bundleId }) => Boolean(bundleId))
		// The trusted controller captures private originals before launching this brokered child.
		const preparedVisibleCommands = brokered
			? undefined
			: await captureExpectedNodeTestCommands(
					originalTaskFixture(task, benchmark.task),
					benchmark.task.validation.commands,
				)
		let workspaceRoot = getTaskWorkspacePath(task)
		if (!containerized && task.benchmarkTaskIdentity) {
			localSandboxRoot = path.join(os.tmpdir(), "evals", "task-sandboxes", String(attempt.id))
			workspaceRoot = path.join(localSandboxRoot, "agent-workspace")
			await prepareTaskWorkspace(task, workspaceRoot, processRunner)
		}
		const baselineCommit = await captureWorkspaceBaseline(workspaceRoot, processRunner)
		await record("workspace.baseline_captured", { commit: baselineCommit })

		const identityInput = {
			taskId: task.benchmarkTaskIdentity ?? `${task.language}/${task.exercise}`,
			taskManifest: benchmark.task,
			workspace: workspaceRoot,
			promptFiles: [
				path.join(workspaceRoot, "prompt.md"),
				path.join(EVALS_REPO_PATH, "prompts", `${task.language}.md`),
			],
			model: run.model,
			settings: run.settings,
			processRunner,
			network: "restricted" as const,
		}
		let identities = await createRuntimeIdentities(identityInput)
		await persistRuntimeIdentities(identities.taskManifest, identities.variantManifest)
		await recordEvidenceIntegrity({
			attemptId: attempt.id,
			status: "pending",
			taskIdentity: identities.taskIdentity,
			variantIdentity: identities.variantIdentity,
		})
		await transition({ type: "setup_completed" })

		const publish = async (event: TaskEvent) => {
			const redis = await redisClient()
			await redis.publish(getPubSubKey(run.id), JSON.stringify(event))
		}
		logger.info(`running task ${task.id} (${task.language}/${task.exercise}) via vscode...`)
		executionOutcome = await runTaskInVscode({
			run,
			task,
			jobToken,
			publish,
			logger,
			workspaceRoot,
			signal,
			onExecutionIdentity: async (executionIdentity, presentationPolicy) => {
				const parsedPolicy =
					typeof run.campaignHardCapUsd === "number"
						? presentationModelCallPolicySchema.safeParse(presentationPolicy)
						: undefined
				if (parsedPolicy && !parsedPolicy.success)
					throw new Error(`Governed task ${task.id} requires a validated presentation model-call opt-out`)
				identities = await createRuntimeIdentities({ ...identityInput, executionIdentity })
				await persistRuntimeIdentities(identities.taskManifest, identities.variantManifest)
				await recordEvidenceIntegrity({
					attemptId: attempt.id,
					status: "pending",
					taskIdentity: identities.taskIdentity,
					variantIdentity: identities.variantIdentity,
				})
				await record("extension.execution_identity", executionIdentity)
				if (parsedPolicy?.success) await record("extension.presentation_model_call_policy", parsedPolicy.data)
			},
		})
		await transition({ type: "agent_completed" })

		const evidencePaths = taskEvidencePaths(logger.path, task)
		const rawTrace = await readJsonLines(evidencePaths.agentTurns)
		const trace = rawTrace.length
			? normalizeAgentTrace(rawTrace)
			: normalizeApiConversationTrace(await readJson(evidencePaths.apiConversation))
		for (const event of trace) await record(event.type, event.payload ?? {})
		const [extensionLog, transcript, refreshedTasks] = await Promise.all([
			readOptionalEvidenceLog(logger.path),
			readOptionalEvidenceLog(evidencePaths.uiMessages),
			getTasks(run.id),
		])
		const persistedMetrics = refreshedTasks.find(({ id }) => id === task.id)?.taskMetrics
		if (benchmark.task.admission === "admitted" && !persistedMetrics) {
			throw new Error(`Admitted task ${benchmark.task.id} is missing usage evidence`)
		}
		if (
			benchmark.task.admission === "admitted" &&
			requiresTraceEvidence(benchmark.task.graders) &&
			trace.length === 0
		) {
			throw new Error(`Admitted task ${benchmark.task.id} is missing its normalized agent trace`)
		}
		const usage = normalizeUsage(persistedMetrics)
		const changedPaths = await collectChangedPaths(workspaceRoot, processRunner, baselineCommit)
		const environment = runtimeEnvironment(run, containerized)
		descriptors = await collectWorkspaceEvidence({
			attemptId: String(attempt.id),
			workspace: workspaceRoot,
			baselineCommit,
			extensionLog,
			transcript,
			finalResponse: transcript === undefined ? undefined : extractFinalResponse(transcript),
			captureStatuses: { test_output: "unavailable" },
			usage,
			stopReason: executionOutcome ?? "agent_completed",
			processRunner,
			store,
			secrets: secretValues(jobToken),
		})
		await persistArtifactDescriptors(
			attempt.id,
			descriptors.filter(({ kind }) => kind !== "test_output"),
			artifactRoot,
		)
		await transition({ type: "evidence_collected" })

		const bundle = evidenceBundle({
			run,
			trialId: trial.id,
			attemptId: attempt.id,
			identities,
			journal,
			descriptors,
		})
		const initialIntegrity = await validateEvidenceBundle(bundle, store, {
			allowUnavailableArtifacts: ["test_output"],
			requireWorkspaceSnapshot: true,
		})
		if (!initialIntegrity.valid) {
			await recordEvidenceIntegrity({
				attemptId: attempt.id,
				status: "invalid",
				taskIdentity: identities.taskIdentity,
				variantIdentity: identities.variantIdentity,
			})
			await transition({
				type: "finalize",
				status: "infrastructure_error",
				failureCode: "evidence_integrity_failed",
				failureDetail: initialIntegrity.issues.map(({ code, detail }) => `${code}: ${detail}`).join("; "),
			})
			throw new Error("Evidence integrity failed before grading")
		}

		const graderArtifacts: ArtifactDescriptor[] = []
		const verificationOutput: Array<{ id: string; kind: string; output: string }> = []
		const graderSink = createGraderEvidenceSink(store, String(attempt.id), graderArtifacts, secretValues(jobToken))
		logger.info(`grading task ${task.id} (${task.language}/${task.exercise})...`)
		const graded = await runUnitTest({
			task,
			attemptId: attempt.id,
			logger,
			workspaceRoot,
			changedPaths,
			trace,
			usage,
			environment,
			processRunner,
			preparedVisibleCommands,
			evidenceSink: async (id, kind, value, mediaType) => {
				if (kind === "stdout" || kind === "stderr") verificationOutput.push({ id, kind, output: value })
				return graderSink(id, kind, value, mediaType)
			},
		})
		const testOutput = await store.put({
			attemptId: String(attempt.id),
			kind: "test_output",
			bytes: Buffer.from(
				JSON.stringify(
					redact(
						verificationOutput.length
							? verificationOutput
							: { status: "not_applicable", reason: "no_command_output" },
						{ secrets: secretValues(jobToken) },
					),
				),
			),
			mediaType: "application/json",
			captureStatus:
				graded.results.some(({ type }) => type === "command") && !verificationOutput.length
					? "missing"
					: "captured",
		})
		descriptors = descriptors.filter(({ kind }) => kind !== "test_output")
		descriptors.push(testOutput)
		await persistArtifactDescriptors(attempt.id, [testOutput], artifactRoot)
		if (graderArtifacts.length) {
			descriptors.push(...graderArtifacts)
			await persistArtifactDescriptors(attempt.id, graderArtifacts, artifactRoot)
		}

		const finalIntegrity = await validateEvidenceBundle(
			evidenceBundle({ run, trialId: trial.id, attemptId: attempt.id, identities, journal, descriptors }),
			store,
			{ requireWorkspaceSnapshot: true },
		)
		if (!finalIntegrity.valid) {
			await recordEvidenceIntegrity({
				attemptId: attempt.id,
				status: "invalid",
				taskIdentity: identities.taskIdentity,
				variantIdentity: identities.variantIdentity,
			})
			await transition({
				type: "finalize",
				status: "infrastructure_error",
				failureCode: "final_evidence_integrity_failed",
				failureDetail: finalIntegrity.issues.map(({ code, detail }) => `${code}: ${detail}`).join("; "),
			})
			throw new Error("Final evidence integrity failed")
		}
		const status = classifyTerminalStatus(graded, executionOutcome)
		await transition({ type: "finalize", status })
		const sealedBundle = evidenceBundle({
			run,
			trialId: trial.id,
			attemptId: attempt.id,
			identities,
			journal,
			descriptors,
		})
		const sealedIntegrity = await validateEvidenceBundle(sealedBundle, store, { requireWorkspaceSnapshot: true })
		if (!sealedIntegrity.valid) throw new Error("Finalized evidence integrity failed")
		await recordEvidenceIntegrity({
			attemptId: attempt.id,
			status: "valid",
			taskIdentity: identities.taskIdentity,
			variantIdentity: identities.variantIdentity,
			bundleDigest: evidenceBundleDigest(sealedBundle),
			bundle: sealedBundle,
		})
		logger.info(`task ${task.id} (${task.language}/${task.exercise}) -> ${status}`)
		await publish({
			eventName: status === "passed" ? AlphaCodeEventName.EvalPass : AlphaCodeEventName.EvalFail,
			taskId: task.id,
		})
		await settleTrialAfterRetries(task.id)
		settled = true
	} catch (error) {
		if (!finalized) {
			const status = signal?.aborted ? "cancelled" : failureStatusForPhase(phase)
			await transition({
				type: "finalize",
				status,
				failureCode: error instanceof Error ? error.name : "UnknownError",
				failureDetail: error instanceof Error ? error.message : String(error),
			})
		}
		if (finalized && !settled) {
			await settleTrialAfterRetries(task.id)
			settled = true
		}
		throw error
	} finally {
		try {
			if (registered) await deregisterRunner({ runId: run.id, taskId })
		} finally {
			try {
				if (localSandboxRoot) await fs.rm(localSandboxRoot, { recursive: true, force: true })
			} finally {
				if (ownsLogger) logger.close()
			}
		}
	}
	return executionOutcome
}

export const processTaskInContainer = async ({
	taskId,
	jobToken,
	logger,
	maxRetries = 10,
	processRunner = new ExecaHarnessProcessRunner(),
	signal,
	sleeper = systemSleeper,
}: {
	taskId: number
	jobToken: string | null
	logger: Logger
	maxRetries?: number
	processRunner?: HarnessProcessRunner
	signal?: AbortSignal
	sleeper?: HarnessSleeper
}) => {
	const task = await findTask(taskId)
	const run = await findRun(task.runId)
	if (run.executionMethod !== "vscode") {
		// Finalize retired runs through the normal lifecycle without starting containers or retrying.
		return processTask({ taskId, jobToken, logger, processRunner, signal })
	}
	const benchmark = await findBenchmarkTask(EVALS_REPO_PATH, `${task.language}/${task.exercise}`)
	const gradingTimeoutMs = taskGradingTimeoutMs(benchmark.task)
	const agentTimeoutMs = (run.timeout || 5) * 60_000
	const containerTimeoutMs = agentTimeoutMs + gradingTimeoutMs
	// Node clamps an overflowing timer to 1ms; reject before creating an owned attempt or workspace.
	if (
		!Number.isSafeInteger(agentTimeoutMs) ||
		agentTimeoutMs < 1 ||
		!Number.isSafeInteger(containerTimeoutMs) ||
		containerTimeoutMs < 1 ||
		containerTimeoutMs > 2_147_483_647
	)
		throw new Error("Invalid task container timeout")
	const preparedVisibleCommands = await captureExpectedNodeTestCommands(
		originalTaskFixture(task, benchmark.task),
		benchmark.task.validation.commands,
	)
	const requiresBroker = benchmark.task.graders.some(({ bundleId }) => Boolean(bundleId))
	const retryLimit = typeof run.campaignHardCapUsd === "number" ? 0 : maxRetries
	const command = `pnpm --filter @alpha-code/evals cli --taskId ${taskId}`
	const docker = new DockerCliAdapter(processRunner)
	logger.info(command)

	for (let retry = 0; retry <= retryLimit; retry++) {
		signal?.throwIfAborted()
		const attemptNumber = retry + 1
		const attempt = await ensureAttempt(task.id, attemptNumber)
		if (attempt.terminalStatus && !isRetryableStatus(attempt.terminalStatus)) return
		const hostSandbox = path.posix.join("/tmp/evals/task-sandboxes", String(attempt.id))
		const hostWorkspace = path.join(hostSandbox, "agent-workspace")
		await prepareTaskWorkspace(task, hostWorkspace, processRunner)
		const baselineCommit = await captureWorkspaceBaseline(hostWorkspace, processRunner)
		await fs.mkdir(path.join(hostSandbox, "grader-broker"), { recursive: true })

		const controller = new AbortController()
		const attemptSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
		const gradingRunner: HarnessProcessRunner = {
			run: (spec) =>
				processRunner.run({
					...spec,
					signal: spec.signal ? AbortSignal.any([spec.signal, attemptSignal]) : attemptSignal,
				}),
		}
		let brokerFailure: unknown
		let brokerPromise: Promise<void> | undefined
		try {
			brokerPromise = requiresBroker
				? serveGraderRequest({
						root: path.join(hostSandbox, "grader-broker"),
						expectedAttemptId: attempt.id,
						// Startup and evidence collection precede the request; the bounded attempt owns this wait.
						untilAbort: attemptSignal,
						execute: (request) =>
							executeTrustedGrade({
								request,
								task,
								logger,
								workspaceRoot: hostWorkspace,
								processRunner: gradingRunner,
								hostSandbox,
								baselineCommit,
								preparedVisibleCommands,
								secrets: secretValues(jobToken),
							}),
					}).catch((error: unknown) => {
						brokerFailure = error
						controller.abort()
					})
				: undefined

			if (retry > 0) {
				const delayMs = calculateBackoffMs(
					attemptNumber,
					{
						maxAttempts: retryLimit + 1,
						baseDelayMs: 1000,
						maxDelayMs: 30_000,
					},
					systemRandom,
				)
				logger.info(`retrying in ${delayMs}ms (attempt ${attemptNumber}/${retryLimit + 1})`)
				await sleeper.sleep(delayMs)
			}

			const secretEnv = inheritedSecretEnvironment(jobToken)
			const trial = await findTrialForTask(task.id)
			if (!trial) throw new Error(`Trial was not created for task ${task.id}`)
			const limits = {
				cpus: 2,
				memoryBytes: 4 * 1024 * 1024 * 1024,
				pids: 512,
				timeoutMs: containerTimeoutMs,
			}
			const environmentNames = [
				"HOST_EXECUTION_METHOD",
				"EVALS_ATTEMPT",
				"EVALS_TASK_WORKSPACE_ROOT",
				"EVALS_GRADER_BROKER_ROOT",
				...Object.keys(secretEnv),
				"EVALS_RUNNER_IMAGE_ID",
				"EVALS_RUNNER_IMAGE_DIGESTS",
				"EVALS_DOCKER_VERSION",
				"EVALS_NETWORK_MODE",
				"EVALS_CPU_LIMIT",
				"EVALS_MEMORY_LIMIT",
				"EVALS_PIDS_LIMIT",
				"EVALS_CONCURRENCY",
				"EVALS_PERMISSION_PROFILE_DIGEST",
			]
			const containerSpec: ContainerSpec = {
				name: `evals-task-${taskId}.${retry}`,
				image: "evals-runner",
				owner: { runId: String(run.id), trialId: String(trial.id), attemptId: String(attempt.id) },
				command: "sh",
				args: ["-c", command],
				envNames: environmentNames,
				binds: [
					{ source: hostSandbox, target: "/var/log/evals", readOnly: false },
					{ source: hostWorkspace, target: "/workspace/eval-task", readOnly: false },
				],
				network: "evals_default",
				limits,
			}
			let infrastructure
			try {
				infrastructure = await collectInfrastructureManifest(containerSpec, processRunner, run.concurrency ?? 1)
			} catch (error) {
				controller.abort()
				if (brokerPromise) await brokerPromise
				const current = await currentAttempt(task.id, attempt.id)
				await finalizeContainerFailure(
					attempt.id,
					current,
					"container_setup_failed",
					error instanceof Error ? error.message : String(error),
				)
				continue
			}
			const identityEnv = {
				EVALS_RUNNER_IMAGE_ID: infrastructure.imageId,
				EVALS_RUNNER_IMAGE_DIGESTS: infrastructure.repoDigests.join(","),
				EVALS_DOCKER_VERSION: infrastructure.dockerVersion,
				EVALS_NETWORK_MODE: infrastructure.networkMode,
				EVALS_CPU_LIMIT: String(infrastructure.limits.cpus),
				EVALS_MEMORY_LIMIT: String(infrastructure.limits.memoryBytes),
				EVALS_PIDS_LIMIT: String(infrastructure.limits.pids),
				EVALS_CONCURRENCY: String(infrastructure.concurrency),
				EVALS_PERMISSION_PROFILE_DIGEST: infrastructure.permissionProfileDigest,
			}
			const env = {
				...secretEnv,
				...identityEnv,
				HOST_EXECUTION_METHOD: "docker",
				EVALS_ATTEMPT: String(retry),
				EVALS_TASK_WORKSPACE_ROOT: "/workspace/eval-task",
				EVALS_GRADER_BROKER_ROOT: "/var/log/evals/grader-broker",
			}

			const result = await docker.run({
				...containerSpec,
				image: infrastructure.imageId,
				processEnv: env,
				signal: attemptSignal,
			})
			controller.abort()
			if (brokerPromise) await brokerPromise
			if (brokerFailure) throw brokerFailure
			const current = await currentAttempt(task.id, attempt.id)
			if (result.timedOut || result.exitCode !== 0) {
				await finalizeContainerFailure(
					attempt.id,
					current,
					"container_process_failed",
					result.stderr || `exit ${result.exitCode}`,
				)
			} else if (!current?.terminalStatus) {
				await finalizeContainerFailure(
					attempt.id,
					current,
					"container_missing_terminal_result",
					"Container exited without a terminal attempt result",
				)
			} else if (!isRetryableStatus(current.terminalStatus)) {
				return
			}
		} catch (error) {
			const current = await currentAttempt(task.id, attempt.id)
			await finalizeContainerFailure(
				attempt.id,
				current,
				"container_process_failed",
				error instanceof Error ? error.message : String(error),
			)
			logger.error(`container process failed (attempt ${attemptNumber}/${retryLimit + 1}): ${String(error)}`)
			// Do not dispatch another attempt while a previous owned container may still be running.
			if (error instanceof ContainerCleanupError || signal?.aborted) throw error
		} finally {
			controller.abort()
			if (brokerPromise) await brokerPromise
		}
	}

	await settleTrialAfterRetries(task.id)
}

async function executeTrustedGrade(input: {
	request: GraderBrokerRequest
	task: Task
	logger: Logger
	workspaceRoot: string
	processRunner: HarnessProcessRunner
	hostSandbox: string
	baselineCommit: string
	preparedVisibleCommands: CommandGraderSpec["commands"]
	secrets: string[]
}) {
	const artifactRoot = path.join(input.hostSandbox, "artifacts")
	const store = new FilesystemArtifactStore(artifactRoot)
	const artifacts: ArtifactDescriptor[] = []
	const run = await runUnitTest({
		task: input.task,
		attemptId: input.request.attemptId,
		logger: input.logger,
		workspaceRoot: input.workspaceRoot,
		changedPaths: await collectChangedPaths(input.workspaceRoot, input.processRunner, input.baselineCommit),
		trace: input.request.trace,
		usage: input.request.usage,
		environment: input.request.environment,
		processRunner: input.processRunner,
		brokerRoot: false,
		preparedVisibleCommands: input.preparedVisibleCommands,
		evidenceSink: createGraderEvidenceSink(store, String(input.request.attemptId), artifacts, input.secrets),
	})
	await persistArtifactDescriptors(input.request.attemptId, artifacts, artifactRoot)
	return { run, artifacts }
}

function createGraderEvidenceSink(
	store: FilesystemArtifactStore,
	attemptId: string,
	descriptors: ArtifactDescriptor[],
	secrets: string[],
) {
	return async (
		id: string,
		kind: GraderEvidence["kind"],
		value: string,
		mediaType: string,
	): Promise<GraderEvidence> => {
		const descriptor = await store.put({
			attemptId,
			kind: "grader_evidence",
			bytes: new TextEncoder().encode(String(redact(value, { secrets }))),
			mediaType,
			access: "reviewer",
		})
		descriptors.push(descriptor)
		return {
			id,
			kind,
			mediaType,
			digest: descriptor.digest,
			byteLength: descriptor.sizeBytes,
		}
	}
}

function evidenceBundle(input: {
	run: Run
	trialId: number
	attemptId: number
	identities: { taskIdentity: string; variantIdentity: string }
	journal: EventJournal
	descriptors: ArtifactDescriptor[]
}): EvidenceBundle {
	return {
		schemaVersion: 1,
		runId: String(input.run.id),
		trialId: String(input.trialId),
		attemptId: String(input.attemptId),
		taskIdentity: input.identities.taskIdentity,
		variantIdentity: input.identities.variantIdentity,
		events: input.journal.all(),
		artifacts: input.descriptors,
	}
}

function taskEvidencePaths(logPath: string, task: Task) {
	const exercise = task.exercise.replaceAll("/", "-")
	const prefix = `${task.language}-${exercise}.${task.iteration}`
	const directory = path.dirname(logPath)
	return {
		agentTurns: path.join(directory, `${prefix}_agent_turn_events.jsonl`),
		apiConversation: path.join(directory, `${prefix}_api_conversation_history.json`),
		uiMessages: path.join(directory, `${prefix}_ui_messages.json`),
	}
}

async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
}

export function normalizeApiConversationTrace(value: unknown): EvalTraceEvent[] {
	if (!Array.isArray(value)) return []
	const calls = new Map<string, { name: string; input: unknown }>()
	const sessions = new Map<string, unknown>()
	const events: EvalTraceEvent[] = []
	for (const message of value) {
		if (!message || typeof message !== "object") continue
		const row = message as { ts?: unknown; content?: unknown }
		if (!Array.isArray(row.content)) continue
		const timestamp =
			typeof row.ts === "number" && Number.isFinite(row.ts)
				? new Date(row.ts).toISOString()
				: new Date(0).toISOString()
		for (const item of row.content) {
			if (!item || typeof item !== "object") continue
			const content = item as Record<string, unknown>
			if (content.type === "tool_use" && typeof content.id === "string" && typeof content.name === "string") {
				calls.set(content.id, { name: content.name, input: content.input })
				events.push({
					sequence: events.length + 1,
					timestamp,
					type: "agent.turn.tool_call",
					payload: { callId: content.id, name: content.name, tool: content.name, input: content.input },
				})
			}
			if (content.type === "tool_result" && typeof content.tool_use_id === "string") {
				const call = calls.get(content.tool_use_id)
				const tool = call?.name ?? "unknown"
				const result =
					typeof content.content === "string" ? content.content : JSON.stringify(content.content ?? "")
				const receipt = isCommandTool(tool) ? commandReceipt(content.content) : {}
				const command = sessionCommand(calls.get(content.tool_use_id)?.input, sessions)
				if (receipt.sessionId !== undefined && call)
					sessions.set(
						String(receipt.sessionId),
						sessions.get(String(objectRecord(call.input)?.session_id)) ?? call.input,
					)
				events.push({
					sequence: events.length + 1,
					timestamp,
					type: "agent.turn.tool_result",
					payload: {
						callId: content.tool_use_id,
						name: tool,
						tool,
						input: call?.input,
						...command,
						...receipt,
						status: legacyResultStatus(content, result, isCommandTool(tool)),
					},
				})
			}
		}
	}
	return events
}

function legacyResultStatus(content: Record<string, unknown>, output: string, command: boolean): string {
	if (content.is_error === true || content.timedOut === true) return "error"
	if (["success", "error", "denied", "cancelled"].includes(String(content.status))) return String(content.status)
	if (content.is_error === false) return "success"
	if (!command) return "unknown"
	const receipt = commandReceipt(output)
	return receipt.exitCode === undefined ? "unknown" : receipt.exitCode === 0 ? "success" : "error"
}

function isCommandTool(name: string): boolean {
	return ["exec_command", "shell", "execute_command", "write_stdin", "manage_command"].includes(name)
}

function commandReceipt(value: unknown): { exitCode?: number; executionStatus?: string; sessionId?: number } {
	let structured = objectRecord(value)
	if (typeof value === "string") {
		try {
			structured = objectRecord(JSON.parse(value))
			if (!structured) return {}
		} catch {
			// Native control headers end at Output; stdout cannot establish exit or session metadata.
			const nativeHeader =
				/^(?:Chunk ID: [^\r\n]+\r?\n)?Wall time: \d+\.\d{4} seconds\r?\n(?:Process exited with code (-?\d+)\r?\n)?(?:Process running with session ID ([1-9]\d*)\r?\n)?(?:Original token count: \d+\r?\n)?Output:\r?\n/.exec(
					value,
				)
			if (nativeHeader) {
				if (nativeHeader[1] !== undefined) {
					const exitCode = Number(nativeHeader[1])
					return { exitCode, executionStatus: exitCode === 0 ? "success" : "error" }
				}
				const sessionId = Number(nativeHeader[2])
				return Number.isSafeInteger(sessionId) && sessionId > 0 ? { sessionId, executionStatus: "running" } : {}
			}
			const header = value.split(/\r?\nOutput:\r?\n/, 1)[0]!
			const exit =
				/^\s*Exit code:\s*(-?\d+)\s*$/.exec(header) ??
				/^Command executed in terminal[^\r\n]*\bExit code:\s*(-?\d+)\b/.exec(header)
			return exit
				? { exitCode: Number(exit[1]), executionStatus: Number(exit[1]) === 0 ? "success" : "error" }
				: {}
		}
	}
	if (typeof structured?.exit_code === "number" && Number.isInteger(structured.exit_code))
		return { exitCode: structured.exit_code, executionStatus: structured.exit_code === 0 ? "success" : "error" }
	if (typeof structured?.session_id === "number" && Number.isSafeInteger(structured.session_id))
		return { sessionId: structured.session_id, executionStatus: "running" }
	return {}
}

function sessionCommand(input: unknown, sessions: Map<string, unknown>): Record<string, unknown> {
	const polling = objectRecord(input)
	const original =
		polling?.session_id === undefined ? undefined : objectRecord(sessions.get(String(polling.session_id)))
	const command = original?.cmd ?? original?.command
	return typeof command === "string"
		? { command, ...(Array.isArray(original?.args) ? { args: original.args } : {}) }
		: {}
}

export function normalizeAgentTrace(records: unknown[]): EvalTraceEvent[] {
	const calls = new Map<string, { name: string; input: unknown }>()
	const sessions = new Map<string, unknown>()
	let previousResult: Record<string, unknown> | undefined
	return records.flatMap((record, index) => {
		if (!record || typeof record !== "object") return []
		const row = record as Record<string, unknown>
		const nested = row.event && typeof row.event === "object" ? (row.event as Record<string, unknown>) : row
		if (typeof nested.type !== "string") return []
		const timestamp =
			typeof row.timestamp === "string"
				? row.timestamp
				: typeof row.timestamp === "number" && Number.isFinite(row.timestamp)
					? new Date(row.timestamp).toISOString()
					: new Date(0).toISOString()
		const rawSequence = typeof row.sequence === "number" ? row.sequence : index + 1
		const type = nested.type.startsWith("agent.turn.") ? nested.type : `agent.turn.${nested.type}`
		const { type: _type, ...payload } = nested
		if (type === "agent.turn.assistant_committed") {
			const response = objectRecord(payload.response)
			if (Array.isArray(response?.items)) {
				for (const item of response.items) {
					const call = objectRecord(item)
					if (call?.type === "tool_call" && typeof call.id === "string" && typeof call.name === "string")
						calls.set(call.id, { name: call.name, input: call.arguments })
				}
			}
		}
		if (type === "agent.turn.tool_result" && typeof payload.callId === "string") {
			const call = calls.get(payload.callId)
			if (call) {
				payload.input = call.input
				payload.name ??= call.name
				if (isCommandTool(call.name)) {
					Object.assign(payload, sessionCommand(call.input, sessions), commandReceipt(payload.output))
					if (typeof payload.sessionId === "number")
						sessions.set(
							String(payload.sessionId),
							sessions.get(String(objectRecord(call.input)?.session_id)) ?? call.input,
						)
				}
			}
		} else if (
			type === "agent.turn.verification_result" &&
			previousResult &&
			payload.toolName === previousResult.name &&
			payload.status === (previousResult.executionStatus ?? previousResult.status) &&
			previousResult.executionStatus !== "running" &&
			verificationOutputMatches(previousResult.output, payload.output)
		) {
			payload.callId = previousResult.callId
			payload.input = previousResult.input
		}
		previousResult = type === "agent.turn.tool_result" ? payload : undefined
		return [{ sequence: rawSequence, timestamp, type, payload }]
	})
}

function verificationOutputMatches(result: unknown, verification: unknown): boolean {
	if (typeof verification !== "string") return false
	if (result === verification) return true
	const text =
		typeof result === "string"
			? result
			: Array.isArray(result)
				? result
						.flatMap((part) => {
							const item = objectRecord(part)
							return item?.type === "text" && typeof item.text === "string" ? [item.text] : []
						})
						.join("\n")
				: undefined
	if (text === undefined) return false
	// Match ToolScheduler's bounded public verification projection before associating its call identity.
	const redacted = (text || "(tool did not return anything)").replace(
		/(\b(?:api[_-]?key|secret|password|credential|authorization|private[_-]?key|bearer|token)\s*[:=]\s*)(["']?)([^\s"',}\n]+)(\2)/gi,
		"$1$2[redacted]$4",
	)
	const suffix = "\n[truncated]"
	return verification === (redacted.length > 8000 ? `${redacted.slice(0, 8000 - suffix.length)}${suffix}` : redacted)
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function normalizeUsage(metrics: Awaited<ReturnType<typeof getTasks>>[number]["taskMetrics"] | undefined) {
	if (!metrics) return { available: false, reason: "task_metrics_missing" }
	const toolCalls = Object.values(metrics.toolUsage ?? {}).reduce((total, usage) => total + usage.attempts, 0)
	return {
		modelCalls: metrics.requestUsage?.length ?? 0,
		toolCalls,
		costUsd: metrics.cost,
		tokensIn: metrics.tokensIn,
		tokensOut: metrics.tokensOut,
		cacheReads: metrics.cacheReads,
		cacheWrites: metrics.cacheWrites,
		requestUsage: metrics.requestUsage ?? [],
		durationMs: metrics.duration,
	}
}

function runtimeEnvironment(run: Run, containerized: boolean): Record<string, unknown> {
	return {
		platform: process.platform,
		architecture: process.arch,
		node: process.version,
		model: run.model,
		executionMethod: run.executionMethod,
		runner: containerized ? "evals-runner" : "local-process",
		runnerImageId: process.env.EVALS_RUNNER_IMAGE_ID ?? "local-process",
		runnerImageDigests: (process.env.EVALS_RUNNER_IMAGE_DIGESTS ?? "").split(",").filter(Boolean),
		dockerVersion: process.env.EVALS_DOCKER_VERSION ?? "local-process",
		network: process.env.EVALS_NETWORK_MODE ?? (containerized ? "evals_default" : "host"),
		permissionProfileDigest: process.env.EVALS_PERMISSION_PROFILE_DIGEST ?? "local-process",
		limits: {
			cpus: Number(process.env.EVALS_CPU_LIMIT ?? 0),
			memoryBytes: Number(process.env.EVALS_MEMORY_LIMIT ?? 0),
			pids: Number(process.env.EVALS_PIDS_LIMIT ?? 0),
		},
		concurrency: Number(process.env.EVALS_CONCURRENCY ?? 1),
	}
}

function classifyGraderDecision(graded: GraderRunResult): TrialTerminalStatus {
	if (graded.decision === "grader_error") return "grader_error"
	const failed = graded.results.filter(({ status }) => status === "failed")
	const nonBudgetSafety = failed.some(
		({ failureClass, diagnostics }) =>
			failureClass === "safety" && diagnostics.some(({ code }) => !code.endsWith("_budget_exceeded")),
	)
	if (graded.decision === "safety_failed" && nonBudgetSafety) return "safety_failed"
	if (failed.some(({ diagnostics }) => diagnostics.some(({ code }) => code.endsWith("_budget_exceeded"))))
		return "budget_exhausted"
	return graded.decision
}

function classifyTerminalStatus(
	graded: GraderRunResult,
	executionOutcome: "completed" | "agent_error" | "budget_exhausted" | "cancelled" | undefined,
): TrialTerminalStatus {
	const graderStatus = classifyGraderDecision(graded)
	if (graderStatus === "grader_error" || graderStatus === "safety_failed") return graderStatus
	if (executionOutcome === "agent_error") return "agent_error"
	if (executionOutcome === "budget_exhausted" || executionOutcome === "cancelled") return executionOutcome
	return graderStatus
}

function requiresTraceEvidence(graders: Array<{ alias: string }>): boolean {
	return graders.some(({ alias }) =>
		["validation_after_edit", "validation_after_last_edit", "trace_retry_budget", "plan_continuity"].includes(
			alias,
		),
	)
}

function failureStatusForPhase(phase: AttemptPhase): TrialTerminalStatus {
	if (phase === "agent_execution") return "agent_error"
	if (phase === "grading") return "grader_error"
	return "infrastructure_error"
}

function parseAttemptNumber(raw: string | undefined): number {
	const zeroBased = Number(raw ?? 0)
	return Number.isInteger(zeroBased) && zeroBased >= 0 ? zeroBased + 1 : 1
}

function secretValues(jobToken: string | null): string[] {
	return [jobToken, process.env.OPENAI_API_KEY].filter((value): value is string => Boolean(value))
}

function inheritedSecretEnvironment(jobToken: string | null): Record<string, string> {
	const values: Record<string, string | undefined> = {
		ALPHA_CODE_CLOUD_TOKEN: jobToken ?? undefined,
		OPENAI_API_KEY: process.env.OPENAI_API_KEY,
	}
	return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])))
}

function originalTaskFixture(task: Task, manifest: BenchmarkTaskManifest): string {
	const holdout = task.benchmarkPartition === "holdout" || manifest.partition === "holdout"
	const root = holdout ? process.env.EVALS_PRIVATE_BENCHMARK_ROOT : EVALS_REPO_PATH
	if (!root) throw new Error("EVALS_PRIVATE_BENCHMARK_ROOT is required to capture original holdout tests")
	// Immutable expectations come from the admitted source, never an agent workspace override.
	const sourceRoot = path.resolve(root)
	const source = path.resolve(sourceRoot, manifest.fixture)
	const relative = path.relative(sourceRoot, source)
	if (
		path.isAbsolute(manifest.fixture) ||
		path.isAbsolute(relative) ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`)
	)
		throw new Error(`Task ${task.id} original fixture escapes its benchmark root`)
	return source
}

async function prepareTaskWorkspace(
	task: Task,
	destination: string,
	processRunner: HarnessProcessRunner,
): Promise<void> {
	let source: string
	try {
		source = getTaskWorkspacePath(task)
		await fs.access(source)
	} catch (error) {
		if (process.env.NODE_ENV === "test") {
			await fs.mkdir(destination, { recursive: true })
			return
		}
		throw error
	}
	await fs.rm(destination, { recursive: true, force: true })
	await fs.mkdir(path.dirname(destination), { recursive: true })
	await fs.cp(source, destination, { recursive: true, filter: (entry) => path.basename(entry) !== ".git" })
	for (const args of [
		["init", "--initial-branch=main"],
		["config", "user.name", "Alpha Evals"],
		["config", "user.email", "evals@alpha.invalid"],
		["add", "--all"],
		["commit", "-m", "Initial benchmark fixture", "--no-gpg-sign"],
	]) {
		const result = await processRunner.run({
			command: "git",
			args,
			cwd: destination,
			timeoutMs: 30_000,
			maxOutputBytes: 10 * 1024 * 1024,
		})
		if (result.timedOut || result.exitCode !== 0)
			throw new Error(`Unable to prepare benchmark workspace: git ${args[0]}: ${result.stderr}`)
	}
}

async function currentAttempt(taskId: number, attemptId: number) {
	const trial = await findTrialForTask(taskId)
	return trial?.attempts.find(({ id }) => id === attemptId)
}

async function finalizeContainerFailure(
	attemptId: number,
	current: Awaited<ReturnType<typeof currentAttempt>>,
	failureCode: string,
	failureDetail: string,
): Promise<void> {
	if (current?.terminalStatus) return
	let phase = current?.phase ?? "created"
	if (phase === "created") {
		const started = await applyAttemptEvent(attemptId, { type: "start" })
		phase = started.attempt.phase
	}
	await applyAttemptEvent(attemptId, { type: "finalize", status: "infrastructure_error", failureCode, failureDetail })
}
