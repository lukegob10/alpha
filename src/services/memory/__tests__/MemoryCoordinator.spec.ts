import * as fs from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import { DEFAULT_MEMORY_SETTINGS, type MemorySettings } from "@alpha-code/types"

import { atomicWriteText } from "../../../core/task-persistence/atomicWrite"
import { MemoryCoordinator } from "../MemoryCoordinator"
import { MemoryStore } from "../MemoryStore"
import type { MemoryConsolidationInput, MemoryModelClient, MemorySource } from "../MemoryTypes"

vi.mock("vscode", () => ({ workspace: { textDocuments: [] } }))

const HOUR = 3_600_000
const DAY = 24 * HOUR
const summary = (text = "Useful Alpha knowledge.") =>
	`v1\n\n## User Profile\n${text}\n\n## User preferences\nUse focused checks.\n\n## General Tips\nInspect current code.\n\n## What's in Memory\n- Alpha extension\n`

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

type Persisted = {
	epoch: string
	rows: Array<{
		id: string
		watermark?: number
		failures: number
		retryAt?: number
		claim?: { token: string; until: number }
		output?: { slug: string }
		usageCount?: number
	}>
	selection: string[]
	forgetPending?: boolean
	citationEvents?: string[]
	usage: Record<"extraction" | "consolidation", { inputTokens: number; outputTokens: number; totalCost: number }>
}

describe("MemoryCoordinator", () => {
	let temporary: string
	let store: MemoryStore
	let clock: number
	let settings: MemorySettings
	let sources: MemorySource[]
	let model: MemoryModelClient
	let coordinators: MemoryCoordinator[]
	let onError: Mock<(error: Error) => void>

	const source = (id = "thread-1", overrides: Partial<MemorySource> = {}): MemorySource => ({
		id,
		updatedAt: clock - 7 * HOUR,
		generateMemories: true,
		active: false,
		...overrides,
	})

	const make = (overrides: Partial<ConstructorParameters<typeof MemoryCoordinator>[0]> = {}) => {
		const coordinator = new MemoryCoordinator({
			store,
			model,
			getSettings: () => settings,
			listSources: async () => sources.map((item) => ({ ...item })),
			readSource: async () => [{ role: "user", content: "Preserve useful project knowledge." }],
			isSourceCurrent: async (captured) =>
				sources.some(
					(item) =>
						item.id === captured.id &&
						item.updatedAt === captured.updatedAt &&
						!item.active &&
						item.generateMemories &&
						(!settings.disableOnExternalContext || !item.externalContext),
				),
			now: () => clock,
			onError,
			...overrides,
		})
		coordinators.push(coordinator)
		return coordinator
	}

	const run = async (coordinator: MemoryCoordinator) => {
		coordinator.wake()
		await coordinator.awaitIdle()
	}
	const state = async (): Promise<Persisted> => JSON.parse(await fs.readFile(store.statePath, "utf8")) as Persisted

	beforeEach(async () => {
		clock = Date.UTC(2026, 9, 25, 12)
		temporary = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "alpha-memory-coordinator-")))
		store = new MemoryStore({
			home: path.join(temporary, ".alpha"),
			now: () => clock,
			// Editor concurrency is covered by MemorySummaryEditor; keep this coordinator sink deterministic.
			summaryWriter: async (file, text, options) => {
				if (!(await options.isCurrent())) return false
				options.signal.throwIfAborted()
				if ((await options.readFile()).version !== options.expectedVersion) return false
				await atomicWriteText(file, text, { requireAtomicReplace: true, mode: 0o600 })
				return true
			},
		})
		settings = { ...DEFAULT_MEMORY_SETTINGS, enabled: true }
		sources = [source()]
		coordinators = []
		onError = vi.fn()
		model = {
			extract: vi.fn(async (item) => ({ rolloutSummary: `Knowledge from ${item.id}.`, rolloutSlug: "alpha" })),
			consolidate: vi.fn(async () => summary()),
		}
	})

	afterEach(async () => {
		await Promise.all(coordinators.map((coordinator) => coordinator.dispose()))
		vi.useRealTimers()
		vi.restoreAllMocks()
		await fs.rm(temporary, { recursive: true, force: true })
	})

	it.each(["enabled", "generateMemories"] as const)("does no disk or model work while %s is off", async (key) => {
		settings[key] = false
		await run(make())
		expect(model.extract).not.toHaveBeenCalled()
		expect(model.consolidate).not.toHaveBeenCalled()
		await expect(fs.stat(store.home)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("initializes the enabled namespace even without eligible sources or remaining quota", async () => {
		sources = []
		await run(make({ remainingQuotaPercent: () => 0 }))
		expect((await fs.stat(store.rootPath)).isDirectory()).toBe(true)
		expect(await store.listFiles()).toEqual([])
		expect(model.extract).not.toHaveBeenCalled()
		expect(model.consolidate).not.toHaveBeenCalled()
	})

	it("waits for another explicit startup wake instead of polling for additional model work", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
		const coordinator = make()
		await run(coordinator)
		expect(model.extract).toHaveBeenCalledTimes(1)
		clock += DAY
		sources.push(source("thread-2"))
		await vi.advanceTimersByTimeAsync(DAY)
		await coordinator.awaitIdle()
		expect(model.extract).toHaveBeenCalledTimes(1)
		await run(coordinator)
		expect(model.extract).toHaveBeenCalledTimes(2)
	})

	it.each(["cancelled", "disabled"])("rejects a %s note after waiting for the store transaction", async (reason) => {
		const coordinator = make()
		const entered = deferred<void>()
		const release = deferred<void>()
		const held = store.withTransaction(async () => {
			entered.resolve()
			await release.promise
		})
		await entered.promise
		const controller = new AbortController()
		const note = coordinator.recordNote("Remember this explicit request.", controller.signal)
		if (reason === "cancelled") controller.abort()
		else settings.enabled = false
		release.resolve()
		await held
		if (reason === "cancelled") await expect(note).rejects.toMatchObject({ name: "AbortError" })
		else await expect(note).rejects.toThrow("Memory is disabled")
		expect(await store.listFiles()).toEqual([])
	})

	it("extracts only idle opted-in primary sources within the age window and startup cap", async () => {
		settings.disableOnExternalContext = true
		sources = [
			source("active", { active: true }),
			source("recent", { updatedAt: clock - HOUR }),
			source("old", { updatedAt: clock - 11 * DAY }),
			source("opted-out", { generateMemories: false }),
			source("external", { externalContext: true }),
			source("eligible-a"),
			source("eligible-b"),
			source("eligible-c"),
		]
		await run(make())
		expect(model.extract).toHaveBeenCalledTimes(2)
		expect(vi.mocked(model.extract).mock.calls.map(([item]) => item.id)).toEqual(["eligible-c", "eligible-b"])
		expect(model.consolidate).toHaveBeenCalledTimes(1)
		expect((await state()).selection).toEqual(["eligible-b", "eligible-c"])
	})

	it("persists successful watermarks, private extractions, selected artifacts, and separate phase usage", async () => {
		model.extract = vi.fn(async (_item, _messages, _signal, observe) => {
			await observe?.("extraction", {
				inputTokens: 12,
				outputTokens: 4,
				cacheWriteTokens: 1,
				cacheReadTokens: 2,
				totalCost: 0.1,
			})
			return { rolloutSummary: "Useful extraction.", rolloutSlug: "alpha" }
		})
		model.consolidate = vi.fn(async (_input, _signal, observe) => {
			await observe?.("consolidation", {
				inputTokens: 30,
				outputTokens: 9,
				cacheWriteTokens: 0,
				cacheReadTokens: 3,
				totalCost: 0.2,
			})
			return summary()
		})
		const coordinator = make()
		await run(coordinator)
		expect(await store.readExtraction("thread-1")).toBe("Useful extraction.")
		expect(await store.listFiles()).toEqual(["memory_summary.md", "rollout_summaries/thread-1_alpha.md"])
		expect(await store.readSummary()).toBe(summary())
		expect((await state()).rows[0].watermark).toBe(sources[0].updatedAt)
		expect((await state()).usage).toMatchObject({
			extraction: { inputTokens: 12, outputTokens: 4, totalCost: 0.1 },
			consolidation: { inputTokens: 30, outputTokens: 9, totalCost: 0.2 },
		})
		await coordinator.dispose()
		clock += 7 * HOUR
		await run(make())
		expect(model.extract).toHaveBeenCalledTimes(1)
		expect(model.consolidate).toHaveBeenCalledTimes(1)
	})

	it("treats a valid empty extraction as success across restarts", async () => {
		model.extract = vi.fn(async () => ({ rolloutSummary: "", rolloutSlug: "" }))
		await run(make())
		clock += 7 * HOUR
		await run(make())
		expect(model.extract).toHaveBeenCalledTimes(1)
		expect(model.consolidate).not.toHaveBeenCalled()
		expect((await state()).rows[0]).toMatchObject({ watermark: sources[0].updatedAt, failures: 0 })
		expect(await store.listFiles()).toEqual([])
	})

	it("coalesces wakes and prevents a second window from claiming an in-flight source", async () => {
		const started = deferred<void>()
		const result = deferred<{ rolloutSummary: string; rolloutSlug: string }>()
		model.extract = vi.fn(async () => {
			started.resolve()
			return result.promise
		})
		const first = make()
		for (let index = 0; index < 12; index++) first.wake()
		await started.promise
		await run(make())
		expect(model.extract).toHaveBeenCalledTimes(1)
		result.resolve({ rolloutSummary: "One owner.", rolloutSlug: "alpha" })
		await first.awaitIdle()
		expect(model.consolidate).toHaveBeenCalledTimes(1)
	})

	it("reclaims an expired lease and rejects the old owner's late publication", async () => {
		const started = deferred<void>()
		const stale = deferred<{ rolloutSummary: string; rolloutSlug: string }>()
		model.extract = vi
			.fn()
			.mockImplementationOnce(async () => {
				started.resolve()
				return stale.promise
			})
			.mockResolvedValueOnce({ rolloutSummary: "New owner.", rolloutSlug: "alpha" })
		const first = make()
		first.wake()
		await started.promise
		clock += HOUR + 1
		await run(make())
		stale.resolve({ rolloutSummary: "Stale owner.", rolloutSlug: "alpha" })
		await first.awaitIdle()
		expect(await store.readExtraction("thread-1")).toBe("New owner.")
		expect(model.extract).toHaveBeenCalledTimes(2)
		expect(model.consolidate).toHaveBeenCalledTimes(1)
	})

	it("renews an owned lease while a provider is still streaming", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
		const started = deferred<void>()
		const result = deferred<{ rolloutSummary: string; rolloutSlug: string }>()
		model.extract = vi.fn(async () => {
			started.resolve()
			return result.promise
		})
		const first = make()
		first.wake()
		await started.promise
		const original = (await state()).rows[0].claim!.until
		clock += HOUR + 1
		await vi.advanceTimersByTimeAsync(90_000)
		// Join the transaction rather than using a wall-clock sleep for the heartbeat.
		await store.withTransaction(async () => undefined)
		expect((await state()).rows[0].claim!.until).toBeGreaterThan(original)
		await run(make())
		expect(model.extract).toHaveBeenCalledTimes(1)
		result.resolve({ rolloutSummary: "Owned stream.", rolloutSlug: "alpha" })
		await first.awaitIdle()
	})

	it("uses one-hour failure backoff and three attempts, resetting retries for a newer source", async () => {
		model.extract = vi.fn().mockRejectedValue(new Error("secret transcript and password=unsafe"))
		const coordinator = make()
		await run(coordinator)
		await run(coordinator)
		expect(model.extract).toHaveBeenCalledTimes(1)
		for (let attempt = 0; attempt < 3; attempt++) {
			clock += HOUR
			await run(coordinator)
		}
		expect(model.extract).toHaveBeenCalledTimes(3)
		expect((await state()).rows[0].failures).toBe(3)
		expect(onError.mock.calls.every(([error]) => error.message === "Memory extraction failed")).toBe(true)
		sources[0].updatedAt++
		vi.mocked(model.extract).mockResolvedValue({ rolloutSummary: "Recovered.", rolloutSlug: "alpha" })
		await run(coordinator)
		expect(model.extract).toHaveBeenCalledTimes(4)
		expect((await state()).rows[0].failures).toBe(0)
	})

	it("rechecks source freshness before sending evidence and before publishing", async () => {
		const started = deferred<void>()
		const result = deferred<{ rolloutSummary: string; rolloutSlug: string }>()
		model.extract = vi.fn(async () => {
			started.resolve()
			return result.promise
		})
		const coordinator = make()
		coordinator.wake()
		await started.promise
		sources[0].active = true
		result.resolve({ rolloutSummary: "Became active.", rolloutSlug: "alpha" })
		await coordinator.awaitIdle()
		expect(await store.readExtraction("thread-1")).toBeUndefined()
		expect((await state()).rows[0].watermark).toBeUndefined()
		expect((await state()).rows[0].claim).toBeUndefined()
		expect(model.consolidate).not.toHaveBeenCalled()
	})

	it("aborts on disable, retains charged usage, and never publishes a late result", async () => {
		const started = deferred<void>()
		const result = deferred<{ rolloutSummary: string; rolloutSlug: string }>()
		let signal: AbortSignal | undefined
		model.extract = vi.fn(async (_source, _messages, captured, observe) => {
			signal = captured
			await observe?.("extraction", {
				inputTokens: 99,
				outputTokens: 1,
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0.3,
			})
			started.resolve()
			return result.promise
		})
		const coordinator = make()
		coordinator.wake()
		await started.promise
		settings.generateMemories = false
		coordinator.wake()
		expect(signal?.aborted).toBe(true)
		result.resolve({ rolloutSummary: "Late output.", rolloutSlug: "alpha" })
		await coordinator.awaitIdle()
		expect((await state()).usage.extraction.inputTokens).toBe(99)
		expect((await state()).rows[0]).toMatchObject({ failures: 0 })
		expect((await state()).rows[0].claim).toBeUndefined()
		expect(await store.readExtraction("thread-1")).toBeUndefined()
	})

	it.each(["extraction", "consolidation"] as const)(
		"rejects %s publication when disabled during the final source freshness check",
		async (phase) => {
			const entered = deferred<void>()
			const release = deferred<boolean>()
			let checks = 0
			const coordinator = make({
				isSourceCurrent: async () => {
					if (++checks !== (phase === "extraction" ? 3 : 4)) return true
					entered.resolve()
					return release.promise
				},
			})
			coordinator.wake()
			await entered.promise
			settings.generateMemories = false
			coordinator.wake()
			release.resolve(true)
			await coordinator.awaitIdle()
			if (phase === "extraction") {
				expect(await store.readExtraction("thread-1")).toBeUndefined()
				expect((await state()).rows[0].watermark).toBeUndefined()
			} else expect(await store.readSummary()).toBeUndefined()
		},
	)

	it("rejects an in-flight job after a cross-window reset creates a new epoch", async () => {
		const started = deferred<void>()
		const stale = deferred<{ rolloutSummary: string; rolloutSlug: string }>()
		model.extract = vi
			.fn()
			.mockImplementationOnce(async () => {
				started.resolve()
				return stale.promise
			})
			.mockResolvedValueOnce({ rolloutSummary: "After reset.", rolloutSlug: "alpha" })
		const first = make()
		first.wake()
		await started.promise
		const epoch = (await state()).epoch
		await store.reset()
		await run(make())
		expect((await state()).epoch).not.toBe(epoch)
		stale.resolve({ rolloutSummary: "Before reset.", rolloutSlug: "alpha" })
		await first.awaitIdle()
		expect(await store.readExtraction("thread-1")).toBe("After reset.")
	})

	it("honors quota while still forgetting excluded source knowledge without tokens", async () => {
		let remaining = 100
		const coordinator = make({ remainingQuotaPercent: () => remaining })
		await run(coordinator)
		expect(await store.readSummary()).toContain("Useful Alpha knowledge")
		remaining = 0
		sources = []
		await run(coordinator)
		expect(await store.readSummary()).not.toContain("Useful Alpha knowledge")
		expect(await store.readExtraction("thread-1")).toBeUndefined()
		expect(await store.listFiles()).toEqual(["memory_summary.md"])
		expect(model.extract).toHaveBeenCalledTimes(1)
		expect(model.consolidate).toHaveBeenCalledTimes(1)
	})

	it("skips both phases below the configured quota and permits an unknown quota", async () => {
		await run(make({ remainingQuotaPercent: () => 24 }))
		expect(model.extract).not.toHaveBeenCalled()
		await run(make({ remainingQuotaPercent: () => undefined }))
		expect(model.extract).toHaveBeenCalledTimes(1)
	})

	it("ranks by usage and recency, rematerializes cached selections, and removes unselected visible files", async () => {
		settings.maxRolloutsPerStartup = 3
		settings.maxMemoriesForConsolidation = 1
		sources = [
			source("a", { updatedAt: clock - 9 * HOUR }),
			source("b", { updatedAt: clock - 8 * HOUR }),
			source("c"),
		]
		const coordinator = make()
		await run(coordinator)
		expect((await state()).selection).toEqual(["c"])
		expect(await store.readExtraction("a")).toContain("a")
		await coordinator.recordUsage(["a", "a"])
		clock += 7 * HOUR
		await run(coordinator)
		expect((await state()).selection).toEqual(["a"])
		expect(await store.listFiles()).toEqual(["memory_summary.md", "rollout_summaries/a_alpha.md"])
		expect(await store.readExtraction("c")).toContain("c")
		expect(vi.mocked(model.consolidate).mock.calls[1][0].previousSummary).toBeUndefined()
		await coordinator.recordUsage(["rollout_summaries/a_alpha.md"])
		expect(model.extract).toHaveBeenCalledTimes(3)
	})

	it("counts a finalized citation once across concurrent coordinators and reload, with distinct attempts counted separately", async () => {
		const coordinator = make()
		await run(coordinator)
		const event = "a".repeat(64)
		await Promise.all([
			coordinator.recordUsage(["thread-1", "thread-1", "rollout_summaries/thread-1_alpha.md"], event),
			make().recordUsage(["thread-1"], event),
		])
		expect((await state()).rows[0].usageCount).toBe(1)
		expect((await state()).citationEvents).toEqual([event])
		await coordinator.dispose()
		await make().recordUsage(["thread-1"], event)
		expect((await state()).rows[0].usageCount).toBe(1)
		await make().recordUsage(["thread-1"], "b".repeat(64))
		expect((await state()).rows[0].usageCount).toBe(2)
	})

	it("accepts only known source references and retains no receipt for unknown or invalid ones", async () => {
		const coordinator = make()
		await run(coordinator)
		const event = "c".repeat(64)
		await coordinator.recordUsage(["unknown", "../thread-1", "memory_summary.md"], event)
		expect((await state()).citationEvents).toEqual([])
		expect((await state()).rows[0].usageCount).toBe(0)
		await expect(coordinator.recordUsage(["thread-1"], "model-provided-invalid-event")).rejects.toThrow(
			"Invalid memory usage event",
		)
		await coordinator.recordUsage(["thread-1"], event)
		expect((await state()).rows[0].usageCount).toBe(1)
	})

	it("bounds durable citation receipts while preserving the latest events", async () => {
		const coordinator = make()
		await run(coordinator)
		const events = Array.from({ length: 2_048 }, (_, index) => index.toString(16).padStart(64, "0"))
		await store.withTransaction(async (transaction) => {
			const persisted = (await transaction.readState()) as Record<string, unknown>
			await transaction.writeState({ ...persisted, citationEvents: events })
		})
		const newest = "f".repeat(64)
		await coordinator.recordUsage(["thread-1"], newest)
		const receipts = (await state()).citationEvents!
		expect(receipts).toHaveLength(2_048)
		expect(receipts[0]).toBe(events[1])
		expect(receipts.at(-1)).toBe(newest)
	})

	it("does not record usage after memory is disabled while waiting for its disk transaction", async () => {
		const coordinator = make()
		await run(coordinator)
		const entered = deferred<void>()
		const release = deferred<void>()
		const held = store.withTransaction(async () => {
			entered.resolve()
			await release.promise
		})
		await entered.promise
		const usage = coordinator.recordUsage(["thread-1"], "d".repeat(64))
		settings.enabled = false
		release.resolve()
		await held
		await usage
		expect((await state()).rows[0].usageCount).toBe(0)
		expect((await state()).citationEvents).toEqual([])
	})

	it("enforces consolidation cooldown and hashes actual input contents rather than only watermarks", async () => {
		const coordinator = make()
		await run(coordinator)
		await store.withTransaction((transaction) =>
			transaction.writeExtraction("thread-1", "Changed canonical extraction."),
		)
		await run(coordinator)
		expect(model.consolidate).toHaveBeenCalledTimes(1)
		clock += 6 * HOUR
		await run(coordinator)
		expect(model.consolidate).toHaveBeenCalledTimes(2)
		expect(vi.mocked(model.consolidate).mock.calls[1][0].rollouts[0].text).toBe("Changed canonical extraction.")
		clock += 6 * HOUR
		await run(coordinator)
		expect(model.consolidate).toHaveBeenCalledTimes(2)
	})

	it("consolidates notes without eligible threads and forgets deleted notes", async () => {
		sources = []
		const note = await store.addAdHocNote("A durable user preference.")
		const coordinator = make()
		await run(coordinator)
		expect(model.extract).not.toHaveBeenCalled()
		expect(vi.mocked(model.consolidate).mock.calls[0][0].notes).toEqual([
			{ path: note, text: "A durable user preference." },
		])
		await fs.rm(path.join(store.rootPath, note))
		await run(coordinator)
		expect(await store.readSummary()).not.toContain("Useful Alpha knowledge")
		expect(model.consolidate).toHaveBeenCalledTimes(1)
	})

	it("retains a correction after thirty days while its contradicted rollout remains eligible", async () => {
		settings.maxUnusedDays = 60
		const note = await store.addAdHocNote("Forget the earlier claim about my name.")
		model.consolidate = vi.fn(async (input: MemoryConsolidationInput) =>
			summary(input.notes.some((item) => item.path === note) ? "Correction retained." : "Old claim restored."),
		)
		const coordinator = make()
		await run(coordinator)
		clock += 31 * DAY
		await run(coordinator)

		expect(await store.readExtraction("thread-1")).toBeDefined()
		expect(await store.readSummary()).toContain("Correction retained.")
		expect(model.consolidate).toHaveBeenCalledTimes(1)
		expect(await store.readFile(note)).toBe("Forget the earlier claim about my name.")
	})

	it("includes an older correction when more than two hundred notes exist", async () => {
		sources = []
		const correction = await store.addAdHocNote("Forget the superseded deployment setting.")
		const later: Array<[string, string]> = Array.from({ length: 200 }, (_, index) => [
			`extensions/ad_hoc/notes/2026-10-25T13-00-00-note-${index}.md`,
			`Later note ${index}.`,
		])
		const notesByPath = new Map([[correction, "Forget the superseded deployment setting."], ...later])
		const list = store.listFiles.bind(store)
		const read = store.readFileDetails.bind(store)
		vi.spyOn(store, "listFiles").mockImplementation((signal, directory) =>
			directory ? Promise.resolve([...notesByPath.keys()]) : list(signal, directory),
		)
		vi.spyOn(store, "readFileDetails").mockImplementation((file, ...args) =>
			notesByPath.has(file)
				? Promise.resolve({ content: notesByPath.get(file)!, totalLines: 1, truncated: false })
				: read(file, ...args),
		)
		await run(make())

		const notes = vi.mocked(model.consolidate).mock.calls[0][0].notes
		expect(notes).toHaveLength(201)
		expect(notes).toContainEqual({ path: correction, text: "Forget the superseded deployment setting." })
		// The expanded durable receipt must remain readable on the following startup.
		await run(make())
		expect(model.consolidate).toHaveBeenCalledTimes(1)
	})

	it("discovers notes when selected rollout summaries fill the root inventory", async () => {
		sources = []
		const note = await store.addAdHocNote("Preserve this explicit correction.")
		const list = store.listFiles.bind(store)
		vi.spyOn(store, "listFiles").mockImplementation((signal, directory) =>
			directory
				? list(signal, directory)
				: Promise.resolve(Array.from({ length: 2_000 }, (_, index) => `rollout_summaries/thread-${index}.md`)),
		)

		await run(make())

		expect(model.consolidate).toHaveBeenCalledOnce()
		expect(vi.mocked(model.consolidate).mock.calls[0][0].notes).toEqual([
			{ path: note, text: "Preserve this explicit correction." },
		])
	})

	it("discards consolidation when a source is deleted during the request", async () => {
		const started = deferred<void>()
		const result = deferred<string>()
		model.consolidate = vi.fn(async () => {
			started.resolve()
			return result.promise
		})
		const coordinator = make()
		coordinator.wake()
		await started.promise
		sources = []
		result.resolve(summary("Must never survive deletion."))
		await coordinator.awaitIdle()
		expect(await store.readSummary()).toBeUndefined()
		expect(await store.readExtraction("thread-1")).toBeUndefined()
		expect((await state()).selection).toEqual([])
	})

	it("retries a changed notes snapshot instead of publishing stale consolidation", async () => {
		sources = []
		await store.addAdHocNote("First note.")
		const started = deferred<void>()
		const result = deferred<string>()
		model.consolidate = vi
			.fn()
			.mockImplementationOnce(async () => {
				started.resolve()
				return result.promise
			})
			.mockResolvedValueOnce(summary("Includes the new note."))
		const coordinator = make()
		coordinator.wake()
		await started.promise
		await store.addAdHocNote("Second note.")
		result.resolve(summary("Stale note snapshot."))
		await coordinator.awaitIdle()
		expect(model.consolidate).toHaveBeenCalledTimes(2)
		expect(await store.readSummary()).toContain("Includes the new note")
	})

	it("preserves a human summary edit while final source validation is pending", async () => {
		await store.writeSummary(summary("Initial summary."))
		const validating = deferred<void>()
		const release = deferred<void>()
		let held = false
		const coordinator = make({
			isSourceCurrent: async () => {
				if (vi.mocked(model.consolidate).mock.calls.length && !held) {
					held = true
					validating.resolve()
					await release.promise
				}
				return true
			},
		})
		coordinator.wake()
		await validating.promise
		const corrected = summary("Human correction during source validation.")
		await fs.writeFile(path.join(store.rootPath, "memory_summary.md"), corrected)
		release.resolve()
		await coordinator.awaitIdle()

		expect(await store.readSummary()).toBe(corrected)
		expect(model.consolidate).toHaveBeenCalledOnce()
		expect((await state()).selection).toEqual([])
	})

	it("suppresses excluded knowledge when automatic clearing cannot replace a human-owned summary", async () => {
		const coordinator = make()
		await run(coordinator)
		const home = store.home
		store = new MemoryStore({ home, now: () => clock, summaryWriter: async () => false })
		sources = []
		await run(make())

		expect((await state()).forgetPending).toBe(true)
		expect(await fs.readFile(path.join(store.rootPath, "memory_summary.md"), "utf8")).toContain(
			"Useful Alpha knowledge",
		)
		expect(await store.readSummary()).toBeUndefined()
		expect(await new MemoryStore({ home }).readSummary()).toBeUndefined()
		await expect(store.readFile("memory_summary.md")).rejects.toThrow("awaiting removal")
		if (process.platform === "win32") {
			await expect(store.readFile("Memory_Summary.md")).rejects.toThrow("awaiting removal")
		}
		expect(await store.search("Useful Alpha knowledge")).toEqual([])
	})

	it("records an admitted publication before late cancellation finishes", async () => {
		const committed = deferred<void>()
		const release = deferred<void>()
		store = new MemoryStore({
			home: store.home,
			now: () => clock,
			summaryWriter: async (file, text, options) => {
				if (!(await options.isCurrent())) return false
				options.signal.throwIfAborted()
				await atomicWriteText(file, text, { requireAtomicReplace: true, mode: 0o600 })
				committed.resolve()
				await release.promise
				return true
			},
		})
		const coordinator = make()
		coordinator.wake()
		await committed.promise
		const disposing = coordinator.dispose()
		release.resolve()
		await disposing

		expect(await store.readSummary()).toContain("Useful Alpha knowledge")
		expect((await state()).selection).toEqual(["thread-1"])
		expect((await state()).forgetPending).toBe(false)
	})

	it("does not consolidate a saturated note inventory without all correction evidence", async () => {
		sources = []
		await store.writeSummary(summary("Keep the existing correction."))
		vi.spyOn(store, "listFiles").mockResolvedValue(
			Array.from({ length: 2_000 }, (_, index) => `extensions/ad_hoc/notes/note-${index}.md`),
		)
		await run(make())

		expect(model.consolidate).not.toHaveBeenCalled()
		expect(await store.readSummary()).toContain("Keep the existing correction.")
	})

	it("preserves the valid summary when a correction note cannot be read completely", async () => {
		sources = []
		await store.writeSummary(summary("Keep the existing correction."))
		await store.addAdHocNote("x\n".repeat(2_001))
		await run(make())

		expect(model.consolidate).not.toHaveBeenCalled()
		expect(await store.readSummary()).toContain("Keep the existing correction.")
	})

	it("retains the previous valid summary when the model rejects an incomplete notes budget", async () => {
		sources = []
		await store.writeSummary(summary("Keep the existing correction."))
		await store.addAdHocNote("A new correction must fit completely.")
		model.consolidate = vi.fn(async () => {
			throw new Error("Memory notes exceed the complete-evidence context budget")
		})
		await run(make())

		expect(model.consolidate).toHaveBeenCalledOnce()
		expect(await store.readSummary()).toContain("Keep the existing correction.")
	})

	it("prunes expired knowledge while retaining its successful extraction watermark", async () => {
		settings.maxUnusedDays = 1
		const coordinator = make()
		await run(coordinator)
		clock += DAY
		await run(coordinator)
		expect(await store.readExtraction("thread-1")).toBeUndefined()
		expect((await state()).rows[0].watermark).toBe(sources[0].updatedAt)
		expect(model.extract).toHaveBeenCalledTimes(1)
		expect(await store.readSummary()).not.toContain("Useful Alpha knowledge")
	})

	it("rejects invalid consolidation and retries after one hour without replacing a valid summary", async () => {
		model.consolidate = vi
			.fn()
			.mockResolvedValueOnce("Malformed model output")
			.mockResolvedValueOnce(summary("Recovered summary."))
		const coordinator = make()
		await run(coordinator)
		expect(await store.readSummary()).toBeUndefined()
		await run(coordinator)
		expect(model.consolidate).toHaveBeenCalledTimes(1)
		clock += HOUR
		await run(coordinator)
		expect(await store.readSummary()).toContain("Recovered summary")
	})

	it("bounds active extraction requests at eight even with a larger startup allowance", async () => {
		settings.maxRolloutsPerStartup = 20
		// One queued source is sufficient to exercise the worker bound without excess private-file writes.
		sources = Array.from({ length: 9 }, (_, index) => source(`thread-${index}`))
		const eightStarted = deferred<void>()
		const release = deferred<void>()
		let active = 0
		let peak = 0
		model.extract = vi.fn(async (item) => {
			active++
			peak = Math.max(peak, active)
			if (active === 8) eightStarted.resolve()
			await release.promise
			active--
			return { rolloutSummary: `Useful ${item.id}.`, rolloutSlug: "alpha" }
		})
		const coordinator = make()
		coordinator.wake()
		await eightStarted.promise
		expect(model.extract).toHaveBeenCalledTimes(8)
		release.resolve()
		await coordinator.awaitIdle()
		expect(model.extract).toHaveBeenCalledTimes(9)
		expect(peak).toBe(8)
	})

	it("fails closed on corrupt persisted metadata without replacing it", async () => {
		await store.withTransaction((transaction) => transaction.writeState({ version: 999, unsafe: "private" }))
		await run(make())
		expect(model.extract).not.toHaveBeenCalled()
		expect(JSON.parse(await fs.readFile(store.statePath, "utf8"))).toEqual({ version: 999, unsafe: "private" })
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Background memory pass failed" }))
	})

	it("prunes completed metadata after the extraction age window while retaining eligible empty successes", async () => {
		model.extract = vi.fn(async () => ({ rolloutSummary: "", rolloutSlug: "" }))
		const coordinator = make()
		await run(coordinator)
		const eligible = sources[0]
		clock += 11 * DAY
		sources = [eligible, source("new-thread")]
		await run(coordinator)
		expect((await state()).rows.map((row) => row.id)).toEqual(["new-thread"])
		await run(coordinator)
		expect(model.extract).toHaveBeenCalledTimes(2)
	})

	it("disposes timers and releases claims when cancellation interrupts a request", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
		settings.maxRolloutsPerStartup = 20
		sources = Array.from({ length: 20 }, (_, index) => source(`queued-${index}`))
		const started = deferred<void>()
		model.extract = vi.fn(async (_item, _messages, signal) => {
			started.resolve()
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
			throw new Error("aborted")
		})
		const coordinator = make()
		coordinator.wake()
		await started.promise
		await coordinator.dispose()
		expect(vi.getTimerCount()).toBe(0)
		expect((await state()).rows).toHaveLength(20)
		expect((await state()).rows.every((row) => row.claim === undefined && row.failures === 0)).toBe(true)
		expect(model.consolidate).not.toHaveBeenCalled()
	})
})
