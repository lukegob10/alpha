import { RooCodeEventName, type RooCodeAPI } from "@alpha-code/types"

type WaitForOptions = {
	timeout?: number
	interval?: number
	description?: string
	onTimeout?: () => unknown | Promise<unknown>
}

const formatDiagnostics = (value: unknown): string => {
	if (value === undefined) return ""
	if (typeof value === "string") return value

	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

export const waitFor = async (
	condition: (() => Promise<boolean>) | (() => boolean),
	{ timeout = 30_000, interval = 250, description = "condition", onTimeout }: WaitForOptions = {},
): Promise<void> => {
	const deadline = Date.now() + timeout

	while (true) {
		const remaining = deadline - Date.now()
		if (remaining <= 0) break

		let timeoutId: NodeJS.Timeout | undefined
		const result = await Promise.race([
			Promise.resolve().then(condition),
			new Promise<"deadline">((resolve) => {
				timeoutId = setTimeout(() => resolve("deadline"), remaining)
			}),
		])
		if (timeoutId) clearTimeout(timeoutId)

		if (result === true) return
		if (result === "deadline") break

		const sleepFor = Math.min(interval, deadline - Date.now())
		if (sleepFor > 0) await sleep(sleepFor)
	}

	let diagnostics = ""
	if (onTimeout) {
		try {
			diagnostics = formatDiagnostics(await onTimeout())
		} catch (error) {
			diagnostics = `Unable to collect diagnostics: ${error instanceof Error ? error.stack || error.message : String(error)}`
		}
	}

	throw new Error(
		`Timed out after ${Math.floor(timeout / 1_000)}s waiting for ${description}${diagnostics ? `\n${diagnostics}` : ""}`,
	)
}

type WaitUntilAbortedOptions = WaitForOptions & {
	api: RooCodeAPI
	taskId: string
}

export const waitUntilAborted = async ({ api, taskId, ...options }: WaitUntilAbortedOptions) => {
	const set = new Set<string>()
	const onTaskAborted = (abortedTaskId: string) => set.add(abortedTaskId)
	api.on(RooCodeEventName.TaskAborted, onTaskAborted)
	try {
		await waitFor(() => set.has(taskId), {
			description: `task ${taskId} to abort`,
			...options,
		})
	} finally {
		api.off(RooCodeEventName.TaskAborted, onTaskAborted)
	}
}

type WaitUntilCompletedOptions = WaitForOptions & {
	api: RooCodeAPI
	taskId: string
}

export const waitUntilCompleted = async ({ api, taskId, ...options }: WaitUntilCompletedOptions) => {
	const set = new Set<string>()
	const onTaskCompleted = (completedTaskId: string) => set.add(completedTaskId)
	api.on(RooCodeEventName.TaskCompleted, onTaskCompleted)
	try {
		await waitFor(() => set.has(taskId), {
			description: `task ${taskId} to complete`,
			...options,
		})
	} finally {
		api.off(RooCodeEventName.TaskCompleted, onTaskCompleted)
	}
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
