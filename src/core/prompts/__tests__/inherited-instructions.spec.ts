import { describe, expect, it } from "vitest"

import type { ApiInstructionFragment } from "../../../api"
import { selectInheritedInstructionFragments } from "../inherited-instructions"

describe("managed child instruction capture", () => {
	it("inherits exact user guidance in order without promoting host or unknown fragments", () => {
		const project: ApiInstructionFragment = {
			role: "user",
			origin: "agent-rules",
			content: "  Project instructions\n",
		}
		const frozen: ApiInstructionFragment = {
			role: "user",
			origin: "alpha-subagent-inherited-instructions",
			content: "\nExact inherited text  ",
		}
		const fragments: ApiInstructionFragment[] = [
			{ role: "developer", origin: "codex-model-instructions", content: "Parent model" },
			{ role: "developer", origin: "approval-context", content: "Parent approvals" },
			{ role: "developer", origin: "built-in-mode-instructions", content: "Parent Code guidance" },
			{ role: "user", origin: "prompt-wrapper", content: "Formatting wrapper" },
			project,
			{ role: "user", origin: "alpha-skill-catalog", content: "Parent skill catalog" },
			{ role: "user", origin: "unknown-source", content: "Unrecognized content" },
			{ role: "developer", origin: "global-custom-instructions", content: "Incorrect authority" },
			frozen,
			{ role: "user", content: "Unidentified legacy fragment" },
		]

		const inherited = selectInheritedInstructionFragments(fragments)

		expect(inherited).toEqual([project, frozen])
		expect(inherited[0]).not.toBe(project)
		expect(inherited[1]).not.toBe(frozen)
		inherited[0]!.content = "Changed child copy"
		expect(project.content).toBe("  Project instructions\n")
	})

	it("returns no guidance when the invoking step has no inheritable instructions", () => {
		expect(selectInheritedInstructionFragments([])).toEqual([])
	})
})
