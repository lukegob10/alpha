import { Anthropic } from "@anthropic-ai/sdk"
import workerpool from "workerpool"

import { countTokensResultSchema } from "../workers/types"
import { tiktoken } from "./tiktoken"

let pool: workerpool.Pool | null | undefined = undefined

export type CountTokensOptions = {
	useWorker?: boolean
}

export async function countTokens(
	content: Anthropic.Messages.ContentBlockParam[],
	{ useWorker = true }: CountTokensOptions = {},
): Promise<number> {
	// Lazily create the worker pool if it doesn't exist.
	if (useWorker && typeof pool === "undefined") {
		pool = workerpool.pool(__dirname + "/workers/countTokens.js", {
			maxWorkers: 1,
			maxQueueSize: 10,
		})
	}

	const activePool = pool
	// A retiring pool blocks replacement until its workers have been released.
	if (!useWorker || !activePool) {
		return tiktoken(content)
	}

	try {
		const data = await activePool.exec("countTokens", [content])
		const result = countTokensResultSchema.parse(data)

		if (!result.success) {
			throw new Error(result.error)
		}

		return result.count
	} catch (error) {
		console.error(error)
		// workerpool rejects admission at its queue limit without invalidating the pool.
		const queueIsFull =
			error instanceof Error && error.message === `Max queue size of ${activePool.maxQueueSize} reached`
		if (!queueIsFull && pool === activePool) {
			pool = null
			try {
				await activePool.terminate(true)
			} catch (terminationError) {
				console.error(terminationError)
			} finally {
				pool = undefined
			}
		}
		return tiktoken(content)
	}
}
