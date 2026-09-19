import { pathToFileURL } from "node:url"
import postgres from "postgres"
import { createClient } from "redis"

export async function checkServices(env: NodeJS.ProcessEnv = process.env): Promise<void> {
	if (!env.DATABASE_URL || !env.REDIS_URL) throw new Error("DATABASE_URL and REDIS_URL are required")
	try {
		await probeServices(env.DATABASE_URL, env.REDIS_URL)
	} catch {
		throw new Error("Evaluator service readiness failed; verify configured PostgreSQL and Redis endpoints")
	}
}

async function probeServices(databaseUrl: string, redisUrl: string): Promise<void> {
	const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5, prepare: false })
	const redis = createClient({ url: redisUrl, socket: { connectTimeout: 5000, reconnectStrategy: false } })
	redis.on("error", () => {}) // Report only the sanitized aggregate status below.
	let timer: NodeJS.Timeout | undefined
	try {
		await Promise.race([
			Promise.all([sql`SELECT 1`, redis.connect().then(() => redis.ping())]),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), 6000)
			}),
		])
	} catch {
		throw new Error("Evaluator service readiness failed; verify configured PostgreSQL and Redis endpoints")
	} finally {
		clearTimeout(timer)
		if (redis.isOpen) redis.destroy()
		await sql.end({ timeout: 1 })
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	checkServices().then(
		() => console.log("PostgreSQL SELECT 1 and Redis PING passed (no data changed)"),
		(error: Error) => {
			console.error(error.message)
			process.exitCode = 1
		},
	)
}
