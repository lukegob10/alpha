import type { ApiInstructionFragment } from "../../api"
import type { SystemPromptInstructionPart } from "./system"

const INHERITED_INSTRUCTION_ORIGINS: ReadonlySet<string> = new Set([
	"custom-role-definition",
	"language-preference",
	"global-custom-instructions",
	"custom-mode-instructions",
	"mode-rules",
	"alpha-ignore",
	"agent-rules",
	"generic-rules",
	"alpha-subagent-inherited-instructions",
] satisfies SystemPromptInstructionPart["origin"][])

/**
 * Capture the invoking step's user guidance without inheriting model, role,
 * environment, tool, mode, approval, or live skill-catalog authority. The child
 * rebuilds those host-owned parts from its narrowed policy and captured skills.
 */
export function selectInheritedInstructionFragments(
	fragments: readonly ApiInstructionFragment[],
): ApiInstructionFragment[] {
	return fragments
		.filter(
			({ role, origin }) => role === "user" && origin !== undefined && INHERITED_INSTRUCTION_ORIGINS.has(origin),
		)
		.map(({ role, origin, content }) => ({ role, origin, content }))
}
