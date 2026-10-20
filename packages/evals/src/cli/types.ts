import { type TaskEvent, type ExecutionIdentity } from "@alpha-code/types"
import { z } from "zod"

import type { Run, Task } from "../db/index"
import { Logger } from "./utils"

export const presentationModelCallPolicySchema = z.object({
	schemaVersion: z.literal(1),
	presentationModelCalls: z.literal(false),
	presentationModelCallOptOut: z.literal(true),
})

export type PresentationModelCallPolicy = z.infer<typeof presentationModelCallPolicySchema>

export class SubprocessTimeoutError extends Error {
	constructor(timeout: number) {
		super(`Subprocess timeout after ${timeout}ms`)
		this.name = "SubprocessTimeoutError"
	}
}

export type RunTaskOptions = {
	run: Run
	task: Task
	jobToken: string | null
	publish: (taskEvent: TaskEvent) => Promise<void>
	logger: Logger
	workspaceRoot?: string
	onExecutionIdentity?: (
		identity: ExecutionIdentity,
		presentationPolicy?: PresentationModelCallPolicy,
	) => Promise<void>
}
