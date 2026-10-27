import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { canonicalJson, sha256 } from "../../evidence/canonical"
import { evidenceBundleDigest } from "../../evidence/integrity"
import {
	ImprovementArtifactStore,
	privateArtifactStore,
	readBoundedFile,
	readOwnedFile,
	stageReference,
	type ImprovementStage,
	type StoredStage,
} from "../store"
import { createWorkflowEvidenceFixture } from "./workflowFixtures"

let root: string
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-improvement-store-"))
})
afterEach(async () => {
	const owned = path.resolve(root)
	expect(path.dirname(owned)).toBe(path.resolve(os.tmpdir()))
	expect(path.basename(owned)).toMatch(/^alpha-improvement-store-/)
	await fs.rm(owned, { recursive: true, force: true })
	vi.restoreAllMocks()
})

describe("immutable improvement artifacts", () => {
	it("imports real sealed CAS evidence without changing source identity", async () => {
		const { bundle, artifactsRoot } = await createWorkflowEvidenceFixture(root)
		const store = await ImprovementArtifactStore.open({ root: path.join(root, "loop"), iterationId: "iteration-1" })
		const imported = await store.importEvidence(bundle, artifactsRoot)
		expect(canonicalJson(imported)).toBe(canonicalJson(bundle))
		for (const artifact of imported.artifacts)
			expect(sha256((await store.artifacts.get(artifact))!)).toBe(artifact.digest)
		const capture = await store.write({ id: "capture", stage: "capture", value: { bundle: imported } })
		expect(capture.manifest.artifact.access).toBe("private")
		expect(await store.read(stageReference(capture.manifest))).toEqual(capture)
	})

	it("publishes once, resumes identical stages, and rejects divergent ID reuse", async () => {
		const store = await ImprovementArtifactStore.open({ root, iterationId: "iteration-1" })
		const first = await store.write({ id: "annotation", stage: "feedback", value: { finding: "observed failure" } })
		expect(
			await store.write({ id: "annotation", stage: "feedback", value: { finding: "observed failure" } }),
		).toEqual(first)
		await expect(
			store.write({ id: "annotation", stage: "feedback", value: { finding: "changed" } }),
		).rejects.toThrow("different immutable")
		const entries = await fs.readdir(path.join(root, "iterations", "iteration-1", "records"))
		expect(entries).toEqual(["annotation.json"])
	})

	it("verifies every parent and rejects stale references or tampered stage bytes", async () => {
		const store = await ImprovementArtifactStore.open({ root, iterationId: "iteration-1" })
		const first = await store.write({ id: "capture", stage: "capture", value: { original: true } })
		const parent = stageReference(first.manifest)
		await expect(
			store.write({ id: "bad", stage: "feedback", inputs: [{ ...parent, digest: sha256("other") }], value: {} }),
		).rejects.toThrow("reference")
		const child = await store.write({
			id: "child",
			stage: "feedback",
			inputs: [parent],
			value: { observation: true },
		})
		const hex = first.manifest.artifact.digest.slice(7)
		await fs.writeFile(path.join(root, "artifacts", "sha256", hex.slice(0, 2), hex), "modified")
		await expect(store.read(child.manifest.id)).rejects.toThrow()
	})

	it("bounds traversal of shared ancestry rather than rereading an exponential DAG", async () => {
		const store = await ImprovementArtifactStore.open({ root, iterationId: "iteration-1" })
		const stages: StoredStage[] = []
		for (let index = 0; index < 14; index++) {
			stages.push(
				await store.write({
					id: `node-${index}`,
					stage: "report",
					inputs: stages.slice(-2).map(({ manifest }) => stageReference(manifest)),
					value: { index },
				}),
			)
		}
		const get = vi.spyOn(store.artifacts, "get")
		await store.read("node-13")
		expect(get).toHaveBeenCalledTimes(14)
	}, 15000)

	it("rejects combined ancestry beyond the reader bound before publishing and preserves failed evidence", async () => {
		const store = await ImprovementArtifactStore.open({ root, iterationId: "iteration-1" })
		const failure = { outcome: "failed", failure: { code: "missing_tool_result" } }
		const first = await store.write({ id: "observed-failure", stage: "capture", value: failure })
		const records = path.join(root, "iterations", "iteration-1", "records")
		const seed = async (id: string, inputs: StoredStage["manifest"]["inputs"]) => {
			const { digest: _digest, ...original } = first.manifest
			const body = { ...original, id, stage: "report" as const, inputs }
			const manifest = { ...body, digest: sha256(canonicalJson(body)) }
			await fs.writeFile(path.join(records, `${id}.json`), canonicalJson(manifest))
			return stageReference(manifest)
		}
		// Each 128-record chain is readable alone; adding their common child would require 257 records.
		let left = stageReference(first.manifest)
		for (let index = 1; index < 128; index++) left = await seed(`left-${index}`, [left])
		let right = await seed("right-0", [])
		for (let index = 1; index < 128; index++) right = await seed(`right-${index}`, [right])
		const put = vi.spyOn(store.artifacts, "put")
		await expect(
			store.write({ id: "unreadable-child", stage: "report", inputs: [left, right], value: { final: true } }),
		).rejects.toThrow(/ancestry.*bound/i)
		expect(put).not.toHaveBeenCalled()
		await expect(fs.lstat(path.join(records, "unreadable-child.json"))).rejects.toMatchObject({ code: "ENOENT" })
		const rightParent = (await store.read(right)).manifest.inputs[0]!
		const boundary = await store.write({
			id: "readable-child",
			stage: "report",
			inputs: [left, rightParent],
			value: { final: true },
		})
		expect(await store.read(stageReference(boundary.manifest))).toEqual(boundary)
		expect((await store.read(stageReference(first.manifest))).value).toEqual(failure)
		// Two 128-record filesystem chains exercise the reader bound, not latency.
	}, 60_000)

	it.each(["duplicate-parent", "unknown-stage"] as const)(
		"rejects unsupported sealed ancestry on resume without rewriting it: %s",
		async (mutation) => {
			const store = await ImprovementArtifactStore.open({ root, iterationId: "iteration-1" })
			const first = await store.write({ id: "failure", stage: "capture", value: { outcome: "failed" } })
			const parent = stageReference(first.manifest)
			const child = await store.write({ id: "child", stage: "report", inputs: [parent], value: {} })
			const { digest: _digest, ...original } = child.manifest
			const body = {
				...original,
				...(mutation === "duplicate-parent" ? { inputs: [parent, parent] } : { stage: "future-stage" }),
			}
			const bytes = canonicalJson({ ...body, digest: sha256(canonicalJson(body)) })
			const file = path.join(root, "iterations", "iteration-1", "records", "child.json")
			await fs.writeFile(file, bytes)
			await expect(store.read("child")).rejects.toThrow()
			expect(await fs.readFile(file, "utf8")).toBe(bytes)
			expect((await store.read(parent)).value).toEqual({ outcome: "failed" })
		},
	)

	it("snapshots requested stage identity and nested content before asynchronous ancestry verification", async () => {
		const store = await ImprovementArtifactStore.open({ root, iterationId: "iteration-1" })
		const first = await store.write({ id: "failure", stage: "capture", value: { outcome: "failed" } })
		let entered!: () => void
		const verified = new Promise<void>((resolve) => {
			entered = resolve
		})
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const read = store.artifacts.get.bind(store.artifacts)
		vi.spyOn(store.artifacts, "get").mockImplementation(async (descriptor) => {
			const bytes = await read(descriptor)
			entered()
			await gate
			return bytes
		})
		const request = {
			id: "review",
			stage: "feedback" as ImprovementStage,
			inputs: [stageReference(first.manifest)],
			requestDigest: sha256("original-request"),
			value: { findings: [{ outcome: "failed" }] },
		}
		const pending = store.write(request)
		try {
			await verified
			request.id = "changed-id"
			request.stage = "report"
			request.requestDigest = sha256("changed-request")
			request.value.findings[0]!.outcome = "passed"
			request.inputs[0]!.digest = sha256("changed-parent")
		} finally {
			release()
		}
		const stored = await pending
		expect(stored.manifest).toMatchObject({
			id: "review",
			stage: "feedback",
			requestDigest: sha256("original-request"),
			inputs: [stageReference(first.manifest)],
		})
		expect(stored.value).toEqual({ findings: [{ outcome: "failed" }] })
		expect(await store.read("review")).toEqual(stored)
		await expect(store.read("changed-id")).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("rejects descriptor-size lies and existing oversized CAS before reading through the generic writer", async () => {
		const store = privateArtifactStore(root)
		const artifact = await store.put({
			attemptId: "a",
			kind: "other",
			bytes: Buffer.from("value"),
			mediaType: "text/plain",
		})
		await expect(store.get({ ...artifact, sizeBytes: 1 })).rejects.toThrow("bounded regular file")
		const hex = artifact.digest.slice(7)
		await fs.writeFile(path.join(root, "sha256", hex.slice(0, 2), hex), "unexpected longer content")
		await expect(
			store.put({ attemptId: "a", kind: "other", bytes: Buffer.from("value"), mediaType: "text/plain" }),
		).rejects.toThrow("bounded regular file")
	})

	it("rejects traversal, outside relative paths, links, and nonregular input", async () => {
		await expect(ImprovementArtifactStore.open({ root, iterationId: "NUL" })).rejects.toThrow("Reserved")
		await fs.mkdir(path.join(root, "real"))
		await fs.writeFile(path.join(root, "real", "value.json"), "{}")
		await expect(readOwnedFile(root, "../value.json")).rejects.toThrow("contained")
		await expect(
			readBoundedFile(`${root}${path.sep}real${path.sep}..${path.sep}real${path.sep}value.json`),
		).rejects.toThrow("traversal")
		await expect(readBoundedFile(path.join(root, "real"))).rejects.toThrow("regular file")
		await fs.symlink(path.join(root, "real"), path.join(root, "alias"), "junction")
		await expect(readOwnedFile(root, "alias/value.json")).rejects.toThrow("Symlink")
	})

	it("rejects unsealed or secret-bearing evidence and records", async () => {
		const { bundle, artifactsRoot } = await createWorkflowEvidenceFixture(root)
		const store = await ImprovementArtifactStore.open({
			root: path.join(root, "loop"),
			iterationId: "iteration-1",
			secrets: ["private-secret-value"],
		})
		await expect(store.importEvidence({ ...bundle, bundleDigest: sha256("wrong") }, artifactsRoot)).rejects.toThrow(
			"seal",
		)
		await expect(
			store.write({ id: "secret", stage: "feedback", value: { finding: "private-secret-value" } }),
		).rejects.toThrow("credentials")
		const changed = structuredClone(bundle)
		changed.events[0]!.payload = "private-secret-value"
		changed.events[0]!.payloadDigest = sha256(canonicalJson(changed.events[0]!.payload))
		changed.bundleDigest = evidenceBundleDigest(changed)
		await expect(store.importEvidence(changed, artifactsRoot)).rejects.toThrow("credentials")
	})
})
