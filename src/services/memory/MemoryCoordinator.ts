import { createHash, randomUUID } from "crypto"
import { z } from "zod"

import { memorySettingsSchema, type MemorySettings } from "@alpha-code/types"

import type { ApiMessage } from "../../core/task-persistence/apiMessages"
import { isValidMemorySummary, MemoryStore, type MemoryStoreTransaction } from "./MemoryStore"
import type {
	MemoryConsolidationInput,
	MemoryModelClient,
	MemoryPhase,
	MemoryRequestUsage,
	MemorySource,
	ObserveMemoryUsage,
} from "./MemoryTypes"

const HOUR = 60 * 60 * 1_000
const DAY = 24 * HOUR
const LEASE = HOUR
const HEARTBEAT = 90_000
const MAX_ROWS = 5_000
const PRUNE_BATCH = 200
const MAX_FAILURES = 3
const CONCURRENCY = 8
const MAX_CITATION_EVENTS = 2_048
const MAX_NOTES = 2_000
const MAX_NOTE_BYTES = 8_000_000
const EMPTY_SUMMARY = "v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n"
const identifier = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const claimSchema = z.object({ token: z.string().uuid(), until: timestamp, sourceVersion: timestamp })
const outputSchema = z.object({
	updatedAt: timestamp,
	slug: z
		.string()
		.min(1)
		.max(80)
		.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
	digest: z.string().length(64),
})
const rowSchema = z.object({
	id: identifier,
	inputVersion: timestamp,
	watermark: timestamp.optional(),
	failures: z.number().int().min(0).max(MAX_FAILURES).default(0),
	retryAt: timestamp.optional(),
	claim: claimSchema.optional(),
	output: outputSchema.optional(),
	usageCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
	lastUsedAt: timestamp.optional(),
})
const usageSchema = z.object({
	inputTokens: z.number().finite().nonnegative(),
	outputTokens: z.number().finite().nonnegative(),
	cacheWriteTokens: z.number().finite().nonnegative(),
	cacheReadTokens: z.number().finite().nonnegative(),
	totalCost: z.number().finite().nonnegative(),
})
const stateSchema = z.object({
	version: z.literal(1),
	epoch: z.string().uuid(),
	rows: z.array(rowSchema).max(MAX_ROWS),
	selection: z.array(identifier).max(4_096),
	notes: z
		.array(z.object({ path: z.string().max(320), digest: z.string().length(64) }))
		.max(MAX_NOTES)
		.default([]),
	selectionDigest: z.string().length(64).optional(),
	summaryDigest: z.string().length(64).optional(),
	forgetPending: z.boolean().default(false),
	citationEvents: z
		.array(z.string().regex(/^[a-f0-9]{64}$/))
		.max(MAX_CITATION_EVENTS)
		.default([]),
	consolidation: z.object({
		claim: claimSchema.optional(),
		retryAt: timestamp.optional(),
		lastSuccessAt: timestamp.optional(),
	}),
	usage: z.object({ extraction: usageSchema, consolidation: usageSchema }),
})
type State = z.infer<typeof stateSchema>
type Row = z.infer<typeof rowSchema>
type Claim = { epoch: string; token: string; source: MemorySource }
type Inputs = {
	input: MemoryConsolidationInput
	selection: string[]
	digest: string
	summaryDigest?: string
	summaryVersion?: string
}

export interface MemoryCoordinatorOptions {
	store: MemoryStore
	model: MemoryModelClient
	getSettings: () => MemorySettings
	listSources: () => Promise<MemorySource[]>
	readSource: (source: MemorySource, signal: AbortSignal) => Promise<ApiMessage[]>
	isSourceCurrent: (source: MemorySource) => Promise<boolean>
	onError?: (error: Error) => void
	now?: () => number
	remainingQuotaPercent?: () => number | undefined
}

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const emptyUsage = (): MemoryRequestUsage => ({
	inputTokens: 0,
	outputTokens: 0,
	cacheWriteTokens: 0,
	cacheReadTokens: 0,
	totalCost: 0,
})
const outputPath = (row: Row): string => `rollout_summaries/${row.id}_${row.output!.slug}.md`

/**
 * Native TypeScript scheduling for Codex's two-stage memory contract (openai/codex@970111f6, 2026-10-25).
 * Host-local transactions replace its SQLite claims; bounded model transformations replace its sandboxed worker.
 * Neither phase can execute tools or acquire workspace authority.
 */
export class MemoryCoordinator {
	private readonly now: () => number
	private disposed = false
	private pending = false
	private running?: Promise<void>
	private controller?: AbortController

	constructor(private readonly options: MemoryCoordinatorOptions) {
		this.now = options.now ?? Date.now
	}

	wake(): void {
		if (this.disposed) return
		if (!this.enabled()) {
			this.pending = false
			this.controller?.abort()
			return
		}
		this.pending = true
		if (this.running) return
		const running = Promise.resolve().then(async () => {
			while (this.pending && !this.disposed) {
				this.pending = false
				if (!this.enabled()) break
				const controller = new AbortController()
				this.controller = controller
				try {
					await this.pass(controller.signal)
				} catch {
					if (!controller.signal.aborted) this.report("Background memory pass failed")
				} finally {
					if (this.controller === controller) this.controller = undefined
				}
			}
		})
		this.running = running
		void running.finally(() => {
			if (this.running === running) this.running = undefined
			if (this.pending && !this.disposed) this.wake()
		})
	}

	/** Join the current coalesced pass without adding another job. */
	async awaitIdle(): Promise<void> {
		while (this.running) await this.running
	}

	async dispose(): Promise<void> {
		this.disposed = true
		this.pending = false
		this.controller?.abort()
		await this.awaitIdle()
	}

	/** Citations and dedicated reads report only source IDs or known relative rollout paths. */
	async recordUsage(ids: readonly string[], eventKey?: string): Promise<void> {
		if (this.disposed || !this.options.getSettings().enabled || !ids.length) return
		if (eventKey !== undefined && !/^[a-f0-9]{64}$/.test(eventKey)) throw new Error("Invalid memory usage event")
		const used = new Set(ids.slice(0, MAX_ROWS))
		await this.options.store.withTransaction(async (transaction) => {
			if (this.disposed || !this.options.getSettings().enabled) return
			const state = await this.readState(transaction)
			if (!state || (eventKey !== undefined && state.citationEvents.includes(eventKey))) return
			let matched = false
			for (const row of state.rows) {
				if (!row.output || (!used.has(row.id) && !used.has(outputPath(row)))) continue
				matched = true
				row.usageCount = Math.min(Number.MAX_SAFE_INTEGER, row.usageCount + 1)
				row.lastUsedAt = this.now()
			}
			if (!matched) return
			// Atomic bounded receipts prevent the same finalized output being counted
			// again after retry/reload, while separate model attempts remain distinct.
			if (eventKey !== undefined) {
				state.citationEvents.push(eventKey)
				if (state.citationEvents.length > MAX_CITATION_EVENTS) state.citationEvents.shift()
			}
			await transaction.writeState(state)
		})
	}

	async recordNote(text: string, signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted()
		if (this.disposed || !this.options.getSettings().enabled) throw new Error("Memory is disabled")
		const relative = await this.options.store.withTransaction((transaction) => {
			signal?.throwIfAborted()
			if (this.disposed || !this.options.getSettings().enabled) throw new Error("Memory is disabled")
			return transaction.addAdHocNote(text, signal)
		})
		this.wake()
		return relative
	}

	private settings(): MemorySettings {
		return memorySettingsSchema.parse(this.options.getSettings())
	}

	private enabled(): boolean {
		const settings = this.options.getSettings()
		return settings.enabled && settings.generateMemories
	}

	private report(message: string): void {
		// Provider errors may contain transcript content or credentials. Keep the host diagnostic bounded.
		this.options.onError?.(new Error(message))
	}

	private async readState(transaction: MemoryStoreTransaction, initialize = false): Promise<State | undefined> {
		const raw = await transaction.readState()
		if (raw !== undefined) {
			const parsed = stateSchema.safeParse(raw)
			if (!parsed.success) throw new Error("Invalid memory job state")
			return parsed.data
		}
		if (!initialize) return undefined
		return {
			version: 1,
			epoch: randomUUID(),
			rows: [],
			selection: [],
			notes: [],
			forgetPending: false,
			citationEvents: [],
			consolidation: {},
			usage: { extraction: emptyUsage(), consolidation: emptyUsage() },
		}
	}

	private validSources(sources: MemorySource[]): MemorySource[] {
		const seen = new Set<string>()
		return sources
			.filter((source) => {
				if (
					!identifier.safeParse(source.id).success ||
					!timestamp.safeParse(source.updatedAt).success ||
					seen.has(source.id)
				)
					return false
				seen.add(source.id)
				return true
			})
			.sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
	}

	private eligible(source: MemorySource, settings: MemorySettings): boolean {
		const now = this.now()
		return (
			settings.enabled &&
			settings.generateMemories &&
			!source.active &&
			source.generateMemories &&
			(!settings.disableOnExternalContext || !source.externalContext) &&
			source.updatedAt >= now - settings.maxRolloutAgeDays * DAY &&
			source.updatedAt <= now - settings.minRolloutIdleHours * HOUR
		)
	}

	private hasQuota(settings: MemorySettings): boolean {
		const remaining = this.options.remainingQuotaPercent?.()
		// Providers without a quota-reporting API follow the same permissive fallback as the CLI.
		return (
			remaining === undefined || !Number.isFinite(remaining) || remaining >= settings.minRateLimitRemainingPercent
		)
	}

	private async pass(signal: AbortSignal): Promise<void> {
		const settings = this.settings()
		const sources = this.validSources(await this.options.listSources())
		signal.throwIfAborted()
		if (!this.enabled()) return
		// Prepare the host-local namespace before pruning or quota checks, even when there are no candidates.
		await this.options.store.initialize()
		signal.throwIfAborted()
		const claims = await this.options.store.withTransaction(async (transaction) => {
			if (signal.aborted || !this.enabled()) return []
			const state = (await this.readState(transaction, true))!
			await this.prune(transaction, state, sources, settings, signal)
			const claims: Claim[] = []
			let outstanding = state.rows.filter((row) => row.claim && row.claim.until > this.now()).length
			if (this.hasQuota(settings)) {
				const rows = new Map(state.rows.map((row) => [row.id, row]))
				for (const source of sources.filter((item) => this.eligible(item, settings)).slice(0, MAX_ROWS)) {
					if (
						claims.length >= settings.maxRolloutsPerStartup ||
						outstanding >= settings.maxRolloutsPerStartup
					)
						break
					let row = rows.get(source.id)
					if (!row) {
						if (state.rows.length >= MAX_ROWS) continue
						row = { id: source.id, inputVersion: source.updatedAt, failures: 0, usageCount: 0 }
						state.rows.push(row)
						rows.set(row.id, row)
					}
					if (row.watermark !== undefined && row.watermark >= source.updatedAt) continue
					if (row.claim && row.claim.until > this.now()) continue
					if (source.updatedAt > row.inputVersion) {
						row.failures = 0
						row.retryAt = undefined
					}
					if (row.failures >= MAX_FAILURES || (row.retryAt !== undefined && row.retryAt > this.now()))
						continue
					const token = randomUUID()
					row.inputVersion = source.updatedAt
					row.claim = { token, until: this.now() + LEASE, sourceVersion: source.updatedAt }
					claims.push({ epoch: state.epoch, token, source })
					outstanding++
				}
			}
			await transaction.writeState(state)
			return claims
		})
		let cursor = 0
		try {
			const workers = await Promise.allSettled(
				Array.from({ length: Math.min(CONCURRENCY, claims.length) }, async () => {
					while (cursor < claims.length && !signal.aborted) await this.extract(claims[cursor++], signal)
				}),
			)
			if (workers.some((worker) => worker.status === "rejected"))
				this.report("Memory extraction finalization failed")
		} finally {
			// Claims waiting behind the bounded worker pool also belong to this pass. Do not strand them on cancellation.
			if (claims.length)
				await this.options.store.withTransaction(async (transaction) => {
					const state = await this.readState(transaction)
					if (!state || state.epoch !== claims[0].epoch) return
					const tokens = new Set(claims.map((claim) => claim.token))
					let changed = false
					for (const row of state.rows)
						if (row.claim && tokens.has(row.claim.token)) {
							row.claim = undefined
							changed = true
						}
					if (changed) await transaction.writeState(state)
				})
		}
		signal.throwIfAborted()
		if (!this.enabled()) return
		await this.consolidate(signal)
	}

	private async prune(
		transaction: MemoryStoreTransaction,
		state: State,
		sources: MemorySource[],
		settings: MemorySettings,
		signal: AbortSignal,
	): Promise<void> {
		const available = new Map(sources.map((source) => [source.id, source]))
		const cutoff = this.now() - settings.maxUnusedDays * DAY
		let pruned = 0
		const byOldestUse = [...state.rows].sort(
			(a, b) =>
				(a.lastUsedAt ?? a.output?.updatedAt ?? a.inputVersion) -
					(b.lastUsedAt ?? b.output?.updatedAt ?? b.inputVersion) || a.id.localeCompare(b.id),
		)
		for (const row of byOldestUse) {
			if (row.claim && row.claim.until <= this.now()) row.claim = undefined
			if (!row.output) continue
			const source = available.get(row.id)
			const disabled =
				!source || !source.generateMemories || (settings.disableOnExternalContext && source.externalContext)
			const expired = (row.lastUsedAt ?? row.output.updatedAt) < cutoff
			if (!disabled && !expired) continue
			if (state.selection.includes(row.id)) state.forgetPending = true
			// Excluded sources disappear from the visible namespace immediately, even when cache pruning is batched.
			await transaction.removeRolloutSummary(outputPath(row))
			if (disabled || pruned < PRUNE_BATCH) {
				await transaction.removeExtraction(row.id)
				row.output = undefined
				pruned++
			}
		}
		// Empty successes remain deduplicated for the entire extraction eligibility window.
		// Once their source is gone or too old, bounded tombstone pruning frees room for future conversations.
		const selected = new Set(state.selection)
		const generationCutoff = this.now() - settings.maxRolloutAgeDays * DAY
		const tombstones = new Set(
			byOldestUse
				.filter((row) => {
					const source = available.get(row.id)
					return (
						!row.output &&
						!row.claim &&
						!selected.has(row.id) &&
						(!source || source.updatedAt < generationCutoff)
					)
				})
				.slice(0, PRUNE_BATCH)
				.map((row) => row.id),
		)
		if (tombstones.size) state.rows = state.rows.filter((row) => !tombstones.has(row.id))
		if (state.forgetPending) {
			await this.clearSummary(transaction, state, signal)
		}
	}

	private async clearSummary(transaction: MemoryStoreTransaction, state: State, signal: AbortSignal): Promise<void> {
		// A human edit may prevent replacement. Suppress stale learned context before
		// attempting it so new tasks cannot reuse knowledge from excluded sources.
		state.forgetPending = true
		await transaction.writeState(state)
		const snapshot = await transaction.readSummarySnapshot()
		if (snapshot.summary?.replace(/\r\n/g, "\n") !== EMPTY_SUMMARY) {
			const published = await transaction.writeSummaryIfUnchanged(EMPTY_SUMMARY, {
				expectedVersion: snapshot.version,
				signal,
				isCurrent: async () => this.enabled(),
			})
			if (!published) throw new Error("Memory maintenance could not replace a changed summary")
		}
		state.summaryDigest = digest((await transaction.readSummarySnapshot()).summary ?? EMPTY_SUMMARY)
	}

	private observeUsage(epoch: string): ObserveMemoryUsage {
		return async (phase: MemoryPhase, usage: MemoryRequestUsage) => {
			const parsed = usageSchema.safeParse(usage)
			if (!parsed.success) return
			await this.options.store.withTransaction(async (transaction) => {
				const state = await this.readState(transaction)
				if (!state || state.epoch !== epoch) return
				for (const key of Object.keys(parsed.data) as Array<keyof MemoryRequestUsage>) {
					state.usage[phase][key] = Math.min(
						Number.MAX_SAFE_INTEGER,
						state.usage[phase][key] + parsed.data[key],
					)
				}
				await transaction.writeState(state)
			})
		}
	}

	private heartbeat(
		epoch: string,
		token: string,
		sourceId: string | undefined,
		controller: AbortController,
	): () => Promise<void> {
		let pending: Promise<void> | undefined
		const timer = setInterval(() => {
			if (pending) return
			pending = this.options.store
				.withTransaction(async (transaction) => {
					const state = await this.readState(transaction)
					const claim =
						sourceId === undefined
							? state?.consolidation.claim
							: state?.rows.find((row) => row.id === sourceId)?.claim
					if (!state || state.epoch !== epoch || claim?.token !== token || !this.enabled()) {
						controller.abort()
						return
					}
					claim.until = this.now() + LEASE
					await transaction.writeState(state)
				})
				.catch(() => controller.abort())
				.finally(() => {
					pending = undefined
				})
		}, HEARTBEAT)
		timer.unref?.()
		return async () => {
			clearInterval(timer)
			await pending
		}
	}

	private async extract(claim: Claim, parentSignal: AbortSignal): Promise<void> {
		const controller = new AbortController()
		const abort = () => controller.abort()
		parentSignal.addEventListener("abort", abort, { once: true })
		if (parentSignal.aborted) controller.abort()
		const stopHeartbeat = this.heartbeat(claim.epoch, claim.token, claim.source.id, controller)
		let failed = false
		try {
			if (!this.eligible(claim.source, this.settings()) || !(await this.options.isSourceCurrent(claim.source)))
				return
			controller.signal.throwIfAborted()
			const messages = await this.options.readSource(claim.source, controller.signal)
			if (!this.eligible(claim.source, this.settings()) || !(await this.options.isSourceCurrent(claim.source)))
				return
			controller.signal.throwIfAborted()
			const output = await this.options.model.extract(
				claim.source,
				messages,
				controller.signal,
				this.observeUsage(claim.epoch),
			)
			await this.options.store.withTransaction(async (transaction) => {
				const state = await this.readState(transaction)
				const row = state?.rows.find((item) => item.id === claim.source.id)
				if (
					!state ||
					state.epoch !== claim.epoch ||
					row?.claim?.token !== claim.token ||
					controller.signal.aborted ||
					!this.eligible(claim.source, this.settings()) ||
					!(await this.options.isSourceCurrent(claim.source))
				)
					return
				// Source validation performs I/O; a setting change or cancellation can arrive while it is pending.
				controller.signal.throwIfAborted()
				if (!this.eligible(claim.source, this.settings())) return
				if (output.rolloutSummary.trim()) {
					if (!outputSchema.shape.slug.safeParse(output.rolloutSlug).success)
						throw new Error("Invalid memory rollout slug")
					if (row.output) await transaction.removeRolloutSummary(outputPath(row))
					await transaction.writeExtraction(row.id, output.rolloutSummary)
					const text = await transaction.readExtraction(row.id)
					if (text === undefined) throw new Error("Missing memory extraction")
					row.output = { updatedAt: claim.source.updatedAt, slug: output.rolloutSlug, digest: digest(text) }
				} else if (row.output) {
					await transaction.removeRolloutSummary(outputPath(row))
					await transaction.removeExtraction(row.id)
					row.output = undefined
					if (state.selection.includes(row.id)) state.forgetPending = true
				}
				// A successful empty extraction also advances this watermark; it must never be charged repeatedly.
				row.watermark = claim.source.updatedAt
				row.claim = undefined
				row.failures = 0
				row.retryAt = undefined
				await transaction.writeState(state)
			})
		} catch {
			failed = !controller.signal.aborted && this.enabled()
			if (failed) this.report("Memory extraction failed")
		} finally {
			await stopHeartbeat()
			parentSignal.removeEventListener("abort", abort)
			await this.options.store.withTransaction(async (transaction) => {
				const state = await this.readState(transaction)
				const row = state?.rows.find((item) => item.id === claim.source.id)
				if (!state || state.epoch !== claim.epoch || row?.claim?.token !== claim.token) return
				row.claim = undefined
				if (failed) {
					row.failures = Math.min(MAX_FAILURES, row.failures + 1)
					row.retryAt = this.now() + HOUR
				}
				await transaction.writeState(state)
			})
		}
	}

	private async inputs(
		transaction: MemoryStoreTransaction,
		state: State,
		sources: MemorySource[],
		signal: AbortSignal,
	): Promise<Inputs> {
		const settings = this.settings()
		await this.prune(transaction, state, sources, settings, signal)
		const available = new Map(sources.map((source) => [source.id, source]))
		const cutoff = this.now() - settings.maxUnusedDays * DAY
		const ranked = state.rows
			.filter((row) => {
				const source = available.get(row.id)
				return (
					row.output &&
					source?.generateMemories &&
					(!settings.disableOnExternalContext || !source.externalContext) &&
					(row.lastUsedAt ?? row.output.updatedAt) >= cutoff
				)
			})
			.sort(
				(a, b) =>
					b.usageCount - a.usageCount ||
					(b.lastUsedAt ?? b.output!.updatedAt) - (a.lastUsedAt ?? a.output!.updatedAt) ||
					b.output!.updatedAt - a.output!.updatedAt ||
					b.id.localeCompare(a.id),
			)
		const chosen: Row[] = []
		const contents = new Map<string, string>()
		for (const row of ranked) {
			if (chosen.length >= settings.maxMemoriesForConsolidation) break
			const text = await transaction.readExtraction(row.id)
			if (!text?.trim()) continue
			chosen.push(row)
			contents.set(row.id, text)
		}
		chosen.sort((a, b) => a.id.localeCompare(b.id))
		const selected = new Set(chosen.map((row) => row.id))
		if (state.selection.some((id) => !selected.has(id))) state.forgetPending = true
		if (state.forgetPending) {
			await this.clearSummary(transaction, state, signal)
		}
		for (const row of state.rows) {
			if (row.output && !selected.has(row.id)) await transaction.removeRolloutSummary(outputPath(row))
		}
		const rollouts: MemoryConsolidationInput["rollouts"] = []
		for (const row of chosen) {
			const text = contents.get(row.id)!
			const relative = outputPath(row)
			let current: string | undefined
			try {
				current = await this.options.store.readFile(relative, 1, 2_000)
			} catch {
				/* Optional materialization. */
			}
			if (current !== text)
				await transaction.writeRolloutSummary(row.id, row.output!.slug, text, row.output!.updatedAt)
			rollouts.push({ id: row.id, updatedAt: row.output!.updatedAt, path: relative, text })
		}
		const notes: MemoryConsolidationInput["notes"] = []
		const files = await this.options.store.listFiles(undefined, "extensions/ad_hoc/notes")
		// Corrections and forget requests remain evidence until the user removes them.
		// A saturated inventory cannot prove that all such evidence was retained.
		if (files.length >= MAX_NOTES) throw new Error("Memory note inventory exceeds its safe consolidation limit")
		let noteBytes = 0
		for (const relative of files.filter((file) => file.startsWith("extensions/ad_hoc/notes/")).sort()) {
			const read = await this.options.store.readFileDetails(relative, 1, 2_000)
			if (read.truncated) throw new Error("Memory correction notes must be complete before consolidation")
			const text = read.content
			noteBytes += Buffer.byteLength(text, "utf8")
			if (noteBytes > MAX_NOTE_BYTES) throw new Error("Memory notes exceed their safe consolidation size")
			if (text.trim()) notes.push({ path: relative, text })
		}
		if (
			state.notes.some(
				(note) => !notes.some((current) => current.path === note.path && digest(current.text) === note.digest),
			)
		) {
			state.forgetPending = true
			await this.clearSummary(transaction, state, signal)
		}
		const { summary, version } = await transaction.readSummarySnapshot()
		return {
			input: { previousSummary: state.forgetPending ? undefined : summary, rollouts, notes },
			selection: chosen.map((row) => row.id),
			digest: digest({ rollouts, notes }),
			summaryDigest: summary === undefined ? undefined : digest(summary),
			summaryVersion: version,
		}
	}

	private async consolidate(parentSignal: AbortSignal): Promise<void> {
		const sources = this.validSources(await this.options.listSources())
		const job = await this.options.store.withTransaction(async (transaction) => {
			const state = await this.readState(transaction)
			if (!state || parentSignal.aborted || !this.enabled()) return undefined
			const inputs = await this.inputs(transaction, state, sources, parentSignal)
			const now = this.now()
			if (!inputs.input.rollouts.length && !inputs.input.notes.length) {
				if (state.selection.length || state.forgetPending)
					await this.clearSummary(transaction, state, parentSignal)
				state.selection = []
				state.notes = []
				state.selectionDigest = inputs.digest
				state.summaryDigest = inputs.summaryDigest
				state.forgetPending = false
				await transaction.writeState(state)
				return undefined
			}
			const unchanged =
				state.selectionDigest === inputs.digest &&
				state.summaryDigest === inputs.summaryDigest &&
				inputs.summaryDigest !== undefined
			if (
				unchanged ||
				!this.hasQuota(this.settings()) ||
				(state.consolidation.claim && state.consolidation.claim.until > now) ||
				(state.consolidation.retryAt !== undefined && state.consolidation.retryAt > now) ||
				(state.consolidation.lastSuccessAt !== undefined && state.consolidation.lastSuccessAt + 6 * HOUR > now)
			) {
				await transaction.writeState(state)
				return undefined
			}
			const token = randomUUID()
			state.consolidation.claim = { token, until: now + LEASE, sourceVersion: now }
			await transaction.writeState(state)
			return { epoch: state.epoch, token, inputs }
		})
		if (!job) return
		const controller = new AbortController()
		const abort = () => controller.abort()
		parentSignal.addEventListener("abort", abort, { once: true })
		if (parentSignal.aborted) controller.abort()
		const stopHeartbeat = this.heartbeat(job.epoch, job.token, undefined, controller)
		let failed = false
		try {
			controller.signal.throwIfAborted()
			const summary = await this.options.model.consolidate(
				job.inputs.input,
				controller.signal,
				this.observeUsage(job.epoch),
			)
			if (!isValidMemorySummary(summary)) throw new Error("Invalid memory consolidation summary")
			const currentSources = this.validSources(await this.options.listSources())
			await this.options.store.withTransaction(async (transaction) => {
				const state = await this.readState(transaction)
				if (
					!state ||
					state.epoch !== job.epoch ||
					state.consolidation.claim?.token !== job.token ||
					controller.signal.aborted ||
					!this.enabled()
				)
					return
				const current = await this.inputs(transaction, state, currentSources, controller.signal)
				if (
					current.digest !== job.inputs.digest ||
					current.summaryDigest !== job.inputs.summaryDigest ||
					current.summaryVersion !== job.inputs.summaryVersion
				) {
					state.consolidation.claim = undefined
					await transaction.writeState(state)
					this.pending = true
					return
				}
				const published = await transaction.writeSummaryIfUnchanged(summary, {
					expectedVersion: job.inputs.summaryVersion,
					signal: controller.signal,
					isCurrent: async () => {
						for (const rollout of current.input.rollouts) {
							const source = currentSources.find((item) => item.id === rollout.id)
							if (!source || (!source.active && !(await this.options.isSourceCurrent(source))))
								return false
						}
						controller.signal.throwIfAborted()
						return this.enabled()
					},
				})
				if (!published) return
				let persisted: string | undefined
				try {
					persisted = (await transaction.readSummarySnapshot()).summary
				} catch {
					/* Write remains validated by the store. */
				}
				state.selection = current.selection
				state.notes = current.input.notes.map((note) => ({ path: note.path, digest: digest(note.text) }))
				state.selectionDigest = current.digest
				state.summaryDigest = digest(persisted ?? summary)
				state.forgetPending = false
				state.consolidation.claim = undefined
				state.consolidation.retryAt = undefined
				state.consolidation.lastSuccessAt = this.now()
				await transaction.writeState(state)
			})
		} catch {
			failed = !controller.signal.aborted && this.enabled()
			if (failed) this.report("Memory consolidation failed")
		} finally {
			await stopHeartbeat()
			parentSignal.removeEventListener("abort", abort)
			await this.options.store.withTransaction(async (transaction) => {
				const state = await this.readState(transaction)
				if (!state || state.epoch !== job.epoch || state.consolidation.claim?.token !== job.token) return
				state.consolidation.claim = undefined
				if (failed) state.consolidation.retryAt = this.now() + HOUR
				await transaction.writeState(state)
			})
		}
	}
}
