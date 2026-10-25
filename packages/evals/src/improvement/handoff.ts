import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

import type { CampaignRepair } from "../../../../apps/vscode-e2e/src/campaign/types"
import type { ProblemSolvingDiagnosis } from "../benchmark/problemSolvingDiagnosis"
import type { ContentAddressedArtifactStore } from "../evidence/artifactStore"
import { canonicalJson, sha256 } from "../evidence/canonical"
import { evidenceBundleDigest } from "../evidence/integrity"
import { REQUIRED_ARTIFACT_KINDS, type EvidenceBundle } from "../evidence/types"
import { restoreWorkspaceSnapshot } from "../evidence/workspaceSnapshot"
import { validateGraderRun } from "../grading/aggregate"
import { createDefaultGraderRegistry, validateSpecs } from "../grading/registry"
import type { GraderSpec } from "../grading/types"
import { parseGraderRun } from "../grading/validation"
import { systemClock } from "../orchestration/systemPorts"
import {
	feedbackSourceSchema,
	feedbackReviewSchema,
	feedbackSchema,
	improvementDigestSchema as digest,
	improvementIdSchema as id,
	type Feedback,
	type FeedbackReview,
} from "./contracts"
import {
	assertBoundedJson,
	FEEDBACK_EVIDENCE_LIMITS,
	parseFeedback,
	parseFeedbackReview,
	validateFeedback,
	validateFeedbackReview,
} from "./feedback"
import {
	parseRegressionProposal,
	parseRegressionControlReceipt,
	regressionFixtureDigest,
	type RegressionProposal,
	type RegressionControlReceipt,
} from "./regressions"
import { assertPrivateContent } from "./store"

const text = feedbackSchema.shape.finding
const identity = feedbackReviewSchema.shape.source.shape.reviewerId
const relativePath = z
	.string()
	.min(1)
	.max(256)
	.transform((value) => value.replaceAll("\\", "/"))
	.refine(
		(value) =>
			/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(value) &&
			value
				.split("/")
				.every(
					(part) =>
						!/[. ]$/.test(part) &&
						!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) &&
						![
							".",
							"..",
							".git",
							".codex",
							".agents",
							".aws",
							"node_modules",
							"dist",
							"out",
							"build",
							"generated",
						].includes(part.toLowerCase()),
				),
		"Handoff paths must be bounded source-relative paths",
	)
const sourceFile = z.object({ path: relativePath, digest }).strict()
const timestamp = z.string().datetime({ offset: true })
const contextInputSchema = z
	.object({
		schemaVersion: z.literal(1),
		sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
		sourceFiles: z.array(sourceFile).min(1).max(64),
		workingTreeDigest: digest.optional(),
		harnessDigest: digest,
		extensionBuildDigest: digest,
		taskSetDigest: digest,
		model: z.object({ id: identity, effort: identity }).strict(),
	})
	.strict()
export const harnessContextSchema = contextInputSchema.extend({ digest }).strict()
export type HarnessContext = z.infer<typeof harnessContextSchema>
export type HandoffSourceReader = (relativePath: string, signal?: AbortSignal) => Promise<Uint8Array | undefined>

const classification = z.enum([
	"missing-requirement",
	"existing-unenforced",
	"implementation-defect",
	"observability-defect",
])
export const handoffCandidateSchema = z
	.object({
		id,
		title: text,
		feedbackDigest: digest,
		reviewDigest: digest,
		regressionProposalDigest: digest,
		classification,
		requirement: z
			.object({ state: z.enum(["missing", "present"]), references: z.array(sourceFile).max(10) })
			.strict(),
		owningPaths: z.array(relativePath).min(1).max(10),
		allowedChangePaths: z.array(relativePath).min(1).max(10),
		impact: z.number().int().min(1).max(5),
		confidence: z.number().int().min(0).max(100),
		effort: z.number().int().min(1).max(5),
	})
	.strict()
export type HandoffCandidate = z.infer<typeof handoffCandidateSchema>
const validationSummary = z
	.object({
		digest,
		scope: z.literal("archived-output-and-offline-controls"),
		status: z.enum(["passed", "failed", "inconclusive"]),
		archivedDecision: z.enum(["passed", "outcome_failed", "safety_failed", "grader_error"]),
	})
	.strict()
const itemSchema = handoffCandidateSchema
	.extend({
		source: feedbackSourceSchema,
		finding: text,
		expectedBehavior: text,
		severity: z.enum(["low", "medium", "high", "critical"]),
		humanReview: z
			.object({ reviewerId: feedbackReviewSchema.shape.source.shape.reviewerId, rationale: text })
			.strict(),
		regressionIds: z.array(id).min(1).max(10),
		validation: z.array(validationSummary).min(1).max(20),
		freshAgentConfirmation: z.literal("required"),
		priorityScore: z.number().int().nonnegative(),
		digest,
	})
	.strict()
export type HandoffItem = z.infer<typeof itemSchema>
const manifestSchema = z
	.object({
		schemaVersion: z.literal(1),
		recordType: z.literal("codex-handoff"),
		id,
		createdAt: timestamp,
		context: harnessContextSchema,
		rankingPolicy: z.literal("severity-impact-confidence-effort-v1"),
		evidenceBundleDigests: z.array(digest).min(1).max(100),
		feedbackDigests: z.array(digest).min(1).max(100),
		feedbackReviewDigests: z.array(digest).min(1).max(100),
		regressionProposalDigests: z.array(digest).min(1).max(100),
		validationReceiptDigests: z.array(digest).min(1).max(100),
		diagnosis: z
			.object({ digest, scope: z.literal("deterministic-metadata-only") })
			.strict()
			.optional(),
		items: z.array(itemSchema).min(1).max(100),
		digest,
	})
	.strict()
export type HandoffManifest = z.infer<typeof manifestSchema>
export type HandoffInput = {
	id: string
	createdAt: string
	context: HarnessContext
	bundles: EvidenceBundle[]
	feedback: Feedback[]
	reviews: FeedbackReview[]
	proposals: RegressionProposal[]
	validations: RegressionValidationReceipt[]
	candidates: HandoffCandidate[]
	diagnosis?: ProblemSolvingDiagnosis
}
export type HandoffOptions = {
	store: ContentAddressedArtifactStore
	/** Trusted host reader must enforce its source root, symlink policy, and bounded reads. */
	readSource: HandoffSourceReader
	secrets?: string[]
	signal?: AbortSignal
}

function sealed<T extends object>(value: T): T & { digest: string } {
	// Existing grader plugins use optional undefined fields; the persisted record is canonical JSON.
	const encoded = canonicalJson(value)
	const content = JSON.parse(encoded) as T
	assertPrivateContent(content)
	return { ...content, digest: sha256(encoded) }
}
function assertSeal(record: { digest: string }): void {
	const { digest: expected, ...content } = record
	if (sha256(canonicalJson(content)) !== expected) throw new Error("Handoff content digest mismatch")
}
function immutable<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) immutable(child)
		Object.freeze(value)
	}
	return value
}
function unique(values: readonly string[], label: string): void {
	if (new Set(values).size !== values.length) throw new Error(`Duplicate handoff ${label}`)
}
function contextSources(context: HarnessContext): Map<string, string> {
	assertSeal(context)
	unique(
		context.sourceFiles.map(({ path }) => path.toLowerCase()),
		"source paths",
	)
	return new Map(context.sourceFiles.map(({ path, digest }) => [path, digest]))
}
export function sealHarnessContext(value: unknown): HarnessContext {
	assertBoundedJson(value, 65_536)
	const context = harnessContextSchema.parse(sealed(contextInputSchema.parse(value)))
	contextSources(context)
	return immutable(context)
}
export async function validateHarnessContext(
	value: unknown,
	readSource: HandoffSourceReader,
	options: {
		signal?: AbortSignal
		timeoutMs?: number
	} = {},
): Promise<HarnessContext> {
	assertBoundedJson(value, 65_536)
	const context = harnessContextSchema.parse(value)
	contextSources(context)
	const timeoutMs = options.timeoutMs ?? 10_000
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
		throw new Error("Harness source verification deadline must be bounded")
	options.signal?.throwIfAborted()
	const controller = new AbortController()
	const abort = () => controller.abort(new Error("Harness source verification cancelled or deadline exceeded"))
	const timer = setTimeout(abort, timeoutMs)
	options.signal?.addEventListener("abort", abort, { once: true })
	let rejectRead: () => void = () => {}
	const cancellation = new Promise<never>((_resolve, reject) => {
		rejectRead = () => reject(controller.signal.reason)
		controller.signal.addEventListener("abort", rejectRead, { once: true })
	})
	try {
		for (const file of context.sourceFiles) {
			controller.signal.throwIfAborted()
			const bytes = await Promise.race([
				Promise.resolve().then(() => readSource(file.path, controller.signal)),
				cancellation,
			])
			controller.signal.throwIfAborted()
			if (!bytes || bytes.byteLength > 2 * 1024 * 1024 || sha256(bytes) !== file.digest)
				throw new Error("Current harness source is missing, stale, or too large")
		}
		return immutable(context)
	} finally {
		clearTimeout(timer)
		options.signal?.removeEventListener("abort", abort)
		controller.signal.removeEventListener("abort", rejectRead)
	}
}
const severityWeight = { low: 1, medium: 2, high: 3, critical: 4 } as const
function score(item: Pick<HandoffItem, "severity" | "impact" | "confidence" | "effort">): number {
	return severityWeight[item.severity] * 1_000_000 + item.impact * 10_000 + item.confidence * 10 + (5 - item.effort)
}
function ordered(left: HandoffItem, right: HandoffItem): number {
	return right.priorityScore - left.priorityScore || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}
function validateItemScope(item: HandoffCandidate, context: HarnessContext): void {
	const sources = contextSources(context)
	unique(
		item.allowedChangePaths.map((path) => path.toLowerCase()),
		"allowed paths",
	)
	unique(
		item.owningPaths.map((path) => path.toLowerCase()),
		"owning paths",
	)
	for (const path of [...item.owningPaths, ...item.allowedChangePaths])
		if (!sources.has(path)) throw new Error("Handoff code scope is missing its current source hash")
	for (const file of item.requirement.references)
		if (sources.get(file.path) !== file.digest) throw new Error("Handoff requirement references stale source")
	if (
		(item.classification === "missing-requirement") !== (item.requirement.state === "missing") ||
		(item.requirement.state === "present" && item.requirement.references.length === 0)
	)
		throw new Error("Handoff must distinguish missing requirements from existing contracts")
}

function validateControls(receipt: RegressionControlReceipt, proposal: RegressionProposal): void {
	const expected = new Map<string, string>([
		["untouched", "untouched"],
		["reference", "reference"],
		["alternative", "alternative"],
	])
	for (const { id } of proposal.draft.controls.incorrect) expected.set(id, "incorrect")
	const fixtureDigest = regressionFixtureDigest(proposal.draft)
	if (
		receipt.proposalDigest !== proposal.digest ||
		receipt.policyDigest !== proposal.policyDigest ||
		receipt.failureMarker !== proposal.draft.verifier.failureMarker ||
		receipt.fixtureDigest !== fixtureDigest ||
		receipt.controls.length !== expected.size ||
		receipt.controls.some(({ id, kind }) => expected.get(id) !== kind)
	)
		throw new Error("Handoff validation does not bind the generated fixture and required controls")
	for (const control of receipt.controls) {
		const result = parseGraderRun(control.result)
		if (sha256(canonicalJson(result)) !== control.graderResultDigest)
			throw new Error("Handoff validation contains fabricated grader evidence")
	}
}

const archivedRegradeSchema = z
	.object({
		schemaVersion: z.literal(1),
		recordType: z.literal("archived-evidence-regrade"),
		evidenceKind: z.literal("archived-output-grading"),
		execution: z.literal("disabled"),
		proposalDigest: digest,
		bundleDigest: digest,
		contextDigest: digest,
		specs: z.array(z.custom<GraderSpec>()).min(1).max(32),
		specsDigest: digest,
		result: z.unknown().transform(validateGraderRun),
		resultDigest: digest,
		digest,
	})
	.strict()
export type ArchivedRegradeReceipt = z.infer<typeof archivedRegradeSchema>

function archivedGraderPaths(spec: GraderSpec): string[] {
	return spec.type === "filesystem"
		? spec.assertions.map(({ path }) => path)
		: spec.type === "static-analysis"
			? (spec.files ?? []).map(({ path }) => path)
			: []
}

function validateArchivedScope(specs: GraderSpec[], bundle: EvidenceBundle): void {
	const projectedArtifacts = new Set(
		bundle.artifacts
			.filter(({ kind }) => REQUIRED_ARTIFACT_KINDS.some((required) => kind === required))
			.map(({ kind }) => `artifacts/${kind}`),
	)
	const capturedWorkspace = bundle.artifacts.filter(({ kind }) => kind === "workspace_snapshot").length === 1
	for (const spec of specs)
		for (const name of archivedGraderPaths(spec)) {
			// Missing reconstruction inputs cannot prove that a file was absent in the original attempt.
			if (!projectedArtifacts.has(name) && !(name.startsWith("workspace/") && capturedWorkspace))
				throw new Error("Archive grader data was not retained in the reconstruction")
		}
}

/** Fixed read-only plugins only. Retained source code is data, never an executable verifier. */
export function validateArchivedGraderSpecs(value: unknown): GraderSpec[] {
	assertBoundedJson(value, 131_072)
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.length > 32 ||
		Buffer.byteLength(canonicalJson(value)) > 131_072
	)
		throw new Error("Archived graders exceed their bounds")
	const specs = structuredClone(value) as GraderSpec[]
	validateSpecs(specs)
	for (const spec of specs) {
		if (
			spec.type === "command" ||
			spec.type === "diff-policy" ||
			(spec.type === "static-analysis" &&
				(spec.scanChangedFiles ||
					(spec.files ?? []).some(
						(file) =>
							file.parseAs !== "json" ||
							(file.requiredPatterns?.length ?? 0) > 0 ||
							(file.forbiddenPatterns?.length ?? 0) > 0,
					))) ||
			(spec.type === "filesystem" && spec.assertions.some(({ kind }) => kind === "content-matches"))
		)
			throw new Error(
				"Archived grading permits only literal read-only artifact checks without executable commands or regular expressions",
			)
		for (const name of archivedGraderPaths(spec)) {
			relativePath.parse(name)
			if (!name.startsWith("artifacts/") && !name.startsWith("workspace/"))
				throw new Error("Archived grader path must select retained artifacts or workspace data")
		}
	}
	return specs
}

export function parseArchivedRegradeReceipt(value: unknown): ArchivedRegradeReceipt {
	assertBoundedJson(value, 8 * 1024 * 1024)
	const receipt = archivedRegradeSchema.parse(value)
	assertSeal(receipt)
	assertPrivateContent(receipt)
	validateArchivedGraderSpecs(receipt.specs)
	if (
		sha256(canonicalJson(receipt.specs)) !== receipt.specsDigest ||
		sha256(canonicalJson(receipt.result)) !== receipt.resultDigest ||
		receipt.result.results.length !== receipt.specs.length
	)
		throw new Error("Archived grading contains fabricated result claims")
	for (const [index, spec] of receipt.specs.entries()) {
		const result = receipt.result.results[index]!
		if (
			result.graderId !== spec.id ||
			result.graderVersion !== spec.version ||
			result.type !== spec.type ||
			result.hardGate !== spec.hardGate ||
			result.failureClass !== spec.failureClass
		)
			throw new Error("Archived grader results do not match their bound checks")
	}
	return immutable(receipt)
}

async function newReconstructionRoot(ownedRoot: string, destinationName: string): Promise<string> {
	if (
		ownedRoot.length > 2048 ||
		!path.isAbsolute(ownedRoot) ||
		!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(destinationName)
	)
		throw new Error("Archived reconstruction requires an absolute owned root and a safe new directory name")
	const root = path.resolve(ownedRoot)
	const ancestors: string[] = []
	for (let cursor = root; ; cursor = path.dirname(cursor)) {
		ancestors.unshift(cursor)
		if (path.dirname(cursor) === cursor) break
	}
	for (const ancestor of ancestors) {
		const info = await fs.lstat(ancestor)
		if (info.isSymbolicLink() || !info.isDirectory())
			throw new Error("Archived reconstruction root contains a symlink or non-directory")
	}
	const destination = path.join(root, destinationName)
	await fs.mkdir(destination, { mode: 0o700 })
	return destination
}

export async function regradeArchivedEvidence(
	input: {
		proposal: RegressionProposal
		bundle: EvidenceBundle
		context: HarnessContext
		specs: GraderSpec[]
	},
	options: HandoffOptions & { ownedRoot: string; destinationName: string },
): Promise<{
	receipt: ArchivedRegradeReceipt
	reconstructionRoot: string
}> {
	const proposal = parseRegressionProposal(input.proposal)
	assertBoundedJson(input.bundle, FEEDBACK_EVIDENCE_LIMITS.metadataBytes)
	const bundle = structuredClone(input.bundle)
	const specs = validateArchivedGraderSpecs(input.specs)
	const context = await validateHarnessContext(input.context, options.readSource, options)
	const verifiedBytes = new Map<string, Uint8Array>()
	const cachedStore: ContentAddressedArtifactStore = {
		put: (value) => options.store.put(value),
		get: async (artifact) => {
			const previous = verifiedBytes.get(artifact.digest)
			if (previous) return previous
			const bytes = await options.store.get(artifact)
			if (bytes && bytes.byteLength > FEEDBACK_EVIDENCE_LIMITS.artifactBytes)
				throw new Error("Archived retained artifact exceeds its byte bound")
			if (bytes) verifiedBytes.set(artifact.digest, Buffer.from(bytes))
			return verifiedBytes.get(artifact.digest)
		},
	}
	await validateFeedback(proposal.feedback, {
		bundle,
		store: cachedStore,
		secrets: options.secrets,
		signal: options.signal,
	})
	if (
		!bundle.bundleDigest ||
		bundle.bundleDigest !== evidenceBundleDigest(bundle) ||
		proposal.source.bundleDigest !== bundle.bundleDigest
	)
		throw new Error("Archived grading requires exact sealed source evidence")
	const artifactBytes = new Map<string, Uint8Array>()
	let byteLength = 0
	for (const kind of [...REQUIRED_ARTIFACT_KINDS, "workspace_snapshot"] as const) {
		const artifacts = bundle.artifacts.filter((artifact) => artifact.kind === kind)
		if (artifacts.length !== (kind === "workspace_snapshot" && artifacts.length === 0 ? 0 : 1))
			throw new Error("Archived grading requires unambiguous artifact identities")
		if (!artifacts[0]) continue
		const bytes = verifiedBytes.get(artifacts[0].digest)
		if (!bytes || bytes.byteLength !== artifacts[0].sizeBytes || sha256(bytes) !== artifacts[0].digest)
			throw new Error("Archived artifact changed after integrity validation")
		byteLength += bytes.byteLength
		if (byteLength > 64 * 1024 * 1024) throw new Error("Archived reconstruction exceeds its byte bound")
		artifactBytes.set(kind, bytes)
	}
	validateArchivedScope(specs, bundle)
	assertPrivateContent({ specs, bundle }, options.secrets)
	options.signal?.throwIfAborted()
	const reconstructionRoot = await newReconstructionRoot(options.ownedRoot, options.destinationName)
	await fs.mkdir(path.join(reconstructionRoot, "artifacts"), { mode: 0o700 })
	for (const [kind, bytes] of artifactBytes) {
		options.signal?.throwIfAborted()
		if (kind === "workspace_snapshot") {
			await restoreWorkspaceSnapshot(
				JSON.parse(new TextDecoder().decode(bytes)),
				path.join(reconstructionRoot, "workspace"),
			)
		} else await fs.writeFile(path.join(reconstructionRoot, "artifacts", kind), bytes, { flag: "wx", mode: 0o600 })
	}
	const decodeJson = (kind: string): unknown => {
		try {
			return JSON.parse(new TextDecoder().decode(artifactBytes.get(kind)))
		} catch {
			return undefined
		}
	}
	const result = await createDefaultGraderRegistry().execute(specs, {
		workspaceRoot: reconstructionRoot,
		changedPaths: [],
		trace: bundle.events.map(({ sequence, type, timestamp, payload }) => ({ sequence, type, timestamp, payload })),
		usage: decodeJson("usage"),
		processRunner: {
			run: async () => {
				throw new Error("Archived evidence execution is disabled")
			},
		},
		clock: systemClock,
	})
	await validateHarnessContext(context, options.readSource, options)
	const receipt = parseArchivedRegradeReceipt(
		sealed({
			schemaVersion: 1 as const,
			recordType: "archived-evidence-regrade" as const,
			evidenceKind: "archived-output-grading" as const,
			execution: "disabled" as const,
			proposalDigest: proposal.digest,
			bundleDigest: bundle.bundleDigest,
			contextDigest: context.digest,
			specs,
			specsDigest: sha256(canonicalJson(specs)),
			result,
			resultDigest: sha256(canonicalJson(result)),
		}),
	)
	return { receipt, reconstructionRoot }
}

const regressionValidationSchema = z
	.object({
		schemaVersion: z.literal(1),
		recordType: z.literal("regression-validation"),
		proposalDigest: digest,
		bundleDigest: digest,
		contextDigest: digest,
		evidenceKind: z.literal("archived-output-and-offline-controls"),
		controls: z.unknown().transform(parseRegressionControlReceipt),
		archived: archivedRegradeSchema,
		status: z.enum(["passed", "failed", "inconclusive"]),
		freshAgentConfirmation: z.literal("required"),
		digest,
	})
	.strict()
export type RegressionValidationReceipt = z.infer<typeof regressionValidationSchema>

export function parseRegressionValidationReceipt(value: unknown): RegressionValidationReceipt {
	assertBoundedJson(value, 8 * 1024 * 1024)
	const receipt = regressionValidationSchema.parse(value)
	assertSeal(receipt)
	assertPrivateContent(receipt)
	const archived = parseArchivedRegradeReceipt(receipt.archived)
	const status = archived.result.decision === "grader_error" ? "inconclusive" : receipt.controls.status
	if (
		receipt.proposalDigest !== receipt.controls.proposalDigest ||
		receipt.proposalDigest !== archived.proposalDigest ||
		receipt.bundleDigest !== archived.bundleDigest ||
		receipt.contextDigest !== archived.contextDigest ||
		receipt.status !== status
	)
		throw new Error("Regression validation contradicts its actual component results")
	return immutable(receipt)
}

/** A passing control gate can reproduce an archived failure; its actual decision remains explicit. */
export function buildRegressionValidation(input: {
	proposal: RegressionProposal
	controls: RegressionControlReceipt
	archived: ArchivedRegradeReceipt
}): RegressionValidationReceipt {
	const proposal = parseRegressionProposal(input.proposal)
	const controls = parseRegressionControlReceipt(input.controls)
	const archived = parseArchivedRegradeReceipt(input.archived)
	validateControls(controls, proposal)
	if (archived.proposalDigest !== proposal.digest || archived.bundleDigest !== proposal.source.bundleDigest)
		throw new Error("Regression validation evidence ancestry differs from its reviewed proposal")
	return parseRegressionValidationReceipt(
		sealed({
			schemaVersion: 1 as const,
			recordType: "regression-validation" as const,
			proposalDigest: proposal.digest,
			bundleDigest: archived.bundleDigest,
			contextDigest: archived.contextDigest,
			evidenceKind: "archived-output-and-offline-controls" as const,
			controls,
			archived,
			status: archived.result.decision === "grader_error" ? ("inconclusive" as const) : controls.status,
			freshAgentConfirmation: "required" as const,
		}),
	)
}

/** Produce reviewable data only; verified archived evidence never substitutes for a fresh agent run. */
export async function buildHandoff(
	input: HandoffInput,
	options: HandoffOptions,
): Promise<{
	manifest: HandoffManifest
	markdown: string
}> {
	assertBoundedJson(input, 8 * 1024 * 1024)
	const snapshot = structuredClone(input)
	assertPrivateContent(snapshot, options.secrets)
	id.parse(snapshot.id)
	timestamp.parse(snapshot.createdAt)
	for (const values of [
		snapshot.bundles,
		snapshot.feedback,
		snapshot.reviews,
		snapshot.proposals,
		snapshot.validations,
		snapshot.candidates,
	])
		if (!Array.isArray(values) || values.length === 0 || values.length > 100)
			throw new Error("Handoff requires bounded evidence and reviewed candidates")
	const context = await validateHarnessContext(snapshot.context, options.readSource, options)
	const feedback = snapshot.feedback.map(parseFeedback)
	const reviews = snapshot.reviews.map(parseFeedbackReview)
	const proposals = snapshot.proposals.map(parseRegressionProposal)
	const validations = snapshot.validations.map(parseRegressionValidationReceipt)
	unique(
		feedback.map(({ id }) => id),
		"feedback identities",
	)
	unique(
		reviews.map(({ id }) => id),
		"review identities",
	)
	unique(
		proposals.map(({ digest }) => digest),
		"proposal digests",
	)
	unique(
		validations.map(({ digest }) => digest),
		"validation receipts",
	)
	unique(
		snapshot.bundles.map(({ bundleDigest }) => bundleDigest ?? ""),
		"evidence bundles",
	)
	const items: HandoffItem[] = []
	for (const value of snapshot.candidates) {
		const candidate = handoffCandidateSchema.parse(value)
		validateItemScope(candidate, context)
		const observation = feedback.find(({ digest }) => digest === candidate.feedbackDigest)
		const review = reviews.find(({ digest }) => digest === candidate.reviewDigest)
		const proposal = proposals.find(({ digest }) => digest === candidate.regressionProposalDigest)
		if (
			!observation ||
			!review ||
			!proposal ||
			proposal.feedback.digest !== observation.digest ||
			proposal.review.digest !== review.digest
		)
			throw new Error("Handoff requires matching feedback, human adjudication, and generated regression")
		validateFeedbackReview(review, observation)
		const newerOrConflicting = reviews.some(
			(other) =>
				other.feedbackDigest === observation.digest &&
				other.digest !== review.digest &&
				Date.parse(other.createdAt) >= Date.parse(review.createdAt),
		)
		if (
			review.decision !== "accepted" ||
			newerOrConflicting ||
			Date.parse(snapshot.createdAt) < Date.parse(review.createdAt)
		)
			throw new Error("Handoff feedback has no current accepted human adjudication")
		const bundle = snapshot.bundles.find(({ bundleDigest }) => bundleDigest === observation.evidence.bundleDigest)
		if (!bundle || bundle.taskIdentity !== proposal.source.evidenceTaskIdentity)
			throw new Error("Handoff evidence source does not match its regression proposal")
		await validateFeedback(observation, {
			bundle,
			store: options.store,
			secrets: options.secrets,
			signal: options.signal,
		})
		const receipts = validations.filter(({ proposalDigest }) => proposalDigest === proposal.digest)
		if (receipts.length === 0) throw new Error("Handoff is missing actual regression validation results")
		for (const receipt of receipts) {
			validateControls(receipt.controls, proposal)
			validateArchivedScope(receipt.archived.specs, bundle)
			if (receipt.contextDigest !== context.digest || receipt.bundleDigest !== bundle.bundleDigest)
				throw new Error("Handoff validation has stale harness or evidence identities")
		}
		items.push(
			sealed({
				...candidate,
				source: observation.source,
				finding: observation.finding,
				expectedBehavior: observation.expectedBehavior,
				severity: observation.severity,
				humanReview: { reviewerId: review.source.reviewerId, rationale: review.rationale },
				regressionIds: [proposal.draft.id],
				validation: receipts
					.map(({ digest, status, archived }) => ({
						digest,
						status,
						archivedDecision: archived.result.decision,
						scope: "archived-output-and-offline-controls" as const,
					}))
					.sort((left, right) => (left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0)),
				freshAgentConfirmation: "required" as const,
				priorityScore: score({ ...candidate, severity: observation.severity }),
			}),
		)
	}
	const sorted = (values: string[]) => [...new Set(values)].sort()
	const usedFeedback = new Set(items.map(({ feedbackDigest }) => feedbackDigest))
	const usedProposals = new Set(items.map(({ regressionProposalDigest }) => regressionProposalDigest))
	const usedBundles = new Set(feedback.map(({ evidence }) => evidence.bundleDigest))
	if (
		feedback.some(({ digest }) => !usedFeedback.has(digest)) ||
		proposals.some(({ digest }) => !usedProposals.has(digest)) ||
		validations.some(({ proposalDigest }) => !usedProposals.has(proposalDigest)) ||
		reviews.some(({ feedbackDigest }) => !usedFeedback.has(feedbackDigest)) ||
		snapshot.bundles.some(({ bundleDigest }) => !bundleDigest || !usedBundles.has(bundleDigest))
	)
		throw new Error("Handoff cannot launder unrelated feedback or validation into its evidence graph")
	if (
		snapshot.diagnosis &&
		(snapshot.diagnosis.schemaVersion !== 1 || snapshot.diagnosis.reportKind !== "alpha-problem-solving-diagnosis")
	)
		throw new Error("Handoff supplemental diagnosis has the wrong deterministic report contract")
	await validateHarnessContext(context, options.readSource, options)
	const manifest = parseHandoff(
		sealed({
			schemaVersion: 1 as const,
			recordType: "codex-handoff" as const,
			id: snapshot.id,
			createdAt: snapshot.createdAt,
			context,
			rankingPolicy: "severity-impact-confidence-effort-v1" as const,
			evidenceBundleDigests: sorted(feedback.map(({ evidence }) => evidence.bundleDigest)),
			feedbackDigests: sorted(items.map(({ feedbackDigest }) => feedbackDigest)),
			feedbackReviewDigests: sorted(reviews.map(({ digest }) => digest)),
			regressionProposalDigests: sorted(items.map(({ regressionProposalDigest }) => regressionProposalDigest)),
			validationReceiptDigests: sorted(items.flatMap(({ validation }) => validation.map(({ digest }) => digest))),
			...(snapshot.diagnosis
				? {
						diagnosis: {
							digest: sha256(canonicalJson(snapshot.diagnosis)),
							scope: "deterministic-metadata-only" as const,
						},
					}
				: {}),
			items: items.sort(ordered),
		}),
	)
	return { manifest, markdown: renderHandoffMarkdown(manifest) }
}

/** Content identity only; building a trusted handoff also validates its source evidence graph. */
export function parseHandoff(value: unknown): HandoffManifest {
	assertBoundedJson(value, 8 * 1024 * 1024)
	const manifest = manifestSchema.parse(value)
	assertPrivateContent(manifest)
	assertSeal(manifest)
	contextSources(manifest.context)
	unique(
		manifest.items.map(({ id }) => id),
		"item identities",
	)
	for (const key of [
		"evidenceBundleDigests",
		"feedbackDigests",
		"feedbackReviewDigests",
		"regressionProposalDigests",
		"validationReceiptDigests",
	] as const)
		unique(manifest[key], key)
	for (const [index, item] of manifest.items.entries()) {
		assertSeal(item)
		validateItemScope(item, manifest.context)
		if (item.priorityScore !== score(item) || (index > 0 && ordered(manifest.items[index - 1]!, item) > 0))
			throw new Error("Handoff ranking does not match the declared deterministic policy")
		if (
			!manifest.feedbackDigests.includes(item.feedbackDigest) ||
			!manifest.feedbackReviewDigests.includes(item.reviewDigest) ||
			!manifest.regressionProposalDigests.includes(item.regressionProposalDigest) ||
			item.validation.some(({ digest }) => !manifest.validationReceiptDigests.includes(digest))
		)
			throw new Error("Handoff item has missing ancestry")
	}
	return immutable(manifest)
}

function markdown(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replace(/[\\`*_{}[\]()#+.!|]/g, "\\$&")
		.replace(/[\r\n]+/g, " ")
}
export function renderHandoffMarkdown(value: unknown): string {
	const handoff = parseHandoff(value)
	const lines = [
		"# Reviewed evidence handoff",
		"",
		`Manifest: ${handoff.digest}`,
		"",
		"Report only. No source mutation or execution is authorized by this artifact.",
		"Offline fixture controls and archived-output grading do not establish fresh agent behavior.",
		"Ranking uses severity, proposed impact, confidence, then lower effort; ties use item ID.",
		"",
	]
	if (handoff.diagnosis)
		lines.push(
			"Supplemental diagnosis contains deterministic event and outcome metadata; it does not analyze semantic output.",
			"",
		)
	for (const [index, item] of handoff.items.entries()) {
		lines.push(
			`## ${index + 1}. ${markdown(item.title)}`,
			"",
			`Observation source: ${item.source.type}; reviewer: ${markdown(item.source.reviewerId)}.`,
			`Human adjudication: ${markdown(item.humanReview.reviewerId)} — ${markdown(item.humanReview.rationale)}`,
			"",
			`Classification: ${item.classification}. Requirement: ${item.requirement.state}.`,
			`Severity: ${item.severity}; impact: ${item.impact}/5; confidence: ${item.confidence}/100; effort: ${item.effort}/5.`,
			"",
			`Finding: ${markdown(item.finding)}`,
			`Expected behavior: ${markdown(item.expectedBehavior)}`,
			"",
			`Owning code: ${item.owningPaths.map(markdown).join(", ")}`,
			`Allowed change scope: ${item.allowedChangePaths.map(markdown).join(", ")}`,
			`Regression IDs: ${item.regressionIds.map(markdown).join(", ")}`,
			`Offline control gate: ${item.validation.map(({ status, digest }) => `${status} (${digest})`).join(", ")}`,
			`Archived output decision: ${item.validation.map(({ archivedDecision }) => archivedDecision).join(", ")}`,
			"Fresh agent confirmation: required after a reviewed repair.",
			`Item digest: ${item.digest}`,
			"",
		)
	}
	return `${lines.join("\n")}\n`
}

/** Publish generated review artifacts into a new directory; never merge with an existing checkout. */
export async function materializeHandoff(
	value: unknown,
	options: {
		ownedRoot: string
		destinationName: string
		signal?: AbortSignal
	},
): Promise<{ root: string; manifestPath: string; markdownPath: string; digest: string }> {
	const manifest = parseHandoff(value)
	const markdown = renderHandoffMarkdown(manifest)
	options.signal?.throwIfAborted()
	const root = await newReconstructionRoot(options.ownedRoot, options.destinationName)
	const manifestPath = path.join(root, "manifest.json")
	const markdownPath = path.join(root, "codex_handoff.md")
	await fs.writeFile(manifestPath, `${canonicalJson(manifest)}\n`, { flag: "wx", mode: 0o600 })
	options.signal?.throwIfAborted()
	await fs.writeFile(markdownPath, markdown, { flag: "wx", mode: 0o600 })
	options.signal?.throwIfAborted()
	return { root, manifestPath, markdownPath, digest: manifest.digest }
}

const reviewedRepairSchema = z
	.object({
		schemaVersion: z.literal(1),
		recordType: z.literal("reviewed-handoff-repair"),
		handoffDigest: digest,
		itemDigest: digest,
		contextDigest: digest,
		source: feedbackReviewSchema.shape.source,
		decision: z.literal("accepted"),
		scenarioId: id,
		regressionScenarioId: id,
		neighborScenarioIds: z.array(id).min(1).max(20),
		patch: z
			.object({
				id,
				edits: z
					.array(
						z
							.object({
								path: relativePath,
								expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
								replacement: z.string().refine((value) => Buffer.byteLength(value) <= 262_144),
							})
							.strict(),
					)
					.min(1)
					.max(10),
			})
			.strict(),
		digest,
	})
	.strict()
export type ReviewedHandoffRepairRecord = z.infer<typeof reviewedRepairSchema>

/** The host authenticates the human operator; this seal supplies content identity, not authentication. */
export function sealReviewedHandoffRepair(input: unknown): ReviewedHandoffRepairRecord {
	assertBoundedJson(input, 4 * 1024 * 1024)
	return parseReviewedHandoffRepairRecord(sealed(reviewedRepairSchema.omit({ digest: true }).parse(input)))
}

export function parseReviewedHandoffRepairRecord(value: unknown): ReviewedHandoffRepairRecord {
	assertBoundedJson(value, 4 * 1024 * 1024)
	const review = reviewedRepairSchema.parse(value)
	assertSeal(review)
	assertPrivateContent(review)
	unique(
		review.patch.edits.map(({ path }) => path.toLowerCase()),
		"patch paths",
	)
	unique(review.neighborScenarioIds, "neighbor scenarios")
	return immutable(review)
}

/** Adapt reviewed data to the existing campaign repair contract. Never applies a patch. */
export async function parseReviewedHandoffRepair(
	value: unknown,
	options: {
		manifest: unknown
		currentContext: unknown
		readSource: HandoffSourceReader
		signal?: AbortSignal
	},
): Promise<CampaignRepair> {
	const review = parseReviewedHandoffRepairRecord(value)
	const manifest = parseHandoff(options.manifest)
	const context = await validateHarnessContext(options.currentContext, options.readSource, options)
	const item = manifest.items.find(({ digest }) => digest === review.itemDigest)
	if (
		review.handoffDigest !== manifest.digest ||
		review.contextDigest !== context.digest ||
		context.digest !== manifest.context.digest ||
		!item
	)
		throw new Error("Reviewed repair does not match the current handoff item")
	if (
		!item.regressionIds.includes(review.regressionScenarioId) ||
		item.validation.some(({ status }) => status !== "passed")
	)
		throw new Error("Reviewed repair requires its bound regression and successful offline validation")
	const sources = contextSources(context)
	for (const edit of review.patch.edits)
		if (!item.allowedChangePaths.includes(edit.path) || sources.get(edit.path) !== `sha256:${edit.expectedSha256}`)
			throw new Error("Reviewed patch exceeds its allowed scope or has a stale source hash")
	return {
		scenarioId: review.scenarioId,
		regressionScenarioId: review.regressionScenarioId,
		neighborScenarioIds: review.neighborScenarioIds,
		diagnosisId: item.id,
		patch: review.patch,
	}
}
