import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { execa } from "execa"
import { stringify } from "yaml"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createTaskTemplate } from "../../benchmark/templates"
import { FilesystemArtifactStore } from "../../evidence/artifactStore"
import { canonicalJson, sha256 } from "../../evidence/canonical"
import { runImprovementCli, improvementCliExitCode } from "../cli"
import { sealFeedback } from "../feedback"
import { ImprovementArtifactStore, stageReference, type StoredStage } from "../store"
import { evaluateConfirmation } from "../confirmation"
import { harnessContextSchema, regradeArchivedEvidence } from "../handoff"
import { materializeRegressionProposal } from "../regressions"
import { ExecaHarnessProcessRunner } from "../../orchestration/processRunner"
import { createConfirmationFixture } from "./confirmationFixtures"

let root: string
const packageRoot = fileURLToPath(new URL("../../..", import.meta.url))
beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-improve-cli-")))
})
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true })
	vi.restoreAllMocks()
})

async function json(name: string, value: unknown) {
	const file = path.join(root, `${name}.json`)
	await fs.writeFile(file, JSON.stringify(value))
	return file
}
function args(command: string, id: string, extra: string[] = []) {
	return [command, "--store", path.join(root, "loop"), "--iteration", "iteration-cli", "--id", id, ...extra]
}
async function capturedFixture() {
	const fixture = await createConfirmationFixture()
	const sourceRoot = path.join(root, "source-artifacts")
	const source = new FilesystemArtifactStore(sourceRoot)
	for (const artifact of fixture.evidence.bundle.artifacts)
		await source.put({ ...artifact, bytes: (await fixture.evidence.store.get(artifact))! })
	const capture = await runImprovementCli(
		args("capture", "observed", [
			"--input",
			await json("bundle", fixture.evidence.bundle),
			"--source-artifacts",
			sourceRoot,
		]),
	)
	const { digest: _digest, ...annotation } = fixture.sources.feedback
	const humanFile = await json("human", annotation)
	return { fixture, capture, humanFile, annotation }
}

function requestDigestFor(command: string[], input: unknown, stages: StoredStage[]) {
	const values: [string, string][] = []
	for (let index = 1; index < command.length; index += 2) values.push([command[index]!, command[index + 1]!])
	return sha256(
		canonicalJson({
			command: command[0],
			input: input ?? null,
			configuration: null,
			runtimeManifest: null,
			sourceTask: null,
			options: values,
			flags: [],
			references: stages.map(({ manifest }) => stageReference(manifest)),
		}),
	)
}

describe("reviewed improvement CLI", () => {
	it("executes the actual package help script and gives malformed input a nonzero exit", async () => {
		const help = await execa("pnpm", ["--config.verify-deps-before-run=false", "benchmark:improve", "--help"], {
			cwd: packageRoot,
			reject: false,
			timeout: 20000,
		})
		expect(help.exitCode).toBe(0)
		expect(help.stdout).toContain("confirm-run")
		const invalid = await execa(
			"pnpm",
			["--config.verify-deps-before-run=false", "benchmark:improve", "capture", "--unrecognized"],
			{ cwd: packageRoot, reject: false, timeout: 20000 },
		)
		expect(invalid.exitCode).not.toBe(0)
		expect(invalid.stderr).toContain("improvement_input_validation_or_stage_failed")
	}, 45000)

	it("runs real archived evidence through human annotation and explicit adjudication offline", async () => {
		const { fixture, humanFile } = await capturedFixture()
		const human = await runImprovementCli(
			args("feedback-human", "human", ["--from", "observed", "--input", humanFile]),
		)
		expect("manifest" in human && human.manifest.stage).toBe("feedback")
		expect(
			await runImprovementCli(args("feedback-human", "human", ["--from", "observed", "--input", humanFile])),
		).toEqual(human)
		const { digest: _digest, ...review } = fixture.sources.feedbackReview
		const adjudicated = await runImprovementCli(
			args("adjudicate", "reviewed", ["--from", "observed,human", "--input", await json("review", review)]),
		)
		expect("manifest" in adjudicated && adjudicated.manifest.stage).toBe("feedback-review")
		const store = await ImprovementArtifactStore.open({
			root: path.join(root, "loop"),
			iterationId: "iteration-cli",
		})
		expect((await store.read("observed")).value).toEqual(fixture.evidence.bundle)
	})

	it("collects current context fingerprints and holds the old producer only as provider reference", async () => {
		const fixture = await createConfirmationFixture()
		const identities = await import("../../../../../apps/vscode-e2e/src/campaign/evaluationIdentity")
		const fingerprints = await import("../../../../../apps/vscode-e2e/src/campaign/liveGate")
		vi.spyOn(identities, "sourceDigest").mockImplementation(async (_root, scopes) =>
			sha256(scopes[0] === "." ? "current-tree" : "current-cases").slice(7),
		)
		const fingerprint = vi
			.spyOn(fingerprints, "fingerprintArtifactPaths")
			.mockImplementation(async (_root, scopes) =>
				sha256(scopes[0] === "src/package.json" ? "current-build" : "current-harness").slice(7),
			)
		vi.spyOn(ExecaHarnessProcessRunner.prototype, "run").mockResolvedValue({
			exitCode: 0,
			stdout: "b".repeat(40),
			stderr: "",
			durationMs: 1,
			timedOut: false,
			outputTruncated: false,
		})
		const sourceRoot = path.join(root, "source")
		await fs.mkdir(path.join(sourceRoot, "src"), { recursive: true })
		await fs.writeFile(path.join(sourceRoot, "src", "cache.js"), "current-source")
		const command = args("context", "current-context", [
			"--source-root",
			sourceRoot,
			"--input",
			await json("context", { sourcePaths: ["src/cache.js"], identityReceipt: fixture.rawCampaign("control") }),
		])
		const result = await runImprovementCli(command)
		if (!("manifest" in result)) throw new Error("Expected context stage")
		const context = harnessContextSchema.parse(result.value)
		expect(context.sourceRevision).toBe("b".repeat(40))
		expect(context.extensionBuildDigest).toBe(sha256("current-build"))
		expect(context.harnessDigest).toBe(sha256("current-harness"))
		expect(context.taskSetDigest).toBe(sha256("current-cases"))
		expect(context.sourceFiles).toEqual([{ path: "src/cache.js", digest: sha256("current-source") }])
		expect(context.model).toEqual({ id: "scripted", effort: "scripted" })
		expect(await runImprovementCli(command)).toEqual(result)
		const conflicting = fixture.rawCampaign("control")
		conflicting.attempts[1]!.request.timeWindow = "a-different-captured-window"
		await expect(
			runImprovementCli(
				args("context", "conflicting-context", [
					"--source-root",
					sourceRoot,
					"--input",
					await json("conflicting-context", { sourcePaths: ["src/cache.js"], identityReceipt: conflicting }),
				]),
			),
		).rejects.toThrow("conflicting")
		fingerprint.mockResolvedValue(sha256("changed-build").slice(7))
		await expect(runImprovementCli(command)).rejects.toThrow("stale")
	})

	it("blocks divergent intrinsic feedback and review IDs under different stage aliases", async () => {
		const { fixture, annotation, humanFile } = await capturedFixture()
		await runImprovementCli(args("feedback-human", "human", ["--from", "observed", "--input", humanFile]))
		await expect(
			runImprovementCli(
				args("feedback-human", "different-stage", [
					"--from",
					"observed",
					"--input",
					await json("different-feedback", {
						...annotation,
						finding: "A different observation reuses the intrinsic identity.",
					}),
				]),
			),
		).rejects.toThrow("Intrinsic")
		const { digest: _digest, ...review } = fixture.sources.feedbackReview
		await runImprovementCli(
			args("adjudicate", "reviewed", ["--from", "observed,human", "--input", await json("review", review)]),
		)
		await expect(
			runImprovementCli(
				args("adjudicate", "different-review", [
					"--from",
					"observed,human",
					"--input",
					await json("different-review", {
						...review,
						rationale: "Different rationale under the same review identity.",
					}),
				]),
			),
		).rejects.toThrow("Intrinsic")
	})

	it("requires explicit model dispatch and also binds every model-batch intrinsic ID", async () => {
		const { fixture, humanFile } = await capturedFixture()
		await runImprovementCli(args("feedback-human", "human", ["--from", "observed", "--input", humanFile]))
		const catalog = path.join(root, "catalog")
		await fs.mkdir(catalog)
		const task = {
			...createTaskTemplate({ id: "source-task", profile: "compact" }),
			fixtureDigest: sha256("source-fixture"),
		}
		await fs.writeFile(path.join(catalog, "benchmark-suites.yaml"), "schemaVersion: 1\nsuites: [suite.yaml]\n")
		await fs.writeFile(
			path.join(catalog, "suite.yaml"),
			stringify({
				schemaVersion: 1,
				id: "review-suite",
				version: 1,
				status: "draft",
				primaryModel: "luna-high",
				referenceModel: "luna-high",
				tasks: [task],
			}),
		)
		const modelInput = await json("model-input", {
			id: "model-review",
			createdAt: "2026-10-23T12:00:00.000Z",
			rubric: { id: "rubric", instructions: "Explain the observed failure." },
			harnessContext: {
				buildIdentity: "observed-build",
				effectiveConfiguration: { mode: "code" },
				requirements: [{ id: "cache", text: "Invalidate derived values." }],
			},
			selectedEvidence: [{ id: "selected", reference: fixture.sources.feedback.evidence }],
		})
		const configuration = await json("model-configuration", {
			endpoint: "https://api.openai.com/v1/responses",
			model: "configured-reviewer",
			apiKeyEnv: "REVIEW_KEY",
			timeoutMs: 1000,
			maxRequestBytes: 8192,
			maxResponseBytes: 8192,
			maxOutputTokens: 128,
		})
		const model = vi.fn(async () => {
			const { digest: _digest, ...body } = fixture.sources.feedback
			const record = await sealFeedback(
				{
					...body,
					source: {
						type: "model",
						reviewerId: "reviewer",
						modelIdentity: "configured-reviewer",
						rubricIdentity: sha256("rubric"),
					},
				},
				fixture.evidence,
			)
			return {
				schemaVersion: 1 as const,
				recordType: "model-review" as const,
				id: "model-review",
				createdAt: "2026-10-23T12:00:00.000Z",
				modelIdentity: "configured-reviewer",
				rubricIdentity: sha256("rubric"),
				contextDigest: sha256("context"),
				feedback: [record],
				drafts: [],
				admission: "requires-human-review" as const,
			}
		})
		const command = args("feedback-model", "model", [
			"--from",
			"observed",
			"--input",
			modelInput,
			"--configuration",
			configuration,
			"--catalog-root",
			catalog,
			"--task",
			"source-task@1",
		])
		await expect(runImprovementCli(command, { modelReview: model })).rejects.toThrow("--allow-network")
		expect(model).not.toHaveBeenCalled()
		await expect(runImprovementCli([...command, "--allow-network"], { modelReview: model })).rejects.toThrow(
			"Intrinsic",
		)
		expect(model).toHaveBeenCalledTimes(1)
	})

	it("refuses to turn arbitrary stored confirmation status into a decision report", async () => {
		const store = await ImprovementArtifactStore.open({
			root: path.join(root, "loop"),
			iterationId: "iteration-cli",
		})
		const fixture = await createConfirmationFixture()
		await store.write({ id: "human", stage: "feedback", value: fixture.sources.feedback })
		await store.write({ id: "reviewed", stage: "feedback-review", value: fixture.sources.feedbackReview })
		await store.write({ id: "proposed", stage: "regression-proposal", value: fixture.sources.regression })
		await store.write({ id: "handoff", stage: "handoff", value: { manifest: fixture.sources.handoff } })
		await store.write({ id: "repair", stage: "reviewed-repair", value: fixture.sources.reviewedRepair })
		await store.write({
			id: "fabricated",
			stage: "confirmation",
			value: { status: "keep", digest: "anything", reasons: [] },
		})
		await expect(
			runImprovementCli(
				args("report", "report", ["--from", "fabricated,human,reviewed,proposed,handoff,repair"]),
			),
		).rejects.toThrow()
		const parentIds = ["human", "reviewed", "proposed", "handoff", "repair"]
		const input = { plan: fixture.plan, ...fixture.campaigns() }
		const command = args("confirm-import", "forged-resume", [
			"--from",
			parentIds.join(","),
			"--input",
			await json("confirmation", input),
		])
		const references = await Promise.all(
			parentIds.map(async (id) => stageReference((await store.read(id)).manifest)),
		)
		const values: [string, string][] = []
		for (let index = 1; index < command.length; index += 2) values.push([command[index]!, command[index + 1]!])
		const requestDigest = sha256(
			canonicalJson({
				command: "confirm-import",
				input,
				configuration: null,
				runtimeManifest: null,
				sourceTask: null,
				options: values,
				flags: [],
				references,
			}),
		)
		const legitimate = evaluateConfirmation(fixture.plan, fixture.sources, fixture.campaigns())
		await store.write({
			id: "forged-resume",
			stage: "confirmation",
			inputs: references,
			requestDigest,
			value: { ...legitimate, status: "keep" },
		})
		await expect(runImprovementCli(command)).rejects.toThrow()
	})

	it("retains an imported confirmation receipt while returning inconclusive gate exit code", async () => {
		const fixture = await createConfirmationFixture()
		const receipt = evaluateConfirmation(fixture.plan, fixture.sources, fixture.campaigns())
		const store = await ImprovementArtifactStore.open({
			root: path.join(root, "loop"),
			iterationId: "iteration-cli",
		})
		const result: StoredStage = await store.write({ id: "imported", stage: "confirmation", value: receipt })
		expect(receipt.origin).toBe("imported")
		expect(receipt.status).toBe("inconclusive")
		expect(improvementCliExitCode(result)).toBe(2)
		expect((await store.read("imported")).value).toEqual(receipt)
	})

	it.each(["missing", "malformed", "proposal", "bundle", "valid"] as const)(
		"checks %s archived validation ancestry before creating an execution boundary",
		async (invalid) => {
			const fixture = await createConfirmationFixture()
			const proposal = fixture.sources.regression
			const materialized = await materializeRegressionProposal({
				proposal,
				policy: proposal.policy,
				selectedProposalDigest: proposal.digest,
				ownedRoot: root,
				destinationName: "generated",
				evidence: fixture.evidence,
			})
			const store = await ImprovementArtifactStore.open({
				root: path.join(root, "loop"),
				iterationId: "iteration-cli",
			})
			await store.write({ id: "proposed", stage: "regression-proposal", value: proposal })
			await store.write({ id: "materialized", stage: "materialization", value: materialized })
			const parents = ["proposed", "materialized"]
			if (invalid !== "missing") {
				const archived = await regradeArchivedEvidence(
					{
						proposal,
						bundle: fixture.evidence.bundle,
						context: fixture.plan.control.context,
						specs: [
							{
								id: "retained-response",
								version: 1,
								type: "filesystem",
								hardGate: true,
								failureClass: "outcome",
								assertions: [{ kind: "exists", path: "artifacts/final_response" }],
							},
						],
					},
					{
						store: fixture.evidence.store,
						readSource: async () => fixture.sourceBytes.control,
						ownedRoot: root,
						destinationName: "archived",
					},
				)
				const { digest: _digest, ...body } = archived.receipt
				const changed = {
					...body,
					...(invalid === "proposal" ? { proposalDigest: sha256("another proposal") } : {}),
					...(invalid === "bundle" ? { bundleDigest: sha256("another bundle") } : {}),
				}
				await store.write({
					id: "archived",
					stage: "archived-regrade",
					value:
						invalid === "malformed"
							? { ...archived.receipt, digest: sha256("tampered receipt") }
							: { ...changed, digest: sha256(canonicalJson(changed)) },
				})
				parents.push("archived")
			}
			const execution = await import("../execution")
			const boundary = vi
				.spyOn(execution, "createRegressionExecutionBoundary")
				.mockRejectedValue(new Error("Unexpected control dispatch"))
			const command = args("validate", "validated", [
				"--from",
				parents.join(","),
				"--input",
				await json("validation", {
					policy: proposal.policy,
					execution: {
						image: sha256("locally installed image"),
						limits: { cpus: 1, memoryBytes: 64 * 1024 * 1024, pids: 16, timeoutMs: 1000 },
					},
				}),
				"--approve-proposal-digest",
				proposal.digest,
				"--allow-execution",
			])
			if (invalid === "valid") {
				await expect(runImprovementCli(command)).rejects.toThrow("Unexpected control dispatch")
				expect(boundary).toHaveBeenCalledTimes(1)
				expect((await store.read("validated_request")).manifest.stage).toBe("execution-request")
			} else {
				await expect(runImprovementCli(command)).rejects.toThrow(
					invalid === "missing"
						? /Exactly one archived-regrade/
						: invalid === "malformed"
							? /digest/
							: /ancestry/,
				)
				expect(boundary).not.toHaveBeenCalled()
				await expect(store.read("validated_request")).rejects.toMatchObject({ code: "ENOENT" })
			}
		},
	)

	it("rejects resumed reports that contradict the confirmation scope or promotion boundary", async () => {
		const fixture = await createConfirmationFixture()
		const store = await ImprovementArtifactStore.open({
			root: path.join(root, "loop"),
			iterationId: "iteration-cli",
		})
		const parents = await Promise.all([
			store.write({ id: "human", stage: "feedback", value: fixture.sources.feedback }),
			store.write({ id: "reviewed", stage: "feedback-review", value: fixture.sources.feedbackReview }),
			store.write({ id: "proposed", stage: "regression-proposal", value: fixture.sources.regression }),
			store.write({ id: "handoff", stage: "handoff", value: { manifest: fixture.sources.handoff } }),
			store.write({ id: "repair", stage: "reviewed-repair", value: fixture.sources.reviewedRepair }),
			store.write({
				id: "confirmed",
				stage: "confirmation",
				value: evaluateConfirmation(fixture.plan, fixture.sources, fixture.campaigns()),
			}),
		])
		const from = parents.map(({ manifest }) => manifest.id).join(",")
		const command = args("report", "reported", ["--from", from])
		const correct = await runImprovementCli(command)
		expect(await runImprovementCli(command)).toEqual(correct)
		if (!("manifest" in correct)) throw new Error("Expected a report stage")
		const changes: Record<string, unknown> = {
			evidenceKind: "live-quality-comparison",
			objective: "fabricated-superiority",
			margin: 0.99,
			population: "all-production-tasks",
			liveQualityImprovement: true,
			promotion: "promoted",
			ancestry: [],
		}
		for (const [field, value] of Object.entries(changes)) {
			const id = `changed-${field}`
			const resume = args("report", id, ["--from", from])
			await store.write({
				id,
				stage: "report",
				inputs: parents.map(({ manifest }) => stageReference(manifest)),
				requestDigest: requestDigestFor(resume, null, parents),
				value: Object.assign({}, correct.value, { [field]: value }),
			})
			await expect(runImprovementCli(resume)).rejects.toThrow(/contradicts/)
		}
		const wrongStage = args("report", "wrong-stage", ["--from", from])
		await store.write({
			id: "wrong-stage",
			stage: "feedback",
			inputs: parents.map(({ manifest }) => stageReference(manifest)),
			requestDigest: requestDigestFor(wrongStage, null, parents),
			value: correct.value,
		})
		await expect(runImprovementCli(wrongStage)).rejects.toThrow(/contradicts/)
	})
})
