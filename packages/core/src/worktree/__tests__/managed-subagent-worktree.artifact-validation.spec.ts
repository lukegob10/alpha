import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import {
	ManagedSubagentWorktreeService,
	type ManagedWorkerArtifact,
	type ManagedWorkerCreationOptions,
} from "../managed-subagent-worktree.js"

const execFileAsync = promisify(execFile)
const TIMEOUT = 30_000

// Artifact recovery exercises real Git processes; use the fixture's I/O budget on Windows too.
vi.setConfig({ testTimeout: TIMEOUT })

describe("Managed worker artifact validation", () => {
	let fixtureRoot: string
	let originalArtifact: ManagedWorkerArtifact
	let proposalFiles: Array<{ name: string; content: Buffer }>
	let root: string
	let repo: string
	let storage: string
	let directory: string
	let metadataPath: string
	let artifact: ManagedWorkerArtifact
	let service: ManagedSubagentWorktreeService

	const expectRejectedSinks = async (message: RegExp, includeTaskDeletion = true) => {
		for (const operation of [
			() => service.load(storage, artifact.id),
			() => service.getDiffFiles(storage, artifact.id),
			() => service.capture(storage, artifact.id),
			() => service.apply(storage, artifact.id),
			() => service.discard(storage, artifact.id),
			() => service.deleteArtifact(storage, artifact.id),
		]) {
			await expect(operation()).rejects.toThrow(message)
		}
		const recovered = await service.recoverOrphans(storage)
		expect(recovered.map((candidate) => candidate.id)).not.toContain(artifact.id)
		if (includeTaskDeletion) {
			await expect(service.deleteArtifactsForTasks(storage, [artifact.taskId])).rejects.toThrow(message)
		}
	}

	beforeAll(async () => {
		fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-artifact-source-"))
		repo = path.join(fixtureRoot, "repo")
		const captureStorage = path.join(fixtureRoot, "storage")
		await fs.mkdir(repo)
		for (const args of [
			["init"],
			["config", "user.name", "Test"],
			["config", "user.email", "test@example.invalid"],
			["config", "core.autocrlf", "false"],
		]) {
			await execFileAsync("git", args, { cwd: repo, windowsHide: true })
		}
		await fs.writeFile(path.join(repo, "value.txt"), "baseline\n")
		await fs.writeFile(path.join(repo, "keep.txt"), "keep\n")
		await execFileAsync("git", ["add", "."], { cwd: repo, windowsHide: true })
		await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repo, windowsHide: true })
		service = new ManagedSubagentWorktreeService()
		const worker = await service.create(captureStorage, "worker", await service.validateScope(repo, ["value.txt"]))
		await fs.writeFile(path.join(worker.workspacePath, "value.txt"), "worker result\n")
		originalArtifact = await service.capture(captureStorage, worker.artifact.id)
		expect(originalArtifact.status).toBe("pending_review")
		const originalDirectory = path.join(captureStorage, "subagent-change-sets", originalArtifact.id)
		proposalFiles = []
		for (const name of await fs.readdir(originalDirectory)) {
			proposalFiles.push({ name, content: await fs.readFile(path.join(originalDirectory, name)) })
		}
		await service.deleteArtifact(captureStorage, originalArtifact.id)
	}, TIMEOUT * 2)

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-artifact-case-"))
		storage = path.join(root, "storage")
		artifact = structuredClone(originalArtifact)
		directory = path.join(storage, "subagent-change-sets", artifact.id)
		metadataPath = path.join(directory, "metadata.json")
		await fs.mkdir(directory, { recursive: true })
		for (const { name, content } of proposalFiles) await fs.writeFile(path.join(directory, name), content)
		await fs.rm(path.join(repo, "value.txt"), { force: true })
		await fs.writeFile(path.join(repo, "value.txt"), "baseline\n")
		await fs.writeFile(path.join(repo, "keep.txt"), "keep\n")
		service = new ManagedSubagentWorktreeService()
	}, TIMEOUT)

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(root, { recursive: true, force: true })
	}, TIMEOUT)

	afterAll(async () => {
		await fs.rm(fixtureRoot, { recursive: true, force: true })
	}, TIMEOUT)

	it("preserves an external canary when only a generated proposal's patch reference is tampered", async () => {
		const canary = path.join(root, "outside-proposal-canary.txt")
		await fs.writeFile(canary, "must survive proposal discard")
		await fs.writeFile(metadataPath, JSON.stringify({ ...artifact, patchFile: path.relative(directory, canary) }))
		const settlement = await service.discard(storage, artifact.id).then(
			() => "accepted",
			() => "rejected",
		)
		expect(await fs.readFile(canary, "utf8")).toBe("must survive proposal discard")
		expect(settlement).toBe("rejected")
	})

	it.each(["undeclared path", "declared content", "declared mode"] as const)(
		"rejects a patch with altered %s before changing parent files or index",
		async (tampering) => {
			const patchPath = path.join(directory, artifact.patchFile!)
			const originalPatch = await fs.readFile(patchPath, "utf8")
			const patch =
				tampering === "undeclared path"
					? `${originalPatch}diff --git a/keep.txt b/keep.txt\n--- a/keep.txt\n+++ b/keep.txt\n@@ -1 +1 @@\n-keep\n+outside scope changed\n`
					: tampering === "declared content"
						? originalPatch.replace("+worker result\n", "+altered result\n")
						: originalPatch.replace(/(index [^\n]+) 100644\n/, "old mode 100644\nnew mode 100755\n$1\n")
			expect(patch).not.toBe(originalPatch)
			await fs.writeFile(patchPath, patch)
			const metadataBefore = await fs.readFile(metadataPath)
			const indexBefore = await fs.readFile(path.join(repo, ".git/index"))
			const failure = await service.apply(storage, artifact.id).then(
				() => undefined,
				(error: unknown) => error,
			)

			expect(await fs.readFile(path.join(repo, "value.txt"), "utf8")).toBe("baseline\n")
			expect(await fs.readFile(path.join(repo, "keep.txt"), "utf8")).toBe("keep\n")
			expect(await fs.readFile(path.join(repo, ".git/index"))).toEqual(indexBefore)
			expect(await fs.readFile(metadataPath)).toEqual(metadataBefore)
			expect(await fs.readFile(patchPath, "utf8")).toBe(patch)
			expect(failure).toBeInstanceOf(Error)
			expect((await service.load(storage, artifact.id)).status).toBe("pending_review")
		},
		TIMEOUT,
	)

	it("checks patch integrity before recognizing a previously applied after-state", async () => {
		await fs.writeFile(path.join(repo, "value.txt"), "worker result\n")
		const patchPath = path.join(directory, artifact.patchFile!)
		await fs.appendFile(
			patchPath,
			"diff --git a/keep.txt b/keep.txt\n--- a/keep.txt\n+++ b/keep.txt\n@@ -1 +1 @@\n-keep\n+outside scope changed\n",
		)

		await expect(service.apply(storage, artifact.id)).rejects.toThrow()
		expect((await service.load(storage, artifact.id)).status).toBe("pending_review")
		expect(await fs.readFile(path.join(repo, "value.txt"), "utf8")).toBe("worker result\n")
		expect(await fs.readFile(path.join(repo, "keep.txt"), "utf8")).toBe("keep\n")
	})

	it("retains an applied receipt after its proposal exports were cleaned up", async () => {
		await expect(service.apply(storage, artifact.id)).resolves.toEqual({ status: "applied" })
		const receipt = await service.load(storage, artifact.id)
		for (const file of [
			receipt.patchFile,
			...receipt.changes.flatMap((change) => [change.beforeFile, change.afterFile]),
		]) {
			if (file) await fs.unlink(path.join(directory, file))
		}
		delete receipt.patchFile
		await fs.writeFile(metadataPath, JSON.stringify(receipt))
		await fs.writeFile(path.join(repo, "value.txt"), "later external work\n")
		const indexBefore = await fs.readFile(path.join(repo, ".git/index"))

		await expect(service.apply(storage, artifact.id)).resolves.toEqual({ status: "applied" })
		expect(await fs.readFile(path.join(repo, "value.txt"), "utf8")).toBe("later external work\n")
		expect(await fs.readFile(path.join(repo, ".git/index"))).toEqual(indexBefore)
	})

	it("applies the validated buffer when the saved patch changes after proof", async () => {
		const patchPath = path.join(directory, artifact.patchFile!)
		const gitOwner = service as unknown as {
			git(
				cwd: string,
				args: string[],
				env?: NodeJS.ProcessEnv,
				creation?: ManagedWorkerCreationOptions,
				input?: Buffer,
			): Promise<string>
		}
		const actualGit = gitOwner.git.bind(service)
		let swapped = false
		vi.spyOn(gitOwner, "git").mockImplementation(async (cwd, args, env, creation, input) => {
			if (args[0] === "apply" && args.includes("--check")) {
				swapped = true
				await fs.appendFile(
					patchPath,
					"diff --git a/keep.txt b/keep.txt\n--- a/keep.txt\n+++ b/keep.txt\n@@ -1 +1 @@\n-keep\n+outside scope changed\n",
				)
			}
			return actualGit(cwd, args, env, creation, input)
		})
		const indexBefore = await fs.readFile(path.join(repo, ".git/index"))

		await expect(service.apply(storage, artifact.id)).resolves.toEqual({ status: "applied" })
		expect(swapped).toBe(true)
		expect(await fs.readFile(path.join(repo, "value.txt"), "utf8")).toBe("worker result\n")
		expect(await fs.readFile(path.join(repo, "keep.txt"), "utf8")).toBe("keep\n")
		expect(await fs.readFile(path.join(repo, ".git/index"))).toEqual(indexBefore)
	})

	it.each(["proof", "preflight", "prepared mutation", "revoked authority"] as const)(
		"retains the proposal and parent bytes when %s prevents apply",
		async (boundary) => {
			const cancellation = new AbortController()
			const reason = new Error(`Worker apply stopped at ${boundary}`)
			let authorized = true
			const validateBeforeMutation = vi.fn(() => {
				if (!authorized) throw reason
			})
			const gitOwner = service as unknown as {
				git(
					cwd: string,
					args: string[],
					env?: NodeJS.ProcessEnv,
					creation?: ManagedWorkerCreationOptions,
					input?: Buffer,
					validateMutation?: () => void,
				): Promise<string>
				prepareGitPaths(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<unknown>
			}
			const actualGit = gitOwner.git.bind(service)
			vi.spyOn(gitOwner, "git").mockImplementation(async (cwd, args, env, creation, input, validateMutation) => {
				const result = await actualGit(cwd, args, env, creation, input, validateMutation)
				if (args[0] === "apply") {
					if (boundary === "proof" && args.includes("--cached")) cancellation.abort(reason)
					if (args.includes("--check")) {
						if (boundary === "preflight") cancellation.abort(reason)
						if (boundary === "revoked authority") authorized = false
					}
				}
				return result
			})
			const actualPrepare = gitOwner.prepareGitPaths.bind(service)
			vi.spyOn(gitOwner, "prepareGitPaths").mockImplementation(async (cwd, args, env) => {
				const prepared = await actualPrepare(cwd, args, env)
				if (
					boundary === "prepared mutation" &&
					args[0] === "apply" &&
					!args.includes("--cached") &&
					!args.includes("--numstat") &&
					!args.includes("--check")
				)
					cancellation.abort(reason)
				return prepared
			})
			const metadataBefore = await fs.readFile(metadataPath)
			const indexBefore = await fs.readFile(path.join(repo, ".git/index"))

			await expect(
				service.apply(storage, artifact.id, {
					signal: cancellation.signal,
					terminateProcessTree: vi.fn(async () => undefined),
					validateBeforeMutation,
				}),
			).rejects.toBe(reason)
			expect(await fs.readFile(path.join(repo, "value.txt"), "utf8")).toBe("baseline\n")
			expect(await fs.readFile(path.join(repo, "keep.txt"), "utf8")).toBe("keep\n")
			expect(await fs.readFile(path.join(repo, ".git/index"))).toEqual(indexBefore)
			expect(await fs.readFile(metadataPath)).toEqual(metadataBefore)
			expect((await service.load(storage, artifact.id)).status).toBe("pending_review")
			if (boundary === "revoked authority") {
				expect(validateBeforeMutation).toHaveBeenCalledOnce()
				expect(validateBeforeMutation).toHaveBeenCalledWith(expect.objectContaining({ id: artifact.id }))
			}
		},
		TIMEOUT,
	)

	it.each(["missing commits", "legacy modes with core.filemode enabled"] as const)(
		"verifies exported blobs with %s",
		async (legacy) => {
			if (legacy === "missing commits") {
				artifact.baselineCommit = "0".repeat(40)
				delete artifact.resultCommit
			} else {
				delete artifact.changes[0]!.beforeMode
				delete artifact.changes[0]!.afterMode
			}
			await fs.writeFile(metadataPath, JSON.stringify(artifact))
			const indexBefore = await fs.readFile(path.join(repo, ".git/index"))
			const originalFileMode = String(
				(await execFileAsync("git", ["config", "--bool", "core.filemode"], { cwd: repo, windowsHide: true }))
					.stdout,
			).trim()
			try {
				if (legacy !== "missing commits") {
					await execFileAsync("git", ["config", "core.filemode", "true"], { cwd: repo, windowsHide: true })
				}

				await expect(service.apply(storage, artifact.id)).resolves.toEqual({ status: "applied" })
				expect(await fs.readFile(path.join(repo, "value.txt"), "utf8")).toBe("worker result\n")
				expect(await fs.readFile(path.join(repo, "keep.txt"), "utf8")).toBe("keep\n")
				expect(await fs.readFile(path.join(repo, ".git/index"))).toEqual(indexBefore)
			} finally {
				await execFileAsync("git", ["config", "core.filemode", originalFileMode], {
					cwd: repo,
					windowsHide: true,
				})
			}
		},
	)

	it("uses recovered legacy modes to reject a regular-file export replaced with a symlink", async ({ skip }) => {
		const originalFileMode = String(
			(await execFileAsync("git", ["config", "--bool", "core.filemode"], { cwd: repo, windowsHide: true }))
				.stdout,
		).trim()
		try {
			await execFileAsync("git", ["config", "core.filemode", "false"], { cwd: repo, windowsHide: true })
			const worker = await service.create(
				storage,
				"legacy-file-kind",
				await service.validateScope(repo, ["value.txt"]),
			)
			await fs.writeFile(path.join(worker.workspacePath, "value.txt"), "keep.txt")
			const captured = await service.capture(storage, worker.artifact.id)
			delete captured.changes[0]!.beforeMode
			delete captured.changes[0]!.afterMode
			await fs.writeFile(
				path.join(storage, "subagent-change-sets", captured.id, "metadata.json"),
				JSON.stringify(captured),
			)
			await fs.unlink(path.join(repo, "value.txt"))
			try {
				await fs.symlink("keep.txt", path.join(repo, "value.txt"), "file")
			} catch (error) {
				if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") skip()
				throw error
			}

			await expect(service.apply(storage, captured.id)).resolves.toEqual({
				status: "conflicted",
				conflictPaths: ["value.txt"],
			})
			expect(await fs.readlink(path.join(repo, "value.txt"))).toBe("keep.txt")
			expect(await fs.readFile(path.join(repo, "keep.txt"), "utf8")).toBe("keep\n")
		} finally {
			await execFileAsync("git", ["config", "core.filemode", originalFileMode], { cwd: repo, windowsHide: true })
		}
	})

	it(
		"rejects traversal, absolute, and cross-role file references at every artifact entry point",
		async () => {
			const canary = path.join(root, "outside-proposal-canary.txt")
			await fs.writeFile(canary, "preserve external data")
			const relative = path.relative(directory, canary)
			for (const field of ["patchFile", "beforeFile", "afterFile"] as const) {
				for (const reference of [
					relative.replace(/\\/g, "/"),
					relative.replace(/\//g, "\\"),
					canary,
					"C:\\external\\canary.txt",
					"/external/canary.txt",
					"changes.patch:stream",
					"metadata.json",
				]) {
					const tampered = structuredClone(artifact)
					if (field === "patchFile") tampered.patchFile = reference
					else tampered.changes[0]![field] = reference
					const metadata = JSON.stringify(tampered)
					await fs.writeFile(metadataPath, metadata)
					await expectRejectedSinks(/Invalid managed worker artifact metadata/)
					expect(await fs.readFile(canary, "utf8")).toBe("preserve external data")
					expect(await fs.readFile(metadataPath, "utf8")).toBe(metadata)
					expect(await fs.readFile(path.join(repo, "value.txt"), "utf8")).toBe("baseline\n")
				}
			}
		},
		TIMEOUT,
	)

	it(
		"rejects malformed ordinary and private metadata without repairing or discarding it",
		async () => {
			const invalid: unknown[] = [
				null,
				[],
				"proposal",
				{},
				{ ...artifact, taskId: "" },
				{ ...artifact, status: "future_status" },
				{ ...artifact, createdAt: -1 },
				{ ...artifact, updatedAt: "now" },
				{ ...artifact, gitRoot: "relative" },
				{ ...artifact, logicalWorkspace: null },
				{ ...artifact, logicalWorkspaceFromRoot: "../external" },
				{ ...artifact, writeScope: [1] },
				{ ...artifact, gitRelativeScope: ["..\\external"] },
				{ ...artifact, fileWriteScope: null },
				{ ...artifact, gitRelativeFileScope: false },
				{ ...artifact, changes: [null] },
				{ ...artifact, changes: [{ ...artifact.changes[0], path: "../canary" }] },
				{ ...artifact, changes: [{ ...artifact.changes[0], binary: "false" }] },
				{ ...artifact, partial: "true" },
				{ ...artifact, conflictPaths: [1] },
				{ ...artifact, privateGitDir: 1 },
				{ ...artifact, privateGitOwner: {} },
				{
					...artifact,
					privateGitOwner: { token: "owner", dev: "1", ino: "2", gitDev: "1", gitIno: "3" },
				},
			]
			for (const value of invalid) {
				const metadata = JSON.stringify(value)
				await fs.writeFile(metadataPath, metadata)
				await expectRejectedSinks(/Invalid managed worker artifact metadata/, false)
				expect(await fs.readFile(metadataPath, "utf8")).toBe(metadata)
				expect(await fs.readFile(path.join(directory, artifact.patchFile!), "utf8")).toContain("worker result")
			}
		},
		TIMEOUT,
	)

	it(
		"validates a generated private proposal's identity, shape, and file references before any settlement",
		async () => {
			const plain = path.join(root, "plain-folder")
			await fs.mkdir(plain)
			await fs.writeFile(path.join(plain, "value.txt"), "baseline\n")
			const worker = await service.create(
				storage,
				"private-worker",
				await service.validateScope(plain, ["value.txt"]),
			)
			await fs.writeFile(path.join(worker.workspacePath, "value.txt"), "private worker result\n")
			artifact = await service.capture(storage, worker.artifact.id)
			directory = path.join(storage, "subagent-change-sets", artifact.id)
			metadataPath = path.join(directory, "metadata.json")
			expect(artifact.privateGitDir).toBeDefined()
			const canary = path.join(root, "private-external-canary.txt")
			await fs.writeFile(canary, "preserve private proposal data")
			for (const tampered of [
				{ ...artifact, id: "foreign-private-proposal" },
				{ ...artifact, changes: [{ ...artifact.changes[0], binary: null }] },
				{ ...artifact, patchFile: path.relative(directory, canary) },
				{ ...artifact, changes: [{ ...artifact.changes[0], beforeFile: path.relative(directory, canary) }] },
				{ ...artifact, changes: [{ ...artifact.changes[0], afterFile: path.relative(directory, canary) }] },
			]) {
				const metadata = JSON.stringify(tampered)
				await fs.writeFile(metadataPath, metadata)
				await expectRejectedSinks(/Invalid managed worker artifact (?:identity|metadata)/, false)
				expect(await fs.readFile(canary, "utf8")).toBe("preserve private proposal data")
				expect(await fs.readFile(metadataPath, "utf8")).toBe(metadata)
				expect(await fs.readFile(path.join(plain, "value.txt"), "utf8")).toBe("baseline\n")
			}
		},
		TIMEOUT,
	)

	it("requires the saved identity to match the requested proposal", async () => {
		const metadata = JSON.stringify({ ...artifact, id: "another-proposal" })
		await fs.writeFile(metadataPath, metadata)
		await expectRejectedSinks(/Invalid managed worker artifact identity/, false)
		await expect(service.deleteArtifactsForTasks(storage, [artifact.taskId])).resolves.toBeUndefined()
		expect(await fs.readFile(metadataPath, "utf8")).toBe(metadata)
		await expect(fs.access(path.join(storage, "subagent-change-sets", "another-proposal"))).rejects.toMatchObject({
			code: "ENOENT",
		})
		for (const id of ["../outside", "..\\outside", "C:\\external", "proposal:stream"]) {
			await expect(service.load(storage, id)).rejects.toThrow("Invalid managed worker artifact identity")
			await expect(service.deleteArtifact(storage, id)).rejects.toThrow(
				"Invalid managed worker artifact identity",
			)
		}
	})

	it.each(["artifact", "bucket"] as const)(
		"rejects a linked %s directory before reading or deleting it",
		async (kind) => {
			const ownedPath = kind === "artifact" ? directory : path.dirname(directory)
			const outside = path.join(root, `outside-${kind}`)
			await fs.rename(ownedPath, outside)
			const canary = path.join(outside, "external-canary.txt")
			await fs.writeFile(canary, "preserve linked directory")
			await fs.symlink(outside, ownedPath, process.platform === "win32" ? "junction" : "dir")
			try {
				await expectRejectedSinks(/artifact directory ownership changed/)
				expect(await fs.readFile(canary, "utf8")).toBe("preserve linked directory")
				expect((await fs.lstat(ownedPath)).isSymbolicLink()).toBe(true)
			} finally {
				await fs.unlink(ownedPath)
				await fs.rename(outside, ownedPath)
			}
		},
	)

	it(
		"rejects linked metadata and proposal files without traversing or removing their targets",
		async () => {
			const outside = path.join(root, "outside-files")
			await fs.mkdir(outside)
			const canary = path.join(outside, "canary.txt")
			await fs.writeFile(canary, "preserve linked file target")
			for (const name of [
				"metadata.json",
				artifact.patchFile!,
				artifact.changes[0]!.beforeFile!,
				artifact.changes[0]!.afterFile!,
			]) {
				const file = path.join(directory, name)
				const retained = `${file}.retained`
				await fs.rename(file, retained)
				await fs.symlink(outside, file, process.platform === "win32" ? "junction" : "dir")
				try {
					await expectRejectedSinks(/artifact file ownership changed/)
					expect(await fs.readFile(canary, "utf8")).toBe("preserve linked file target")
					expect((await fs.lstat(file)).isSymbolicLink()).toBe(true)
				} finally {
					await fs.unlink(file)
					await fs.rename(retained, file)
				}
			}
		},
		TIMEOUT,
	)

	it(
		"rejects file symlinks for every stored proposal reference",
		async ({ skip }) => {
			const canary = path.join(root, "outside-file.txt")
			await fs.writeFile(canary, "preserve file symlink target")
			for (const name of [
				"metadata.json",
				artifact.patchFile!,
				artifact.changes[0]!.beforeFile!,
				artifact.changes[0]!.afterFile!,
			]) {
				const file = path.join(directory, name)
				const retained = `${file}.retained`
				await fs.rename(file, retained)
				try {
					await fs.symlink(canary, file, "file")
				} catch (error) {
					if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") skip()
					throw error
				}
				try {
					await expectRejectedSinks(/artifact file ownership changed/)
					expect(await fs.readFile(canary, "utf8")).toBe("preserve file symlink target")
				} finally {
					await fs.unlink(file)
					await fs.rename(retained, file)
				}
			}
		},
		TIMEOUT,
	)

	it("preserves an existing artifact with missing metadata and keeps absent deletion idempotent", async () => {
		await fs.unlink(metadataPath)
		await expect(service.deleteArtifact(storage, artifact.id)).rejects.toMatchObject({ code: "ENOENT" })
		expect(await fs.readFile(path.join(directory, artifact.patchFile!), "utf8")).toContain("worker result")
		await expect(service.deleteArtifact(storage, "never-created")).resolves.toBeUndefined()
	})

	for (const name of ["changes.patch", "0-before", "0-after"]) {
		it(
			`preserves external files when capture output ${name} was replaced with a file symlink`,
			async ({ skip }) => {
				const canary = path.join(root, "outside-capture.txt")
				const worker = await service.create(
					storage,
					"capture-worker",
					await service.validateScope(repo, ["value.txt"]),
				)
				await fs.writeFile(path.join(worker.workspacePath, "value.txt"), "capture result\n")
				const workerDirectory = path.join(storage, "subagent-change-sets", worker.artifact.id)
				const workerMetadata = path.join(workerDirectory, "metadata.json")
				const originalMetadata = await fs.readFile(workerMetadata, "utf8")
				const linkedFile = path.join(workerDirectory, name)
				await fs.writeFile(canary, "preserve capture target")
				try {
					await fs.symlink(canary, linkedFile, "file")
				} catch (error) {
					if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") skip()
					throw error
				}
				try {
					await expect(service.capture(storage, worker.artifact.id)).rejects.toThrow(
						"artifact file ownership changed",
					)
					expect(await fs.readFile(canary, "utf8")).toBe("preserve capture target")
					expect(await fs.readFile(workerMetadata, "utf8")).toBe(originalMetadata)
					expect(await fs.readFile(path.join(worker.workspacePath, "value.txt"), "utf8")).toBe(
						"capture result\n",
					)
				} finally {
					await fs.unlink(linkedFile)
					await service.deleteArtifact(storage, worker.artifact.id)
				}
			},
			TIMEOUT,
		)
	}

	it.each([false, true])(
		"reads and applies legacy proposals with missing exact-file scopes (private: %s)",
		async (privateRepository) => {
			let source = repo
			if (privateRepository) {
				source = path.join(root, "plain-folder")
				await fs.mkdir(source)
				await fs.writeFile(path.join(source, "value.txt"), "baseline\n")
				const worker = await service.create(
					storage,
					"private-worker",
					await service.validateScope(source, ["value.txt"]),
				)
				await fs.writeFile(path.join(worker.workspacePath, "value.txt"), "worker result\n")
				artifact = await service.capture(storage, worker.artifact.id)
				directory = path.join(storage, "subagent-change-sets", artifact.id)
				metadataPath = path.join(directory, "metadata.json")
				expect(artifact.privateGitDir).toBeDefined()
			}
			const legacy: Record<string, unknown> = { ...artifact, futureMetadata: { retain: true } }
			delete legacy.fileWriteScope
			delete legacy.gitRelativeFileScope
			const metadata = JSON.stringify(legacy)
			await fs.writeFile(metadataPath, metadata)
			await expect(service.load(storage, artifact.id)).resolves.toMatchObject({
				fileWriteScope: [],
				gitRelativeFileScope: [],
			})
			expect(await fs.readFile(metadataPath, "utf8")).toBe(metadata)
			const [diff] = await service.getDiffFiles(storage, artifact.id)
			expect(await fs.readFile(diff!.beforePath!, "utf8")).toBe("baseline\n")
			expect(await fs.readFile(diff!.afterPath!, "utf8")).toBe("worker result\n")
			await expect(service.apply(storage, artifact.id)).resolves.toEqual({ status: "applied" })
			expect(await fs.readFile(path.join(source, "value.txt"), "utf8")).toBe("worker result\n")
			expect(JSON.parse(await fs.readFile(metadataPath, "utf8"))).toMatchObject({
				futureMetadata: { retain: true },
			})
			await service.deleteArtifact(storage, artifact.id)
			await expect(service.deleteArtifact(storage, artifact.id)).resolves.toBeUndefined()
		},
		// This case generates a second repository and applies it through real Git.
		TIMEOUT * 2,
	)
})
