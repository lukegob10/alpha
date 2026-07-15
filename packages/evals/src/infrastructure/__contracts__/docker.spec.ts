import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { ExecaHarnessProcessRunner } from "../../orchestration/index"
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
import {
	assertNoContainerLeaks,
	collectInfrastructureManifest,
	DockerCliAdapter,
	type ContainerSpec,
	type ResourceOwner,
} from "../index"

const runner = new ExecaHarnessProcessRunner()
const docker = new DockerCliAdapter(runner)
const campaign = `m5-${process.pid}-${Date.now()}`
const owner = (attemptId: string): ResourceOwner => ({ runId: campaign, trialId: "trial", attemptId })
const name = (suffix: string) => `${campaign}-${suffix}`.replace(/[^a-zA-Z0-9_.-]/g, "-")

function spec(suffix: string, overrides: Partial<ContainerSpec> = {}): ContainerSpec {
	return {
		name: name(suffix),
		image: "redis:7-alpine",
		owner: owner(suffix),
		command: "/bin/echo",
		args: [suffix],
		network: "none",
		limits: { cpus: 0.25, memoryBytes: 64 * 1024 * 1024, pids: 32, timeoutMs: 30_000 },
		...overrides,
	}
}

afterAll(async () => {
	for (const container of await docker.list({ runId: campaign })) await docker.remove(container.id)
	await assertNoContainerLeaks(docker, { runId: campaign })
	await disconnectRedis()
})

describe("real Docker certification", () => {
	it("maintains and removes real Redis runner leases and controller heartbeats", async () => {
		process.env.REDIS_URL = "redis://localhost:6380"
		const runId = Math.abs(campaign.split("").reduce((value, character) => value + character.charCodeAt(0), 0))
		await registerRunner({ runId, taskId: 901, timeoutSeconds: 10 })
		const client = await redisClient()
		expect(await client.sCard(getRunnersKey(runId))).toBe(1)
		const heartbeat = await startHeartbeat(runId, 4)
		expect(await isHeartbeatActive(runId)).toBe(true)
		await deregisterRunner({ runId, taskId: 901 })
		expect(await client.sCard(getRunnersKey(runId))).toBe(0)
		await stopHeartbeat(runId, heartbeat)
		expect(await isHeartbeatActive(runId)).toBe(false)
	})

	it.each([
		{
			service: "redis",
			image: "redis:7-alpine",
			command: "/usr/local/bin/redis-server",
			args: ["--save", "", "--appendonly", "no"],
			probe: ["redis-cli", "ping"],
			expected: "PONG",
			processEnv: undefined,
			envNames: undefined,
		},
		{
			service: "postgres",
			image: "postgres:15.4",
			command: "/usr/local/bin/docker-entrypoint.sh",
			args: ["postgres"],
			probe: ["pg_isready", "-U", "postgres"],
			expected: "accepting connections",
			processEnv: { POSTGRES_PASSWORD: "m5-local-only" },
			envNames: ["POSTGRES_PASSWORD"],
		},
	] as const)(
		"observes a real $service outage as infrastructure failure",
		async ({ service, image, command, args, probe, expected, processEnv, envNames }) => {
			const input = spec(`service-${service}`, {
				image,
				command,
				args: [...args],
				processEnv: processEnv ? { ...processEnv } : undefined,
				envNames: envNames ? [...envNames] : undefined,
				limits: { cpus: 0.5, memoryBytes: 256 * 1024 * 1024, pids: 64, timeoutMs: 60_000 },
			})
			const id = await docker.runDetached(input)
			let healthy = false
			for (let attempt = 0; attempt < 40; attempt++) {
				const result = await runner.run({
					command: "docker",
					args: ["exec", id, ...probe],
					timeoutMs: 5_000,
					maxOutputBytes: 10_000,
				})
				if (result.exitCode === 0 && result.stdout.includes(expected)) {
					healthy = true
					break
				}
				await new Promise((resolve) => setTimeout(resolve, 250))
			}
			expect(healthy).toBe(true)
			await docker.kill(id)
			const outage = await runner.run({
				command: "docker",
				args: ["exec", id, ...probe],
				timeoutMs: 5_000,
				maxOutputBytes: 10_000,
			})
			expect(outage.exitCode).not.toBe(0)
			await docker.remove(id)
		},
	)

	it("records pinned image/runtime/resource/network provenance and enforces the limits", async () => {
		const input = spec("manifest", { command: "/bin/sleep", args: ["30"] })
		const manifest = await collectInfrastructureManifest(input, runner, 2)
		expect(manifest.imageId).toMatch(/^sha256:/)
		expect(manifest).toMatchObject({
			architecture: expect.any(String),
			os: "linux",
			networkMode: "none",
			concurrency: 2,
		})
		const id = await docker.runDetached(input)
		const inspected = (await docker.inspect(id)) as {
			HostConfig: { NanoCpus: number; Memory: number; PidsLimit: number; NetworkMode: string }
			Config: { Labels: Record<string, string> }
		}
		expect(inspected.HostConfig).toMatchObject({
			NanoCpus: 250_000_000,
			Memory: 64 * 1024 * 1024,
			PidsLimit: 32,
			NetworkMode: "none",
		})
		expect(inspected.Config.Labels["alpha.evals.attempt-id"]).toBe("manifest")
		await docker.remove(id)
	})

	it("keeps workspaces isolated and hidden state unmounted", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-m5-isolation-"))
		const first = path.join(root, "first")
		const second = path.join(root, "second")
		await fs.mkdir(first)
		await fs.mkdir(second)
		await fs.writeFile(path.join(first, "value"), "first")
		await fs.writeFile(path.join(second, "value"), "second")
		for (const [id, workspace, expected] of [
			["first", first, "first"],
			["second", second, "second"],
		] as const) {
			const result = await docker.run(
				spec(id, {
					command: "/bin/sh",
					args: ["-c", "cat /workspace/value && test ! -e /grader"],
					binds: [{ source: workspace, target: "/workspace", readOnly: false }],
				}),
			)
			expect(result).toMatchObject({ exitCode: 0, timedOut: false })
			expect(result.stdout.trim()).toBe(expected)
		}
	})

	it("kills a timed-out process tree and leaves no labeled container", async () => {
		const input = spec("timeout", {
			command: "/bin/sh",
			args: ["-c", "sleep 30 & wait"],
			limits: { cpus: 0.25, memoryBytes: 64 * 1024 * 1024, pids: 32, timeoutMs: 500 },
		})
		const result = await docker.run(input)
		expect(result.timedOut).toBe(true)
		expect(await docker.list(input.owner)).toEqual([])
	})

	it("does not expose secret values in container argv or process listings", async () => {
		const secret = `secret-${campaign}`
		const input = spec("secret", {
			command: "/bin/sleep",
			args: ["30"],
			envNames: ["M5_SECRET"],
			processEnv: { M5_SECRET: secret },
		})
		const id = await docker.runDetached(input)
		const top = await runner.run({
			command: "docker",
			args: ["top", id, "-eo", "args"],
			timeoutMs: 30_000,
			maxOutputBytes: 100_000,
		})
		expect(top.stdout).not.toContain(secret)
		await docker.remove(id)
	})

	it("cleans only the selected attempt under concurrent execution", async () => {
		const first = spec("scope-one", { command: "/bin/sleep", args: ["30"] })
		const second = spec("scope-two", { command: "/bin/sleep", args: ["30"] })
		await Promise.all([docker.runDetached(first), docker.runDetached(second)])
		await docker.cleanup(first.owner)
		expect(await docker.list(first.owner)).toEqual([])
		expect(await docker.list(second.owner)).toHaveLength(1)
		await docker.cleanup(second.owner)
	})

	it("retains an output artifact before automatic container removal", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-m5-artifact-"))
		const source = path.join(root, "source")
		const output = path.join(root, "output")
		await fs.mkdir(source)
		await fs.mkdir(output)
		await fs.writeFile(path.join(source, "evidence"), "retained-before-removal")
		const result = await docker.run(
			spec("artifact", {
				command: "/bin/cp",
				args: ["/source/evidence", "/output/evidence"],
				binds: [
					{ source, target: "/source", readOnly: true },
					{ source: output, target: "/output", readOnly: false },
				],
			}),
		)
		expect(result.exitCode).toBe(0)
		expect(await fs.readFile(path.join(output, "evidence"), "utf8")).toBe("retained-before-removal")
		expect(await docker.list(owner("artifact"))).toEqual([])
	})
})
