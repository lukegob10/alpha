import { createClient, type RedisClientType } from "redis"
import { randomUUID } from "node:crypto"

let redis: RedisClientType | undefined
const heartbeatOwners = new WeakMap<NodeJS.Timeout, { token: string; lost: boolean; expiresAt: number }>()

export const redisClient = async () => {
	if (!redis) {
		redis = createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" })
		redis.on("error", (error) => console.error("redis error:", error))
		await redis.connect()
	}

	return redis
}

export const getPubSubKey = (runId: number) => `evals:${runId}`
export const getRunnersKey = (runId: number) => `runners:${runId}`
export const getHeartbeatKey = (runId: number) => `heartbeat:${runId}`

async function boundedLeaseOperation<T>(operation: Promise<T>): Promise<T> {
	let timer: NodeJS.Timeout | undefined
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Evaluation controller lease operation timed out")), 5000)
			}),
		])
	} finally {
		clearTimeout(timer)
	}
}

export const registerRunner = async ({
	runId,
	taskId,
	timeoutSeconds,
}: {
	runId: number
	taskId: number
	timeoutSeconds: number
}) => {
	const redis = await redisClient()
	const runnersKey = getRunnersKey(runId)
	await redis.sAdd(runnersKey, `task-${taskId}:${process.env.HOSTNAME ?? process.pid}`)
	await redis.expire(runnersKey, timeoutSeconds)
}

export const deregisterRunner = async ({ runId, taskId }: { runId: number; taskId: number }) => {
	const redis = await redisClient()
	await redis.sRem(getRunnersKey(runId), `task-${taskId}:${process.env.HOSTNAME ?? process.pid}`)
}

export const startHeartbeat = async (runId: number, seconds = 10, onLeaseLost?: () => void) => {
	const redis = await boundedLeaseOperation(redisClient())
	const heartbeatKey = getHeartbeatKey(runId)
	const token = `${process.pid}:${randomUUID()}`
	const acquiredAt = performance.now()
	const acquired = await boundedLeaseOperation(redis.set(heartbeatKey, token, { EX: seconds, NX: true }))
	if (acquired !== "OK") throw new Error(`Evaluation run ${runId} already has an active controller`)
	const owner = { token, lost: false, expiresAt: acquiredAt + seconds * 1000 }
	let renewing = false
	const loseLease = () => {
		if (owner.lost) return
		owner.lost = true
		onLeaseLost?.()
	}

	const heartbeat = setInterval(
		() => {
			if (performance.now() >= owner.expiresAt) loseLease()
			if (owner.lost || renewing) return
			renewing = true
			const renewedAt = performance.now()
			void redis
				.eval(
					"if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) else return 0 end",
					{
						keys: [heartbeatKey],
						arguments: [token, String(seconds)],
					},
				)
				.then((renewed) => {
					if (renewed !== 1) loseLease()
					else if (!owner.lost) owner.expiresAt = renewedAt + seconds * 1000
				})
				.catch(loseLease)
				.finally(() => {
					renewing = false
				})
		},
		(seconds * 1_000) / 2,
	)
	heartbeatOwners.set(heartbeat, owner)
	return heartbeat
}

export const stopHeartbeat = async (runId: number, heartbeat: NodeJS.Timeout) => {
	clearInterval(heartbeat)
	const owner = heartbeatOwners.get(heartbeat)
	if (!owner) throw new Error("Evaluation controller lease is not owned by this process")
	owner.lost = true
	const client = await boundedLeaseOperation(redisClient())
	await boundedLeaseOperation(
		client.eval(
			"if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
			{
				keys: [getHeartbeatKey(runId)],
				arguments: [owner.token],
			},
		),
	)
}

export const assertHeartbeatOwnership = async (runId: number, heartbeat: NodeJS.Timeout): Promise<void> => {
	const owner = heartbeatOwners.get(heartbeat)
	if (!owner || owner.lost || performance.now() >= owner.expiresAt)
		throw new Error(`Evaluation run ${runId} lost its controller lease`)
	const token = await boundedLeaseOperation(redisClient().then((client) => client.get(getHeartbeatKey(runId))))
	if (owner.lost || performance.now() >= owner.expiresAt || token !== owner.token)
		throw new Error(`Evaluation run ${runId} lost its controller lease`)
}

export const isHeartbeatActive = async (runId: number): Promise<boolean> => {
	const client = await redisClient()
	return (await client.exists(getHeartbeatKey(runId))) === 1
}

export const disconnectRedis = async (): Promise<void> => {
	if (!redis) return
	const client = redis
	redis = undefined
	if (client.isOpen) await client.quit()
}
