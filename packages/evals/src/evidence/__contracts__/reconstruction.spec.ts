import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
	collectRequiredEvidence,
	collectWorkspaceEvidence,
	EventJournal,
	FilesystemArtifactStore,
	reconstructEvidenceBundle,
	REQUIRED_ARTIFACT_KINDS,
	validateEvidenceBundle,
	readEvidenceLog,
	type EvidenceBundle,
	type RequiredEvidence,
} from "../index"
import { ExecaHarnessProcessRunner } from "../../orchestration/index"

describe("M4 reconstruction contract", () => {
	it("collects the final tracked and untracked workspace without mutating it", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "m4-workspace-"))
		const workspace = path.join(root, "workspace")
		const store = new FilesystemArtifactStore(path.join(root, "store"))
		const runner = new ExecaHarnessProcessRunner()
		await fs.mkdir(workspace)
		for (const args of [
			["init"],
			["config", "user.email", "evals@alpha.invalid"],
			["config", "user.name", "Alpha Evals"],
		] as const) {
			expect(
				(
					await runner.run({
						command: "git",
						args: [...args],
						cwd: workspace,
						timeoutMs: 10_000,
						maxOutputBytes: 10_000,
					})
				).exitCode,
			).toBe(0)
		}
		await fs.writeFile(path.join(workspace, "tracked.txt"), "initial")
		for (const args of [
			["add", "tracked.txt"],
			["commit", "-m", "fixture"],
		] as const) {
			expect(
				(
					await runner.run({
						command: "git",
						args: [...args],
						cwd: workspace,
						timeoutMs: 10_000,
						maxOutputBytes: 10_000,
					})
				).exitCode,
			).toBe(0)
		}
		await fs.writeFile(path.join(workspace, "tracked.txt"), "changed")
		await fs.writeFile(path.join(workspace, "untracked.txt"), "new")
		const descriptors = await collectWorkspaceEvidence({
			attemptId: "attempt",
			workspace,
			extensionLog: "log canary-secret",
			transcript: "transcript",
			finalResponse: "done",
			testOutput: "tests passed",
			usage: { tokens: 12 },
			stopReason: "completed",
			processRunner: runner,
			store,
			secrets: ["canary-secret"],
		})
		expect(descriptors).toHaveLength(REQUIRED_ARTIFACT_KINDS.length)
		expect(descriptors.every(({ uploadState }) => uploadState === "complete")).toBe(true)
		expect(await fs.readFile(path.join(workspace, "tracked.txt"), "utf8")).toBe("changed")
		expect(await readEvidenceLog(path.join(root, "missing.log"))).toBe("")
		const logPath = path.join(root, "extension.log")
		await fs.writeFile(logPath, "retained")
		expect(await readEvidenceLog(logPath)).toBe("retained")
		const fallbackDescriptors = await collectWorkspaceEvidence({
			attemptId: "fallback",
			workspace,
			stopReason: "completed",
			processRunner: runner,
			store,
		})
		expect(fallbackDescriptors).toHaveLength(REQUIRED_ARTIFACT_KINDS.length)
		await expect(readEvidenceLog(root)).rejects.toThrow()
	})

	it("reconstructs the same verified bundle after the source workspace is destroyed", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "m4-contract-"))
		const workspace = path.join(root, "runner-workspace")
		const artifactRoot = path.join(root, "artifact-store")
		const output = path.join(root, "review")
		await fs.mkdir(workspace)
		await fs.writeFile(path.join(workspace, "result.txt"), "runner result")
		const store = new FilesystemArtifactStore(artifactRoot)
		const evidence = Object.fromEntries(
			await Promise.all(
				REQUIRED_ARTIFACT_KINDS.map(async (kind) => [
					kind,
					kind === "final_diff"
						? await fs.readFile(path.join(workspace, "result.txt"), "utf8")
						: `${kind} value`,
				]),
			),
		) as RequiredEvidence
		const artifacts = await collectRequiredEvidence("attempt-1", evidence, store)
		const journal = new EventJournal({ runId: "run-1", trialId: "trial-1", attemptId: "attempt-1" })
		journal.append("attempt.completed", { status: "passed" }, "2026-01-01T00:00:00.000Z")
		const bundle: EvidenceBundle = {
			schemaVersion: 1,
			runId: "run-1",
			trialId: "trial-1",
			attemptId: "attempt-1",
			taskIdentity: "task@1:sha256:task",
			variantIdentity: "variant@1:sha256:variant",
			events: journal.all(),
			artifacts,
		}
		await fs.rm(workspace, { recursive: true })
		expect((await validateEvidenceBundle(bundle, store)).valid).toBe(true)
		await reconstructEvidenceBundle(bundle, store, output)
		const firstManifest = await fs.readFile(path.join(output, "manifest.json"), "utf8")
		await fs.rm(output, { recursive: true })
		await reconstructEvidenceBundle(bundle, store, output)
		expect(await fs.readFile(path.join(output, "manifest.json"), "utf8")).toBe(firstManifest)
		expect(await fs.readdir(path.join(output, "artifacts"))).toHaveLength(REQUIRED_ARTIFACT_KINDS.length)
	})
})
