import { afterEach, describe, expect, it, vi } from "vitest"

import type { ContentAddressedArtifactStore } from "../../evidence/artifactStore"
import { canonicalJson, sha256 } from "../../evidence/canonical"
import { collectRequiredEvidence, type RequiredEvidence } from "../../evidence/collector"
import { EventJournal } from "../../evidence/eventJournal"
import { evidenceBundleDigest } from "../../evidence/integrity"
import { manifestIdentity } from "../../evidence/manifests"
import { REQUIRED_ARTIFACT_KINDS, type EvidenceBundle } from "../../evidence/types"
import { parseFeedbackReview } from "../feedback"
import { runModelReview, type ModelReviewConfiguration, type ModelReviewInput } from "../modelReview"
import * as regressions from "../regressions"

const apiKey = "configured-only-credential-value"
const configuration: ModelReviewConfiguration = {
	endpoint: "https://review.example.test/v1/responses",
	model: "review-model-pinned",
	apiKeyEnv: "REVIEW_API_KEY",
	timeoutMs: 5_000,
	maxRequestBytes: 131_072,
	maxResponseBytes: 131_072,
	maxOutputTokens: 2_048,
}

async function fixture() {
	const bytes = new Map<string, Uint8Array>()
	const store: ContentAddressedArtifactStore = {
		put: async (input) => {
			const digest = sha256(input.bytes)
			bytes.set(digest, input.bytes)
			return {
				schemaVersion: 1,
				id: digest,
				attemptId: input.attemptId,
				kind: input.kind,
				digest,
				mediaType: input.mediaType,
				sizeBytes: input.bytes.length,
				access: input.access ?? "reviewer",
				retention: "campaign",
				uploadState: "complete",
				captureStatus: input.bytes.length ? "captured" : "captured-empty",
				createdAt: "2026-10-23T12:00:00.000Z",
			}
		},
		get: vi.fn(async (descriptor) => bytes.get(descriptor.digest)),
	}
	const values = Object.fromEntries(
		REQUIRED_ARTIFACT_KINDS.map((kind) => [kind, `${kind}: retained failed verification`]),
	) as RequiredEvidence
	values.test_output = `expected origin 4000, observed 3000; ${apiKey}`
	const journal = new EventJournal({ runId: "review-run", trialId: "review-trial", attemptId: "review-attempt" })
	journal.append("verification", { status: "failed", password: "not-for-model" })
	const bundle: EvidenceBundle = {
		schemaVersion: 1,
		runId: "review-run",
		trialId: "review-trial",
		attemptId: "review-attempt",
		taskIdentity: "review-task@1",
		variantIdentity: sha256("build"),
		identityStatus: "attempt-bound",
		events: journal.all(),
		artifacts: await collectRequiredEvidence("review-attempt", values, store),
	}
	bundle.bundleDigest = evidenceBundleDigest(bundle)
	const input: ModelReviewInput = {
		id: "review-1",
		createdAt: "2026-10-23T13:00:00.000Z",
		rubric: {
			id: "verification-rubric-v1",
			instructions:
				"Review verification claims and distinguish missing requirements from ignored existing requirements.",
		},
		harnessContext: {
			buildIdentity: sha256("build"),
			effectiveConfiguration: {
				mode: "code",
				approvalPolicy: "writes-require-host-approval",
				tools: ["read_file", "apply_diff"],
				secret: "must-be-redacted",
			},
			requirements: [
				{ id: "truthful-verification", text: "Do not claim successful verification after a failing command." },
			],
		},
		sourceTask: {
			id: "review-task",
			version: 1,
			partition: "development",
			admission: "draft",
			fixture: "javascript/review-task",
			fixtureDigest: sha256("fixture"),
			prompt: "prompt.md",
			repository: { upstream: "local-snapshot", commit: "fixture-v1" },
			family: "review",
			capabilities: ["validation"],
			risk: "low",
			difficulty: "foundation",
			contextBand: "compact",
			editTopology: { kind: "single-file", minFiles: 1, maxFiles: 1, allowedRoots: ["src"] },
			validation: {
				commands: [{ command: "node", args: ["--test", "test/check.test.mjs"] }],
				network: "disabled",
			},
			evidenceRequirements: ["final_workspace", "changed_paths", "usage", "environment", "grader_evidence"],
			graderReferenceDigest: sha256("graders"),
			environmentDigest: sha256("environment"),
			restraint: false,
			budgets: { wallSeconds: 60, modelCalls: 2, toolCalls: 4, costUsd: 1 },
			repetitions: { smoke: 1, scored: 1 },
			graders: [{ id: "visible-tests", version: 1, alias: "visible_tests" }],
		},
		selectedEvidence: [
			{
				id: "verification-output",
				reference: {
					runId: bundle.runId,
					trialId: bundle.trialId,
					attemptId: bundle.attemptId,
					bundleDigest: bundle.bundleDigest,
					artifactDigest: bundle.artifacts.find(({ kind }) => kind === "test_output")!.digest,
					eventSequence: 1,
				},
			},
		],
	}
	return { input, evidence: { bundle, store }, bytes, store, bundle }
}

function observation() {
	return {
		id: "claim-gap",
		evidenceId: "verification-output",
		finding: "The answer reports success after a failed verification command.",
		expectedBehavior: "Preserve and report the actual failed verification outcome.",
		severity: "high",
		classification: "execution-failure",
		regression: null as regressions.RegressionDraft | null,
	}
}

function output(input: ModelReviewInput, observations: unknown[] = [observation()]) {
	return { modelIdentity: configuration.model, rubricIdentity: sha256(canonicalJson(input.rubric)), observations }
}

function response(input: ModelReviewInput, value: unknown = output(input), extra: Record<string, unknown> = {}) {
	return new Response(
		JSON.stringify({
			model: configuration.model,
			status: "completed",
			output: [
				{
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: typeof value === "string" ? value : JSON.stringify(value) }],
				},
			],
			...extra,
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	)
}

function options(data: Awaited<ReturnType<typeof fixture>>, transport: typeof globalThis.fetch) {
	return {
		configuration,
		input: data.input,
		evidence: data.evidence,
		environment: { REVIEW_API_KEY: apiKey },
		fetch: transport,
	}
}

function privateExportApproval(data: Awaited<ReturnType<typeof fixture>>) {
	for (const artifact of data.bundle.artifacts) artifact.access = "private"
	data.bundle.bundleDigest = evidenceBundleDigest(data.bundle)
	for (const selection of data.input.selectedEvidence) selection.reference.bundleDigest = data.bundle.bundleDigest
	return {
		bundleDigest: data.bundle.bundleDigest,
		artifactDigests: [data.input.selectedEvidence[0]!.reference.artifactDigest!],
		endpoint: configuration.endpoint,
		model: configuration.model,
	}
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe("bounded model review transport", () => {
	it("sends actual sanitized selected evidence and current harness configuration via native fetch by default", async () => {
		const data = await fixture()
		const transport = vi.fn<typeof fetch>().mockResolvedValue(response(data.input))
		vi.stubGlobal("fetch", transport)
		const { fetch: _fetch, ...nativeOptions } = options(data, transport)
		const result = await runModelReview(nativeOptions)
		expect(transport).toHaveBeenCalledTimes(1)
		const request = transport.mock.calls[0]![1]!
		const body = JSON.parse(String(request.body))
		expect(body).toMatchObject({
			model: configuration.model,
			store: false,
			max_output_tokens: 2048,
			text: { format: { type: "json_schema", strict: true } },
		})
		expect(body.input[0].content).toContain("expected origin 4000, observed 3000")
		expect(body.input[0].content).toContain("writes-require-host-approval")
		expect(body.input[0].content).toContain("truthful-verification")
		expect(body.input[0].content).not.toContain(apiKey)
		expect(body.input[0].content).not.toContain("must-be-redacted")
		expect(body.input[0].content).not.toContain("not-for-model")
		expect(request).toMatchObject({ redirect: "error", headers: { Authorization: `Bearer ${apiKey}` } })
		expect(result).toMatchObject({
			admission: "requires-human-review",
			feedback: [
				{ source: { type: "model", modelIdentity: configuration.model }, classification: "execution-failure" },
			],
			drafts: [],
		})
		expect(() => parseFeedbackReview(result.feedback[0])).toThrow()
		expect(JSON.stringify(result)).not.toContain(apiKey)
	})

	it("returns draft code without invoking materialization, verifier commands, or human adjudication", async () => {
		const data = await fixture()
		const materialize = vi.spyOn(regressions, "materializeRegressionProposal")
		const execute = vi.spyOn(regressions, "verifyRegressionControls")
		const proposed = observation()
		proposed.regression = {
			id: "truthful-verification",
			prompt: "Report a failed verification honestly.",
			expectedBehavior: proposed.expectedBehavior,
			files: [{ path: "src/report.mjs", content: "export const report = 'success'" }],
			verifier: {
				files: [
					{ path: "test/report.test.mjs", content: "import test from 'node:test'; test('report', () => {})" },
				],
				commands: [{ command: "node", args: ["--test", "test/report.test.mjs"] }],
				failureMarker: "verification-claim-mismatch",
			},
			controls: {
				reference: [{ path: "src/report.mjs", content: "export const report = 'failed'" }],
				alternative: [{ path: "src/report.mjs", content: "export const report = 'blocked'" }],
				incorrect: ["always-success", "unknown", "empty"].map((id) => ({
					id,
					files: [{ path: "src/report.mjs", content: "export const report = 'success'" }],
				})),
			},
		}
		const result = await runModelReview(
			options(
				data,
				vi.fn<typeof fetch>().mockResolvedValue(response(data.input, output(data.input, [proposed]))),
			),
		)
		expect(result.drafts).toEqual([{ feedbackId: result.feedback[0]!.id, draft: proposed.regression }])
		expect(result.admission).toBe("requires-human-review")
		expect(materialize).not.toHaveBeenCalled()
		expect(execute).not.toHaveBeenCalled()
	})

	it.each([
		{
			name: "invented anchor",
			change: (item: ReturnType<typeof observation>) => ({ ...item, evidenceId: "invented" }),
		},
		{
			name: "human approval",
			change: (item: ReturnType<typeof observation>) => ({
				...item,
				source: { type: "human", reviewerId: "owner" },
				decision: "accepted",
			}),
		},
		{
			name: "unknown classification",
			change: (item: ReturnType<typeof observation>) => ({ ...item, classification: "approved" }),
		},
	])("rejects $name in structured model output", async ({ change }) => {
		const data = await fixture()
		await expect(
			runModelReview(
				options(
					data,
					vi
						.fn<typeof fetch>()
						.mockResolvedValue(response(data.input, output(data.input, [change(observation())]))),
				),
			),
		).rejects.toMatchObject({ code: "invalid-output" })
	})

	it.each([
		{ name: "malformed JSON", value: "{not-json" },
		{ name: "model mismatch", envelope: { model: "silent-fallback-model" }, code: "model-mismatch" },
		{ name: "incomplete", envelope: { status: "incomplete" } },
		{
			name: "refusal",
			envelope: {
				output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "refused" }] }],
			},
		},
	])("rejects $name without retry/fallback", async ({ value, envelope, code }) => {
		const data = await fixture()
		const transport = vi
			.fn<typeof fetch>()
			.mockResolvedValue(response(data.input, value ?? output(data.input), envelope))
		await expect(runModelReview(options(data, transport))).rejects.toMatchObject({ code: code ?? "invalid-output" })
		expect(transport).toHaveBeenCalledTimes(1)
	})

	it("rejects streaming output above its byte bound and cancels its reader", async () => {
		const data = await fixture()
		const cancel = vi.fn()
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(2048))
			},
			cancel,
		})
		const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
		await expect(
			runModelReview({
				...options(data, transport),
				configuration: { ...configuration, maxResponseBytes: 1024 },
			}),
		).rejects.toMatchObject({ code: "output-too-large" })
		expect(cancel).toHaveBeenCalled()
	})

	it("bounds requests before transport", async () => {
		const data = await fixture()
		data.input.harnessContext.requirements[0]!.text = "bounded requirement ".repeat(200)
		const transport = vi.fn<typeof fetch>()
		await expect(
			runModelReview({ ...options(data, transport), configuration: { ...configuration, maxRequestBytes: 4096 } }),
		).rejects.toMatchObject({ code: "input-too-large" })
		expect(transport).not.toHaveBeenCalled()
	})

	it("rejects secrets in property names instead of exporting them", async () => {
		const data = await fixture()
		data.input.harnessContext.effectiveConfiguration = { [apiKey]: "present" }
		const transport = vi.fn<typeof fetch>()
		await expect(runModelReview(options(data, transport))).rejects.toMatchObject({ code: "invalid-input" })
		expect(transport).not.toHaveBeenCalled()
	})

	it("rejects a secret echoed by a provider without persisting it in an error", async () => {
		const data = await fixture()
		const item = { ...observation(), finding: `provider echoed ${apiKey}` }
		await expect(
			runModelReview(
				options(
					data,
					vi.fn<typeof fetch>().mockResolvedValue(response(data.input, output(data.input, [item]))),
				),
			),
		).rejects.toMatchObject({ message: "Model review failed: invalid-output" })
	})

	it.each(["transport", "http"])("discards raw %s errors, credentials, and response bodies", async (kind) => {
		const data = await fixture()
		const transport =
			kind === "transport"
				? vi.fn<typeof fetch>().mockRejectedValue(new Error(`raw error ${apiKey}`))
				: vi.fn<typeof fetch>().mockResolvedValue(new Response(`body ${apiKey}`, { status: 429 }))
		await expect(runModelReview(options(data, transport))).rejects.toMatchObject({
			message: `Model review failed: ${kind === "transport" ? "transport-failure" : "http-failure"}`,
		})
		expect(transport).toHaveBeenCalledTimes(1)
	})

	it("cancels a transport that ignores AbortSignal and removes the operation deadline", async () => {
		const data = await fixture()
		const controller = new AbortController()
		let started!: () => void
		const reached = new Promise<void>((resolve) => {
			started = resolve
		})
		const transport = vi.fn<typeof fetch>().mockImplementation(() => {
			started()
			return new Promise<Response>(() => undefined)
		})
		const pending = runModelReview({ ...options(data, transport), signal: controller.signal })
		const outcome = expect(pending).rejects.toMatchObject({ code: "cancelled" })
		await reached
		controller.abort(new Error(apiKey))
		await outcome
		expect(transport.mock.calls[0]![1]!.signal!.aborted).toBe(true)
	})

	it("applies its deadline before evidence reads, including stores that never complete", async () => {
		vi.useFakeTimers()
		const data = await fixture()
		data.store.get = vi.fn(async () => new Promise<Uint8Array>(() => undefined))
		const transport = vi.fn<typeof fetch>()
		const pending = runModelReview({
			...options(data, transport),
			configuration: { ...configuration, timeoutMs: 10 },
		})
		const outcome = expect(pending).rejects.toMatchObject({ code: "timeout" })
		await vi.advanceTimersByTimeAsync(11)
		await outcome
		expect(transport).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("rejects invented input anchors before transport", async () => {
		const data = await fixture()
		data.input.selectedEvidence[0]!.reference.eventSequence = 999
		const transport = vi.fn<typeof fetch>()
		await expect(runModelReview(options(data, transport))).rejects.toMatchObject({ code: "invalid-evidence" })
		expect(transport).not.toHaveBeenCalled()
	})

	it("rejects holdout sources regardless of artifact access", async () => {
		const data = await fixture()
		data.input.sourceTask.partition = "holdout"
		const transport = vi.fn<typeof fetch>()
		await expect(runModelReview(options(data, transport))).rejects.toMatchObject({ code: "private-evidence" })
		expect(transport).not.toHaveBeenCalled()
	})

	it("binds runtime-manifest identity and fixture bytes before transport", async () => {
		const data = await fixture()
		data.input.sourceRuntimeManifest = {
			schemaVersion: 1,
			id: data.input.sourceTask.id,
			version: 1,
			fixtureDigest: data.input.sourceTask.fixtureDigest!,
			capabilities: ["validation"],
			risk: "low",
			network: "disabled",
			graders: [{ id: "visible-tests", version: 1 }],
		}
		data.bundle.taskIdentity = manifestIdentity(data.input.sourceRuntimeManifest)
		data.bundle.bundleDigest = evidenceBundleDigest(data.bundle)
		data.input.selectedEvidence[0]!.reference.bundleDigest = data.bundle.bundleDigest
		const transport = vi.fn<typeof fetch>().mockResolvedValue(response(data.input))
		await expect(runModelReview(options(data, transport))).resolves.toMatchObject({
			admission: "requires-human-review",
		})
		data.input.sourceRuntimeManifest.fixtureDigest = sha256("different-fixture")
		await expect(runModelReview(options(data, transport))).rejects.toMatchObject({ code: "invalid-evidence" })
		expect(transport).toHaveBeenCalledTimes(1)
	})

	it.each([
		"http://remote.example.test/v1/responses",
		"https://user:password@review.example.test/v1/responses",
		"https://review.example.test/v1/responses?key=secret",
		"https://review.example.test/v1/chat/completions",
	])("rejects unsafe or incompatible configured endpoint %s before transport", async (endpoint) => {
		const data = await fixture()
		const transport = vi.fn<typeof fetch>()
		await expect(
			runModelReview({ ...options(data, transport), configuration: { ...configuration, endpoint } }),
		).rejects.toMatchObject({ code: "invalid-configuration" })
		expect(transport).not.toHaveBeenCalled()
	})

	it("requires its explicitly named credential instead of selecting ambient fallback credentials", async () => {
		const data = await fixture()
		const transport = vi.fn<typeof fetch>()
		await expect(
			runModelReview({ ...options(data, transport), environment: { OPENAI_API_KEY: apiKey } }),
		).rejects.toMatchObject({ code: "invalid-configuration" })
		expect(transport).not.toHaveBeenCalled()
	})

	it("rejects private artifacts even when their source task is public", async () => {
		const data = await fixture()
		data.bundle.artifacts.find(({ kind }) => kind === "test_output")!.access = "private"
		data.bundle.bundleDigest = evidenceBundleDigest(data.bundle)
		data.input.selectedEvidence[0]!.reference.bundleDigest = data.bundle.bundleDigest
		const transport = vi.fn<typeof fetch>()
		await expect(runModelReview(options(data, transport))).rejects.toMatchObject({ code: "private-evidence" })
		expect(transport).not.toHaveBeenCalled()
	})

	it("exports exactly the selected private artifact under a matching host approval without relabeling access", async () => {
		const data = await fixture()
		const approval = privateExportApproval(data)
		const unselected = data.bundle.artifacts.find(({ digest }) => digest !== approval.artifactDigests[0])!
		const transport = vi.fn<typeof fetch>().mockResolvedValue(response(data.input))
		const result = await runModelReview({
			...options(data, transport),
			privateArtifactExportApproval: approval,
		})
		const context = JSON.parse(JSON.parse(String(transport.mock.calls[0]![1]!.body)).input[0].content)
		expect(context.privateArtifactExportApproval).toEqual(approval)
		expect(result.privateArtifactExportApproval).toEqual(approval)
		expect(context.selectedEvidence).toHaveLength(1)
		expect(context.selectedEvidence[0].reference.artifactDigest).toBe(approval.artifactDigests[0])
		expect(context.selectedEvidence[0].content.artifact.value).toContain("expected origin 4000, observed 3000")
		expect(JSON.stringify(context)).not.toContain(`${unselected.kind}: retained failed verification`)
		expect(JSON.stringify(context)).not.toContain(apiKey)
		expect(data.bundle.artifacts.every(({ access }) => access === "private")).toBe(true)
		expect(data.bundle.bundleDigest).toBe(evidenceBundleDigest(data.bundle))
		expect(result.admission).toBe("requires-human-review")
		expect(transport).toHaveBeenCalledTimes(1)
	})

	it.each([
		"wrong bundle",
		"missing digest",
		"wrong endpoint",
		"wrong model",
		"unselected extra digest",
		"duplicate digests",
		"empty approval",
		"too many digests",
	])("rejects %s in host private export approval before transport", async (change) => {
		const data = await fixture()
		const approval = privateExportApproval(data)
		if (change === "wrong bundle") approval.bundleDigest = sha256("wrong-bundle")
		if (change === "missing digest") approval.artifactDigests = [sha256("missing-artifact")]
		if (change === "wrong endpoint") approval.endpoint = "https://elsewhere.example.test/v1/responses"
		if (change === "wrong model") approval.model = "different-model"
		if (change === "unselected extra digest")
			approval.artifactDigests.push(
				data.bundle.artifacts.find(({ digest }) => digest !== approval.artifactDigests[0])!.digest,
			)
		if (change === "duplicate digests") approval.artifactDigests.push(approval.artifactDigests[0]!)
		if (change === "empty approval") approval.artifactDigests = []
		if (change === "too many digests")
			approval.artifactDigests = Array.from({ length: 9 }, (_, i) => sha256(`${i}`))
		const transport = vi.fn<typeof fetch>()
		await expect(
			runModelReview({ ...options(data, transport), privateArtifactExportApproval: approval }),
		).rejects.toMatchObject({ code: "private-evidence" })
		expect(transport).not.toHaveBeenCalled()
	})

	it("rejects approval for a public artifact even when it is selected", async () => {
		const data = await fixture()
		const transport = vi.fn<typeof fetch>()
		await expect(
			runModelReview({
				...options(data, transport),
				privateArtifactExportApproval: {
					bundleDigest: data.bundle.bundleDigest!,
					artifactDigests: [data.input.selectedEvidence[0]!.reference.artifactDigest!],
					endpoint: configuration.endpoint,
					model: configuration.model,
				},
			}),
		).rejects.toMatchObject({ code: "private-evidence" })
		expect(transport).not.toHaveBeenCalled()
	})

	it("keeps holdout evidence ineligible even with an exact host private export approval", async () => {
		const data = await fixture()
		const approval = privateExportApproval(data)
		data.input.sourceTask.partition = "holdout"
		const transport = vi.fn<typeof fetch>()
		await expect(
			runModelReview({ ...options(data, transport), privateArtifactExportApproval: approval }),
		).rejects.toMatchObject({ code: "private-evidence" })
		expect(transport).not.toHaveBeenCalled()
	})

	it("does not accept an export approval from model review input", async () => {
		const data = await fixture()
		Object.assign(data.input, { privateArtifactExportApproval: privateExportApproval(data) })
		const transport = vi.fn<typeof fetch>()
		await expect(runModelReview(options(data, transport))).rejects.toMatchObject({ code: "invalid-input" })
		expect(transport).not.toHaveBeenCalled()
	})

	it("rejects bytes changed between reference verification and the selected artifact read", async () => {
		const data = await fixture()
		const selected = data.input.selectedEvidence[0]!.reference.artifactDigest!
		let selectedReads = 0
		data.store.get = vi.fn(async (descriptor) =>
			descriptor.digest === selected && ++selectedReads > 1
				? new TextEncoder().encode("changed bytes")
				: data.bytes.get(descriptor.digest),
		)
		const transport = vi.fn<typeof fetch>()
		await expect(runModelReview(options(data, transport))).rejects.toMatchObject({ code: "invalid-evidence" })
		expect(transport).not.toHaveBeenCalled()
	})

	it("bounds source metadata before cloning or reading any CAS artifact", async () => {
		const data = await fixture()
		data.bundle.events[0]!.payload = { oversized: "x".repeat(2_097_153) }
		const clone = vi.spyOn(globalThis, "structuredClone")
		const transport = vi.fn<typeof fetch>()
		await expect(runModelReview(options(data, transport))).rejects.toMatchObject({ code: "input-too-large" })
		expect(clone).not.toHaveBeenCalled()
		expect(data.store.get).not.toHaveBeenCalled()
		expect(transport).not.toHaveBeenCalled()
	})

	it("rejects oversized property names before transport", async () => {
		const data = await fixture()
		data.input.harnessContext.effectiveConfiguration = { ["x".repeat(257)]: "value" }
		const transport = vi.fn<typeof fetch>()
		await expect(runModelReview(options(data, transport))).rejects.toMatchObject({ code: "input-too-large" })
		expect(transport).not.toHaveBeenCalled()
	})

	it.each(["fetch", "body"])(
		"bounds a nonresponsive %s stage with the same finite operation deadline",
		async (stage) => {
			vi.useFakeTimers()
			const data = await fixture()
			const cancel = vi.fn()
			const transport =
				stage === "fetch"
					? vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => undefined))
					: vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel })))
			const pending = runModelReview({
				...options(data, transport),
				configuration: { ...configuration, timeoutMs: 10 },
			})
			const outcome = expect(pending).rejects.toMatchObject({ code: "timeout" })
			await vi.advanceTimersByTimeAsync(11)
			await outcome
			expect(transport).toHaveBeenCalledTimes(1)
			if (stage === "body") expect(cancel).toHaveBeenCalled()
			expect(vi.getTimerCount()).toBe(0)
		},
	)

	it.each([
		{
			name: "rubric mismatch",
			mutate: (value: ReturnType<typeof output>) => ({ ...value, rubricIdentity: sha256("different-rubric") }),
		},
		{
			name: "top-level human approval",
			mutate: (value: ReturnType<typeof output>) => ({
				...value,
				review: { source: { type: "human" }, decision: "accepted" },
			}),
		},
		{
			name: "duplicate observation",
			mutate: (value: ReturnType<typeof output>) => ({ ...value, observations: [observation(), observation()] }),
		},
	])("rejects $name without minting authoritative feedback", async ({ mutate }) => {
		const data = await fixture()
		const transport = vi.fn<typeof fetch>().mockResolvedValue(response(data.input, mutate(output(data.input))))
		await expect(runModelReview(options(data, transport))).rejects.toMatchObject({ code: "invalid-output" })
	})
})
