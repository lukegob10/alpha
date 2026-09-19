import { randomInt } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import {
	deregisterRunner,
	disconnectRedis,
	getRunnersKey,
	isHeartbeatActive,
	redisClient,
	registerRunner,
	startHeartbeat,
	stopHeartbeat,
} from "../../cli/redis"

afterAll(disconnectRedis)
describe("real Redis service contracts", () => {
	it("maintains and removes real Redis runner leases and controller heartbeats", async () => {
		if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required for service contracts")
		const runId = randomInt(1, 2 ** 48)
		let heartbeat: NodeJS.Timeout | undefined
		try {
			await registerRunner({ runId, taskId: 901, timeoutSeconds: 10 })
			const client = await redisClient()
			expect(await client.sCard(getRunnersKey(runId))).toBe(1)
			heartbeat = await startHeartbeat(runId, 4)
			expect(await isHeartbeatActive(runId)).toBe(true)
			await deregisterRunner({ runId, taskId: 901 })
			expect(await client.sCard(getRunnersKey(runId))).toBe(0)
			await stopHeartbeat(runId, heartbeat)
			expect(await isHeartbeatActive(runId)).toBe(false)
		} finally {
			if (heartbeat) await stopHeartbeat(runId, heartbeat)
			await deregisterRunner({ runId, taskId: 901 })
		}
	})
})
