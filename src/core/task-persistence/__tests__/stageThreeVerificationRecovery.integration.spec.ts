import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { createHash } from "crypto"

import type { Anthropic } from "@anthropic-ai/sdk"
import type { ModelInfo, ParentVerificationObligation } from "@alpha-code/types"
import { TelemetryService } from "@alpha-code/telemetry"
import { beforeEach, describe, expect, it } from "vitest"

import type { ApiStream } from "../../../api/transform/stream"
import { BaseProvider } from "../../../api/providers/base-provider"
import {
	AgentControlStore,
	FileAgentControlPersistence,
	type ParentCommandVerificationEvidence,
} from "../../agent/AgentControlStore"
import { countHistoryTokens, getEffectiveApiHistory, summarizeConversation } from "../../condense"
import type { ApiMessage } from "../apiMessages"
import { ProviderTranscriptStore } from "../ProviderTranscriptStore"

const TASK_ID = "stage-three-verification-recovery"
const CHANGED_FILE = "src/fixture.ts"
const REVISION_A = "export const fixture = 1\n"
const REVISION_B = "export const fixture = 2\n"
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex")

class RecoverySummaryProvider extends BaseProvider {
	async *createMessage(): ApiStream {
		yield { type: "text", text: "Synthetic summary of older steps. Continue with the preserved recent context." }
		yield { type: "usage", inputTokens: 0, outputTokens: 16, totalCost: 0 }
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: "verification-recovery-fixture",
			info: {
				contextWindow: 65_536,
				maxTokens: 4_096,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0,
				outputPrice: 0,
			},
		}
	}

	override async countTokens(content: Anthropic.Messages.ContentBlockParam[]): Promise<number> {
		return Math.ceil(JSON.stringify(content).length / 4)
	}
}

function initialHistory(): ApiMessage[] {
	return [
		{
			id: "original-request",
			ts: 100,
			role: "user",
			content: "Implement the requested source change and validate it.",
		},
		{
			id: "originating-edit",
			ts: 101,
			role: "assistant",
			content: [{ type: "tool_use", id: "edit-call", name: "apply_diff", input: { path: CHANGED_FILE } }],
		},
		{
			id: "edit-receipt",
			ts: 102,
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "edit-call",
					content: JSON.stringify({ status: "success", evidence: "Archived source detail. ".repeat(800) }),
				},
			],
		},
		{
			id: "edit-step-summary",
			ts: 103,
			role: "assistant",
			content: "The requested source change has been applied; validation remains pending.",
		},
		{
			id: "recent-request",
			ts: 200,
			role: "user",
			content: "Inspect the current workspace without further edits.",
		},
		{
			id: "recent-read",
			ts: 201,
			role: "assistant",
			content: [{ type: "tool_use", id: "read-call", name: "list_files", input: { path: "src" } }],
		},
		{
			id: "recent-receipt",
			ts: 202,
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "read-call", content: "fixture.ts" }],
		},
	]
}

async function createFixture() {
	const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "alpha-stage-three-recovery-"))
	const workspace = path.join(directory, "workspace")
	const storage = path.join(directory, "storage")
	const file = path.join(workspace, CHANGED_FILE)
	await fs.mkdir(path.dirname(file), { recursive: true })
	await fs.writeFile(file, REVISION_A)
	const stores: AgentControlStore[] = []
	let time = 10_000
	const now = () => ++time
	const openLedger = async () => {
		const ledger = new AgentControlStore(new FileAgentControlPersistence(storage), now)
		stores.push(ledger)
		await ledger.initialize()
		await ledger.ensureRoot({ taskId: TASK_ID, objective: "Verify the fixture source change", status: "running" })
		return ledger
	}
	const ledger = await openLedger()
	const versions = async () => ({ [CHANGED_FILE]: hash(await fs.readFile(file)) })
	const recordMutation = async (target: AgentControlStore) => {
		const obligation = await target.recordPrimaryMutation({
			rootTaskId: TASK_ID,
			parentTaskId: TASK_ID,
			workspacePath: workspace,
			fileVersions: await versions(),
			at: now(),
		})
		if (!obligation) throw new Error("The material primary mutation must create an obligation")
		return obligation
	}
	const reconcile = async (target: AgentControlStore, obligation: ParentVerificationObligation) =>
		target.reconcileVerificationContent(TASK_ID, obligation.changeSetId, workspace, await versions(), TASK_ID)
	const reloadLedger = async (previous: AgentControlStore) => {
		await previous.shutdown()
		return openLedger()
	}
	return {
		directory,
		workspace,
		storage,
		file,
		now,
		ledger,
		recordMutation,
		reconcile,
		reloadLedger,
		async close() {
			await Promise.all(stores.map((store) => store.shutdown()))
			await fs.rm(directory, { recursive: true, force: true })
		},
	}
}

type Fixture = Awaited<ReturnType<typeof createFixture>>

/**
 * This is host-admitted fixture evidence, not a command-recognition test. Real process admission,
 * command relevance, and cancellation are covered by the separate command-outcome integration suite.
 */
function passingEvidence(
	fixture: Fixture,
	obligation: ParentVerificationObligation,
	id = "verification-a",
): ParentCommandVerificationEvidence {
	if (!obligation.contentVersion || !obligation.contentFingerprint) {
		throw new Error("Primary obligations must carry a current content version")
	}
	return {
		toolCallId: id,
		executionId: `${id}-physical-execution`,
		status: "succeeded",
		exitCode: 0,
		startedAt: fixture.now(),
		completedAt: fixture.now(),
		cwd: fixture.workspace,
		verificationChangeSetIds: [obligation.changeSetId],
		verificationVersions: {
			[obligation.changeSetId]: {
				kind: "test",
				contentVersion: obligation.contentVersion,
				contentFingerprint: obligation.contentFingerprint,
				scopePath: fixture.workspace,
				commandDigest: hash("fixture-admitted-verifier"),
				repositoryDigest: hash("fixture-repository-requirements"),
			},
		},
	}
}

async function compactAndReloadTranscript(fixture: Fixture) {
	const transcript = new ProviderTranscriptStore(TASK_ID, fixture.storage, { now: fixture.now })
	const history = initialHistory()
	const initial = await transcript.commit(history)
	await transcript.verifyCommitReceipt(initial)
	const summaryProvider = new RecoverySummaryProvider()
	const condensed = await summarizeConversation({
		messages: history,
		apiHandler: summaryProvider,
		systemPrompt: "Synthetic verification-recovery fixture",
		taskId: TASK_ID,
		isAutomaticTrigger: false,
		metadata: { taskId: TASK_ID },
		recentTailTokenBudget: await countHistoryTokens(history.slice(-3), summaryProvider),
		maxContextTokens: 16_384,
	})
	expect(condensed.error).toBeUndefined()
	expect(condensed.summary).toBeTruthy()
	const receipt = await transcript.commit({ messages: condensed.messages, expectedRevision: initial.revision })
	await transcript.verifyCommitReceipt(receipt)
	const restarted = new ProviderTranscriptStore(TASK_ID, fixture.storage, { now: fixture.now })
	const loaded = await restarted.read()
	await restarted.verifyCommitReceipt(receipt)
	const effective = getEffectiveApiHistory(loaded.messages)
	expect(effective.some((message) => message.id === "originating-edit")).toBe(false)
	expect(effective[0]?.isSummary).toBe(true)
	expect(effective.slice(1)).toEqual(history.slice(-3))
	expect(loaded.messages.find((message) => message.id === "edit-receipt")?.content).toEqual(history[2].content)
	return { restarted, receipt, loaded }
}

describe("Stage Three verification authority through compaction and recovery", () => {
	beforeEach(() => {
		if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	})

	it("does not invent verification debt when an ordinary no-obligation task compacts and reloads", async () => {
		const fixture = await createFixture()
		try {
			await compactAndReloadTranscript(fixture)
			const reloaded = await fixture.reloadLedger(fixture.ledger)
			expect(reloaded.getVerificationObligations({ parentTaskId: TASK_ID })).toEqual([])
			expect(reloaded.getParentCompletionDecision(TASK_ID).allowed).toBe(true)
		} finally {
			await fixture.close()
		}
	})

	it("retains primary verification debt after its originating edit leaves active context and the stores restart", async () => {
		const fixture = await createFixture()
		try {
			const obligation = await fixture.recordMutation(fixture.ledger)
			expect(fixture.ledger.getParentCompletionDecision(TASK_ID).allowed).toBe(false)
			await compactAndReloadTranscript(fixture)
			const reloaded = await fixture.reloadLedger(fixture.ledger)
			await fixture.reconcile(reloaded, obligation)
			expect(reloaded.getVerificationObligations({ parentTaskId: TASK_ID })).toEqual([obligation])
			expect(reloaded.getParentCompletionDecision(TASK_ID)).toMatchObject({
				allowed: false,
				blockingObligations: [{ changeSetId: obligation.changeSetId, status: "pending" }],
			})
		} finally {
			await fixture.close()
		}
	})

	it("preserves current passing evidence across compaction/reload and treats replay as a no-op", async () => {
		const fixture = await createFixture()
		try {
			const obligation = await fixture.recordMutation(fixture.ledger)
			const evidence = passingEvidence(fixture, obligation)
			await fixture.ledger.recordParentVerificationEvidence(TASK_ID, [evidence], TASK_ID)
			expect(fixture.ledger.getParentCompletionDecision(TASK_ID).allowed).toBe(true)
			const satisfied = fixture.ledger.getVerificationObligations({ parentTaskId: TASK_ID })
			await compactAndReloadTranscript(fixture)
			const reloaded = await fixture.reloadLedger(fixture.ledger)
			await fixture.reconcile(reloaded, obligation)
			expect(await reloaded.recordParentVerificationEvidence(TASK_ID, [evidence], TASK_ID)).toEqual([])
			expect(reloaded.getVerificationObligations({ parentTaskId: TASK_ID })).toEqual(satisfied)
			expect(reloaded.getParentCompletionDecision(TASK_ID).allowed).toBe(true)
		} finally {
			await fixture.close()
		}
	})

	it("does not resurrect old passing evidence when history and file content rewind to an earlier revision", async () => {
		const fixture = await createFixture()
		try {
			const original = await fixture.recordMutation(fixture.ledger)
			const oldEvidence = passingEvidence(fixture, original)
			await fixture.ledger.recordParentVerificationEvidence(TASK_ID, [oldEvidence], TASK_ID)
			const { restarted, receipt } = await compactAndReloadTranscript(fixture)
			const reloaded = await fixture.reloadLedger(fixture.ledger)

			await fs.writeFile(fixture.file, REVISION_B)
			const changed = await fixture.recordMutation(reloaded)
			expect(changed.contentVersion).toBeGreaterThan(original.contentVersion!)
			expect(reloaded.getParentCompletionDecision(TASK_ID).allowed).toBe(false)

			// A history rewind cannot remove ledger debt. Returning to identical bytes is still
			// a new revision after an intervening change, so an old physical execution stays stale.
			await fs.writeFile(fixture.file, REVISION_A)
			const rewoundReceipt = await restarted.commit({
				messages: [initialHistory()[0]],
				expectedRevision: receipt.revision,
			})
			await restarted.verifyCommitReceipt(rewoundReceipt)
			const reconciled = await fixture.reconcile(reloaded, changed)
			expect(reconciled?.contentFingerprint).toBe(original.contentFingerprint)
			expect(reconciled?.contentVersion).toBeGreaterThan(changed.contentVersion!)
			expect(await reloaded.recordParentVerificationEvidence(TASK_ID, [oldEvidence], TASK_ID)).toEqual([])
			expect(reloaded.getParentCompletionDecision(TASK_ID).allowed).toBe(false)

			const finalReload = await fixture.reloadLedger(reloaded)
			expect(finalReload.getVerificationObligations({ parentTaskId: TASK_ID })).toEqual([reconciled])
			expect(finalReload.getParentCompletionDecision(TASK_ID).allowed).toBe(false)
			expect((await restarted.read()).messages).toEqual([initialHistory()[0]])
		} finally {
			await fixture.close()
		}
	})
})
