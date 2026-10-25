import type { HarnessProcessRunner, HarnessProcessResult } from "../orchestration/index"
import { OWNER_LABELS, type ContainerRecord, type ContainerSpec, type ResourceOwner } from "./types"

export class ContainerCleanupError extends Error {
	constructor(owner: ResourceOwner, cause: unknown) {
		super(`Unable to verify cleanup of evaluation attempt ${owner.attemptId}`, { cause })
		this.name = "ContainerCleanupError"
	}
}

export class DockerCliAdapter {
	constructor(private readonly runner: HarnessProcessRunner) {}

	async run(spec: ContainerSpec): Promise<HarnessProcessResult> {
		let result: HarnessProcessResult | undefined
		let failure: { error: unknown } | undefined
		try {
			result = await this.runner.run({
				command: "docker",
				args: ["run", "--rm", ...containerArgs(spec)],
				env: spec.processEnv,
				timeoutMs: spec.limits.timeoutMs,
				maxOutputBytes: spec.maxOutputBytes ?? 10 * 1024 * 1024,
				signal: spec.signal,
			})
		} catch (error) {
			failure = { error }
		}
		// Killing the Docker client does not establish that its daemon-owned container stopped.
		try {
			await this.cleanup(spec.owner)
		} catch (error) {
			throw new ContainerCleanupError(
				spec.owner,
				failure ? new AggregateError([failure.error, error], "Execution and owned cleanup failed") : error,
			)
		}
		if (failure) throw failure.error
		return result!
	}

	async runDetached(spec: ContainerSpec): Promise<string> {
		spec.signal?.throwIfAborted()
		try {
			const result = await this.runner.run({
				command: "docker",
				args: ["run", "--detach", ...containerArgs(spec)],
				env: spec.processEnv,
				timeoutMs: 30_000,
				maxOutputBytes: 1024 * 1024,
				signal: spec.signal,
			})
			spec.signal?.throwIfAborted()
			assertSuccess(result, "docker run --detach")
			const id = result.stdout.trim()
			if (result.outputTruncated || !/^[a-f0-9]{64}$/.test(id))
				throw new Error("docker run --detach did not return a complete container ID")
			return id
		} catch (error) {
			// A failed client launch/ID receipt may still leave a daemon-owned service running.
			try {
				await this.cleanup(spec.owner)
			} catch (cleanup) {
				throw new ContainerCleanupError(
					spec.owner,
					new AggregateError([error, cleanup], "Detached execution and owned cleanup failed"),
				)
			}
			throw error
		}
	}

	async inspect(id: string): Promise<unknown> {
		const result = await this.command(["inspect", id])
		assertSuccess(result, "docker inspect")
		return JSON.parse(result.stdout)[0]
	}

	async list(owner?: Partial<ResourceOwner>): Promise<ContainerRecord[]> {
		const filters = ["label=alpha.evals.managed=true", ...ownerFilters(owner)]
		const result = await this.command([
			"ps",
			"--all",
			...filters.flatMap((filter) => ["--filter", filter]),
			"--format",
			"{{json .}}",
		])
		assertSuccess(result, "docker ps")
		return result.stdout
			.split(/\r?\n/)
			.filter(Boolean)
			.map((line) => {
				const row = JSON.parse(line) as { ID: string; Names: string; Status: string; Labels: string }
				return { id: row.ID, name: row.Names, status: row.Status, labels: parseLabels(row.Labels) }
			})
	}

	async kill(id: string): Promise<void> {
		const result = await this.command(["kill", id])
		assertSuccess(result, "docker kill")
	}

	async remove(id: string): Promise<void> {
		const result = await this.command(["rm", "--force", id])
		assertSuccess(result, "docker rm")
	}

	async cleanup(owner: Partial<ResourceOwner>): Promise<string[]> {
		if (!owner.runId && !owner.trialId && !owner.attemptId)
			throw new Error("Evaluation container cleanup requires an explicit owner")
		const containers = await this.list(owner)
		for (const container of containers) await this.remove(container.id)
		const remaining = await this.list(owner)
		if (remaining.length)
			throw new Error(`Evaluation container cleanup left ${remaining.length} owned container(s)`)
		return containers.map(({ id }) => id)
	}

	private command(args: string[]): Promise<HarnessProcessResult> {
		return this.runner.run({ command: "docker", args, timeoutMs: 30_000, maxOutputBytes: 10 * 1024 * 1024 })
	}
}

export function containerArgs(spec: ContainerSpec): string[] {
	const labels = {
		...spec.labels,
		[OWNER_LABELS.managed]: "true",
		[OWNER_LABELS.runId]: spec.owner.runId,
		[OWNER_LABELS.trialId]: spec.owner.trialId,
		[OWNER_LABELS.attemptId]: spec.owner.attemptId,
	}
	return [
		...(spec.pull ? ["--pull", spec.pull] : []),
		...(spec.readOnlyRootFilesystem ? ["--read-only"] : []),
		...(spec.dropAllCapabilities ? ["--cap-drop", "ALL"] : []),
		...(spec.noNewPrivileges ? ["--security-opt", "no-new-privileges=true"] : []),
		"--name",
		spec.name,
		"--network",
		spec.network,
		"--cpus",
		String(spec.limits.cpus),
		"--memory",
		String(spec.limits.memoryBytes),
		"--pids-limit",
		String(spec.limits.pids),
		...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
		...(spec.workingDirectory ? ["--workdir", spec.workingDirectory] : []),
		...(spec.envNames ?? []).flatMap((name) => ["--env", name]),
		...(spec.binds ?? []).flatMap(({ source, target, readOnly }) => [
			"--mount",
			`type=bind,src=${source},dst=${target}${readOnly ? ",readonly" : ""}`,
		]),
		"--entrypoint",
		spec.command,
		spec.image,
		...spec.args,
	]
}

function ownerFilters(owner: Partial<ResourceOwner> = {}): string[] {
	return [
		owner.runId && `label=${OWNER_LABELS.runId}=${owner.runId}`,
		owner.trialId && `label=${OWNER_LABELS.trialId}=${owner.trialId}`,
		owner.attemptId && `label=${OWNER_LABELS.attemptId}=${owner.attemptId}`,
	].filter((value): value is string => !!value)
}

function parseLabels(value: string): Record<string, string> {
	return Object.fromEntries(
		value
			.split(",")
			.filter(Boolean)
			.map((label) => label.split("=", 2) as [string, string]),
	)
}

function assertSuccess(result: HarnessProcessResult, command: string): void {
	if (result.timedOut || result.exitCode !== 0) throw new Error(`${command} failed: ${result.stderr}`)
}
