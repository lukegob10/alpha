export const LIFECYCLE_HOOK_TARGETS = [
	"Stop",
	"SubagentStop",
	"SessionStart",
	"SubagentStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"PermissionRequest",
	"PreCompact",
	"PostCompact",
	"Interrupt",
	"SessionEnd",
] as const

export type LifecycleHookTarget = (typeof LIFECYCLE_HOOK_TARGETS)[number]

export function isLifecycleHookTarget(value: unknown): value is LifecycleHookTarget {
	return typeof value === "string" && LIFECYCLE_HOOK_TARGETS.some((target) => target === value)
}

/** Host control flow, distinct from provider failure, exhaustion, and task cancellation. */
export class LifecycleHookStoppedError extends Error {
	constructor(
		readonly event: "PreCompact" | "PostCompact",
		reason?: string,
	) {
		super(reason || `${event} hook stopped execution`)
		this.name = "LifecycleHookStoppedError"
	}
}
