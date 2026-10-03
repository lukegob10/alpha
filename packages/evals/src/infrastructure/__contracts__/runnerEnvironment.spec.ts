import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { ExecaHarnessProcessRunner } from "../../orchestration/index"
import { assertNoContainerLeaks, DockerCliAdapter } from "../index"

const runner = new ExecaHarnessProcessRunner()
const docker = new DockerCliAdapter(runner)
const campaign = `environment-${process.pid}-${Date.now()}`
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..")
const run = (args: string[]) => runner.run({ command: "docker", args, timeoutMs: 60_000, maxOutputBytes: 32_000 })

afterAll(async () => {
	for (const container of await docker.list({ runId: campaign })) await docker.remove(container.id)
	await assertNoContainerLeaks(docker, { runId: campaign })
})

describe("runner environment on real Docker", () => {
	it("excludes nested credential files from COPY while retaining tracked non-secret settings", async () => {
		const context = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-env-context-"))
		const tag = `alpha-env-contract:${campaign}`
		let imageId: string | undefined
		try {
			await fs.copyFile(path.join(repository, ".dockerignore"), path.join(context, ".dockerignore"))
			await fs.mkdir(path.join(context, "packages/evals"), { recursive: true })
			await fs.mkdir(path.join(context, "packages/other"), { recursive: true })
			await fs.mkdir(path.join(context, "evals"))
			await fs.writeFile(path.join(context, "evals", "public-fixture-sentinel"), "checked-out public fixture\n")
			for (const directory of [
				"src/node_modules",
				"packages/evals/node_modules",
				"packages/evals/artifacts",
				"src/out",
			]) {
				await fs.mkdir(path.join(context, directory), { recursive: true })
				await fs.writeFile(
					path.join(context, directory, "generated-sentinel"),
					"not part of the build context\n",
				)
			}
			for (const file of [".env.local", "packages/evals/.env.local", "packages/other/.env.production"])
				await fs.writeFile(path.join(context, file), "SENTINEL_DUMMY_KEY=not-a-real-credential\n")
			for (const file of [".env.development", ".env.test"])
				await fs.writeFile(path.join(context, "packages/evals", file), "DATABASE_URL=fixture\n")
			await fs.writeFile(
				path.join(context, "Dockerfile"),
				`FROM redis:7-alpine\nLABEL alpha.evals.test-owner="${campaign}"\nCOPY . /fixture\n`,
			)
			expect(
				(await run(["build", "--tag", tag, "--iidfile", path.join(context, "image-id"), context])).exitCode,
			).toBe(0)
			imageId = (await fs.readFile(path.join(context, "image-id"), "utf8")).trim()
			const probe = await run([
				"run",
				"--rm",
				"--label",
				`alpha.evals.run-id=${campaign}`,
				"--network",
				"none",
				imageId,
				"/bin/sh",
				"-c",
				"test ! -e /fixture/.env.local && test ! -e /fixture/packages/evals/.env.local && test ! -e /fixture/packages/other/.env.production && test -e /fixture/packages/evals/.env.test && test -e /fixture/packages/evals/.env.development && test ! -e /fixture/src/node_modules && test ! -e /fixture/packages/evals/node_modules && test ! -e /fixture/packages/evals/artifacts && test ! -e /fixture/src/out && test -e /fixture/evals/public-fixture-sentinel",
			])
			expect(probe.exitCode).toBe(0)
		} finally {
			if (imageId) {
				const inspected = await run(["image", "inspect", imageId])
				const [identity] = JSON.parse(inspected.stdout) as Array<{
					Id: string
					Config: { Labels: Record<string, string> }
				}>
				expect(identity?.Id).toBe(imageId)
				expect(identity?.Config.Labels["alpha.evals.test-owner"]).toBe(campaign)
				expect((await run(["image", "rm", imageId])).exitCode).toBe(0)
			}
			await fs.rm(context, { recursive: true, force: true })
		}
	})

	it("creates both evaluator databases on empty PostgreSQL storage using repository script bytes", async () => {
		const script = await fs.readFile(
			path.join(repository, "packages/evals/.docker/scripts/postgres/create-databases.sh"),
		)
		expect(script.includes(Buffer.from("\r\n"))).toBe(false)
		const id = await docker.runDetached({
			name: `${campaign}-fresh-db`,
			image: "postgres:15.4",
			owner: { runId: campaign, trialId: "environment", attemptId: "fresh-db" },
			command: "/usr/local/bin/docker-entrypoint.sh",
			args: ["postgres"],
			network: "none",
			processEnv: {
				POSTGRES_PASSWORD: "fixture-only",
				POSTGRES_DATABASES: "evals_development,evals_test",
				PGDATA: "/tmp/alpha-fresh-pgdata",
			},
			envNames: ["POSTGRES_PASSWORD", "POSTGRES_DATABASES", "PGDATA"],
			binds: [
				{
					source: path.join(repository, "packages/evals/.docker/scripts/postgres"),
					target: "/docker-entrypoint-initdb.d",
					readOnly: true,
				},
			],
			limits: { cpus: 0.5, memoryBytes: 256 * 1024 * 1024, pids: 64, timeoutMs: 60_000 },
		})
		try {
			let names = ""
			for (let attempt = 0; attempt < 60; attempt++) {
				const result = await run([
					"exec",
					id,
					"psql",
					"-U",
					"postgres",
					"-Atc",
					"SELECT datname FROM pg_database WHERE datname IN ('evals_development','evals_test') ORDER BY datname",
				])
				if (result.exitCode === 0) names = result.stdout.trim()
				if (names === "evals_development\nevals_test") break
				await new Promise((resolve) => setTimeout(resolve, 250))
			}
			expect(names).toBe("evals_development\nevals_test")
		} finally {
			await docker.remove(id)
		}
	})
})
