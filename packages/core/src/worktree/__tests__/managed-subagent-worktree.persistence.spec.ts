import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ManagedSubagentWorktreeService, type ManagedWorkerArtifact } from "../managed-subagent-worktree.js"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) }
})

describe("Worker proposal settlement under filesystem contention", () => {
	let storage: string
	let directory: string
	let metadataPath: string
	let patchPath: string
	let service: ManagedSubagentWorktreeService

	beforeEach(async () => {
		storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-worker-persistence-"))
		directory = path.join(storage, "subagent-change-sets", "proposal")
		metadataPath = path.join(directory, "metadata.json")
		patchPath = path.join(directory, "changes.patch")
		await fs.mkdir(directory, { recursive: true })
		const artifact: ManagedWorkerArtifact = {
			id: "proposal",
			taskId: "worker",
			status: "pending_review",
			createdAt: 1,
			updatedAt: 1,
			gitRoot: storage,
			logicalWorkspace: storage,
			logicalWorkspaceFromRoot: "",
			baselineCommit: "baseline",
			writeScope: ["file.txt"],
			gitRelativeScope: ["file.txt"],
			fileWriteScope: ["file.txt"],
			gitRelativeFileScope: ["file.txt"],
			changes: [],
			patchFile: "changes.patch",
		}
		await fs.writeFile(metadataPath, JSON.stringify(artifact))
		await fs.writeFile(patchPath, "retained proposal")
		service = new ManagedSubagentWorktreeService()
		vi.mocked(fs.rename).mockClear()
		vi.mocked(fs.rm).mockClear()
	})

	afterEach(async () => {
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename)
		vi.mocked(fs.rm).mockReset().mockImplementation(actual.rm)
		await actual.rm(storage, { recursive: true, force: true })
	})

	it.each(["EPERM", "EACCES", "EBUSY"])(
		"settles discard after transient %s without losing the proposal",
		async (code) => {
			vi.mocked(fs.rename).mockImplementationOnce(async () => {
				expect((await service.load(storage, "proposal")).status).toBe("pending_review")
				expect(await fs.readFile(patchPath, "utf8")).toBe("retained proposal")
				throw Object.assign(new Error("temporary sharing violation"), { code })
			})
			await expect(service.discard(storage, "proposal")).resolves.toMatchObject({ status: "discarded" })
			expect((await service.load(storage, "proposal")).status).toBe("discarded")
			expect(vi.mocked(fs.rename).mock.calls[0]?.[0]).toBe(vi.mocked(fs.rename).mock.calls[1]?.[0])
			expect(await fs.readdir(directory)).toEqual(["metadata.json"])
			expect(fs.rm).not.toHaveBeenCalledWith(metadataPath, expect.anything())
		},
	)

	it.each(["EPERM", "EIO"])("preserves pending metadata and patch when %s prevents settlement", async (code) => {
		const failure = Object.assign(new Error("replacement unavailable"), { code })
		vi.mocked(fs.rename).mockRejectedValue(failure)
		await expect(service.discard(storage, "proposal")).rejects.toBe(failure)
		expect(vi.mocked(fs.rename).mock.calls.length).toBe(code === "EPERM" ? 6 : 1)
		expect((await service.load(storage, "proposal")).status).toBe("pending_review")
		expect(await fs.readFile(patchPath, "utf8")).toBe("retained proposal")
		expect((await fs.readdir(directory)).sort()).toEqual(["changes.patch", "metadata.json"])
	})

	it("resumes cleanup after discard was committed but patch removal failed", async () => {
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const failure = Object.assign(new Error("patch is busy"), { code: "EBUSY" })
		vi.mocked(fs.rm).mockImplementation(async (target, options) => {
			if (target === patchPath) throw failure
			return actual.rm(target, options)
		})
		await expect(service.discard(storage, "proposal")).rejects.toBe(failure)
		expect(await service.load(storage, "proposal")).toMatchObject({
			status: "discarded",
			patchFile: "changes.patch",
		})
		vi.mocked(fs.rm).mockImplementation(actual.rm)
		await expect(service.discard(storage, "proposal")).resolves.toMatchObject({ status: "discarded" })
		expect((await service.load(storage, "proposal")).patchFile).toBeUndefined()
		expect(await fs.readdir(directory)).toEqual(["metadata.json"])
	})

	it("resumes after cleanup succeeded but its final metadata write failed", async () => {
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		const failure = Object.assign(new Error("final metadata unavailable"), { code: "EIO" })
		vi.mocked(fs.rename).mockImplementationOnce(actual.rename).mockRejectedValue(failure)
		await expect(service.discard(storage, "proposal")).rejects.toBe(failure)
		expect(await service.load(storage, "proposal")).toMatchObject({
			status: "discarded",
			patchFile: "changes.patch",
		})
		await expect(fs.access(patchPath)).rejects.toMatchObject({ code: "ENOENT" })
		vi.mocked(fs.rename).mockImplementation(actual.rename)
		await expect(service.discard(storage, "proposal")).resolves.toMatchObject({ status: "discarded" })
		expect((await service.load(storage, "proposal")).patchFile).toBeUndefined()
		expect(await fs.readdir(directory)).toEqual(["metadata.json"])
	})
})
