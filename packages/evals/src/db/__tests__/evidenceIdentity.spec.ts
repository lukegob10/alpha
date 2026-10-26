import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
	selected: 1,
	rows: new Map<number, Record<string, unknown>>(),
	trial: { id: 1, task: { runId: 7 }, taskDefinitionIdentity: "", variantIdentity: "" },
}))

vi.mock("../db", () => {
	const transaction = {
		select: () => ({ from: () => ({ where: () => ({ for: async () => [state.rows.get(state.selected)] }) }) }),
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: () => ({
					returning: async () => {
						const row = state.rows.get(state.selected)!
						Object.assign(row, values)
						return [row]
					},
					then: (resolve: (value: unknown) => unknown) => {
						Object.assign(state.trial, values)
						return Promise.resolve(resolve(undefined))
					},
				}),
			}),
		}),
	}
	return {
		client: {
			transaction: (run: (tx: typeof transaction) => unknown) => run(transaction),
			query: { attempts: { findFirst: async () => ({ ...state.rows.get(state.selected), trial: state.trial }) } },
		},
	}
})

import { evidenceBundleDigest } from "../../evidence/integrity"
import type { EvidenceBundle } from "../../evidence/types"
import { getReconstructableEvidenceBundle, recordEvidenceIntegrity } from "../queries/evidence"

function bundle(attemptId: number, suffix: string): EvidenceBundle {
	return {
		schemaVersion: 1,
		runId: "7",
		trialId: "1",
		attemptId: String(attemptId),
		taskIdentity: `task-${suffix}`,
		variantIdentity: `variant-${suffix}`,
		events: [],
		artifacts: [],
	}
}

beforeEach(() => {
	state.selected = 1
	state.rows.clear()
	for (const id of [1, 2])
		state.rows.set(id, { id, trialId: 1, evidenceStatus: "pending", events: [], artifacts: [] })
	Object.assign(state.trial, { taskDefinitionIdentity: "", variantIdentity: "" })
})

describe("attempt-bound immutable evidence", () => {
	it("preserves an earlier attempt when the retry has different or not-yet-observed identity", async () => {
		const first = bundle(1, "first")
		await recordEvidenceIntegrity({
			attemptId: 1,
			status: "valid",
			taskIdentity: first.taskIdentity,
			variantIdentity: first.variantIdentity,
			bundleDigest: evidenceBundleDigest(first),
			bundle: first,
		})
		state.selected = 2
		await recordEvidenceIntegrity({
			attemptId: 2,
			status: "pending",
			taskIdentity: "task-second",
			variantIdentity: "unavailable:executed-harness",
		})
		state.selected = 1
		expect(await getReconstructableEvidenceBundle(1)).toMatchObject({ ...first, identityStatus: "attempt-bound" })
		state.selected = 2
		const second = bundle(2, "second")
		await recordEvidenceIntegrity({
			attemptId: 2,
			status: "valid",
			taskIdentity: second.taskIdentity,
			variantIdentity: second.variantIdentity,
			bundleDigest: evidenceBundleDigest(second),
			bundle: second,
		})
		state.selected = 1
		state.rows.get(1)!.events = [{ late: true }]
		state.rows.get(1)!.artifacts = [{ kind: "superseded-output" }]
		expect(await getReconstructableEvidenceBundle(1)).toMatchObject(first)
	})

	it("rejects reassignment and content changes after sealing", async () => {
		const original = bundle(1, "first")
		const input = {
			attemptId: 1,
			status: "valid" as const,
			taskIdentity: original.taskIdentity,
			variantIdentity: original.variantIdentity,
			bundleDigest: evidenceBundleDigest(original),
			bundle: original,
		}
		await recordEvidenceIntegrity(input)
		await expect(recordEvidenceIntegrity(input)).resolves.toMatchObject({ evidenceStatus: "valid" })
		await expect(recordEvidenceIntegrity({ ...input, variantIdentity: "different" })).rejects.toThrow("sealed")
		state.rows.get(1)!.variantIdentity = "database-replaced"
		await expect(getReconstructableEvidenceBundle(1)).rejects.toThrow("digest mismatch")
	})

	it("requires a complete digest and reports historical shared identities as unavailable", async () => {
		await expect(
			recordEvidenceIntegrity({
				attemptId: 1,
				status: "valid",
				taskIdentity: "task",
				variantIdentity: "variant",
			}),
		).rejects.toThrow("complete evidence bundle digest")
		state.rows.get(1)!.evidenceStatus = "valid"
		Object.assign(state.trial, { taskDefinitionIdentity: "later-task", variantIdentity: "later-variant" })
		expect(await getReconstructableEvidenceBundle(1)).toMatchObject({
			identityStatus: "legacy-unavailable",
			taskIdentity: "unavailable:legacy-attempt-identity",
			variantIdentity: "unavailable:legacy-attempt-identity",
		})
	})
})
