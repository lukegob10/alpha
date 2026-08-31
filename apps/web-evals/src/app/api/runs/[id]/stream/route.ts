import type { NextRequest } from "next/server"

import { taskEventSchema } from "@alpha-code/types"
import { findRun } from "@alpha-code/evals"

import { SSEStream } from "@/lib/server/sse-stream"
import { redisClient } from "@/lib/server/redis"

export const dynamic = "force-dynamic"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params
	const requestId = crypto.randomUUID()
	const stream = new SSEStream()
	const run = await findRun(Number(id))
	const redis = await redisClient()
	const subscriber = redis.duplicate()
	subscriber.on("error", (error) => console.error(`[stream#${requestId}] Redis subscriber error:`, error))

	let isStreamClosed = false
	const channelName = `evals:${run.id}`

	const onMessage = async (data: string) => {
		if (isStreamClosed || stream.isClosed) {
			return
		}

		try {
			const taskEvent = taskEventSchema.parse(JSON.parse(data))
			// console.log(`[stream#${requestId}] task event -> ${taskEvent.eventName}`)
			const writeSuccess = await stream.write(JSON.stringify(taskEvent))

			if (!writeSuccess) {
				await disconnect()
			}
		} catch (_error) {
			console.error(`[stream#${requestId}] invalid task event:`, data)
		}
	}

	const disconnect = async () => {
		if (isStreamClosed) {
			return
		}

		isStreamClosed = true
		request.signal.removeEventListener("abort", onAbort)

		try {
			await subscriber.unsubscribe(channelName, onMessage)
			console.log(`[stream#${requestId}] unsubscribed from ${channelName}`)
		} catch (error) {
			console.error(`[stream#${requestId}] error unsubscribing:`, error)
		}

		try {
			await subscriber.close()
		} catch (error) {
			console.error(`[stream#${requestId}] error closing Redis subscriber:`, error)
			if (subscriber.isOpen) {
				subscriber.destroy()
			}
		}

		try {
			await stream.close()
		} catch (error) {
			console.error(`[stream#${requestId}] error closing stream:`, error)
		}
	}

	const onAbort = () => {
		console.log(`[stream#${requestId}] abort`)

		disconnect().catch((error) => {
			console.error(`[stream#${requestId}] cleanup error:`, error)
		})
	}

	try {
		await subscriber.connect()
		await subscriber.subscribe(channelName, onMessage)
	} catch (error) {
		if (subscriber.isOpen) {
			subscriber.destroy()
		}
		await stream.close()
		throw error
	}

	request.signal.addEventListener("abort", onAbort, { once: true })
	if (request.signal.aborted) {
		await disconnect()
	}

	return stream.getResponse()
}
