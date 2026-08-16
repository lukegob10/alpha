export function getSharedToolUseSection(subagentRole?: "explore" | "review" | "worker"): string {
	if (subagentRole) {
		const authority =
			subagentRole === "worker"
				? "repository reads, native file edits within the approved write scope, foreground local commands, command-output reads, and attempt_completion"
				: "repository reads, file listing and search, available codebase search, and attempt_completion"

		return `====

TOOL USE

You have only ${authority}. Use the provider-native tool-calling mechanism. Do not include XML markup or examples.

Batch independent reads and searches when their results do not affect one another. Serialize dependent actions, approvals, and${
			subagentRole === "worker" ? " workspace mutations" : " final synthesis"
		}, and inspect returned evidence before deciding the next action. Do not call capabilities outside this bounded child authority.`
	}

	return `====

TOOL USE

You have access to tools governed by the current execution and approval policy. Use the provider-native tool-calling mechanism. Do not include XML markup or examples. Use tools when they materially advance inspection, implementation, or verification; a response that can be completed from established context does not require a token tool call.

Batch independent reads, searches, and diagnostics when their results do not affect one another. Serialize dependent actions, workspace mutations, approvals, and control-flow operations, and inspect their results before deciding the next action. Do not maximize the number of calls in a batch. new_task and delegate_task are blocking delegation boundaries and must each be called alone, never batched with another tool. spawn_agent is nonblocking; multiple independent spawn_agent calls may share a batch when their scopes do not overlap. Use wait_agent only for one bounded mailbox wait after useful local work or when collecting results; never call it in a polling loop.`
}
