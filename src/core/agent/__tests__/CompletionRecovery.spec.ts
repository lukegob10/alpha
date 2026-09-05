import type { ParentVerificationObligation } from "@alpha-code/types"

import { CompletionRecovery } from "../CompletionRecovery"

function obligation(id = "change"): ParentVerificationObligation {
	return {
		id,
		rootTaskId: "root",
		parentTaskId: "root",
		workerTaskId: "worker",
		workerNickname: "Worker",
		groupId: "group",
		changeSetId: id,
		status: "pending",
		createdAt: 1,
		updatedAt: 1,
		contentVersion: 1,
		changedFiles: ["src/change.ts"],
		fileVersions: { "src/change.ts": "v1" },
		verificationRequirements: { "src/change.ts": ["test"] },
	}
}

const scopes = [{ changeSetId: "change", matchedFiles: ["src/change.ts"], kind: "test" }]

describe("completion repair allowance", () => {
	it("does not reset existing debt when unrelated edits change the aggregate version", () => {
		const recovery = new CompletionRecovery()
		const original = obligation()
		const decision = { allowed: false, blockingObligations: [original] }
		expect(recovery.reject(decision)).toBe(false)
		expect(recovery.reject(decision)).toBe(false)
		original.contentVersion = 2
		original.changedFiles.push("other/new.ts")
		original.fileVersions!["other/new.ts"] = "new"
		expect(recovery.reject(decision)).toBe(true)
	})

	it("reopens the allowance for a relevant new content receipt", () => {
		const recovery = new CompletionRecovery()
		const original = obligation()
		const decision = { allowed: false, blockingObligations: [original] }
		recovery.reject(decision)
		recovery.reject(decision)
		original.fileVersions!["src/change.ts"] = "v2"
		expect(recovery.reject(decision)).toBe(false)
	})

	it("bounds equivalent associated checks that produce no accepted evidence", () => {
		const recovery = new CompletionRecovery()
		const decision = { allowed: false, blockingObligations: [obligation()] }
		recovery.reject(decision)
		for (let index = 0; index < 8; index++) expect(recovery.recordCheck(decision, scopes)).toBe(index === 7)
	})

	it("does not charge an unrelated or differently scoped check to the blocker", () => {
		const recovery = new CompletionRecovery()
		const decision = { allowed: false, blockingObligations: [obligation()] }
		recovery.reject(decision)
		for (let index = 0; index < 10; index++) {
			expect(recovery.recordCheck(decision, [{ changeSetId: "other" }])).toBe(false)
			expect(recovery.recordCheck(decision, [{ changeSetId: "change", kind: "lint" }])).toBe(false)
		}
		for (let index = 0; index < 8; index++) expect(recovery.recordCheck(decision, scopes)).toBe(index === 7)
	})

	it("allows nine covered debts to be verified sequentially without charging untouched blockers", () => {
		const recovery = new CompletionRecovery()
		const obligations = Array.from({ length: 9 }, (_, index) => obligation(`change-${index}`))
		const allScopes = obligations.map((item) => ({ changeSetId: item.changeSetId }))
		const decision = { allowed: false, blockingObligations: obligations }
		recovery.reject(decision)
		for (let index = 0; index < 9; index++) {
			decision.blockingObligations.splice(0, 1)
			decision.allowed = decision.blockingObligations.length === 0
			expect(recovery.recordCheck(decision, allScopes)).toBe(false)
		}
	})

	it("retains tracked unresolved debt when lexically earlier unrelated debt exceeds the storage cap", () => {
		const recovery = new CompletionRecovery()
		const original = obligation("z-original")
		const decision = { allowed: false, blockingObligations: [original] }
		recovery.reject(decision)
		recovery.reject(decision)
		decision.blockingObligations.unshift(...Array.from({ length: 130 }, (_, index) => obligation(`a-${index}`)))
		expect(recovery.reject(decision)).toBe(true)
		expect(Reflect.get(recovery, "allowances").size).toBe(128)
	})

	it("retains failed optional-check debt even when required checks passed", () => {
		const recovery = new CompletionRecovery()
		const original = obligation()
		original.status = "failed"
		original.verifiedChecks = { "src/change.ts": ["test"] }
		original.verification = {
			status: "failed",
			kind: "lint",
			toolCallId: "lint",
			executionId: "lint",
			startedAt: 1,
			completedAt: 2,
			matchedFiles: ["src/change.ts"],
		}
		const decision = { allowed: false, blockingObligations: [original] }
		expect(recovery.reject(decision)).toBe(false)
		expect(recovery.reject(decision)).toBe(false)
		expect(recovery.reject(decision)).toBe(true)
	})

	it("allows user guidance to reopen the same unresolved debt", () => {
		const recovery = new CompletionRecovery()
		const decision = { allowed: false, blockingObligations: [obligation()] }
		recovery.reject(decision)
		recovery.reject(decision)
		expect(recovery.reject(decision)).toBe(true)
		recovery.reset()
		expect(recovery.reject(decision)).toBe(false)
	})
})
