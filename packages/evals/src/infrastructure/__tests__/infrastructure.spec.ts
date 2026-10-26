import { describe, expect, it, vi } from "vitest"

import type { HarnessProcessResult, HarnessProcessRunner, HarnessProcessSpec } from "../../orchestration/index"
import {
	assertNoContainerLeaks,
	collectInfrastructureManifest,
	containerArgs,
	DockerCliAdapter,
	reconcileOrphanedAttempts,
	type ContainerSpec,
} from "../index"

const success = (stdout = ""): HarnessProcessResult => ({
	exitCode: 0,
	stdout,
	stderr: "",
	durationMs: 1,
	timedOut: false,
	outputTruncated: false,
})

const spec: ContainerSpec = {
	name: "eval-attempt",
	image: "redis:7-alpine",
	owner: { runId: "run", trialId: "trial", attemptId: "attempt" },
	command: "/bin/echo",
	args: ["hello"],
	envNames: ["API_TOKEN"],
	processEnv: { API_TOKEN: "secret-canary" },
	binds: [{ source: "/source", target: "/workspace", readOnly: true }],
	network: "none",
	limits: { cpus: 0.5, memoryBytes: 64 * 1024 * 1024, pids: 32, timeoutMs: 10_000 },
}

class FakeRunner implements HarnessProcessRunner {
	readonly calls: HarnessProcessSpec[] = []
	constructor(private readonly results: HarnessProcessResult[]) {}
	async run(input: HarnessProcessSpec): Promise<HarnessProcessResult> {
		this.calls.push(input)
		return this.results.shift() ?? success()
	}
}

describe("structured Docker adapter", () => {
	it("supports opt-in offline confinement without changing existing container defaults", async () => {
		const confined = {
			...spec,
			pull: "never" as const,
			readOnlyRootFilesystem: true,
			dropAllCapabilities: true,
			noNewPrivileges: true,
			maxOutputBytes: 65_536,
		}
		expect(containerArgs(confined)).toEqual(
			expect.arrayContaining([
				"--pull",
				"never",
				"--read-only",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges=true",
			]),
		)
		const previous = containerArgs(spec)
		expect(previous).not.toContain("--pull")
		expect(previous).not.toContain("--read-only")
		const runner = new FakeRunner([success()])
		await new DockerCliAdapter(runner).run(confined)
		expect(runner.calls[0]!.maxOutputBytes).toBe(65_536)
	})

	it("builds resource-scoped argv without secret values or shell composition", async () => {
		const args = containerArgs(spec)
		expect(args).toContain("alpha.evals.attempt-id=attempt")
		expect(args).toContain("API_TOKEN")
		expect(args).not.toContain("secret-canary")
		expect(args).not.toContain("-c")
		expect(args.slice(-2)).toEqual(["redis:7-alpine", "hello"])
		const runner = new FakeRunner([success("ok")])
		await new DockerCliAdapter(runner).run(spec)
		expect(runner.calls[0]).toMatchObject({ command: "docker", env: { API_TOKEN: "secret-canary" } })
	})

	it("lists, inspects, and cleans only the exact owner", async () => {
		const row = JSON.stringify({
			ID: "abc",
			Names: "eval-attempt",
			Status: "Up",
			Labels: "alpha.evals.managed=true,alpha.evals.run-id=run,alpha.evals.trial-id=trial,alpha.evals.attempt-id=attempt",
		})
		const runner = new FakeRunner([success(row), success("abc"), success()])
		const adapter = new DockerCliAdapter(runner)
		expect(await adapter.cleanup(spec.owner)).toEqual(["abc"])
		expect(runner.calls[0]!.args.join(" ")).toContain("alpha.evals.attempt-id=attempt")
		expect(runner.calls[1]!.args).toEqual(["rm", "--force", "abc"])
		expect(runner.calls[2]!.args[0]).toBe("ps")
	})

	it.each(["timeout", "launch-failure", "interruption"])("verifies owned cleanup after %s", async (kind) => {
		const row = JSON.stringify({ ID: "owned", Names: spec.name, Status: "Up", Labels: "alpha.evals.managed=true" })
		const calls: HarnessProcessSpec[] = []
		const runner = {
			run: async (input: HarnessProcessSpec) => {
				calls.push(input)
				if (input.args[0] === "run") {
					if (kind !== "timeout") throw new Error(kind)
					return { ...success(), timedOut: true }
				}
				if (input.args[0] === "ps") return success(calls.length === 2 ? row : "")
				return success()
			},
		}
		const result = new DockerCliAdapter(runner).run(spec)
		if (kind === "timeout") await expect(result).resolves.toMatchObject({ timedOut: true })
		else await expect(result).rejects.toThrow(kind)
		expect(calls.map(({ args }) => args[0])).toEqual(["run", "ps", "rm", "ps"])
		expect(calls[1]!.args).toContain("label=alpha.evals.attempt-id=attempt")
	})

	it("fails closed when cleanup cannot prove that the old container stopped", async () => {
		const row = JSON.stringify({ ID: "owned", Names: spec.name, Status: "Up", Labels: "alpha.evals.managed=true" })
		const runner = new FakeRunner([success(), success(row), success(), success(row)])
		await expect(new DockerCliAdapter(runner).run(spec)).rejects.toThrow("Unable to verify cleanup")
	})

	it("retains both the launch fault and the cleanup fault when cleanup cannot be verified", async () => {
		const launch = new Error("launch failed")
		const cleanup = new Error("cleanup failed")
		let calls = 0
		const runner: HarnessProcessRunner = {
			run: async () => {
				throw calls++ === 0 ? launch : cleanup
			},
		}
		const failure = await new DockerCliAdapter(runner).run(spec).catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(Error)
		expect(failure).toMatchObject({ cause: expect.any(AggregateError) })
		expect(failure).toMatchObject({ cause: { errors: [launch, cleanup] } })
	})

	it.each(["timeout", "launch-failure", "interruption", "missing-id", "truncated-id"])(
		"cleans owned detached services after %s",
		async (kind) => {
			const controller = new AbortController()
			const calls: HarnessProcessSpec[] = []
			let listings = 0
			const runner: HarnessProcessRunner = {
				run: async (input) => {
					calls.push(input)
					if (input.args[0] === "run") {
						if (kind === "launch-failure") throw new Error("launch-failure")
						if (kind === "interruption") controller.abort(new Error("interrupted"))
						return {
							...success(kind === "missing-id" ? "" : "a".repeat(64)),
							timedOut: kind === "timeout",
							outputTruncated: kind === "truncated-id",
						}
					}
					if (input.args[0] === "ps")
						return success(
							listings++ === 0
								? JSON.stringify({
										ID: "owned",
										Names: spec.name,
										Status: "Up",
										Labels: "alpha.evals.managed=true",
									})
								: "",
						)
					return success()
				},
			}
			await expect(
				new DockerCliAdapter(runner).runDetached({ ...spec, signal: controller.signal }),
			).rejects.toThrow()
			expect(calls.map(({ args }) => args[0])).toEqual(["run", "ps", "rm", "ps"])
			expect(calls[0]!.signal).toBe(controller.signal)
			expect(calls[1]!.args).toContain("label=alpha.evals.attempt-id=attempt")
			expect(calls.slice(1).every(({ signal }) => signal === undefined)).toBe(true)
		},
	)

	it("keeps a successful detached service running until its owner removes it", async () => {
		const id = "a".repeat(64)
		const runner = new FakeRunner([success(id)])
		expect(await new DockerCliAdapter(runner).runDetached(spec)).toBe(id)
		expect(runner.calls.map(({ args }) => args[0])).toEqual(["run"])
	})

	it("does not launch a detached service after cancellation", async () => {
		const controller = new AbortController()
		controller.abort(new Error("cancelled before launch"))
		const runner = new FakeRunner([success("a".repeat(64))])
		await expect(new DockerCliAdapter(runner).runDetached({ ...spec, signal: controller.signal })).rejects.toThrow(
			"cancelled before launch",
		)
		expect(runner.calls).toHaveLength(0)
	})

	it("retains detached launch and cleanup faults and prevents false cleanup success", async () => {
		const launch = new Error("detached launch failed")
		const cleanup = new Error("detached cleanup failed")
		let calls = 0
		const runner: HarnessProcessRunner = {
			run: async () => {
				throw calls++ === 0 ? launch : cleanup
			},
		}
		const failure = await new DockerCliAdapter(runner).runDetached(spec).catch((error: unknown) => error)
		expect(failure).toMatchObject({ name: "ContainerCleanupError", cause: { errors: [launch, cleanup] } })
	})

	it("collects immutable runtime and image provenance", async () => {
		const runner = new FakeRunner([
			success(
				JSON.stringify([
					{ Id: "sha256:image", RepoDigests: ["redis@sha256:digest"], Architecture: "amd64", Os: "linux" },
				]),
			),
			success("27.0.0\n"),
		])
		expect(await collectInfrastructureManifest(spec, runner, 4)).toMatchObject({
			imageId: "sha256:image",
			repoDigests: ["redis@sha256:digest"],
			dockerVersion: "27.0.0",
			networkMode: "none",
			concurrency: 4,
			permissionProfileDigest: expect.stringMatching(/^sha256:/),
		})
	})

	it("supports untagged images and rejects image/runtime inspection failures", async () => {
		const untagged = new FakeRunner([
			success(JSON.stringify([{ Id: "sha256:image", Architecture: "amd64", Os: "linux" }])),
			success("27"),
		])
		expect((await collectInfrastructureManifest(spec, untagged, 1)).repoDigests).toEqual([])
		await expect(
			collectInfrastructureManifest(
				spec,
				new FakeRunner([{ ...success(), exitCode: 1, stderr: "missing image" }, success("27")]),
				1,
			),
		).rejects.toThrow("Unable to inspect image")
		await expect(
			collectInfrastructureManifest(
				spec,
				new FakeRunner([
					success(JSON.stringify([{ Id: "sha256:image", Architecture: "amd64", Os: "linux" }])),
					{ ...success(), timedOut: true, exitCode: null, stderr: "timeout" },
				]),
				1,
			),
		).rejects.toThrow("Unable to inspect Docker runtime")
	})

	it("fails teardown when labeled resources leak", async () => {
		const runner = new FakeRunner([
			success(JSON.stringify({ ID: "abc", Names: "leak", Status: "Up", Labels: "alpha.evals.managed=true" })),
		])
		await expect(assertNoContainerLeaks(new DockerCliAdapter(runner), { runId: "run" })).rejects.toThrow("leak")
	})
})

describe("restart reconciliation", () => {
	it("marks missing containers and expired leases without touching live attempts", async () => {
		const markOrphaned = vi.fn(async () => undefined)
		const orphaned = await reconcileOrphanedAttempts({
			listOpenAttempts: async () => [
				{ databaseId: 1, runId: "run", trialId: "one", attemptId: "live", leaseActive: true },
				{ databaseId: 2, runId: "run", trialId: "two", attemptId: "missing", leaseActive: true },
				{ databaseId: 3, runId: "run", trialId: "three", attemptId: "expired", leaseActive: false },
			],
			listContainerAttemptIds: async () => ["live", "expired"],
			markOrphaned,
		})
		expect(orphaned).toEqual([2, 3])
		expect(markOrphaned).toHaveBeenCalledTimes(2)
	})
})
