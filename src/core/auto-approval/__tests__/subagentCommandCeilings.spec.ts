import { describe, expect, it } from "vitest"
import type { SubagentCommandApprovalPolicy } from "@alpha-code/types"

import { compactSubagentCommandApprovalCeilings, createSubagentCommandApprovalPolicy } from "../commands"

const v2 = (denied: string[], salt: string, allowed = ["*"]) => {
	const policy = createSubagentCommandApprovalPolicy(allowed, denied, salt.repeat(64))
	if (policy.algorithm !== "sha256-salted-argv-v2") throw new Error("Expected the current token policy")
	return policy
}

describe("managed-child command ceiling compaction", () => {
	it("removes proven equivalent denial captures across salts while retaining a distinct ancestor denial", () => {
		const primary = v2(["git reset"], "a")
		const equivalent = v2(["git reset"], "b")
		const ancestor = v2(["git push"], "c")
		expect(compactSubagentCommandApprovalCeilings(primary, [equivalent, ancestor], ["git reset"])).toEqual([
			ancestor,
		])
	})

	it("does not trust candidate text absent from the currently enforced primary grant", () => {
		const primary = v2(["git reset"], "a")
		const prior = v2(["git push"], "b")
		expect(compactSubagentCommandApprovalCeilings(primary, [prior], ["git push"])).toEqual([prior])
	})

	it("retains finite allowance ceilings when the primary can approve commands", () => {
		const primary = v2([], "a", ["git status"])
		const prior = v2([], "b", ["pnpm test"])
		expect(compactSubagentCommandApprovalCeilings(primary, [prior], [])).toEqual([prior])
	})

	it("retains legacy opaque denials and unresolved token denials", () => {
		const primary = v2([], "a")
		const legacy: SubagentCommandApprovalPolicy = {
			algorithm: "sha256-salted-prefix-v1",
			salt: "b".repeat(64),
			allowAll: true,
			denyAll: false,
			allowed: [],
			denied: [{ prefixLength: 3, digest: "c".repeat(64) }],
		}
		const unresolved = { ...v2([], "d"), unresolvedDenyRules: true }
		expect(compactSubagentCommandApprovalCeilings(primary, [legacy, unresolved], [])).toEqual([legacy, unresolved])
	})

	it("preserves platform-specific denial evidence when the current host cannot reproduce it", () => {
		const primary = v2(["git push"], "a")
		const prior = {
			...v2(["git push"], "b"),
			platform: primary.platform === "win32" ? ("posix" as const) : ("win32" as const),
		}
		expect(compactSubagentCommandApprovalCeilings(primary, [prior], ["git push"])).toEqual([prior])
	})

	it("deduplicates identical opaque rule sets independently of their ordering", () => {
		const primary = v2([], "a")
		const prior = v2(["git push", "git reset"], "b")
		const reordered = { ...prior, denied: [...prior.denied].reverse() }
		expect(compactSubagentCommandApprovalCeilings(primary, [prior, reordered], [])).toHaveLength(1)
	})
})
