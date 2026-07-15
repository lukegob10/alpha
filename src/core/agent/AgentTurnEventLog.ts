import crypto from "crypto"
import * as fs from "fs/promises"
import * as path from "path"

import type { StepContext } from "./StepContext"
import type { AgentTurnEvent } from "./AgentTurnEvents"
import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"

const MAX_EVENT_VALUE_LENGTH = 8_000

export interface PersistedAgentTurnEvent {
	taskId: string
	runId: string
	sequence: number
	timestamp: number
	stepContextId?: string
	stepContextParentId?: string
	event: AgentTurnEvent
}

function boundValue(value: unknown): unknown {
	if (typeof value === "string") {
		if (value.length <= MAX_EVENT_VALUE_LENGTH) {
			return value
		}
		const suffix = "\n[truncated]"
		return `${value.slice(0, MAX_EVENT_VALUE_LENGTH - suffix.length)}${suffix}`
	}

	if (Array.isArray(value)) {
		return value.map(boundValue)
	}

	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, child]) => [
				key,
				/(api.?key|secret|password|credential|authorization|private.?key|bearer|token)/i.test(key)
					? "[redacted]"
					: boundValue(child),
			]),
		)
	}

	return value
}

export class AgentTurnEventLog {
	private readonly runId = crypto.randomUUID()
	private sequence = 0
	private writeQueue: Promise<void> = Promise.resolve()

	constructor(
		private readonly taskId: string,
		private readonly globalStoragePath: string,
	) {}

	append(event: AgentTurnEvent, context?: StepContext): Promise<void> {
		const record: PersistedAgentTurnEvent = {
			taskId: this.taskId,
			runId: this.runId,
			sequence: ++this.sequence,
			timestamp: Date.now(),
			stepContextId: context?.contextId,
			stepContextParentId: context?.parentContextId,
			event: boundValue(event) as AgentTurnEvent,
		}

		this.writeQueue = this.writeQueue
			.catch(() => undefined)
			.then(async () => {
				const taskDirectory = await getTaskDirectoryPath(this.globalStoragePath, this.taskId)
				await fs.appendFile(
					path.join(taskDirectory, GlobalFileNames.agentTurnEvents),
					`${JSON.stringify(record)}\n`,
					"utf8",
				)
			})

		return this.writeQueue
	}
}

export async function readAgentTurnEvents(
	taskId: string,
	globalStoragePath: string,
): Promise<PersistedAgentTurnEvent[]> {
	const taskDirectory = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDirectory, GlobalFileNames.agentTurnEvents)

	try {
		const contents = await fs.readFile(filePath, "utf8")
		return contents
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as PersistedAgentTurnEvent)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return []
		}
		throw error
	}
}
