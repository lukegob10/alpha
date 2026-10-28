import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { createRequire } from "node:module"
import * as os from "node:os"
import {
	executedExperimentCaptureSchema,
	nativeExperimentContextSchema,
	NATIVE_EXPERIMENT_CONDITION_SCOPES,
	nativeBuildSourceAssociationSchema,
	type ExecutedExperimentCapture,
	type ExecutedExperimentRequestObservation,
	type NativeExperimentContext,
	type NativeBuildSourceAssociation,
} from "@alpha-code/types"

import { fingerprintArtifactPaths } from "../campaign/liveGate"
import { captureLiveProviderExtension } from "../liveProviderIdentity"
import { readBounded, rejectSymlinkComponents, requireEvidenceRoot, requireEvidenceRun } from "./paths"

const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
const credentialKey =
	/(api.?key|secret|password|credential|authorization|private.?key|access.?token|refresh.?token|^token$|cookie)/i
const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`
const digestPattern = /^sha256:[a-f0-9]{64}$/

function canonical(value: unknown, omitCredentials = false): string {
	let nodes = 0
	const project = (item: unknown, depth: number): unknown => {
		if (++nodes > 100_000 || depth > 64) throw new Error("Experiment observation exceeds its structure bound")
		if (item === undefined) return undefined
		if (item === null || typeof item === "string" || typeof item === "boolean") return item
		if (typeof item === "number" && Number.isFinite(item)) return item
		if (Array.isArray(item)) return item.map((child) => project(child, depth + 1))
		if (typeof item !== "object") throw new Error("Experiment observation is not serializable")
		return Object.fromEntries(
			Object.entries(item)
				.filter(([key]) => !omitCredentials || !credentialKey.test(key))
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, project(child, depth + 1)]),
		)
	}
	const text = JSON.stringify(project(value, 0))
	if (text === undefined || Buffer.byteLength(text) > 8 * 1024 * 1024)
		throw new Error("Experiment observation exceeds its byte bound")
	return text
}

const hash = (value: unknown) => sha(canonical(value))

export function observedModelSettingsDigest(
	model: string,
	reasoningEffort: string,
	generationOptionsDigest: string,
): string {
	return hash({ model, reasoningEffort, generationOptionsDigest })
}

type BuildProof = {
	status: "verified" | "unavailable" | "invalid"
	manifestDigest?: string
	sourceRevision?: string
	sourceTreeDigest?: string
	artifactTreeDigest?: string
	entrypointSha256?: string
	packageJsonSha256?: string
	sourceAssociation?: NativeBuildSourceAssociation
	missing: string[]
}

export type ExperimentTaskLabel = { id: string; version: number; digest: string }

export function readNativeExperimentContext(env: NodeJS.ProcessEnv): NativeExperimentContext | undefined {
	const encoded = env.ALPHA_E2E_EXPERIMENT_CONTEXT_JSON
	if (encoded === undefined) return undefined
	if (Buffer.byteLength(encoded) > 64 * 1024) throw new Error("Experiment process context exceeds its bound")
	return nativeExperimentContextSchema.parse(JSON.parse(encoded))
}

export function readExperimentTaskLabel(env: NodeJS.ProcessEnv): ExperimentTaskLabel {
	const encoded = env.ALPHA_E2E_EXPERIMENT_TASK_JSON
	if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 2048)
		throw new Error("Missing public experiment task label")
	const value = record(JSON.parse(encoded))
	if (
		!value ||
		Object.keys(value).sort().join(",") !== "digest,id,version" ||
		typeof value.id !== "string" ||
		!/^[a-z0-9][a-z0-9._/-]{0,255}$/.test(value.id) ||
		!Number.isSafeInteger(value.version) ||
		Number(value.version) < 1 ||
		typeof value.digest !== "string" ||
		!digestPattern.test(value.digest)
	)
		throw new Error("Invalid public experiment task label")
	return value as ExperimentTaskLabel
}

/** Uses the official build-owned verifier, not a checkout hash copied into a historical run. */
export async function verifyObservedExperimentBuild(extensionPath: string): Promise<BuildProof> {
	const root = path.resolve(__dirname, "../../../..")
	try {
		// Node 24 supports synchronous loading of this ESM helper, which has no top-level await.
		const verifier = createRequire(__filename)(path.join(root, "scripts/extension-build-provenance.mjs")) as {
			verifyExtensionBuildProvenance(input: { extensionPath: string }): Promise<BuildProof>
		}
		const proof = await verifier.verifyExtensionBuildProvenance({ extensionPath })
		return proof
	} catch {
		return { status: "unavailable", missing: ["build-provenance-verifier-unavailable"] }
	}
}

export interface NativeExperimentCaptureOptions {
	runDirectory: string
	attemptId: string
	task: ExperimentTaskLabel
	assignmentDigest?: string
	pairDigest?: string
	extensionPath: string
	/** Runner-owned prelaunch observation, checked again in the newly launched active extension host. */
	prelaunchBuildManifestDigest?: string
	providerExtension?: { packageJSON: unknown; extensionPath: string }
	hostVersion: string
	providerMode: "scripted" | "live-copilot"
	requestLimit: number
	scenarioTimeoutMs: number
	executionTimeoutMs?: number
	workspace: string
	expectedWorkspaceDigest?: string
}

/** A request observer records hashes only. It never replaces messages, schemas, options or model output. */
export class NativeExperimentCapture {
	private readonly requests: ExecutedExperimentRequestObservation[] = []
	private readonly missing = new Set<string>()
	private promptDigest?: string
	private configurationDigest?: string
	private policyDigest?: string
	private configuration?: Record<string, unknown>
	private initialWorkspaceDigest?: string
	private stagedFixtureDigest?: string
	private buildBefore?: BuildProof
	private runnerDigest?: string
	private providerDigest?: string
	private machineDigest?: string

	constructor(
		private readonly options: NativeExperimentCaptureOptions,
		private readonly ports: {
			verifyBuild?: (extensionPath: string) => Promise<BuildProof>
			captureRunnerDigest?: () => Promise<string>
			captureProviderDigest?: () => Promise<string>
		} = {},
	) {
		if (options.assignmentDigest !== undefined && !digestPattern.test(options.assignmentDigest))
			throw new Error("Invalid experiment assignment digest")
		if (options.pairDigest !== undefined && !digestPattern.test(options.pairDigest))
			throw new Error("Invalid experiment pair digest")
		if (
			options.prelaunchBuildManifestDigest !== undefined &&
			!digestPattern.test(options.prelaunchBuildManifestDigest)
		)
			throw new Error("Invalid prelaunch experiment build digest")
		if (
			options.executionTimeoutMs !== undefined &&
			(!Number.isSafeInteger(options.executionTimeoutMs) || options.executionTimeoutMs <= 0)
		)
			throw new Error("Invalid observed host execution deadline")
	}

	async prepare(): Promise<void> {
		const root = await requireEvidenceRoot(path.dirname(this.options.runDirectory))
		if ((await requireEvidenceRun(root, this.options.attemptId)) !== path.resolve(this.options.runDirectory))
			throw new Error("Experiment capture must belong to its native run")
		this.buildBefore = await (this.ports.verifyBuild ?? verifyObservedExperimentBuild)(this.options.extensionPath)
		if (!nativeBuildSourceAssociationSchema.safeParse(this.buildBefore.sourceAssociation).success)
			this.missing.add("build-source-association-scope")
		if (
			!this.options.prelaunchBuildManifestDigest ||
			this.buildBefore.status !== "verified" ||
			`sha256:${this.buildBefore.manifestDigest}` !== this.options.prelaunchBuildManifestDigest
		)
			this.missing.add("fresh-host-prelaunch-build-association")
		try {
			const snapshot = await snapshotExperimentWorkspace(this.options.workspace)
			this.initialWorkspaceDigest = snapshot.workspaceDigest
			this.stagedFixtureDigest = snapshot.fixtureDigest
			if (snapshot.fixtureDigest !== (this.options.expectedWorkspaceDigest ?? this.options.task.digest))
				this.missing.add("staged-fixture-differs-from-controller-snapshot")
		} catch {
			this.missing.add("initial-workspace-snapshot")
		}
		try {
			this.runnerDigest = await this.captureRunnerDigest()
		} catch {
			this.missing.add("runnerImageDigest")
		}
		if (this.options.providerMode === "live-copilot") {
			try {
				this.providerDigest = await this.captureProviderDigest()
			} catch {
				this.missing.add("live-provider-installation-identity")
			}
		}
		try {
			this.machineDigest = this.captureMachineDigest()
		} catch {
			this.missing.add("observed-host-machine-and-runtime")
		}
	}

	onTaskPrompt(text: string): void {
		if (this.promptDigest !== undefined) {
			this.missing.add("multiple-task-prompts")
			return
		}
		if (Buffer.byteLength(text) > 100_000) {
			this.missing.add("task-prompt-over-limit")
			return
		}
		this.promptDigest = sha(text)
	}

	onConfiguration(value: unknown, policyDigest: string | null): void {
		try {
			const configuration = record(value)
			if (!configuration) throw new Error("Invalid configuration")
			const { fakeAi: _fakeAi, ...ordinary } = configuration
			this.configuration = JSON.parse(canonical(ordinary, true)) as Record<string, unknown>
			this.configurationDigest = hash(this.configuration)
			if (typeof policyDigest === "string" && /^[a-f0-9]{64}$/.test(policyDigest))
				this.policyDigest = `sha256:${policyDigest}`
		} catch {
			this.missing.add("configurationDigest")
		}
	}

	onTaskRequest(client: Record<string, unknown>, messages: unknown, options: unknown): void {
		try {
			if (this.requests.length >= 200) throw new Error("Request count exceeds capture bound")
			const request = record(options)
			const modelOptions = record(request?.modelOptions)
			const compatible = record(request?.configuration)
			const effort = modelOptions?.reasoningEffort ?? compatible?.reasoningEffort ?? "disable"
			if (typeof client.id !== "string" || typeof effort !== "string") throw new Error("Missing observed model")
			if (
				modelOptions?.reasoningEffort !== undefined &&
				compatible?.reasoningEffort !== undefined &&
				modelOptions.reasoningEffort !== compatible.reasoningEffort
			)
				throw new Error("Conflicting observed effort")
			if (!request || !Array.isArray(request.tools) || !Array.isArray(messages))
				throw new Error("Missing wire content")
			const generationOptionsDigest = hash({
				modelOptions: request.modelOptions,
				configuration: request.configuration,
			})
			this.requests.push({
				index: this.requests.length,
				startedAt: new Date().toISOString(),
				model: client.id,
				reasoningEffort: effort,
				modelSettingsDigest: observedModelSettingsDigest(client.id, effort, generationOptionsDigest),
				messagesDigest: hash(messages),
				toolSchemaDigest: hash(request.tools),
				optionsDigest: generationOptionsDigest,
			})
		} catch {
			this.missing.add("actual-provider-request-observation")
		}
	}

	noteObservationFailure(): void {
		this.missing.add("dispatch-observer-failed")
	}

	private async captureRunnerDigest(): Promise<string> {
		return this.ports.captureRunnerDigest
			? this.ports.captureRunnerDigest()
			: `sha256:${await fingerprintArtifactPaths(path.resolve(__dirname, "../../../.."), ["apps/vscode-e2e/out"])}`
	}

	private async captureProviderDigest(): Promise<string> {
		if (this.ports.captureProviderDigest) return this.ports.captureProviderDigest()
		const extension = this.options.providerExtension
		const snapshot = await captureLiveProviderExtension(extension)
		if (!extension || !snapshot.version || !snapshot.entrypointSha256)
			throw new Error("Observed live provider installation unavailable")
		// Include the entire observed installation, rather than treating its entrypoint as its dependency closure.
		return hash({ snapshot, installationDigest: await fingerprintArtifactPaths(extension.extensionPath, ["."]) })
	}

	private captureMachineDigest(): string {
		const processors = os.cpus().map((cpu) => cpu.model)
		if (processors.length === 0) throw new Error("Observed host machine identity unavailable")
		return hash({
			hostname: os.hostname(),
			system: os.type(),
			release: os.release(),
			machine: os.machine(),
			platform: process.platform,
			architecture: process.arch,
			processors,
			memoryBytes: os.totalmem(),
			runtimeVersions: process.versions,
			hostVersion: this.options.hostVersion,
		})
	}

	async finalize({ persist = true }: { persist?: boolean } = {}): Promise<ExecutedExperimentCapture> {
		const after = await (this.ports.verifyBuild ?? verifyObservedExperimentBuild)(this.options.extensionPath)
		const before = this.buildBefore
		const build =
			before?.status === "verified" &&
			after.status === "verified" &&
			before.manifestDigest === after.manifestDigest &&
			before.artifactTreeDigest === after.artifactTreeDigest &&
			before.sourceTreeDigest === after.sourceTreeDigest
				? after
				: {
						...after,
						status: after.status === "verified" ? ("invalid" as const) : after.status,
						missing: [...after.missing, "build-association-not-stable-through-attempt"],
					}
		const first = this.requests[0]
		try {
			if (!this.machineDigest || this.captureMachineDigest() !== this.machineDigest)
				this.missing.add("observed-host-machine-or-runtime-changed")
		} catch {
			this.missing.add("observed-host-machine-and-runtime")
		}
		try {
			if (!this.runnerDigest || (await this.captureRunnerDigest()) !== this.runnerDigest)
				this.missing.add("runner-bytes-changed-during-attempt")
		} catch {
			this.missing.add("runnerImageDigest")
		}
		if (this.options.providerMode === "live-copilot") {
			try {
				if (!this.providerDigest || (await this.captureProviderDigest()) !== this.providerDigest)
					this.missing.add("live-provider-installation-changed-during-attempt")
			} catch {
				this.missing.add("live-provider-installation-identity")
			}
		}
		if (!first) this.missing.add("actual-provider-request-observation")
		if (
			first &&
			this.requests.some(
				(request) =>
					request.model !== first.model ||
					request.reasoningEffort !== first.reasoningEffort ||
					request.modelSettingsDigest !== first.modelSettingsDigest,
			)
		)
			this.missing.add("model-settings-changed-during-attempt")
		if (this.options.providerMode !== "live-copilot") this.missing.add("live-provider-not-observed")
		if (!this.promptDigest) this.missing.add("taskPromptDigest")
		if (!this.configurationDigest) this.missing.add("configurationDigest")
		if (!this.policyDigest) this.missing.add("permissionDigest")
		if (
			build.status !== "verified" ||
			!build.sourceRevision ||
			!build.sourceTreeDigest ||
			!build.artifactTreeDigest
		)
			for (const field of [
				"extensionCommit",
				"workingTreeDigest",
				"extensionBuildDigest",
				"toolImplementationDigest",
				"skillBundleDigest",
				"compactionDigest",
			])
				this.missing.add(field)
		const sourceDigest = build.sourceTreeDigest
			? `sha256:${build.sourceTreeDigest.replace(/^sha256:/, "")}`
			: undefined
		const artifactDigest = build.artifactTreeDigest
			? `sha256:${build.artifactTreeDigest.replace(/^sha256:/, "")}`
			: undefined
		const runtimeDigest = sourceDigest && artifactDigest ? hash({ sourceDigest, artifactDigest }) : undefined
		const staticConfiguration =
			this.configurationDigest && runtimeDigest
				? hash({ runtimeDigest, configuration: this.configurationDigest })
				: undefined
		// These are fixed external trial controls, not a claim that two Alpha schedulers behave identically.
		const conditionScopes = NATIVE_EXPERIMENT_CONDITION_SCOPES
		const resources =
			this.machineDigest &&
			this.runnerDigest &&
			this.configuration &&
			hash({
				scope: conditionScopes.resourceProfile,
				resourceEnvelope: conditionScopes.resourceEnvelope,
				enforcementDigest: this.runnerDigest,
				machineDigest: this.machineDigest,
				requestLimit: this.options.requestLimit,
				scenarioTimeoutMs: this.options.scenarioTimeoutMs,
				executionTimeoutMs: this.options.executionTimeoutMs ?? null,
				commandTimeoutSeconds: this.configuration.commandExecutionTimeout,
			})
		const retry =
			this.runnerDigest &&
			this.providerDigest &&
			this.configuration &&
			hash({
				scope: conditionScopes.retryPolicy,
				alphaRuntimeRetries: conditionScopes.alphaRuntimeRetries,
				enforcementDigest: this.runnerDigest,
				providerDigest: this.providerDigest,
				automaticTrialRetries: 0,
				requestLimit: this.options.requestLimit,
				requestDelaySeconds: this.configuration.requestDelaySeconds,
			})
		const observedVariant =
			this.missing.size === 0 &&
			first &&
			build.sourceRevision &&
			sourceDigest &&
			artifactDigest &&
			staticConfiguration &&
			this.runnerDigest &&
			resources &&
			retry &&
			this.policyDigest
				? {
						schemaVersion: 1 as const,
						id: "alpha-native-harness",
						extensionCommit: build.sourceRevision,
						workingTreeDigest: sourceDigest,
						extensionBuildDigest: artifactDigest,
						model: first.model,
						modelSettingsDigest: first.modelSettingsDigest,
						promptDigest: staticConfiguration,
						toolSchemaDigest: staticConfiguration,
						toolImplementationDigest: runtimeDigest!,
						skillBundleDigest: staticConfiguration,
						policyDigest: staticConfiguration,
						compactionDigest: staticConfiguration,
						runnerImageDigest: hash({
							runnerDigest: this.runnerDigest,
							providerDigest: this.providerDigest,
							hostVersion: this.options.hostVersion,
						}),
						resourceProfileDigest: resources,
						permissionDigest: this.policyDigest,
						networkMode: "native-host-without-network-sandbox",
						retryPolicyDigest: retry,
					}
				: null
		if (!observedVariant && this.missing.size === 0) this.missing.add("complete-executed-variant")
		const provenance: ExecutedExperimentCapture["measurementProvenance"] = {}
		if (observedVariant)
			for (const field of Object.keys(observedVariant).filter((key) => key !== "schemaVersion")) {
				const wholeSource = [
					"extensionCommit",
					"workingTreeDigest",
					"extensionBuildDigest",
					"promptDigest",
					"toolSchemaDigest",
					"toolImplementationDigest",
					"skillBundleDigest",
					"policyDigest",
					"compactionDigest",
				].includes(field)
				provenance[field] = {
					source: wholeSource
						? "fresh-host-prelaunch-active-extension-and-unchanged-build-configuration"
						: "native-host-observation",
					digest: hash({ field, value: observedVariant[field as keyof typeof observedVariant] }),
					scope: wholeSource ? "conservative-whole-source" : "observed",
				}
			}
		const body = {
			schemaVersion: 1 as const,
			kind: "alpha-executed-experiment-capture" as const,
			status: observedVariant ? ("captured" as const) : ("incomplete" as const),
			producer: "native-extension-host" as const,
			attemptId: this.options.attemptId,
			...(this.options.assignmentDigest ? { assignmentDigest: this.options.assignmentDigest } : {}),
			...(this.options.pairDigest ? { pairDigest: this.options.pairDigest } : {}),
			task: this.options.task,
			taskLabelAuthority: "controller-public-task-label" as const,
			capturedAt: new Date().toISOString(),
			observedVariant,
			identityScope: "conservative-whole-source" as const,
			conditionScopes,
			measurementProvenance: provenance,
			missing: [...this.missing].sort(),
			observed: {
				...(build.entrypointSha256 ? { entrypointDigest: `sha256:${build.entrypointSha256}` } : {}),
				...(build.packageJsonSha256 ? { extensionManifestDigest: `sha256:${build.packageJsonSha256}` } : {}),
				...(artifactDigest ? { extensionBuildDigest: artifactDigest } : {}),
				...(first
					? {
							model: first.model,
							reasoningEffort: first.reasoningEffort,
							modelSettingsDigest: first.modelSettingsDigest,
						}
					: {}),
				...(this.policyDigest ? { policyDigest: this.policyDigest } : {}),
				...(this.promptDigest ? { taskPromptDigest: this.promptDigest } : {}),
				...(this.configurationDigest ? { configurationDigest: this.configurationDigest } : {}),
				...(this.initialWorkspaceDigest ? { initialWorkspaceDigest: this.initialWorkspaceDigest } : {}),
				...(this.stagedFixtureDigest ? { stagedFixtureDigest: this.stagedFixtureDigest } : {}),
				...(this.stagedFixtureDigest ? { stagedFixtureAlgorithm: "source-tree-pretty-json-v1" as const } : {}),
				requestCount: this.requests.length,
			},
			requests: this.requests,
			processCoverage: {
				sourceVersions: "unavailable" as const,
				instructionDelivery: "unavailable" as const,
				hookDelivery: "unavailable" as const,
			},
			buildProvenance: {
				status: build.status,
				...(build.sourceAssociation ? { sourceAssociation: build.sourceAssociation } : {}),
				...(build.manifestDigest
					? { manifestDigest: `sha256:${build.manifestDigest.replace(/^sha256:/, "")}` }
					: {}),
				missing: build.missing,
			},
		}
		const capture = executedExperimentCaptureSchema.parse({ ...body, digest: hash(body) })
		if (persist) await this.persist(capture)
		return capture
	}

	async persist(
		capture: ExecutedExperimentCapture,
		processCoverage = capture.processCoverage,
	): Promise<ExecutedExperimentCapture> {
		const { digest: _digest, ...body } = { ...capture, processCoverage }
		const sealed = executedExperimentCaptureSchema.parse({ ...body, digest: hash(body) })
		await writeExperimentArtifact(
			this.options.runDirectory,
			this.options.attemptId,
			"experiment-capture.json",
			sealed,
		)
		return sealed
	}
}

/** The existing repository grader/process source seal, with validated runner metadata excluded. */
export async function snapshotExperimentWorkspace(workspace: string): Promise<{
	rows: Array<[string, string | null]>
	fixtureDigest: string
	workspaceDigest: string
}> {
	await rejectSymlinkComponents(workspace)
	const root = await fs.realpath(workspace)
	if (!(await fs.lstat(root)).isDirectory()) throw new Error("Invalid experiment workspace")
	const rows: Array<[string, string | null]> = []
	let bytes = 0,
		entries = 0
	const visit = async (directory: string): Promise<void> => {
		for (const name of (await fs.readdir(directory)).sort()) {
			const target = path.join(directory, name)
			const relative = path.relative(root, target).split(path.sep).join("/")
			const info = await fs.lstat(target)
			if (
				++entries > 20_000 ||
				info.isSymbolicLink() ||
				(!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
			)
				throw new Error("Unsafe experiment workspace tree")
			const parts = relative.split("/")
			if (parts[0] === ".git" || parts.includes("__pycache__") || /\.py[co]$/.test(parts.at(-1)!)) continue
			if (relative === ".alpha-e2e-owned.json") {
				const marker = JSON.parse((await readBounded(target, 512)).toString("utf8"))
				if (
					canonical(marker) !==
					canonical({ schemaVersion: 1, purpose: "alpha-vscode-e2e", kind: "workspace" })
				)
					throw new Error("Invalid owned workspace marker")
				continue
			}
			if (info.isDirectory()) {
				rows.push([relative + "/", null])
				await visit(target)
			} else {
				if (info.size > 16 * 1024 * 1024 || (bytes += info.size) > 64 * 1024 * 1024)
					throw new Error("Experiment workspace exceeds its size bound")
				rows.push([relative, sha(await readBounded(target, info.size))])
			}
		}
	}
	await visit(root)
	rows.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
	const workspaceDigest = sha(JSON.stringify(rows, null, 2) + "\n")
	return { rows, fixtureDigest: workspaceDigest, workspaceDigest }
}

export async function writeExperimentArtifact(
	runDirectory: string,
	attemptId: string,
	name: string,
	value: unknown,
): Promise<void> {
	if (!["experiment-capture.json", "final-response.json", "process-evidence.json"].includes(name))
		throw new Error("Unknown native experiment artifact")
	const root = await requireEvidenceRoot(path.dirname(runDirectory))
	if ((await requireEvidenceRun(root, attemptId)) !== path.resolve(runDirectory))
		throw new Error("Foreign experiment run")
	const file = path.join(runDirectory, name)
	await rejectSymlinkComponents(file)
	const bytes = JSON.stringify(value, null, 2) + "\n"
	if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new Error("Experiment artifact exceeds its size bound")
	await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 })
}

/** Persist the actual final assistant history only in the explicitly opted private run. */
export function observedFinalExperimentResponse(
	history: unknown,
): { status: "captured"; text: string; digest: string } | { status: "unavailable" } {
	if (!Array.isArray(history)) return { status: "unavailable" }
	const message = [...history]
		.reverse()
		.map(record)
		.find((message) => message?.role === "assistant")
	if (!message || message.phase === "commentary" || record(message.agentResponseOutcome)?.status === "failed")
		return { status: "unavailable" }
	const content = message.content
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content) && !content.some((part) => record(part)?.type === "tool_use")
				? content
						.flatMap((part) =>
							record(part)?.type === "text" && typeof record(part)?.text === "string"
								? [String(record(part)!.text)]
								: [],
						)
						.join("\n")
				: undefined
	return text?.trim() && Buffer.byteLength(text) <= 256 * 1024
		? { status: "captured", text, digest: sha(text) }
		: { status: "unavailable" }
}

export function observedExperimentVariantIdentity(
	variant: NonNullable<ExecutedExperimentCapture["observedVariant"]>,
): string {
	return `${variant.id}@${variant.schemaVersion}:${hash(variant)}`
}
