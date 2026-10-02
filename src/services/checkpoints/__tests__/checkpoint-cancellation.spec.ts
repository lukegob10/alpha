import os from "node:os"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const gitState = vi.hoisted(() => ({
	clients: [] as {
		signal?: AbortSignal
		add: ReturnType<typeof vi.fn>
		commit: ReturnType<typeof vi.fn>
	}[],
	addBarrier: undefined as Promise<void> | undefined,
}))

vi.mock("fs/promises", () => ({ default: { mkdir: vi.fn(), writeFile: vi.fn() } }))
vi.mock("../../../utils/fs", () => ({ fileExistsAtPath: vi.fn().mockResolvedValue(true) }))
vi.mock("../../../services/search/file-search", () => ({ executeRipgrep: vi.fn().mockResolvedValue([]) }))
vi.mock("../excludes", () => ({ getExcludePatterns: vi.fn().mockResolvedValue([]) }))
vi.mock("simple-git", () => ({
	default: vi.fn((options: { abort?: AbortSignal }) => {
		const git = {
			signal: options.abort,
			env: vi.fn(),
			getConfig: vi.fn().mockResolvedValue({ value: os.tmpdir() }),
			raw: vi.fn().mockResolvedValue(""),
			revparse: vi.fn().mockResolvedValue("a".repeat(40)),
			add: vi.fn(() => gitState.addBarrier ?? Promise.resolve()),
			diffSummary: vi.fn().mockResolvedValue({ files: [{ file: "test.txt" }] }),
			commit: vi.fn().mockResolvedValue({ commit: "b".repeat(40) }),
			clean: vi.fn().mockResolvedValue(undefined),
			reset: vi.fn().mockResolvedValue(undefined),
		}
		gitState.clients.push(git)
		return git
	}),
}))

import { RepoPerTaskCheckpointService } from "../RepoPerTaskCheckpointService"

const deferred = () => {
	let resolve!: () => void
	const promise = new Promise<void>((finish) => (resolve = finish))
	return { promise, resolve }
}

describe("checkpoint operation cancellation", () => {
	beforeEach(() => {
		gitState.clients = []
		gitState.addBarrier = undefined
	})

	const createService = () =>
		RepoPerTaskCheckpointService.create({
			taskId: "cancellation-task",
			workspaceDir: os.tmpdir(),
			shadowDir: path.join(os.tmpdir(), "alpha-checkpoint-cancellation"),
			log: () => {},
		})

	it("does not publish a late cancelled save or release its transaction queue early", async () => {
		const service = createService()
		await service.initShadowGit()
		const checkpoint = vi.fn()
		service.on("checkpoint", checkpoint)
		const staging = deferred()
		gitState.addBarrier = staging.promise
		const cancellation = new AbortController()
		const first = service.saveCheckpoint("Cancelled save", { signal: cancellation.signal })
		const firstOutcome = expect(first).rejects.toThrow("cancelled checkpoint")
		await Promise.resolve()
		const controlledGit = gitState.clients[1]
		expect(controlledGit.signal).toBe(cancellation.signal)
		expect(controlledGit.add).toHaveBeenCalledOnce()

		cancellation.abort(new Error("cancelled checkpoint"))
		gitState.addBarrier = undefined
		const next = service.saveCheckpoint("Next save")
		await Promise.resolve()
		expect(gitState.clients[0].add).not.toHaveBeenCalled()
		staging.resolve()
		await firstOutcome
		await expect(next).resolves.toEqual({ commit: "b".repeat(40) })
		expect(controlledGit.commit).not.toHaveBeenCalled()
		expect(checkpoint).toHaveBeenCalledOnce()
		expect(service.getCheckpoints()).toEqual(["b".repeat(40)])
	})

	it("skips a queued save whose signal expired before it acquired the transaction", async () => {
		const service = createService()
		await service.initShadowGit()
		const staging = deferred()
		gitState.addBarrier = staging.promise
		const active = service.saveCheckpoint("Active save")
		const cancellation = new AbortController()
		const queued = service.saveCheckpoint("Expired queued save", { signal: cancellation.signal })
		const queuedOutcome = expect(queued).rejects.toThrow("queued checkpoint expired")
		cancellation.abort(new Error("queued checkpoint expired"))
		staging.resolve()
		await active
		await queuedOutcome
		expect(gitState.clients).toHaveLength(1)
		expect(gitState.clients[0].add).toHaveBeenCalledOnce()
	})

	it("keeps initialized checkpoint restore independent from its finished initialization signal", async () => {
		const service = createService()
		const cancellation = new AbortController()
		await service.initShadowGit(undefined, cancellation.signal)
		expect(gitState.clients[0].signal).toBe(cancellation.signal)
		expect(gitState.clients[1].signal).toBeUndefined()
		cancellation.abort()
		await expect(service.restoreCheckpoint("a".repeat(40))).resolves.toBeUndefined()
	})
})
