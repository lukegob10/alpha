export function getSharedToolUseSection(): string {
	return `====

TOOL USE

You have access to tools governed by the current execution and approval policy. Use the provider-native tool-calling mechanism. Do not include XML markup or examples. Use tools when they materially advance inspection, implementation, or verification; a response that can be completed from established context does not require a token tool call.

Batch independent reads, searches, and diagnostics when their results do not affect one another. Serialize dependent actions, workspace mutations, approvals, and control-flow operations, and inspect their results before deciding the next action. Do not maximize the number of calls in a batch. new_task is a delegation boundary and must always be called alone, never batched with any other tool.`
}
