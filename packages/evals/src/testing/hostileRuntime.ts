import crypto from "crypto"

import {
	executeAttempt,
	HarnessExecutionError,
	type ArtifactRecord,
	type ArtifactStore,
	type AttemptLifecyclePort,
	type AttemptObservation,
	type AttemptObserver,
	type AttemptSnapshot,
	type GradeDecision,
	type HarnessClock,
	type HarnessProcessResult,
	type HarnessProcessRunner,
	type HarnessProcessSpec,
	type HarnessRandomSource,
	type HarnessSleeper,
} from "../orchestration/index"
import {
	initialAttemptState,
	transitionAttempt,
	type AttemptLifecycleEvent,
	type AttemptLifecycleState,
	type TrialTerminalStatus,
} from "../lifecycle/index"

export type FaultSpec = {
	kind: "error" | "timeout" | "denied" | "cancelled"
	message: string
	code?: string
	status?: Extract<
		TrialTerminalStatus,
		"agent_error" | "infrastructure_error" | "grader_error" | "safety_failed" | "budget_exhausted" | "cancelled"
	>
}

export type StageScript = { outcome: "success" } | { outcome: "fault"; fault: FaultSpec }
export type GradeScript = { outcome: "decision"; decision: GradeDecision } | { outcome: "fault"; fault: FaultSpec }

export type EventFaultScript = {
	drop?: AttemptObservation["type"][]
	duplicate?: AttemptObservation["type"][]
	malformed?: AttemptObservation["type"][]
	late?: AttemptObservation["type"][]
	fail?: AttemptObservation["type"][]
	failOnce?: AttemptObservation["type"][]
}

export type HostileScenario = {
	id: string
	seed: number
	setup?: StageScript
	agent?: StageScript
	evidence?: StageScript
	grade?: GradeScript
	persistenceFailure?: { eventType: AttemptLifecycleEvent["type"]; occurrence?: number }
	eventFaults?: EventFaultScript
	artifactFault?: "none" | "upload_error" | "interrupted" | "corrupt"
}

export type HostileRunResult = {
	status?: TrialTerminalStatus
	error?: { name: string; message: string }
	attempt?: AttemptSnapshot
	observations: unknown[]
	artifacts: ArtifactRecord[]
	reproduction: string
}

export class VirtualClock implements HarnessClock, HarnessSleeper {
	constructor(private currentMs = 0) {}
	now(): Date {
		return new Date(this.currentMs)
	}
	monotonicMs(): number {
		return this.currentMs
	}
	async sleep(ms: number): Promise<void> {
		this.currentMs += Math.max(0, ms)
	}
	advance(ms: number): void {
		this.currentMs += Math.max(0, ms)
	}
}

export class SeededRandom implements HarnessRandomSource {
	private state: number
	constructor(seed: number) {
		this.state = seed >>> 0 || 0x6d2b79f5
	}
	next(): number {
		let value = this.state
		value ^= value << 13
		value ^= value >>> 17
		value ^= value << 5
		this.state = value >>> 0
		return this.state / 0x1_0000_0000
	}
}

export class InMemoryLifecyclePort implements AttemptLifecyclePort {
	private nextId = 1
	private readonly attempts = new Map<number, AttemptSnapshot>()
	private readonly eventCounts = new Map<AttemptLifecycleEvent["type"], number>()

	constructor(private readonly failure?: HostileScenario["persistenceFailure"]) {}

	async ensureAttempt(_taskId: number, attemptNumber: number): Promise<AttemptSnapshot> {
		const existing = [...this.attempts.values()].find((attempt) => attempt.attemptNumber === attemptNumber)
		if (existing) return { ...existing }
		const created = { id: this.nextId++, attemptNumber, ...initialAttemptState() }
		this.attempts.set(created.id, created)
		return { ...created }
	}

	async applyEvent(attemptId: number, event: AttemptLifecycleEvent): Promise<AttemptSnapshot> {
		const count = (this.eventCounts.get(event.type) ?? 0) + 1
		this.eventCounts.set(event.type, count)
		if (this.failure?.eventType === event.type && count === (this.failure.occurrence ?? 1)) {
			throw new HarnessExecutionError(
				`scripted persistence failure on ${event.type}`,
				"infrastructure_error",
				"scripted_persistence_failure",
			)
		}
		const current = this.attempts.get(attemptId)
		if (!current) throw new Error(`Attempt ${attemptId} not found`)
		const nextState = transitionAttempt(toLifecycleState(current), event)
		const next = { ...current, ...nextState }
		this.attempts.set(attemptId, next)
		return { ...next }
	}

	async findAttempt(_taskId: number, attemptId: number): Promise<AttemptSnapshot | undefined> {
		const attempt = this.attempts.get(attemptId)
		return attempt ? { ...attempt } : undefined
	}

	all(): AttemptSnapshot[] {
		return [...this.attempts.values()].map((attempt) => ({ ...attempt }))
	}
}

export class ScriptedObserver implements AttemptObserver {
	readonly records: unknown[] = []
	private readonly lateRecords: unknown[] = []
	private readonly emissionCounts = new Map<AttemptObservation["type"], number>()
	constructor(private readonly faults: EventFaultScript = {}) {}

	async emit(observation: AttemptObservation): Promise<void> {
		const count = (this.emissionCounts.get(observation.type) ?? 0) + 1
		this.emissionCounts.set(observation.type, count)
		if (
			this.faults.fail?.includes(observation.type) ||
			(this.faults.failOnce?.includes(observation.type) && count === 1)
		) {
			throw new HarnessExecutionError(
				`scripted event sink failure on ${observation.type}`,
				"infrastructure_error",
				"scripted_event_sink_failure",
			)
		}
		if (this.faults.drop?.includes(observation.type)) return
		const value: unknown = this.faults.malformed?.includes(observation.type)
			? { malformed: true, originalType: observation.type }
			: structuredClone(observation)
		if (this.faults.late?.includes(observation.type)) this.lateRecords.push(value)
		else this.records.push(value)
		if (this.faults.duplicate?.includes(observation.type)) this.records.push(structuredClone(value))
	}

	flushLate(): void {
		this.records.push(...this.lateRecords.splice(0))
	}
}

export class InMemoryArtifactStore implements ArtifactStore {
	private readonly records = new Map<string, ArtifactRecord>()
	constructor(private readonly fault: NonNullable<HostileScenario["artifactFault"]> = "none") {}

	async put(id: string, bytes: Uint8Array, mediaType: string): Promise<ArtifactRecord> {
		if (this.fault === "upload_error" || this.fault === "interrupted") {
			throw new HarnessExecutionError(
				this.fault === "interrupted" ? "artifact upload interrupted" : "artifact upload failed",
				"infrastructure_error",
				this.fault === "interrupted" ? "artifact_upload_interrupted" : "artifact_upload_error",
			)
		}
		const originalDigest = digest(bytes)
		const storedBytes = this.fault === "corrupt" ? Uint8Array.from([...bytes, 0xff]) : Uint8Array.from(bytes)
		const record = { id, mediaType, bytes: storedBytes, digest: originalDigest }
		this.records.set(id, record)
		return cloneArtifact(record)
	}

	async get(id: string): Promise<ArtifactRecord | undefined> {
		const record = this.records.get(id)
		return record ? cloneArtifact(record) : undefined
	}

	all(): ArtifactRecord[] {
		return [...this.records.values()].map(cloneArtifact)
	}

	verify(id: string): boolean {
		const record = this.records.get(id)
		return !!record && digest(record.bytes) === record.digest
	}
}

export type ScriptedProcessOutcome =
	| { type: "result"; result: HarnessProcessResult }
	| { type: "error"; fault: FaultSpec; stdout?: string; stderr?: string }

export class ScriptedProcessError extends HarnessExecutionError {
	constructor(
		fault: FaultSpec,
		readonly stdout: string,
		readonly stderr: string,
	) {
		super(fault.message, fault.status ?? "infrastructure_error", fault.code ?? `scripted_${fault.kind}`)
		this.name = "ScriptedProcessError"
	}
}

export class ScriptedProcessRunner implements HarnessProcessRunner {
	readonly calls: HarnessProcessSpec[] = []
	constructor(private readonly outcomes: ScriptedProcessOutcome[]) {}

	async run(spec: HarnessProcessSpec): Promise<HarnessProcessResult> {
		this.calls.push(structuredClone(spec))
		const outcome = this.outcomes.shift()
		if (!outcome) throw new Error("No scripted process outcome remains")
		if (outcome.type === "error") {
			throw new ScriptedProcessError(outcome.fault, outcome.stdout ?? "", outcome.stderr ?? "")
		}
		return structuredClone(outcome.result)
	}
}

export class ScriptedGrader {
	private index = 0
	constructor(private readonly scripts: GradeScript[]) {}
	async grade(): Promise<GradeDecision> {
		const script = this.scripts[Math.min(this.index++, this.scripts.length - 1)]
		if (!script) throw new Error("No scripted grader outcome")
		if (script.outcome === "fault") throw faultError(script.fault, "grader_error")
		return script.decision
	}
	async sample(count: number): Promise<{ decisions: GradeDecision[]; deterministic: boolean }> {
		const decisions: GradeDecision[] = []
		for (let index = 0; index < count; index++) decisions.push(await this.grade())
		return { decisions, deterministic: new Set(decisions).size <= 1 }
	}
}

export class ScriptedAgent {
	constructor(private readonly script: StageScript = { outcome: "success" }) {}
	execute(): Promise<void> {
		return runStage(this.script, "agent_error")
	}
}

export class ScriptedEvidenceCollector {
	constructor(
		private readonly script: StageScript = { outcome: "success" },
		private readonly artifactStore?: ArtifactStore,
	) {}
	async collect(): Promise<void> {
		await runStage(this.script, "infrastructure_error")
		const record = await this.artifactStore?.put(
			"workspace",
			new TextEncoder().encode("workspace-state"),
			"text/plain",
		)
		if (record && digest(record.bytes) !== record.digest) {
			throw new HarnessExecutionError(
				"artifact digest verification failed",
				"infrastructure_error",
				"artifact_corrupt",
			)
		}
	}
}

export class HostileScenarioBuilder {
	private readonly value: HostileScenario
	constructor(id: string, seed: number) {
		this.value = { id, seed }
	}
	stage(stage: "setup" | "agent" | "evidence", script: StageScript): this {
		this.value[stage] = script
		return this
	}
	grade(script: GradeScript): this {
		this.value.grade = script
		return this
	}
	persistenceFailure(eventType: AttemptLifecycleEvent["type"], occurrence = 1): this {
		this.value.persistenceFailure = { eventType, occurrence }
		return this
	}
	eventFaults(faults: EventFaultScript): this {
		this.value.eventFaults = structuredClone(faults)
		return this
	}
	artifactFault(fault: NonNullable<HostileScenario["artifactFault"]>): this {
		this.value.artifactFault = fault
		return this
	}
	build(): HostileScenario {
		return structuredClone(this.value)
	}
}

export async function runHostileScenario(scenario: HostileScenario): Promise<HostileRunResult> {
	const lifecycle = new InMemoryLifecyclePort(scenario.persistenceFailure)
	const observer = new ScriptedObserver(scenario.eventFaults)
	const artifactStore = new InMemoryArtifactStore(scenario.artifactFault ?? "none")
	const agent = new ScriptedAgent(scenario.agent)
	const evidence = new ScriptedEvidenceCollector(scenario.evidence, artifactStore)
	const reproduction = stableStringify({ schemaVersion: 1, scenario })

	try {
		const result = await executeAttempt(
			{ taskId: 1, attemptNumber: 1 },
			{
				lifecycle,
				setup: () => runStage(scenario.setup, "infrastructure_error"),
				executeAgent: () => agent.execute(),
				collectEvidence: () => evidence.collect(),
				grade: () =>
					new ScriptedGrader([scenario.grade ?? { outcome: "decision", decision: "passed" }]).grade(),
				cleanup: async () => undefined,
				observer,
			},
		)
		return {
			status: result.status,
			attempt: result.attempt,
			observations: observer.records,
			artifacts: artifactStore.all(),
			reproduction,
		}
	} catch (error) {
		const attempt = lifecycle.all()[0]
		return {
			status: attempt?.terminalStatus,
			error: { name: error instanceof Error ? error.name : "UnknownError", message: String(error) },
			attempt,
			observations: observer.records,
			artifacts: artifactStore.all(),
			reproduction,
		}
	}
}

export type SecretCanaryBundle = {
	raw: string
	base64: string
	urlEncoded: string
	nestedPayload: unknown
}

export function createSecretCanary(secret: string): SecretCanaryBundle {
	return {
		raw: secret,
		base64: Buffer.from(secret).toString("base64"),
		urlEncoded: encodeURIComponent(secret),
		nestedPayload: {
			authorization: `Bearer ${secret}`,
			nested: [{ credential: secret }, { opaque: Buffer.from(secret).toString("base64") }],
		},
	}
}

export function findSecretCanaryLeaks(value: unknown, canary: SecretCanaryBundle): string[] {
	const serialized = JSON.stringify(value)
	return [canary.raw, canary.base64, canary.urlEncoded].filter((candidate) => serialized.includes(candidate))
}

async function runStage(
	script: StageScript | undefined,
	fallback: Extract<TrialTerminalStatus, "agent_error" | "infrastructure_error" | "grader_error">,
): Promise<void> {
	if (script?.outcome === "fault") throw faultError(script.fault, fallback)
}

function faultError(
	fault: FaultSpec,
	fallback: Extract<TrialTerminalStatus, "agent_error" | "infrastructure_error" | "grader_error">,
): HarnessExecutionError {
	return new HarnessExecutionError(fault.message, fault.status ?? fallback, fault.code ?? `scripted_${fault.kind}`)
}

function toLifecycleState(attempt: AttemptSnapshot): AttemptLifecycleState {
	return {
		phase: attempt.phase,
		terminalStatus: attempt.terminalStatus,
		version: attempt.version,
	}
}

function digest(bytes: Uint8Array): string {
	return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`
}

function cloneArtifact(record: ArtifactRecord): ArtifactRecord {
	return { ...record, bytes: Uint8Array.from(record.bytes) }
}

function stableStringify(value: unknown): string {
	return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue)
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, sortValue(child)]),
		)
	}
	return value
}
