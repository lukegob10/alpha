import { spawnSync } from "node:child_process"
import { setTimeout } from "node:timers/promises"
import { fileURLToPath } from "node:url"

// Optional Docker setup only. Corporate/native service checks use services:check in the evaluator.
// Readiness polling is bounded setup, never a retry of a failed evaluation.
const cwd = fileURLToPath(new URL("../../packages/evals/", import.meta.url))
const deadline = Date.now() + 60_000
const probes = [
	["db", "pg_isready", "-U", "postgres"],
	["redis", "redis-cli", "ping"],
]
while (true) {
	let ready = true
	for (const [service, ...args] of probes) {
		const result = spawnSync("docker", ["compose", "exec", "-T", service, ...args], {
			cwd,
			encoding: "utf8",
			timeout: Math.max(1, Math.min(5000, deadline - Date.now())),
			windowsHide: true,
		})
		ready &&= result.status === 0 && (service !== "redis" || result.stdout.trim() === "PONG")
	}
	if (ready) {
		console.log("Evaluator Postgres and Redis are ready")
		break
	}
	if (Date.now() >= deadline) {
		console.error(
			"Evaluator services did not become ready within 60 seconds. Inspect docker compose ps/logs locally.",
		)
		process.exitCode = 1
		break
	}
	await setTimeout(500)
}
