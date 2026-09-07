import * as fs from "fs/promises"
import * as path from "path"
import {
	captureRunEvidence,
	pruneRunEvidence,
	markRunRetentionEligible,
	type EvidenceFailure,
	type RepositoryEvidence,
	type EvidenceRetentionResult,
} from "./evidence"
import { assertOwnedTestRoot, type TestProfile } from "./testProfile"
import { TestRunError } from "./runFailure"
import type { ExtensionTestRunOptions, ExtensionTestRunResult } from "./runTest"
import { requireEvidenceRoot, requireEvidenceRun } from "./evidence/paths"

export interface RunRetentionReport {
	schemaVersion: 1
	runId: string
	status: "complete" | "blocked" | "failed"
	eligibility: "pending-release" | "held" | "not-eligible"
	/** A held phase does not make a standalone quota claim; its campaign audits aggregate storage before acceptance. */
	maintenance?: "campaign-owned"
	result?: EvidenceRetentionResult
	failure?: "evidence-retention-failed"
}

/** Final artifact maintenance: the canonical eligibility receipt is the last write to a released run. */
export async function finalizeRunRetention(
	options: ExtensionTestRunOptions,
	profile: TestProfile,
	result: ExtensionTestRunResult,
): Promise<RunRetentionReport> {
	const mayRelease =
		!options.retainEvidenceForCampaign &&
		result.status === "passed" &&
		result.captureComplete === true &&
		result.execution === "extension-host" &&
		result.hostExitObserved &&
		result.ownershipGate === "verified"
	const base = {
		schemaVersion: 1 as const,
		runId: result.runId,
		eligibility: options.retainEvidenceForCampaign
			? ("held" as const)
			: mayRelease
				? ("pending-release" as const)
				: ("not-eligible" as const),
	}
	let report: RunRetentionReport
	try {
		if (options.retainEvidenceForCampaign) {
			const root = await requireEvidenceRoot(profile.artifactsDir)
			if ((await requireEvidenceRun(root, result.runId)) !== path.resolve(result.artifactsDir))
				throw new Error("Campaign evidence directory mismatch")
			// A child owns its receipt, not cleanup of its parent's other attempts or historical campaigns.
			report = { ...base, status: "complete", maintenance: "campaign-owned" }
		} else {
			const retention = await pruneRunEvidence({
				...options.evidenceRetention,
				artifactsRoot: profile.artifactsDir,
				keepRunIds: [result.runId],
			})
			const complete = retention.complete && !retention.overBudget
			report = {
				...base,
				status: complete ? "complete" : "blocked",
				result: retention,
				...(complete ? {} : { failure: "evidence-retention-failed" as const }),
			}
		}
	} catch {
		report = { ...base, status: "failed", failure: "evidence-retention-failed" }
	}
	await fs.writeFile(path.join(result.artifactsDir, "retention-result.json"), JSON.stringify(report, null, 2), {
		flag: "wx",
		mode: 0o600,
	})
	if (mayRelease && report.status === "complete") {
		try {
			await markRunRetentionEligible({ artifactsRoot: profile.artifactsDir, runId: result.runId })
		} catch {
			// The canonical helper throws only before a valid marker is published, so this run is still protected.
			report = { ...report, status: "failed", failure: "evidence-retention-failed" }
			await fs.writeFile(
				path.join(result.artifactsDir, "retention-error.json"),
				JSON.stringify({
					schemaVersion: 1,
					runId: result.runId,
					status: "failed",
					failure: "evidence-retention-failed",
				}),
				{ flag: "wx", mode: 0o600 },
			)
		}
	}
	return report
}

function classifyRunFailure(result: ExtensionTestRunResult): EvidenceFailure | undefined {
	switch (result.failure) {
		case "host-cancelled":
			return { phase: "lifecycle", code: "ABORT_ERR" }
		case undefined:
			return undefined
		case "authentication-required":
			return { phase: "provider", code: "AUTH_REQUIRED" }
		case "model-unavailable":
		case "model-selection-ambiguous":
			return { phase: "provider", code: "MODEL_UNAVAILABLE" }
		case "authentication-unknown":
		case "provider-unavailable":
		case "effort-unavailable":
		case "effort-unsupported":
			return { phase: "provider", code: "UNKNOWN" }
		default:
			return { phase: "host", code: result.failure === "host-failed" ? "HOST_EXIT" : "UNKNOWN" }
	}
}

async function existingDirectory(candidate: string): Promise<string | undefined> {
	try {
		const stat = await fs.lstat(candidate)
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid source directory")
		return await fs.realpath(candidate)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw error
	}
}

async function scenarioTaskIds(file: string, runId: string): Promise<string[]> {
	try {
		const stat = await fs.lstat(file)
		if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("Invalid scenario evidence")
		const value: unknown = JSON.parse(await fs.readFile(file, "utf8"))
		if (
			!value ||
			typeof value !== "object" ||
			!("runId" in value) ||
			value.runId !== runId ||
			!("taskIds" in value) ||
			!Array.isArray(value.taskIds) ||
			value.taskIds.length > 100 ||
			!value.taskIds.every(
				(id: unknown) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id),
			)
		) {
			throw new Error("Invalid scenario evidence")
		}
		return value.taskIds as string[]
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
}

/** Capture only projected evidence from the runner's already-owned roots, never arbitrary settings/auth files. */
export async function finalizeRunEvidence(input: {
	options: ExtensionTestRunOptions
	profile: TestProfile
	result: ExtensionTestRunResult
	extensionId: string
	extensionDevelopmentPath: string
	startedAt: string
	repositoryBefore?: RepositoryEvidence
	scenarioResultPath: string
}): Promise<void> {
	const { options, profile, result } = input
	const storagePath = await existingDirectory(
		path.join(profile.userDataDir, "User", "globalStorage", input.extensionId.toLowerCase()),
	)
	const logsPath = await existingDirectory(path.join(profile.userDataDir, "logs"))
	const workspacePath = await fs.realpath(profile.workspace)
	const capture = await captureRunEvidence({
		artifactsRoot: profile.artifactsDir,
		runId: result.runId,
		metadata: {
			scenarioId: options.scenarioId ?? (options.setup ? "copilot-setup" : "extension-suite"),
			hostVersion: result.actualVSCodeVersion ?? null,
			requestedHostVersion: options.vscodeVersion,
			provider: options.providerMode,
			modelId: result.actualModelId,
			reasoningEffort: result.actualReasoningEffort,
			taskIds: options.scenarioId ? await scenarioTaskIds(input.scenarioResultPath, result.runId) : [],
			startedAt: input.startedAt,
			finishedAt: new Date().toISOString(),
			outcome: result.status,
		},
		bundlePath:
			result.execution === "extension-host"
				? path.join(input.extensionDevelopmentPath, "dist", "extension.js")
				: undefined,
		workspacePath,
		storagePath,
		logsPath,
		repositoryBefore: input.repositoryBefore,
		failure: classifyRunFailure(result),
		assertSourceOwned: async (source) => {
			if (![workspacePath, storagePath, logsPath].includes(source)) {
				throw new TestRunError("profile-invalid", "Evidence source is not owned by this run")
			}
			if (profile.temporaryRoot) await assertOwnedTestRoot(profile.temporaryRoot, "temporary")
			else if (source === workspacePath) await assertOwnedTestRoot(profile.workspace, "workspace")
			else if (profile.profileDir) await assertOwnedTestRoot(profile.profileDir, "profile")
			else throw new TestRunError("profile-invalid", "Evidence source has no ownership marker")
		},
	})
	result.evidenceManifestPath = capture.manifestPath
	result.captureComplete = capture.captureComplete
	if (!capture.captureComplete)
		throw new TestRunError("evidence-failed", "Evidence capture is incomplete; sources retained")
}
