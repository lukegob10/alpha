import type { HarnessProcessRunner } from "../orchestration/index"
import { canonicalJson, sha256 } from "../evidence/index"
import type { ContainerSpec, InfrastructureManifest } from "./types"

export async function collectInfrastructureManifest(
	spec: ContainerSpec,
	runner: HarnessProcessRunner,
	concurrency: number,
): Promise<InfrastructureManifest> {
	const [image, version] = await Promise.all([
		runner.run({
			command: "docker",
			args: ["image", "inspect", spec.image],
			timeoutMs: 30_000,
			maxOutputBytes: 1024 * 1024,
		}),
		runner.run({
			command: "docker",
			args: ["version", "--format", "{{.Server.Version}}"],
			timeoutMs: 30_000,
			maxOutputBytes: 10_000,
		}),
	])
	if (image.timedOut || image.exitCode !== 0)
		throw new Error(`Unable to inspect image ${spec.image}: ${image.stderr}`)
	if (version.timedOut || version.exitCode !== 0)
		throw new Error(`Unable to inspect Docker runtime: ${version.stderr}`)
	const details = JSON.parse(image.stdout)[0] as {
		Id: string
		RepoDigests?: string[]
		Architecture: string
		Os: string
	}
	return {
		schemaVersion: 1,
		imageReference: spec.image,
		imageId: details.Id,
		repoDigests: details.RepoDigests ?? [],
		architecture: details.Architecture,
		os: details.Os,
		dockerVersion: version.stdout.trim(),
		networkMode: spec.network,
		limits: spec.limits,
		owner: spec.owner,
		concurrency,
		permissionProfileDigest: sha256(
			canonicalJson({
				binds: spec.binds ?? [],
				envNames: [...(spec.envNames ?? [])].sort(),
				network: spec.network,
				workingDirectory: spec.workingDirectory ?? null,
			}),
		),
	}
}
