import type { HarnessProcessRunner, HarnessProcessResult } from "../orchestration/index"
import { OWNER_LABELS, type ContainerRecord, type ContainerSpec, type ResourceOwner } from "./types"

export class DockerCliAdapter {
	constructor(private readonly runner: HarnessProcessRunner) {}

	async run(spec: ContainerSpec): Promise<HarnessProcessResult> {
		const result = await this.runner.run({
			command: "docker",
			args: ["run", "--rm", ...containerArgs(spec)],
			env: spec.processEnv,
			timeoutMs: spec.limits.timeoutMs,
			maxOutputBytes: 10 * 1024 * 1024,
		})
		if (result.timedOut) await this.removeQuietly(spec.name)
		return result
	}

	async runDetached(spec: ContainerSpec): Promise<string> {
		const result = await this.runner.run({
			command: "docker",
			args: ["run", "--detach", ...containerArgs(spec)],
			env: spec.processEnv,
			timeoutMs: 30_000,
			maxOutputBytes: 1024 * 1024,
		})
		assertSuccess(result, "docker run --detach")
		return result.stdout.trim()
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
		const containers = await this.list(owner)
		for (const container of containers) await this.remove(container.id)
		return containers.map(({ id }) => id)
	}

	private command(args: string[]): Promise<HarnessProcessResult> {
		return this.runner.run({ command: "docker", args, timeoutMs: 30_000, maxOutputBytes: 10 * 1024 * 1024 })
	}

	private async removeQuietly(id: string): Promise<void> {
		await this.command(["rm", "--force", id]).catch(() => undefined)
	}
}

export function containerArgs(spec: ContainerSpec): string[] {
	const labels = {
		[OWNER_LABELS.managed]: "true",
		[OWNER_LABELS.runId]: spec.owner.runId,
		[OWNER_LABELS.trialId]: spec.owner.trialId,
		[OWNER_LABELS.attemptId]: spec.owner.attemptId,
		...spec.labels,
	}
	return [
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
