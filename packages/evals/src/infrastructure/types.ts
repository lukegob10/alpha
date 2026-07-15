export type ResourceOwner = { runId: string; trialId: string; attemptId: string }

export type ContainerLimits = {
	cpus: number
	memoryBytes: number
	pids: number
	timeoutMs: number
}

export type ContainerSpec = {
	name: string
	image: string
	owner: ResourceOwner
	command: string
	args: string[]
	envNames?: string[]
	processEnv?: Record<string, string>
	labels?: Record<string, string>
	binds?: { source: string; target: string; readOnly: boolean }[]
	network: string
	limits: ContainerLimits
	workingDirectory?: string
}

export type ContainerRecord = {
	id: string
	name: string
	status: string
	labels: Record<string, string>
}

export type InfrastructureManifest = {
	schemaVersion: 1
	imageReference: string
	imageId: string
	repoDigests: string[]
	architecture: string
	os: string
	dockerVersion: string
	networkMode: string
	limits: ContainerLimits
	owner: ResourceOwner
	concurrency: number
	permissionProfileDigest: string
}

export const OWNER_LABELS = {
	managed: "alpha.evals.managed",
	runId: "alpha.evals.run-id",
	trialId: "alpha.evals.trial-id",
	attemptId: "alpha.evals.attempt-id",
} as const
