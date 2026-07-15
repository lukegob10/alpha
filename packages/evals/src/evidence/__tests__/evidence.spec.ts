import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
	canonicalJson,
	collectRequiredEvidence,
	collectWorkspaceEvidence,
	createRuntimeIdentities,
	containsSecret,
	EventJournal,
	extractFinalResponse,
	FilesystemArtifactStore,
	createRuntimeEventRegistry,
	manifestIdentity,
	preserveLargeOutput,
	REQUIRED_ARTIFACT_KINDS,
	redact,
	sha256,
	validateEvidenceBundle,
	taskManifestSchema,
	variantManifestSchema,
	type EvidenceBundle,
	type RequiredEvidence,
} from "../index"
import { ExecaHarnessProcessRunner } from "../../orchestration/processRunner"

function baseInput(root: string, prompt: string, processRunner: ExecaHarnessProcessRunner) {
	return {
		taskId: "identity-task",
		workspace: root,
		promptFiles: [prompt],
		model: "fixed-model",
		processRunner,
		network: "disabled" as const,
	}
}

const identity = { runId: "run-1", trialId: "trial-1", attemptId: "attempt-1" }
const requiredEvidence = Object.fromEntries(
	REQUIRED_ARTIFACT_KINDS.map((kind) => [kind, `${kind} content`]),
) as RequiredEvidence

describe("M4 evidence contracts", () => {
	it("derives task and variant identities from the actual fixture, prompt, settings, and workspace revision", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-identities-"))
		const prompt = `${root}-prompt.md`
		const runner = new ExecaHarnessProcessRunner()
		const git = async (...args: string[]) => {
			const result = await runner.run({
				command: "git",
				args,
				cwd: root,
				timeoutMs: 30_000,
				maxOutputBytes: 1024 * 1024,
			})
			expect(result.exitCode).toBe(0)
		}
		try {
			await fs.writeFile(path.join(root, "fixture.txt"), "fixture-v1")
			await fs.writeFile(prompt, "prompt-v1")
			await git("init")
			await git("config", "user.email", "evals@example.invalid")
			await git("config", "user.name", "Eval Harness")
			await git("add", ".")
			await git("commit", "-m", "fixture")
			const base = await createRuntimeIdentities({
				taskId: "identity-task",
				workspace: root,
				promptFiles: [prompt],
				model: "fixed-model",
				settings: { temperature: 0 },
				processRunner: runner,
				network: "disabled",
			})
			await fs.writeFile(prompt, "prompt-v2")
			const promptChanged = await createRuntimeIdentities({
				...baseInput(root, prompt, runner),
				settings: { temperature: 0 },
			})
			expect(promptChanged.taskIdentity).toBe(base.taskIdentity)
			expect(promptChanged.variantIdentity).not.toBe(base.variantIdentity)
			await fs.writeFile(path.join(root, "fixture.txt"), "fixture-v2")
			const fixtureChanged = await createRuntimeIdentities({
				...baseInput(root, prompt, runner),
				settings: { temperature: 1 },
			})
			expect(fixtureChanged.taskIdentity).not.toBe(base.taskIdentity)
			expect(fixtureChanged.variantIdentity).not.toBe(promptChanged.variantIdentity)
		} finally {
			await fs.rm(root, { recursive: true, force: true })
			await fs.rm(prompt, { force: true })
		}
	})
	it("canonicalizes objects and produces stable content identities", () => {
		expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}')
		expect(sha256(canonicalJson({ a: 1, b: 2 }))).toBe(sha256(canonicalJson({ b: 2, a: 1 })))
	})

	it("redacts sensitive keys and raw, base64, and encoded secret canaries recursively", () => {
		const secret = "sk alpha/secret"
		const payload = {
			authorization: `Bearer ${secret}`,
			nested: [{ value: secret }, Buffer.from(secret).toString("base64"), encodeURIComponent(secret)],
		}
		const result = redact(payload, { secrets: [secret] })
		expect(containsSecret(result, [secret])).toBe(false)
		expect(JSON.stringify(result)).not.toContain(secret)
	})

	it("creates sequential redacted event envelopes with payload digests", () => {
		const journal = new EventJournal(identity, { secrets: ["canary"] })
		const first = journal.append("tool.requested", { token: "canary" }, "2026-01-01T00:00:00.000Z")
		const second = journal.append("tool.completed", { ok: true }, "2026-01-01T00:00:01.000Z")
		expect([first.sequence, second.sequence]).toEqual([1, 2])
		expect(first.payloadDigest).toBe(sha256(canonicalJson(first.payload)))
		expect(containsSecret(journal.all(), ["canary"])).toBe(false)
	})

	it("extracts the last structured final response without trusting malformed history", () => {
		expect(extractFinalResponse(JSON.stringify([{ text: "draft" }, { message: { content: "final" } }]))).toBe(
			"final",
		)
		expect(extractFinalResponse("not-json")).toBe("")
		expect(extractFinalResponse("")).toBe("")
	})

	it("validates immutable task and variant manifests and derives identities", () => {
		const validDigest = `sha256:${"a".repeat(64)}`
		const task = taskManifestSchema.parse({
			schemaVersion: 1,
			id: "task",
			version: 1,
			fixtureDigest: validDigest,
			capabilities: ["editing"],
			risk: "high",
			network: "disabled",
			graders: [{ id: "command", version: 1 }],
		})
		const variant = variantManifestSchema.parse({
			schemaVersion: 1,
			id: "variant",
			extensionCommit: "abc123",
			workingTreeDigest: validDigest,
			model: "fixed-model",
			promptDigest: validDigest,
			toolSchemaDigest: validDigest,
			runnerImageDigest: validDigest,
		})
		expect(manifestIdentity(task)).toMatch(/^task@1:sha256:/)
		expect(manifestIdentity(variant)).toMatch(/^variant@1:sha256:/)
		expect(() => taskManifestSchema.parse({ ...task, fixtureDigest: "mutable" })).toThrow()
	})

	it("rejects unknown or malformed runtime event adapters", () => {
		const registry = createRuntimeEventRegistry()
		const journal = new EventJournal(identity)
		expect(registry.normalize(journal, "agent.turn", { turnId: "one" }).type).toBe("agent.turn")
		expect(() => registry.normalize(journal, "agent.turn", null)).toThrow("Invalid payload")
		expect(() => registry.normalize(journal, "unknown", {})).toThrow("Unknown eval event")
	})

	it.each([
		[
			"event_sequence_gap",
			(bundle: EvidenceBundle): void => {
				bundle.events[0]!.sequence = 2
			},
		],
		[
			"event_sequence_duplicate",
			(bundle: EvidenceBundle): void => {
				bundle.events.push({ ...bundle.events[0]! })
			},
		],
		[
			"event_payload_corrupt",
			(bundle: EvidenceBundle): void => {
				bundle.events[0]!.payload = { changed: true }
			},
		],
		[
			"late_event_forbidden",
			(bundle: EvidenceBundle): void => {
				bundle.events[0]!.late = true
			},
		],
		[
			"artifact_missing",
			(bundle: EvidenceBundle): void => {
				bundle.artifacts.pop()
			},
		],
		[
			"artifact_incomplete",
			(bundle: EvidenceBundle): void => {
				bundle.artifacts[0]!.uploadState = "incomplete"
			},
		],
		[
			"identity_mismatch",
			(bundle: EvidenceBundle): void => {
				bundle.events[0]!.attemptId = "wrong"
			},
		],
	] as const)("detects %s", async (code, mutate) => {
		const { bundle, store } = await fixture()
		mutate(bundle)
		const result = await validateEvidenceBundle(bundle, store)
		expect(result.valid).toBe(false)
		expect(result.issues.map((issue) => issue.code)).toContain(code)
	})

	it("detects corrupt artifact bytes", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-corrupt-"))
		const store = new FilesystemArtifactStore(root)
		const artifacts = await collectRequiredEvidence(identity.attemptId, requiredEvidence, store)
		const target = artifacts[0]!
		const hex = target.digest.slice("sha256:".length)
		await fs.writeFile(path.join(root, "sha256", hex.slice(0, 2), hex), "corrupt")
		const bundle = createBundle(artifacts)
		const result = await validateEvidenceBundle(bundle, store)
		expect(result.issues.map((issue) => issue.code)).toContain("artifact_corrupt")
	})

	it("retains protected full output while bounding the event preview", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-output-"))
		const store = new FilesystemArtifactStore(root)
		const result = await preserveLargeOutput(identity.attemptId, "x".repeat(100), store, 10)
		expect(result).toMatchObject({ preview: "x".repeat(10), truncated: true })
		expect(result.artifact?.sizeBytes).toBe(100)
		expect(await store.get(result.artifact!)).toHaveLength(100)
	})

	it("idempotently resumes over an interrupted partial artifact upload", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-resume-"))
		const store = new FilesystemArtifactStore(root)
		const bytes = new TextEncoder().encode("complete artifact")
		const digest = sha256(bytes)
		const hex = digest.slice("sha256:".length)
		const target = path.join(root, "sha256", hex.slice(0, 2), hex)
		await fs.mkdir(path.dirname(target), { recursive: true })
		await fs.writeFile(`${target}.partial`, "interrupted")
		const first = await store.put({ attemptId: "one", kind: "other", bytes, mediaType: "text/plain" })
		const second = await store.put({ attemptId: "one", kind: "other", bytes, mediaType: "text/plain" })
		expect(second.digest).toBe(first.digest)
		expect([...((await store.get(second)) ?? [])]).toEqual([...bytes])
		expect(await fs.stat(`${target}.partial`).catch(() => undefined)).toBeUndefined()
	})

	it("rejects a corrupt existing object and reports an absent object", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-collision-"))
		const store = new FilesystemArtifactStore(root)
		const bytes = new TextEncoder().encode("expected")
		const digest = sha256(bytes)
		const hex = digest.slice("sha256:".length)
		const target = path.join(root, "sha256", hex.slice(0, 2), hex)
		await fs.mkdir(path.dirname(target), { recursive: true })
		await fs.writeFile(target, "wrong")
		await expect(store.put({ attemptId: "one", kind: "other", bytes, mediaType: "text/plain" })).rejects.toThrow(
			"Artifact collision",
		)
		expect(
			await store.get({
				schemaVersion: 1,
				id: `sha256:${"f".repeat(64)}`,
				attemptId: "one",
				kind: "other",
				digest: `sha256:${"f".repeat(64)}`,
				mediaType: "text/plain",
				sizeBytes: 1,
				access: "private",
				retention: "campaign",
				uploadState: "complete",
				createdAt: "2026-01-01T00:00:00.000Z",
			}),
		).toBeUndefined()
	})

	it("rejects reconstruction when integrity is invalid", async () => {
		const { bundle, store } = await fixture()
		bundle.events = []
		await expect(
			import("../reconstruct").then(({ reconstructEvidenceBundle }) =>
				reconstructEvidenceBundle(bundle, store, path.join(os.tmpdir(), "invalid-reconstruction")),
			),
		).rejects.toThrow("Evidence integrity failed")
	})

	it("supports binary and object evidence values and optional integrity policies", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-values-"))
		const store = new FilesystemArtifactStore(root)
		const values: RequiredEvidence = {
			...requiredEvidence,
			final_diff: new TextEncoder().encode("binary canary"),
			usage: { tokens: 12 },
		}
		const artifacts = await collectRequiredEvidence(identity.attemptId, values, store, { secrets: ["canary"] })
		const bundle = createBundle(artifacts)
		bundle.events[0]!.late = true
		expect(
			await validateEvidenceBundle(bundle, store, {
				allowLateEventTypes: [bundle.events[0]!.type],
				requireAllArtifacts: false,
			}),
		).toEqual({ valid: true, issues: [] })
		bundle.artifacts[0]!.attemptId = "wrong"
		expect((await validateEvidenceBundle(bundle, store)).issues.map(({ code }) => code)).toContain(
			"identity_mismatch",
		)
	})

	it.each([
		{ timedOut: true, exitCode: null, stderr: "timeout" },
		{ timedOut: false, exitCode: 1, stderr: "failed" },
	])("rejects workspace evidence when a structured Git command fails", async (result) => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-git-failure-"))
		const store = new FilesystemArtifactStore(path.join(root, "store"))
		await expect(
			collectWorkspaceEvidence({
				attemptId: "failed",
				workspace: root,
				stopReason: "failed",
				store,
				processRunner: {
					run: async () => ({ ...result, stdout: "", durationMs: 1, outputTruncated: false }),
				},
			}),
		).rejects.toThrow("git")
	})
})

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-valid-"))
	const store = new FilesystemArtifactStore(root)
	const artifacts = await collectRequiredEvidence(identity.attemptId, requiredEvidence, store)
	return { bundle: createBundle(artifacts), store }
}

function createBundle(artifacts: EvidenceBundle["artifacts"]): EvidenceBundle {
	const journal = new EventJournal(identity)
	journal.append("attempt.completed", { status: "passed" }, "2026-01-01T00:00:00.000Z")
	return {
		schemaVersion: 1,
		...identity,
		taskIdentity: "task@1:sha256:task",
		variantIdentity: "variant@1:sha256:variant",
		events: journal.all(),
		artifacts,
	}
}
