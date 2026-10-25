import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { stringify } from "yaml"
import { z } from "zod"

import { benchmarkTaskManifestSchema, type BenchmarkTaskManifest } from "../benchmark/contracts"
import { createTaskTemplate } from "../benchmark/templates"
import { canonicalFixtureBytes, fixtureTreeDigest } from "../benchmark/fixtureDigest.mjs"
import { canonicalJson, sha256 } from "../evidence/canonical"
import { manifestIdentity, taskManifestSchema, type TaskManifest } from "../evidence/manifests"
import { validateGraderRun } from "../grading/aggregate"
import { evidenceFromText } from "../grading/evidence"
import { captureExpectedNodeTestCommands } from "../grading/nodeTestCompletion"
import { createDefaultGraderRegistry } from "../grading/registry"
import type { GraderRunResult } from "../grading/types"
import type { HarnessProcessRunner } from "../orchestration/ports"
import { systemClock } from "../orchestration/systemPorts"
import { feedbackSchema, feedbackReviewSchema, improvementDigestSchema } from "./contracts"
import {
	assertBoundedJson,
	assertSafeImprovementContent,
	FEEDBACK_EVIDENCE_LIMITS,
	parseFeedback,
	validateFeedback,
	validateFeedbackReview,
	type FeedbackEvidenceContext,
} from "./feedback"

const slug = z
	.string()
	.max(80)
	.regex(/^[a-z][a-z0-9-]*$/)
const text = z.string().min(1).max(16_000)
const fileSchema = z.object({ path: z.string().min(1).max(180), content: z.string().max(65_536) }).strict()
const filesSchema = z.array(fileSchema).min(1).max(32)
const commandSchema = z
	.object({ command: z.enum(["node", "python"]), args: z.array(z.string().max(180)).min(1).max(12) })
	.strict()

export const regressionDraftSchema = z
	.object({
		id: slug,
		prompt: text,
		expectedBehavior: text,
		files: filesSchema,
		verifier: z
			.object({
				files: filesSchema,
				commands: z.array(commandSchema).min(1).max(4),
				failureMarker: z.string().min(1).max(200),
			})
			.strict(),
		controls: z
			.object({
				reference: filesSchema,
				alternative: filesSchema,
				incorrect: z
					.array(z.object({ id: slug, files: filesSchema }).strict())
					.min(3)
					.max(8),
			})
			.strict(),
	})
	.strict()
export type RegressionDraft = z.infer<typeof regressionDraftSchema>

const jsonObject = (properties: Record<string, unknown>) => ({
	type: "object",
	properties,
	required: Object.keys(properties),
	additionalProperties: false,
})
const jsonSlug = { type: "string", minLength: 1, maxLength: 80, pattern: "^[a-z][a-z0-9-]*$" }
const jsonText = { type: "string", minLength: 1, maxLength: 16_000 }
const jsonFile = jsonObject({
	path: { type: "string", minLength: 1, maxLength: 180 },
	content: { type: "string", maxLength: 65_536 },
})
const jsonFiles = { type: "array", minItems: 1, maxItems: 32, items: jsonFile }
/** Strict request shape; runtime schema and policy remain the authority for all bounds and paths. */
export const regressionDraftJsonSchema = jsonObject({
	id: jsonSlug,
	prompt: jsonText,
	expectedBehavior: jsonText,
	files: jsonFiles,
	verifier: jsonObject({
		files: jsonFiles,
		commands: {
			type: "array",
			minItems: 1,
			maxItems: 4,
			items: jsonObject({
				command: { type: "string", enum: ["node", "python"] },
				args: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", maxLength: 180 } },
			}),
		},
		failureMarker: { type: "string", minLength: 1, maxLength: 200 },
	}),
	controls: jsonObject({
		reference: jsonFiles,
		alternative: jsonFiles,
		incorrect: { type: "array", minItems: 3, maxItems: 8, items: jsonObject({ id: jsonSlug, files: jsonFiles }) },
	}),
})

export const regressionHostPolicySchema = z
	.object({
		schemaVersion: z.literal(1),
		allowedSourceTaskIdentities: z.array(z.string().min(1)).min(1).max(256),
		allowedCommands: z.array(commandSchema).min(1).max(16),
		maxFiles: z.number().int().min(1).max(32),
		maxBytes: z.number().int().min(1).max(262_144),
		network: z.literal("disabled"),
	})
	.strict()
export type RegressionHostPolicy = z.infer<typeof regressionHostPolicySchema>

const proposalSchema = z
	.object({
		schemaVersion: z.literal(1),
		recordType: z.literal("regression-proposal"),
		draft: regressionDraftSchema,
		feedback: feedbackSchema,
		review: feedbackReviewSchema,
		source: z
			.object({
				taskIdentity: z.string().min(1),
				evidenceTaskIdentity: z.string().min(1),
				partition: z.enum(["smoke", "development", "regression"]),
				taskDigest: improvementDigestSchema,
				fixtureDigest: improvementDigestSchema,
				bundleDigest: improvementDigestSchema,
			})
			.strict(),
		policy: regressionHostPolicySchema,
		policyDigest: improvementDigestSchema,
		digest: improvementDigestSchema,
	})
	.strict()
export type RegressionProposal = z.infer<typeof proposalSchema>

export function parseRegressionProposal(value: unknown): RegressionProposal {
	const proposal = proposalSchema.parse(value)
	assertSeal(proposal)
	assertSafeImprovementContent(proposal)
	const feedback = parseFeedback(proposal.feedback)
	if (validateFeedbackReview(proposal.review, feedback).decision !== "accepted")
		throw new Error("Regression requires accepted human review")
	if (
		proposal.policyDigest !== sha256(canonicalJson(proposal.policy)) ||
		proposal.source.bundleDigest !== feedback.evidence.bundleDigest
	)
		throw new Error("Regression ancestry or policy mismatch")
	if (proposal.draft.expectedBehavior !== feedback.expectedBehavior)
		throw new Error("Regression expected behavior differs from reviewed feedback")
	validateDraft(proposal.draft, proposal.policy)
	assertPublicSource(proposal.source.taskIdentity, proposal.policy)
	return freeze(proposal)
}

/** The host resolves sourceTask from its trusted catalog; a model cannot provide its own source partition or policy. */
export async function createRegressionProposal(input: {
	draft: unknown
	feedback: unknown
	review: unknown
	sourceTask: BenchmarkTaskManifest
	sourceRuntimeManifest?: TaskManifest
	evidence: FeedbackEvidenceContext
	policy: RegressionHostPolicy
}): Promise<RegressionProposal> {
	const sourceTask = benchmarkTaskManifestSchema.parse(input.sourceTask)
	const policy = regressionHostPolicySchema.parse(input.policy)
	const identity = `${sourceTask.id}@${sourceTask.version}`
	assertPublicSource(identity, policy)
	if (sourceTask.partition === "holdout" || !sourceTask.fixtureDigest)
		throw new Error("Holdout or unsealed source cannot generate public regressions")
	const draft = regressionDraftSchema.parse(input.draft)
	assertSafeImprovementContent(draft, input.evidence.secrets)
	assertBoundedJson(input.evidence.bundle, FEEDBACK_EVIDENCE_LIMITS.metadataBytes)
	const bundle = structuredClone(input.evidence.bundle)
	if (input.sourceRuntimeManifest) {
		const runtime = taskManifestSchema.parse(input.sourceRuntimeManifest)
		if (
			runtime.id !== sourceTask.id ||
			runtime.version !== sourceTask.version ||
			runtime.fixtureDigest !== sourceTask.fixtureDigest ||
			manifestIdentity(runtime) !== bundle.taskIdentity
		)
			throw new Error("Regression runtime task does not match trusted source")
	} else if (bundle.taskIdentity !== identity)
		throw new Error("Regression evidence task does not match trusted source")
	const feedback = await validateFeedback(input.feedback, { ...input.evidence, bundle })
	const review = validateFeedbackReview(input.review, feedback)
	const content = {
		schemaVersion: 1 as const,
		recordType: "regression-proposal" as const,
		draft,
		feedback,
		review,
		source: {
			taskIdentity: identity,
			evidenceTaskIdentity: bundle.taskIdentity,
			partition: sourceTask.partition,
			taskDigest: sha256(canonicalJson(sourceTask)),
			fixtureDigest: sourceTask.fixtureDigest,
			bundleDigest: feedback.evidence.bundleDigest,
		},
		policy,
		policyDigest: sha256(canonicalJson(policy)),
	}
	assertSafeImprovementContent(content, input.evidence.secrets)
	return parseRegressionProposal({ ...content, digest: sha256(canonicalJson(content)) })
}

export type MaterializedRegression = {
	root: string
	fixtureRoot: string
	taskManifestPath: string
	provenancePath: string
	task: BenchmarkTaskManifest
	proposal: RegressionProposal
}

export async function materializeRegressionProposal(input: {
	proposal: unknown
	selectedProposalDigest: string
	ownedRoot: string
	destinationName: string
	policy: RegressionHostPolicy
	evidence: FeedbackEvidenceContext
}): Promise<MaterializedRegression> {
	const proposal = parseRegressionProposal(input.proposal)
	assertSafeImprovementContent(proposal, input.evidence.secrets)
	assertPolicy(proposal, input.policy)
	if (input.selectedProposalDigest !== proposal.digest)
		throw new Error("Explicit regression proposal selection required")
	if (input.evidence.bundle.taskIdentity !== proposal.source.evidenceTaskIdentity)
		throw new Error("Regression evidence task changed")
	await validateFeedback(proposal.feedback, input.evidence)
	const ownedRoot = path.resolve(input.ownedRoot)
	if (!path.isAbsolute(input.ownedRoot)) throw new Error("Regression owned root must be absolute")
	await assertDirectory(ownedRoot)
	const name = slug.parse(input.destinationName)
	const root = path.join(ownedRoot, name)
	// Exclusive ownership, no overwrite and no user-provided symlink entry can be adopted.
	await fs.mkdir(root, { mode: 0o700 })
	const fixtureRoot = path.join(root, "fixture")
	await fs.mkdir(fixtureRoot)
	for (const file of regressionFixtureFiles(proposal.draft)) await writeOwnedFile(fixtureRoot, file)
	const base = createTaskTemplate({ id: proposal.draft.id, profile: "compact", partition: "regression" })
	const fixtureDigest = await verifiedFixtureDigest(fixtureRoot, proposal.draft)
	const validation = { commands: proposal.draft.verifier.commands, network: "disabled" as const }
	const roots = [...new Set(proposal.draft.files.map(({ path: file }) => file.split("/")[0]!))]
	const positiveEditCounts = [proposal.draft.controls.reference, proposal.draft.controls.alternative].map(
		(patch) =>
			patch.filter(
				(file) => file.content !== proposal.draft.files.find((source) => source.path === file.path)?.content,
			).length,
	)
	const minFiles = Math.max(1, Math.min(...positiveEditCounts))
	const maxFiles = Math.max(1, ...positiveEditCounts)
	const task = benchmarkTaskManifestSchema.parse({
		...base,
		fixture: `${name}/fixture`,
		fixtureDigest,
		promptDigest: sha256(canonicalFixtureBytes(Buffer.from(fixturePrompt(proposal.draft)))),
		repository: {
			upstream: "local-snapshot:feedback-regression",
			commit: proposal.digest,
			snapshotDigest: fixtureDigest,
		},
		family: "feedback-regression",
		capabilities: ["regression-repair", "validation"],
		validation,
		environmentDigest: sha256(canonicalJson(validation)),
		editTopology: {
			kind: minFiles > 1 ? "multi-file" : "single-file",
			minFiles,
			maxFiles,
			allowedRoots: roots,
		},
		improvement: {
			schemaVersion: 1,
			proposalDigest: proposal.digest,
			feedbackDigest: proposal.feedback.digest,
			reviewDigest: proposal.review.digest,
			sourceBundleDigest: proposal.source.bundleDigest,
			sourceTaskIdentity: proposal.source.taskIdentity,
			policyDigest: proposal.policyDigest,
		},
	})
	const taskManifestPath = path.join(root, "task.template.yaml")
	const provenancePath = path.join(root, "proposal.json")
	await writeOwnedFile(root, { path: "task.template.yaml", content: stringify(task, { lineWidth: 120 }) })
	await writeOwnedFile(root, { path: "proposal.json", content: JSON.stringify(proposal, null, 2) + "\n" })
	await fs.mkdir(path.join(root, "controls"))
	for (const control of controlVariants(proposal.draft))
		await writeOwnedFile(root, {
			path: `controls/${control.id}.json`,
			content: JSON.stringify(control, null, 2) + "\n",
		})
	return { root, fixtureRoot, taskManifestPath, provenancePath, task, proposal }
}

const controlResultSchema = z
	.object({
		id: z.string().min(1),
		kind: z.enum(["untouched", "reference", "alternative", "incorrect"]),
		status: z.enum(["passed", "failed", "error"]),
		expectedPassed: z.boolean(),
		matchedExpectedFailure: z.boolean(),
		outputEvidence: z
			.array(
				z
					.object({
						id: z.string().min(1).max(128),
						kind: z.enum(["stdout", "stderr"]),
						content: z.string().max(65_536),
					})
					.strict(),
			)
			.max(8),
		graderResultDigest: improvementDigestSchema,
		result: z.unknown().transform(validateGraderRun),
	})
	.strict()
const controlReceiptSchema = z
	.object({
		schemaVersion: z.literal(1),
		recordType: z.literal("regression-control-receipt"),
		proposalDigest: improvementDigestSchema,
		policyDigest: improvementDigestSchema,
		fixtureDigest: improvementDigestSchema,
		failureMarker: z.string().min(1).max(200),
		evidenceKind: z.literal("offline-fixture-control"),
		status: z.enum(["passed", "failed", "inconclusive"]),
		controls: z.array(controlResultSchema).max(11),
		admission: z.literal("draft"),
		digest: improvementDigestSchema,
	})
	.strict()
export type RegressionControlReceipt = z.infer<typeof controlReceiptSchema>

export function parseRegressionControlReceipt(value: unknown): RegressionControlReceipt {
	const receipt = controlReceiptSchema.parse(value)
	assertSeal(receipt)
	if (new Set(receipt.controls.map(({ id }) => id)).size !== receipt.controls.length)
		throw new Error("Duplicate regression controls")
	for (const control of receipt.controls) {
		if (
			sha256(canonicalJson(control.result)) !== control.graderResultDigest ||
			graderStatus(control.result) !== control.status
		)
			throw new Error("Regression control grader evidence mismatch")
		if (control.expectedPassed !== ["reference", "alternative"].includes(control.kind))
			throw new Error("Regression control expected outcome mismatch")
		const evidence = control.result.results.flatMap((result) => result.evidence)
		if (
			control.outputEvidence.length !== evidence.length ||
			new Set(control.outputEvidence.map(({ id }) => id)).size !== evidence.length ||
			control.outputEvidence.reduce((sum, { content }) => sum + Buffer.byteLength(content), 0) > 65_536
		)
			throw new Error("Regression control output evidence exceeds bounds")
		for (const output of control.outputEvidence) {
			const item = evidence.find(({ id, kind }) => id === output.id && kind === output.kind)
			if (
				!item ||
				item.digest !== sha256(output.content) ||
				item.byteLength !== Buffer.byteLength(output.content)
			)
				throw new Error("Regression control output differs from grader evidence")
		}
		if (
			control.matchedExpectedFailure !==
			matchesExpectedFailure(control.result, control.outputEvidence, receipt.failureMarker)
		)
			throw new Error("Regression failure reason contradicts grader output")
	}
	if (receipt.status !== controlStatus(receipt.controls))
		throw new Error("Regression control status contradicts evidence")
	return freeze(receipt)
}

/** Explicit host approval permits these captured commands only; this never invokes a model or admits a task. */
export async function verifyRegressionControls(input: {
	materialized: MaterializedRegression
	policy: RegressionHostPolicy
	executionApproval: { proposalDigest: string; policyDigest: string }
	executionBoundary?: { processRunner: HarnessProcessRunner; policyDigest: string; network: "disabled" }
	signal?: AbortSignal
}): Promise<RegressionControlReceipt> {
	input.signal?.throwIfAborted()
	const { proposal, fixtureRoot, root } = input.materialized
	parseRegressionProposal(proposal)
	assertPolicy(proposal, input.policy)
	if (
		input.executionApproval.proposalDigest !== proposal.digest ||
		input.executionApproval.policyDigest !== proposal.policyDigest
	)
		throw new Error("Regression command execution requires matching host approval")
	await assertDirectory(root)
	await assertDirectory(fixtureRoot)
	const fixtureDigest = await verifiedFixtureDigest(fixtureRoot, proposal.draft)
	input.signal?.throwIfAborted()
	if (fixtureDigest !== input.materialized.task.fixtureDigest)
		throw new Error("Materialized regression fixture changed")
	if (!input.executionBoundary) return sealControls(proposal, fixtureDigest, [])
	if (
		input.executionBoundary.network !== "disabled" ||
		input.executionBoundary.policyDigest !== proposal.policyDigest
	)
		throw new Error("Regression execution boundary does not enforce captured policy")
	const runRoot = path.join(path.resolve(root), `verification-${randomUUID()}`)
	if (path.dirname(runRoot) !== path.resolve(root)) throw new Error("Regression cleanup escaped owned root")
	await fs.mkdir(runRoot, { mode: 0o700 })
	const controls: RegressionControlReceipt["controls"] = []
	const processRunner: HarnessProcessRunner = {
		run: async (spec) => {
			input.signal?.throwIfAborted()
			const signal =
				input.signal && spec.signal
					? AbortSignal.any([input.signal, spec.signal])
					: (input.signal ?? spec.signal)
			const result = await input.executionBoundary!.processRunner.run({ ...spec, signal })
			input.signal?.throwIfAborted()
			return result
		},
	}
	try {
		for (const control of controlVariants(proposal.draft)) {
			input.signal?.throwIfAborted()
			const workspace = path.join(runRoot, control.id)
			await fs.mkdir(workspace)
			// Reconstruct reviewed bytes instead of copying a mutable tree or following replaced control paths.
			const patched = {
				...proposal.draft,
				files: proposal.draft.files.map(
					(file) => control.files.find((patch) => patch.path === file.path) ?? file,
				),
			}
			for (const file of regressionFixtureFiles(patched)) {
				input.signal?.throwIfAborted()
				await writeOwnedFile(workspace, file)
			}
			await verifiedFixtureDigest(workspace, patched)
			input.signal?.throwIfAborted()
			const outputEvidence: RegressionControlReceipt["controls"][number]["outputEvidence"] = []
			const commands = await captureExpectedNodeTestCommands(workspace, proposal.draft.verifier.commands)
			input.signal?.throwIfAborted()
			const result = await createDefaultGraderRegistry().execute(
				[
					{
						id: "feedback-regression",
						version: 1,
						type: "command",
						hardGate: true,
						failureClass: "outcome",
						commands,
						cwd: "workspace",
						timeoutMs: 15_000,
						maxOutputBytes: 65_536,
					},
				],
				{
					workspaceRoot: workspace,
					changedPaths: control.files.map(({ path: file }) => file),
					trace: [],
					processRunner,
					clock: systemClock,
					evidenceSink: async (id, kind, value) => {
						if (kind !== "stdout" && kind !== "stderr") throw new Error("Unexpected regression output kind")
						if (
							outputEvidence.reduce(
								(sum, { content }) => sum + Buffer.byteLength(content),
								Buffer.byteLength(value),
							) > 65_536
						)
							throw new Error("Regression output exceeds receipt byte bound")
						outputEvidence.push({ id, kind, content: value })
						return evidenceFromText(id, kind, value)
					},
				},
			)
			input.signal?.throwIfAborted()
			const boundEvidence = outputEvidence.filter((output) =>
				result.results.some((grader) =>
					grader.evidence.some(({ id, kind }) => id === output.id && kind === output.kind),
				),
			)
			const matchedExpectedFailure = matchesExpectedFailure(
				result,
				boundEvidence,
				proposal.draft.verifier.failureMarker,
			)
			controls.push({
				id: control.id,
				kind: control.kind,
				expectedPassed: control.expectedPassed,
				status: graderStatus(result),
				matchedExpectedFailure,
				outputEvidence: boundEvidence,
				graderResultDigest: sha256(canonicalJson(result)),
				result,
			})
		}
		return sealControls(proposal, fixtureDigest, controls)
	} finally {
		// This UUID child was exclusively created here; cleanup never adopts a supplied path.
		await assertDirectory(root)
		await fs.rm(runRoot, { recursive: true, force: true })
	}
}

function validateDraft(draft: RegressionDraft, policy: RegressionHostPolicy): void {
	const files = regressionFixtureFiles(draft)
	checkFiles(files, policy)
	for (const file of draft.files)
		if (/^(?:tests?|controls)\//.test(file.path) || file.path === "prompt.md")
			throw new Error("Source files cannot replace verifier or prompt")
	for (const file of draft.verifier.files)
		if (!/^tests?\//.test(file.path)) throw new Error("Verifier files require a test directory")
	const sourcePaths = new Set(draft.files.map(({ path: file }) => file))
	const variants = controlVariants(draft).filter(({ kind }) => kind !== "untouched")
	const identities = new Set<string>()
	const patches = new Set([regressionFixtureDigest(draft)])
	for (const variant of variants) {
		if (["untouched", "reference", "alternative"].includes(variant.id) && variant.kind === "incorrect")
			throw new Error("Reserved control identity")
		if (identities.has(variant.id)) throw new Error("Duplicate control identity")
		identities.add(variant.id)
		checkFiles(variant.files, policy)
		if (variant.files.some(({ path: file }) => !sourcePaths.has(file)))
			throw new Error("Controls may only patch original source files")
		const patched = {
			...draft,
			files: draft.files.map((file) => variant.files.find((patch) => patch.path === file.path) ?? file),
		}
		checkFiles(regressionFixtureFiles(patched), policy)
		const digest = regressionFixtureDigest(patched)
		if (patches.has(digest)) throw new Error("Correct alternatives and incorrect controls must be distinct")
		patches.add(digest)
	}
	for (const command of draft.verifier.commands) {
		if (!policy.allowedCommands.some((allowed) => canonicalJson(allowed) === canonicalJson(command)))
			throw new Error("Verification command exceeds captured host policy")
		if (command.command === "node") {
			if (command.args[0] !== "--test" || command.args.length < 2)
				throw new Error("Only explicit Node test commands are allowed")
			for (const file of command.args.slice(1))
				if (
					!draft.verifier.files.some((entry) => entry.path === file) ||
					!/^tests?\/.+\.test\.(?:mjs|cjs|js)$/.test(file)
				)
					throw new Error("Node test command must select declared verifier files")
		} else if (
			canonicalJson(command.args) !== canonicalJson(["-B", "-m", "unittest", "discover", "-s", "test", "-v"])
		)
			throw new Error("Only bounded Python unittest discovery is allowed")
	}
}

function checkFiles(files: Array<{ path: string; content: string }>, policy: RegressionHostPolicy): void {
	if (
		files.length > policy.maxFiles ||
		files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > policy.maxBytes
	)
		throw new Error("Regression exceeds file or byte bounds")
	const seen = new Set<string>()
	for (const file of files) {
		if (
			!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(file.path) ||
			file.path.split("/").length > 12 ||
			file.path
				.split("/")
				.some(
					(segment) =>
						!segment ||
						segment.endsWith(".") ||
						/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
				)
		)
			throw new Error("Regression file path is not portable and contained")
		if (
			/(?:^|\/)(?:agents(?:\.override)?\.md|\.alphaignore|\.git|\.vscode|\.codex|\.agents|holdout(?:[-/]|$))/i.test(
				file.path,
			)
		)
			throw new Error("Regression cannot override host policy or expose holdout files")
		const key = file.path.toLowerCase()
		if (seen.has(key) || [...seen].some((other) => other.startsWith(`${key}/`) || key.startsWith(`${other}/`)))
			throw new Error("Duplicate or overlapping regression file paths")
		seen.add(key)
	}
}

function controlVariants(draft: RegressionDraft) {
	return [
		{ id: "untouched", kind: "untouched" as const, expectedPassed: false, files: [] },
		{ id: "reference", kind: "reference" as const, expectedPassed: true, files: draft.controls.reference },
		{ id: "alternative", kind: "alternative" as const, expectedPassed: true, files: draft.controls.alternative },
		...draft.controls.incorrect.map((control) => ({
			...control,
			kind: "incorrect" as const,
			expectedPassed: false,
		})),
	]
}

function assertPublicSource(identity: string, policy: RegressionHostPolicy): void {
	if (/^holdout(?:[-/@]|$)/i.test(identity) || !policy.allowedSourceTaskIdentities.includes(identity))
		throw new Error("Source task is holdout or outside captured public scope")
}
function assertPolicy(proposal: RegressionProposal, policy: RegressionHostPolicy): void {
	if (sha256(canonicalJson(regressionHostPolicySchema.parse(policy))) !== proposal.policyDigest)
		throw new Error("Captured regression host policy changed")
}
function assertSeal(record: { digest: string }): void {
	const { digest, ...content } = record
	if (digest !== sha256(canonicalJson(content))) throw new Error("Regression record digest mismatch")
}
function graderStatus(result: GraderRunResult): "passed" | "failed" | "error" {
	return result.decision === "passed" ? "passed" : result.decision === "grader_error" ? "error" : "failed"
}
const failedAssertionReceiptSchema = z.object({
	schemaVersion: z.literal(1),
	kind: z.literal("alpha-expected-node-tests"),
	complete: z.literal(true),
	failed: z.literal(true),
	timedOut: z.literal(false),
	tests: z
		.array(
			z.object({
				file: z.string(),
				name: z.string(),
				passed: z.boolean(),
				skipped: z.boolean(),
				todo: z.boolean(),
			}),
		)
		.max(1056),
	assertionFailures: z
		.array(
			z.object({
				file: z.string(),
				name: z.string(),
				code: z.literal("ERR_ASSERTION"),
				message: z.string().max(16_384),
			}),
		)
		.max(256),
})
function matchesExpectedFailure(
	result: GraderRunResult,
	outputs: RegressionControlReceipt["controls"][number]["outputEvidence"],
	marker: string,
): boolean {
	if (graderStatus(result) !== "failed") return false
	// Child stdout/stderr can print arbitrary markers. Only the existing Node supervisor's
	// structured assertion channel can prove that the intended original assertion failed.
	return outputs.some(({ kind, content }) => {
		if (kind !== "stdout") return false
		let value: unknown
		try {
			value = JSON.parse(content)
		} catch {
			return false
		}
		const receipt = failedAssertionReceiptSchema.safeParse(value)
		return (
			receipt.success &&
			receipt.data.assertionFailures.some(
				(failure) =>
					failure.message.includes(marker) &&
					receipt.data.tests.some(
						(test) =>
							test.file === failure.file &&
							test.name === failure.name &&
							!test.passed &&
							!test.skipped &&
							!test.todo,
					),
			)
		)
	})
}
function controlStatus(
	controls: Array<{ kind: string; status: string; expectedPassed: boolean; matchedExpectedFailure: boolean }>,
): "passed" | "failed" | "inconclusive" {
	if (
		["untouched", "reference", "alternative"].some(
			(kind) => controls.filter((control) => control.kind === kind).length !== 1,
		) ||
		controls.filter(({ kind }) => kind === "incorrect").length < 3
	)
		return "inconclusive"
	if (controls.some(({ status }) => status === "error")) return "inconclusive"
	return controls.every((control) =>
		control.expectedPassed
			? control.status === "passed"
			: control.status === "failed" && control.matchedExpectedFailure,
	)
		? "passed"
		: "failed"
}
function sealControls(
	proposal: RegressionProposal,
	fixtureDigest: string,
	controls: RegressionControlReceipt["controls"],
): RegressionControlReceipt {
	const content = {
		schemaVersion: 1 as const,
		recordType: "regression-control-receipt" as const,
		proposalDigest: proposal.digest,
		policyDigest: proposal.policyDigest,
		fixtureDigest,
		failureMarker: proposal.draft.verifier.failureMarker,
		evidenceKind: "offline-fixture-control" as const,
		status: controlStatus(controls),
		controls,
		admission: "draft" as const,
	}
	return parseRegressionControlReceipt({ ...content, digest: sha256(canonicalJson(content)) })
}
async function verifiedFixtureDigest(root: string, draft: RegressionDraft): Promise<string> {
	const expected = regressionFixtureFiles(draft)
	const files: Array<{ path: string; bytes: Buffer }> = []
	const directories = new Set(
		expected.flatMap(({ path: file }) =>
			file
				.split("/")
				.slice(0, -1)
				.map((_, index) =>
					file
						.split("/")
						.slice(0, index + 1)
						.join("/"),
				),
		),
	)
	async function visit(directory: string): Promise<void> {
		for await (const entry of await fs.opendir(directory)) {
			const target = path.join(directory, entry.name)
			const relative = path.relative(root, target).replaceAll("\\", "/")
			if (entry.isSymbolicLink()) throw new Error("Regression fixture cannot contain symbolic links")
			if (entry.isDirectory()) {
				if (!directories.has(relative)) throw new Error("Regression fixture contains an unapproved directory")
				await visit(target)
			} else if (entry.isFile()) {
				const approved = expected.find(({ path: file }) => file === relative)
				if (!approved) throw new Error("Regression fixture contains an unapproved file")
				await assertDirectory(path.dirname(target))
				const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
				try {
					const before = await handle.stat()
					const size = Buffer.byteLength(approved.content)
					if (!before.isFile() || before.size !== size)
						throw new Error("Regression file size differs from approved proposal")
					const buffer = Buffer.alloc(size + 1)
					let bytesRead = 0
					while (bytesRead < buffer.length) {
						const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
						if (!chunk.bytesRead) break
						bytesRead += chunk.bytesRead
					}
					const after = await handle.stat()
					if (
						bytesRead !== size ||
						after.size !== size ||
						after.mtimeMs !== before.mtimeMs ||
						after.ctimeMs !== before.ctimeMs ||
						(await fs.lstat(target)).isSymbolicLink()
					)
						throw new Error("Regression file changed while reading")
					files.push({ path: relative, bytes: buffer.subarray(0, size) })
				} finally {
					await handle.close()
				}
			} else throw new Error("Regression fixture contains a nonregular file")
		}
	}
	await visit(root)
	const actual = fixtureTreeDigest(files)
	if (
		actual !==
		fixtureTreeDigest(expected.map(({ path: file, content }) => ({ path: file, bytes: Buffer.from(content) })))
	)
		throw new Error("Regression fixture differs from approved proposal")
	return actual
}
function fixturePrompt(draft: RegressionDraft): string {
	return `${draft.prompt}\n\nExpected behavior:\n${draft.expectedBehavior}\n`
}
export function regressionFixtureFiles(draft: RegressionDraft): Array<{ path: string; content: string }> {
	return [...draft.files, ...draft.verifier.files, { path: "prompt.md", content: fixturePrompt(draft) }]
}
export function regressionFixtureDigest(draft: RegressionDraft): string {
	return fixtureTreeDigest(
		regressionFixtureFiles(draft).map(({ path: file, content }) => ({ path: file, bytes: Buffer.from(content) })),
	)
}
async function assertDirectory(directory: string): Promise<void> {
	const absolute = path.resolve(directory)
	let current = path.parse(absolute).root
	for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment)
		const stat = await fs.lstat(current)
		if (stat.isSymbolicLink() || !stat.isDirectory())
			throw new Error("Regression destination cannot traverse symbolic links")
	}
	if ((await fs.realpath(absolute)) !== absolute) throw new Error("Regression destination changed its real path")
}
async function writeOwnedFile(root: string, file: { path: string; content: string }): Promise<void> {
	const target = path.join(root, file.path)
	await fs.mkdir(path.dirname(target), { recursive: true })
	await assertDirectory(path.dirname(target))
	await fs.writeFile(target, file.content, { flag: "wx" })
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child)
		Object.freeze(value)
	}
	return value
}
