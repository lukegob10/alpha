import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { type TaskEvent, RooCodeEventName } from "@alpha-code/types"

import { findBenchmarkTask, serveGraderRequest, type GraderBrokerRequest } from "../benchmark/index"
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
	readEvidenceLog,
	readJsonLines,
	collectWorkspaceEvidence,
	validateEvidenceBundle,
	type ArtifactDescriptor,
	type EvidenceBundle,
} from "../evidence/index"
import type { EvalTraceEvent, GraderEvidence, GraderRunResult } from "../grading/index"
import { collectInfrastructureManifest, type ContainerSpec } from "../infrastructure/index"
import { isRetryableStatus, type AttemptPhase, type TrialTerminalStatus } from "../lifecycle/index"
import { ExecaHarnessProcessRunner, type HarnessProcessRunner } from "../orchestration/index"

import { Logger, getTag, isDockerContainer } from "./utils"
import { redisClient, getPubSubKey, registerRunner, deregisterRunner } from "./redis"
import { runUnitTest } from "./runUnitTest"
import { runTaskWithCli } from "./runTaskInCli"
import { runTaskInVscode } from "./runTaskInVscode"

type ProcessTaskOptions = {
	taskId: number
	jobToken: string | null
	logger?: Logger
	processRunner?: HarnessProcessRunner
}

export const processTask = async ({
	taskId,
	jobToken,
	logger,
	processRunner = new ExecaHarnessProcessRunner(),
}: ProcessTaskOptions) => {
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
	const journal = new EventJournal({
		runId: String(run.id),
		trialId: String(trial.id),
		attemptId: String(attempt.id),
	})
	let phase: AttemptPhase = attempt.phase
	let finalized = false
	let registered = false
	let settled = false
	let localSandboxRoot: string | undefined
	let descriptors: ArtifactDescriptor[] = []

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
		await registerRunner({ runId: run.id, taskId, timeoutSeconds: (run.timeout || 5) * 60 })
		registered = true
		const benchmark = await findBenchmarkTask(EVALS_REPO_PATH, `${task.language}/${task.exercise}`)
		let workspaceRoot = getTaskWorkspacePath(task)
		if (!containerized && task.benchmarkTaskIdentity) {
			localSandboxRoot = path.join(os.tmpdir(), "evals", "task-sandboxes", String(attempt.id))
			workspaceRoot = path.join(localSandboxRoot, "agent-workspace")
			await prepareTaskWorkspace(task, workspaceRoot, processRunner)
		}

		const identities = await createRuntimeIdentities({
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
			network: "restricted",
		})
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
		const executionMethod = run.executionMethod || "vscode"
		logger.info(`running task ${task.id} (${task.language}/${task.exercise}) via ${executionMethod}...`)
		const executionOutcome =
			executionMethod === "cli"
				? await runTaskWithCli({ run, task, jobToken, publish, logger, workspaceRoot })
				: await runTaskInVscode({ run, task, jobToken, publish, logger, workspaceRoot })
		await transition({ type: "agent_completed" })

		const evidencePaths = taskEvidencePaths(logger.path, task)
		const rawTrace = await readJsonLines(evidencePaths.agentTurns)
		const trace = rawTrace.length
			? normalizeAgentTrace(rawTrace)
			: normalizeApiConversationTrace(await readJson(evidencePaths.apiConversation))
		for (const event of trace) await record(event.type, event.payload ?? {})
		const [extensionLog, transcript, refreshedTasks] = await Promise.all([
			readEvidenceLog(logger.path),
			readEvidenceLog(evidencePaths.uiMessages),
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
		const changedPaths = await collectChangedPaths(workspaceRoot, processRunner)
		const environment = runtimeEnvironment(run, containerized)
		descriptors = await collectWorkspaceEvidence({
			attemptId: String(attempt.id),
			workspace: workspaceRoot,
			extensionLog,
			transcript,
			finalResponse: extractFinalResponse(transcript),
			testOutput: "",
			usage,
			stopReason: "agent_completed",
			processRunner,
			store,
			secrets: secretValues(jobToken),
		})
		await persistArtifactDescriptors(attempt.id, descriptors, artifactRoot)
		await transition({ type: "evidence_collected" })

		const bundle = evidenceBundle({
			run,
			trialId: trial.id,
			attemptId: attempt.id,
			identities,
			journal,
			descriptors,
		})
		const initialIntegrity = await validateEvidenceBundle(bundle, store)
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
			evidenceSink: createGraderEvidenceSink(store, String(attempt.id), graderArtifacts),
		})
		if (graderArtifacts.length) {
			descriptors.push(...graderArtifacts)
			await persistArtifactDescriptors(attempt.id, graderArtifacts, artifactRoot)
		}

		const finalIntegrity = await validateEvidenceBundle(
			evidenceBundle({ run, trialId: trial.id, attemptId: attempt.id, identities, journal, descriptors }),
			store,
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
		await recordEvidenceIntegrity({
			attemptId: attempt.id,
			status: "valid",
			taskIdentity: identities.taskIdentity,
			variantIdentity: identities.variantIdentity,
		})

		const status = classifyTerminalStatus(graded, executionOutcome)
		await transition({ type: "finalize", status })
		logger.info(`task ${task.id} (${task.language}/${task.exercise}) -> ${status}`)
		await publish({
			eventName: status === "passed" ? RooCodeEventName.EvalPass : RooCodeEventName.EvalFail,
			taskId: task.id,
		})
		await settleTrialAfterRetries(task.id)
		settled = true
	} catch (error) {
		if (!finalized) {
			const status = failureStatusForPhase(phase)
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
		if (registered) await deregisterRunner({ runId: run.id, taskId })
		if (localSandboxRoot) await fs.rm(localSandboxRoot, { recursive: true, force: true })
	}
}

export const processTaskInContainer = async ({
	taskId,
	jobToken,
	logger,
	maxRetries = 10,
	processRunner = new ExecaHarnessProcessRunner(),
}: {
	taskId: number
	jobToken: string | null
	logger: Logger
	maxRetries?: number
	processRunner?: HarnessProcessRunner
}) => {
	const task = await findTask(taskId)
	const run = await findRun(task.runId)
	const benchmark = await findBenchmarkTask(EVALS_REPO_PATH, `${task.language}/${task.exercise}`)
	const requiresBroker = benchmark.task.graders.some(({ bundleId }) => Boolean(bundleId))
	const retryLimit = typeof run.campaignHardCapUsd === "number" ? 0 : maxRetries
	const command = `pnpm --filter @alpha-code/evals cli --taskId ${taskId}`
	logger.info(command)

	for (let retry = 0; retry <= retryLimit; retry++) {
		const attemptNumber = retry + 1
		const attempt = await ensureAttempt(task.id, attemptNumber)
		if (attempt.terminalStatus && !isRetryableStatus(attempt.terminalStatus)) return
		const hostSandbox = path.posix.join("/tmp/evals/task-sandboxes", String(attempt.id))
		const hostWorkspace = path.join(hostSandbox, "agent-workspace")
		await prepareTaskWorkspace(task, hostWorkspace, processRunner)
		await fs.mkdir(path.join(hostSandbox, "grader-broker"), { recursive: true })

		const controller = new AbortController()
		const brokerPromise = requiresBroker
			? serveGraderRequest({
					root: path.join(hostSandbox, "grader-broker"),
					timeoutMs: Math.max(120_000, (run.timeout || 5) * 60_000),
					signal: controller.signal,
					execute: (request) =>
						executeTrustedGrade({
							request,
							task,
							logger,
							workspaceRoot: hostWorkspace,
							processRunner,
							hostSandbox,
						}),
				})
			: undefined

		if (retry > 0) {
			const delayMs = Math.pow(2, retry - 1) * 1_000 * (0.5 + Math.random())
			logger.info(`retrying in ${delayMs}ms (attempt ${attemptNumber}/${retryLimit + 1})`)
			await new Promise((resolve) => setTimeout(resolve, delayMs))
		}

		const secretEnv = inheritedSecretEnvironment(jobToken)
		const trial = await findTrialForTask(task.id)
		if (!trial) throw new Error(`Trial was not created for task ${task.id}`)
		const limits = {
			cpus: 2,
			memoryBytes: 4 * 1024 * 1024 * 1024,
			pids: 512,
			timeoutMs: Math.max(120_000, (run.timeout || 5) * 60_000 + 120_000),
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
		const args = [
			"run",
			"--rm",
			"--name",
			`evals-task-${taskId}.${retry}`,
			"--network",
			"evals_default",
			"--cpus",
			String(limits.cpus),
			"--memory",
			String(limits.memoryBytes),
			"--pids-limit",
			String(limits.pids),
			"--label",
			"alpha.evals.managed=true",
			"--label",
			`alpha.evals.run-id=${run.id}`,
			"--label",
			`alpha.evals.trial-id=${trial.id}`,
			"--label",
			`alpha.evals.attempt-id=${attempt.id}`,
			"-v",
			`${portablePath(hostSandbox)}:/var/log/evals:rw`,
			"-v",
			`${portablePath(hostWorkspace)}:/workspace/eval-task:rw`,
			"-e",
			"HOST_EXECUTION_METHOD",
			"-e",
			"EVALS_ATTEMPT",
			"-e",
			"EVALS_TASK_WORKSPACE_ROOT",
			"-e",
			"EVALS_GRADER_BROKER_ROOT",
			...Object.keys({ ...secretEnv, ...identityEnv }).flatMap((name) => ["-e", name]),
			"evals-runner",
			"sh",
			"-c",
			command,
		]
		const env = {
			...secretEnv,
			...identityEnv,
			HOST_EXECUTION_METHOD: "docker",
			EVALS_ATTEMPT: String(retry),
			EVALS_TASK_WORKSPACE_ROOT: "/workspace/eval-task",
			EVALS_GRADER_BROKER_ROOT: "/var/log/evals/grader-broker",
		}

		try {
			const result = await processRunner.run({
				command: "docker",
				args,
				env,
				timeoutMs: limits.timeoutMs,
				maxOutputBytes: 10 * 1024 * 1024,
			})
			if (brokerPromise) await brokerPromise
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
		} finally {
			controller.abort()
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
}) {
	const artifactRoot = path.join(input.hostSandbox, "trusted-artifacts")
	const store = new FilesystemArtifactStore(artifactRoot)
	const artifacts: ArtifactDescriptor[] = []
	const run = await runUnitTest({
		task: input.task,
		attemptId: input.request.attemptId,
		logger: input.logger,
		workspaceRoot: input.workspaceRoot,
		changedPaths: input.request.changedPaths,
		trace: input.request.trace,
		usage: input.request.usage,
		environment: input.request.environment,
		processRunner: input.processRunner,
		brokerRoot: false,
		evidenceSink: createGraderEvidenceSink(store, String(input.request.attemptId), artifacts),
	})
	await persistArtifactDescriptors(input.request.attemptId, artifacts, artifactRoot)
	return { run, artifacts }
}

function createGraderEvidenceSink(
	store: FilesystemArtifactStore,
	attemptId: string,
	descriptors: ArtifactDescriptor[],
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
			bytes: new TextEncoder().encode(value),
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
	const toolNames = new Map<string, string>()
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
				toolNames.set(content.id, content.name)
				events.push({
					sequence: events.length + 1,
					timestamp,
					type:
						content.name === "execute_command" ? "agent.turn.verification_started" : "agent.turn.tool_call",
					payload: { tool: content.name },
				})
			}
			if (content.type === "tool_result" && typeof content.tool_use_id === "string") {
				const tool = toolNames.get(content.tool_use_id) ?? "unknown"
				const result =
					typeof content.content === "string" ? content.content : JSON.stringify(content.content ?? "")
				events.push({
					sequence: events.length + 1,
					timestamp,
					type: tool === "execute_command" ? "agent.turn.verification_result" : "agent.turn.tool_result",
					payload: {
						tool,
						...(tool === "execute_command" ? { ok: /exit code:\s*0\b/i.test(result) } : {}),
					},
				})
			}
		}
	}
	return events
}

function normalizeAgentTrace(records: unknown[]): EvalTraceEvent[] {
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
		return [{ sequence: rawSequence, timestamp, type, payload }]
	})
}

async function collectChangedPaths(workspaceRoot: string, processRunner: HarnessProcessRunner): Promise<string[]> {
	const result = await processRunner.run({
		command: "git",
		args: ["status", "--porcelain=v1", "--untracked-files=all"],
		cwd: workspaceRoot,
		timeoutMs: 30_000,
		maxOutputBytes: 10 * 1024 * 1024,
	})
	if (result.timedOut || result.exitCode !== 0) {
		if (process.env.NODE_ENV === "test") return []
		throw new Error(`Unable to collect changed paths: ${result.stderr}`)
	}
	return result.stdout
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => line.slice(3).split(" -> ").at(-1)!.replaceAll("\\", "/"))
		.sort()
}

function normalizeUsage(metrics: Awaited<ReturnType<typeof getTasks>>[number]["taskMetrics"] | undefined) {
	if (!metrics) return { modelCalls: 0, toolCalls: 0, costUsd: 0 }
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
	return [
		jobToken,
		process.env.OPENROUTER_API_KEY,
		process.env.ANTHROPIC_API_KEY,
		process.env.OPENAI_API_KEY,
		process.env.GOOGLE_API_KEY,
		process.env.DEEPSEEK_API_KEY,
		process.env.MISTRAL_API_KEY,
	].filter((value): value is string => Boolean(value))
}

function inheritedSecretEnvironment(jobToken: string | null): Record<string, string> {
	const values: Record<string, string | undefined> = {
		ROO_CODE_CLOUD_TOKEN: jobToken ?? undefined,
		OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
		OPENAI_API_KEY: process.env.OPENAI_API_KEY,
		GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
		DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
		MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
	}
	return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])))
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

function portablePath(value: string): string {
	return value.replaceAll("\\", "/")
}
