import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
	collectWorkspaceEvidence,
	EventJournal,
	FilesystemArtifactStore,
	reconstructEvidenceBundle,
	type EvidenceBundle,
} from "../index"
import { ExecaHarnessProcessRunner } from "../../orchestration/processRunner"

describe("final workspace reconstruction", () => {
	it("refuses to retain configured multiline secrets in final file bytes", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-snapshot-secret-"))
		const workspace = path.join(root, "source")
		const runner = new ExecaHarnessProcessRunner()
		try {
			await fs.mkdir(workspace)
			const initialized = await runner.run({
				command: "git",
				args: ["init"],
				cwd: workspace,
				timeoutMs: 10_000,
				maxOutputBytes: 10_000,
			})
			expect(initialized.exitCode).toBe(0)
			await fs.writeFile(path.join(workspace, "source.txt"), "line1\nline2")
			await expect(
				collectWorkspaceEvidence({
					attemptId: "attempt",
					workspace,
					processRunner: runner,
					store: new FilesystemArtifactStore(path.join(root, "store")),
					stopReason: "completed",
					secrets: ["line1\nline2"],
				}),
			).rejects.toThrow("protected secret material")
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})

	it.each(["unstaged", "staged", "committed", "new", "ignored-new", "deleted", "renamed"])(
		"restores and independently verifies %s results after disposal",
		async (change) => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-snapshot-contract-"))
			const workspace = path.join(root, "source")
			const store = new FilesystemArtifactStore(path.join(root, "store"))
			const runner = new ExecaHarnessProcessRunner()
			const git = async (...args: string[]) => {
				const result = await runner.run({
					command: "git",
					args: ["-c", "core.hooksPath=", ...args],
					cwd: workspace,
					timeoutMs: 10_000,
					maxOutputBytes: 1024 * 1024,
				})
				expect(result.exitCode).toBe(0)
				return result.stdout.trim()
			}
			try {
				await fs.mkdir(workspace)
				await fs.writeFile(path.join(workspace, "value.cjs"), "module.exports = 1\n")
				await fs.writeFile(path.join(workspace, "obsolete.txt"), "obsolete")
				await fs.writeFile(path.join(workspace, "binary.bin"), Buffer.from([0, 255, 128, 13, 10]))
				await git("init")
				await git("config", "user.email", "snapshot@example.invalid")
				await git("config", "user.name", "Snapshot Contract")
				await git("add", ".")
				await git("commit", "-m", "baseline")
				const baselineCommit = await git("rev-parse", "HEAD")
				await fs.writeFile(path.join(workspace, "value.cjs"), "module.exports = 2\n")
				if (change === "staged" || change === "committed") await git("add", ".")
				if (change === "committed") await git("commit", "-m", "agent result")
				if (change === "new") await fs.writeFile(path.join(workspace, "new.cjs"), "module.exports = 3\n")
				if (change === "ignored-new") {
					await fs.writeFile(path.join(workspace, ".gitignore"), "new.cjs\n")
					await fs.writeFile(path.join(workspace, "new.cjs"), "module.exports = 3\n")
				}
				if (change === "deleted") await fs.rm(path.join(workspace, "obsolete.txt"))
				if (change === "renamed")
					await fs.rename(path.join(workspace, "obsolete.txt"), path.join(workspace, "renamed.txt"))
				const artifacts = await collectWorkspaceEvidence({
					attemptId: "attempt",
					workspace,
					baselineCommit,
					extensionLog: "extension completed",
					transcript: "[]",
					finalResponse: "implemented",
					testOutput: "verified",
					usage: { requests: 1 },
					stopReason: "completed",
					processRunner: runner,
					store,
				})
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
					artifacts,
				}
				await fs.rm(workspace, { recursive: true, force: true })
				const output = path.join(root, "review")
				await reconstructEvidenceBundle(bundle, store, output)
				const restored = path.join(output, "workspace")
				const checked = await runner.run({
					command: process.execPath,
					args: ["-e", "require('node:assert/strict').equal(require('./value.cjs'), 2)"],
					cwd: restored,
					timeoutMs: 10_000,
					maxOutputBytes: 10_000,
				})
				expect(checked.exitCode).toBe(0)
				expect(await fs.readFile(path.join(restored, "binary.bin"))).toEqual(Buffer.from([0, 255, 128, 13, 10]))
				if (change === "new" || change === "ignored-new")
					expect(await fs.readFile(path.join(restored, "new.cjs"), "utf8")).toContain("3")
				if (change === "deleted" || change === "renamed")
					await expect(fs.stat(path.join(restored, "obsolete.txt"))).rejects.toMatchObject({ code: "ENOENT" })
				if (change === "renamed")
					expect(await fs.readFile(path.join(restored, "renamed.txt"), "utf8")).toBe("obsolete")
			} finally {
				await fs.rm(root, { recursive: true, force: true })
			}
		},
		60_000,
	)
})
