import type { AgentLifecycleToolResultItem } from "@alpha-code/types"

import { isAgentLifecycleToolResultOutputTruncated } from "../agent/lifecycle"

const MAX_RECOVERED_OUTPUT_LENGTH = 16_000

/** Journal previews cannot replace complete canonical output during crash recovery (Codex a0981298). */
export function recoveredToolOutput(
	item: AgentLifecycleToolResultItem | undefined,
	text: string,
): { content: string; incomplete: boolean } {
	const output = item?.output ?? item?.result
	const incomplete =
		(item !== undefined && isAgentLifecycleToolResultOutputTruncated(item)) ||
		text.length > MAX_RECOVERED_OUTPUT_LENGTH ||
		(Array.isArray(output) &&
			output.some(
				(block) =>
					!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string",
			))
	if (!incomplete) return { content: text, incomplete: false }

	const warning = `The tool execution status was ${item?.status ?? "unknown"}. Its full output is unavailable; the recovered preview is incomplete. Do not repeat the tool solely to recover its output. Inspect the current state before taking another action.\n\nRecovered preview:\n`
	return {
		content: warning + text.slice(0, MAX_RECOVERED_OUTPUT_LENGTH - warning.length),
		incomplete: true,
	}
}
