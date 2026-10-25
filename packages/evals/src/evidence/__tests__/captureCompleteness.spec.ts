import { describe, expect, it } from "vitest"

import { collectRequiredEvidence, type RequiredEvidence } from "../collector"
import { EventJournal } from "../eventJournal"
import { evidenceBundleDigest, validateEvidenceBundle } from "../integrity"
import { sha256 } from "../canonical"
import { parseWorkspaceSnapshot } from "../workspaceSnapshot"
import type { ContentAddressedArtifactStore } from "../artifactStore"
import { REQUIRED_ARTIFACT_KINDS, type EvidenceBundle } from "../types"

function fixture() {
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
				access: "reviewer",
				retention: "campaign",
				uploadState: "complete",
				captureStatus: input.captureStatus ?? (input.bytes.length ? "captured" : "captured-empty"),
				createdAt: "2026-10-23T00:00:00.000Z",
			}
		},
		get: async (descriptor) => bytes.get(descriptor.digest),
	}
	const evidence = Object.fromEntries(
		REQUIRED_ARTIFACT_KINDS.map((kind) => [kind, `${kind} evidence`]),
	) as RequiredEvidence
	evidence.final_diff = ""
	evidence.git_status = ""
	const journal = new EventJournal({ runId: "run", trialId: "trial", attemptId: "attempt" })
	journal.append("attempt.completed", { status: "passed" })
	const bundle: EvidenceBundle = {
		schemaVersion: 1,
		runId: "run",
		trialId: "trial",
		attemptId: "attempt",
		taskIdentity: "task",
		variantIdentity: "variant",
		events: journal.all(),
		artifacts: [],
	}
	return { store, evidence, bundle }
}

describe("artifact capture completeness", () => {
	it("removes configured secrets from property names without dropping colliding observations", async () => {
		const { store, evidence, bundle } = fixture()
		const secret = "trace-canary/one two"
		const payload = Object.fromEntries(
			[secret, Buffer.from(secret).toString("base64"), encodeURIComponent(secret)].map((key, index) => [
				key,
				index + 1,
			]),
		)
		evidence.transcript = payload
		bundle.artifacts = await collectRequiredEvidence("attempt", evidence, store, { secrets: [secret] })
		const transcript = bundle.artifacts.find(({ kind }) => kind === "transcript")
		if (!transcript) throw new Error("Fixture must retain a transcript artifact")
		const retained = new TextDecoder().decode(await store.get(transcript))
		for (const variant of [secret, Buffer.from(secret).toString("base64"), encodeURIComponent(secret)])
			expect(retained).not.toContain(variant)
		expect(Object.values(JSON.parse(retained))).toEqual([1, 2, 3])
		const journal = new EventJournal(
			{ runId: "run", trialId: "trial", attemptId: "attempt" },
			{ secrets: [secret] },
		)
		journal.append("tool.completed", payload)
		expect(JSON.stringify(journal.all())).not.toContain(secret)
	})

	it.each(["line1\nline2", "path\\canary", 'quoted"canary'])(
		"redacts a configured secret already escaped inside a serialized transcript: %j",
		async (secret) => {
			const { store, evidence, bundle } = fixture()
			evidence.transcript = JSON.stringify([{ role: "user", text: secret }])
			bundle.artifacts = await collectRequiredEvidence("attempt", evidence, store, { secrets: [secret] })
			const transcript = bundle.artifacts.find(({ kind }) => kind === "transcript")
			if (!transcript) throw new Error("Fixture must retain a transcript artifact")
			const retained = new TextDecoder().decode(await store.get(transcript))
			expect(retained).not.toContain(JSON.stringify(secret).slice(1, -1))
			expect(JSON.parse(retained)).toEqual([{ role: "user", text: expect.stringContaining("REDACTED") }])
		},
	)

	it.each(["final_response", "test_output", "tree_digest"] as const)(
		"rejects conflicting duplicate %s descriptors under a valid content seal",
		async (kind) => {
			const { store, evidence, bundle } = fixture()
			bundle.artifacts = await collectRequiredEvidence("attempt", evidence, store)
			bundle.artifacts.push(
				await store.put({
					attemptId: "attempt",
					kind,
					bytes: new TextEncoder().encode("conflicting retained observation"),
					mediaType: "text/plain",
				}),
			)
			bundle.bundleDigest = evidenceBundleDigest(bundle)
			for (const requireAllArtifacts of [true, false]) {
				const result = await validateEvidenceBundle(bundle, store, { requireAllArtifacts })
				expect(result.valid).toBe(false)
				expect(result.issues).toContainEqual({
					code: "artifact_duplicate",
					detail: `multiple required artifacts ${kind}`,
				})
			}
		},
	)

	it("permits multiple grader evidence records while requiring one authoritative task artifact per kind", async () => {
		const { store, evidence, bundle } = fixture()
		bundle.artifacts = await collectRequiredEvidence("attempt", evidence, store)
		for (const value of ["first grader", "second grader"])
			bundle.artifacts.push(
				await store.put({
					attemptId: "attempt",
					kind: "grader_evidence",
					bytes: new TextEncoder().encode(value),
					mediaType: "text/plain",
				}),
			)
		expect((await validateEvidenceBundle(bundle, store)).valid).toBe(true)
	})

	it("retains a SHA-256 Git baseline identity", () => {
		expect(
			parseWorkspaceSnapshot({ schemaVersion: 1, baselineCommit: "a".repeat(64), files: [] }).baselineCommit,
		).toBe("a".repeat(64))
	})
	it.each(["../escape", "C:/escape", "dir\\escape", ".git/config", "nul.txt"])(
		"rejects unsafe retained workspace path %s",
		(unsafePath) => {
			expect(() =>
				parseWorkspaceSnapshot({
					schemaVersion: 1,
					files: [{ path: unsafePath, bytesBase64: "", digest: sha256(""), executable: false }],
				}),
			).toThrow()
		},
	)

	it("rejects hashed empty required captures while permitting a valid empty diff and status", async () => {
		const { store, evidence, bundle } = fixture()
		bundle.artifacts = await collectRequiredEvidence("attempt", evidence, store)
		expect((await validateEvidenceBundle(bundle, store)).valid).toBe(true)
		bundle.artifacts = await collectRequiredEvidence(
			"attempt",
			Object.fromEntries(REQUIRED_ARTIFACT_KINDS.map((kind) => [kind, ""])) as RequiredEvidence,
			store,
		)
		expect((await validateEvidenceBundle(bundle, store)).issues).toContainEqual(
			expect.objectContaining({ code: "artifact_capture_incomplete" }),
		)
	})

	it.each(["missing", "unavailable", "failed"] as const)(
		"retains %s status and requires actual final capture",
		async (captureStatus) => {
			const { store, evidence, bundle } = fixture()
			evidence.test_output = undefined
			bundle.artifacts = await collectRequiredEvidence("attempt", evidence, store, {
				captureStatuses: { test_output: captureStatus },
			})
			expect(bundle.artifacts.find(({ kind }) => kind === "test_output")!.captureStatus).toBe(captureStatus)
			expect((await validateEvidenceBundle(bundle, store)).valid).toBe(false)
			expect(
				(await validateEvidenceBundle(bundle, store, { allowUnavailableArtifacts: ["test_output"] })).valid,
			).toBe(captureStatus === "unavailable")
		},
	)

	it("distinguishes absent capture from a silent verifier and binds all metadata to the seal", async () => {
		const { store, evidence, bundle } = fixture()
		evidence.test_output = ""
		bundle.artifacts = await collectRequiredEvidence("attempt", evidence, store)
		expect(bundle.artifacts.find(({ kind }) => kind === "test_output")!.captureStatus).toBe("captured-empty")
		bundle.bundleDigest = evidenceBundleDigest(bundle)
		expect((await validateEvidenceBundle(bundle, store)).valid).toBe(true)
		bundle.variantIdentity = "different"
		expect((await validateEvidenceBundle(bundle, store)).issues).toContainEqual(
			expect.objectContaining({ code: "bundle_digest_mismatch" }),
		)
	})
})
