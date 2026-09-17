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
		const runner = new FakeRunner([success(row), success("abc"), success("[]")])
		const adapter = new DockerCliAdapter(runner)
		expect(await adapter.cleanup(spec.owner)).toEqual(["abc"])
		expect(runner.calls[0]!.args.join(" ")).toContain("alpha.evals.attempt-id=attempt")
		expect(runner.calls[1]!.args).toEqual(["rm", "--force", "abc"])
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
