import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
	canonicalJson,
	collectRequiredEvidence,
	containsSecret,
	EventJournal,
	FilesystemArtifactStore,
	REQUIRED_ARTIFACT_KINDS,
	validateEvidenceBundle,
	type EvidenceBundle,
	type RequiredEvidence,
} from "../evidence/index"
import type { TrialTerminalStatus } from "../lifecycle/index"
import type { GradeDecision } from "../orchestration/index"
import { ScriptedGrader, runHostileScenario, type HostileScenario } from "../testing/index"
import {
	certificationSuiteSchema,
	type CertificationKind,
	type CertificationResult,
	type CertificationScenario,
	type CertificationSuite,
} from "./types"

export async function loadCertificationSuite(file: string): Promise<CertificationSuite> {
	return certificationSuiteSchema.parse(JSON.parse(await fs.readFile(file, "utf8")))
}

export async function runCertificationScenario(scenario: CertificationScenario): Promise<CertificationResult> {
	const scripts = attemptScripts(scenario)
	const attemptStatuses: TrialTerminalStatus[] = []
	for (const [index, script] of scripts.entries()) {
		const result = await runHostileScenario({
			id: `${scenario.id}-${index + 1}`,
			seed: scenario.seed + index,
			...script,
		})
		attemptStatuses.push(result.status ?? "infrastructure_error")
	}

	let terminalStatus = attemptStatuses.at(-1) ?? "infrastructure_error"
	let graders = graderResults(scenario.kind)
	if (scenario.kind === "nondeterministic_grader") {
		const sample = await new ScriptedGrader([
			{ outcome: "decision", decision: "passed" },
			{ outcome: "decision", decision: "outcome_failed" },
		]).sample(2)
		terminalStatus = sample.deterministic ? "passed" : "grader_error"
		attemptStatuses[0] = terminalStatus
		graders = [{ id: "determinism-canary", status: sample.deterministic ? "passed" : "error", hardGate: true }]
	}

	const evidence = await certifyEvidence(scenario)
	if (!evidence.valid) {
		terminalStatus = "infrastructure_error"
		attemptStatuses[attemptStatuses.length - 1] = "infrastructure_error"
	}
	const infrastructure = terminalStatus === "infrastructure_error" || attemptStatuses.includes("infrastructure_error")
	return {
		terminalStatus,
		attemptStatuses,
		graders,
		requiredArtifacts: [...REQUIRED_ARTIFACT_KINDS],
		eventIntegrityValid: evidence.eventIntegrityValid,
		artifactsComplete: evidence.artifactsComplete,
		retryCount: Math.max(0, attemptStatuses.length - 1),
		metrics: {
			outcome: ["passed", "outcome_failed", "safety_failed"].includes(terminalStatus),
			reliability: true,
			infrastructure,
			safety: terminalStatus === "safety_failed",
		},
	}
}

export async function certifySuite(
	suite: CertificationSuite,
	options: { repetitions: number; concurrency: number },
): Promise<{ canonicalResult: string; runs: CertificationResult[][] }> {
	const runs: CertificationResult[][] = []
	let canonicalResult: string | undefined
	for (let repetition = 0; repetition < options.repetitions; repetition++) {
		const results = await mapConcurrent(suite.scenarios, options.concurrency, runAndCompare)
		const serialized = canonicalJson(results)
		if (canonicalResult !== undefined && serialized !== canonicalResult) {
			throw new Error(`Certification drift at repetition ${repetition + 1}`)
		}
		canonicalResult = serialized
		runs.push(results)
	}
	return { canonicalResult: canonicalResult ?? "[]", runs }
}

async function runAndCompare(scenario: CertificationScenario): Promise<CertificationResult> {
	const actual = await runCertificationScenario(scenario)
	const expected = canonicalJson(scenario.expected)
	if (canonicalJson(actual) !== expected) {
		throw new Error(
			`Certification mismatch for ${scenario.id}: ${canonicalJson({ expected: scenario.expected, actual, reproduction: scenario })}`,
		)
	}
	return actual
}

function attemptScripts(scenario: CertificationScenario): Partial<HostileScenario>[] {
	const outcome = (decision: GradeDecision): Partial<HostileScenario> => ({
		grade: { outcome: "decision", decision },
	})
	switch (scenario.kind) {
		case "known_pass":
		case "secret_redaction":
		case "missing_event":
		case "duplicate_event":
		case "nondeterministic_grader":
			return [outcome("passed")]
		case "functional_failure":
			return [outcome("outcome_failed")]
		case "forbidden_path":
		case "hidden_grader_access":
		case "network_violation":
			return [outcome("safety_failed")]
		case "agent_timeout":
			return [
				{
					agent: {
						outcome: "fault",
						fault: { kind: "timeout", message: "agent timed out", status: "agent_error" },
					},
				},
			]
		case "grader_timeout":
			return [{ grade: { outcome: "fault", fault: { kind: "timeout", message: "grader timed out" } } }]
		case "setup_failure":
			return [{ setup: { outcome: "fault", fault: { kind: "error", message: "setup unavailable" } } }]
		case "artifact_corruption":
			return [{ artifactFault: "corrupt" }]
		case "infrastructure_retry":
			return [
				{ setup: { outcome: "fault", fault: { kind: "error", message: "transient infrastructure" } } },
				outcome("passed"),
			]
		case "agent_retry":
			return [outcome("outcome_failed"), outcome("passed")]
		case "cancellation":
			return [
				{
					agent: {
						outcome: "fault",
						fault: { kind: "cancelled", message: "cancelled", status: "cancelled" },
					},
				},
			]
	}
}

function graderResults(kind: CertificationKind): CertificationResult["graders"] {
	if (
		[
			"agent_timeout",
			"setup_failure",
			"artifact_corruption",
			"missing_event",
			"duplicate_event",
			"cancellation",
		].includes(kind)
	) {
		return []
	}
	if (["forbidden_path", "hidden_grader_access", "network_violation"].includes(kind)) {
		return [{ id: `${kind}-gate`, status: "failed", hardGate: true }]
	}
	if (kind === "grader_timeout") return [{ id: "grader-timeout", status: "error", hardGate: false }]
	if (kind === "functional_failure" || kind === "agent_retry") {
		return [{ id: "functional", status: kind === "agent_retry" ? "passed" : "failed", hardGate: false }]
	}
	return [{ id: "certification", status: "passed", hardGate: false }]
}

async function certifyEvidence(scenario: CertificationScenario): Promise<{
	valid: boolean
	eventIntegrityValid: boolean
	artifactsComplete: boolean
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `alpha-cert-${scenario.id}-`))
	const store = new FilesystemArtifactStore(root)
	const secret = `secret-${scenario.seed}`
	const journal = new EventJournal(
		{ runId: "certification", trialId: scenario.id, attemptId: "1" },
		{ secrets: scenario.kind === "secret_redaction" ? [secret] : [] },
	)
	journal.append("certification.executed", {
		kind: scenario.kind,
		nested: { token: scenario.kind === "secret_redaction" ? secret : "none" },
	})
	const values = Object.fromEntries(
		REQUIRED_ARTIFACT_KINDS.map((kind) => [kind, `${scenario.id}:${kind}`]),
	) as RequiredEvidence
	const artifacts = await collectRequiredEvidence("1", values, store, { secrets: [secret] })
	const bundle: EvidenceBundle = {
		schemaVersion: 1,
		runId: "certification",
		trialId: scenario.id,
		attemptId: "1",
		taskIdentity: `${scenario.id}@1`,
		variantIdentity: "certification-runtime@1",
		events: journal.all(),
		artifacts,
	}
	if (scenario.kind === "missing_event") bundle.events = []
	if (scenario.kind === "duplicate_event") bundle.events.push({ ...bundle.events[0]! })
	if (scenario.kind === "artifact_corruption") bundle.artifacts[0]!.digest = `sha256:${"0".repeat(64)}`
	const integrity = await validateEvidenceBundle(bundle, store)
	const noSecretLeak = !containsSecret(bundle, [secret])
	const result = {
		valid: integrity.valid && noSecretLeak,
		eventIntegrityValid: !integrity.issues.some(({ code }) => code.startsWith("event_")),
		artifactsComplete: !integrity.issues.some(({ code }) => code.startsWith("artifact_")),
	}
	await fs.rm(root, { recursive: true, force: true })
	return result
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(values.length)
	let next = 0
	await Promise.all(
		Array.from({ length: Math.min(concurrency, values.length) }, async () => {
			while (next < values.length) {
				const index = next++
				results[index] = await mapper(values[index]!)
			}
		}),
	)
	return results
}
