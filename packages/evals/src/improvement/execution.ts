import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { z } from "zod"

import {
	ContainerCleanupError,
	DockerCliAdapter,
	type ContainerLimits,
	type ContainerSpec,
} from "../infrastructure/index"
import { ExecaHarnessProcessRunner } from "../orchestration/processRunner"
import type { HarnessProcessResult, HarnessProcessRunner, HarnessProcessSpec } from "../orchestration/ports"

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const imageReference = z
	.string()
	.max(256)
	.regex(/^(?:[a-z0-9][a-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/)
export const regressionExecutionConfigurationSchema = z
	.object({
		image: imageReference,
		limits: z
			.object({
				cpus: z.number().min(0.1).max(2),
				memoryBytes: z
					.number()
					.int()
					.min(64 * 1024 * 1024)
					.max(2 * 1024 * 1024 * 1024),
				pids: z.number().int().min(16).max(128),
				timeoutMs: z.number().int().min(1000).max(60_000),
			})
			.strict(),
	})
	.strict()
export type RegressionExecutionConfiguration = z.infer<typeof regressionExecutionConfigurationSchema>
export type RegressionExecutionBoundary = {
	processRunner: HarnessProcessRunner
	policyDigest: string
	network: "disabled"
	dispose(): Promise<void>
}

const helperRoot = path.dirname(fileURLToPath(new URL("../grading/nodeTestExecution.mjs", import.meta.url)))
const workspaceTarget = "/workspace"
const helperTarget = "/alpha-grader"
const helperFiles = ["nodeTestExecution.mjs", "nodeTestContext.cjs", "nodeTestAssertions.cjs"]
const expectedContractSchema = z
	.object({
		expected: z
			.array(
				z
					.object({
						file: z.string(),
						name: z.string().min(1).max(1000),
						assertions: z.number().int().min(1).max(10_000),
					})
					.strict(),
			)
			.min(1)
			.max(256),
		sourceDigests: z
			.array(z.object({ file: z.string(), digest }).strict())
			.min(1)
			.max(32),
	})
	.strict()

/** Only the existing assertion supervisor may execute model-created control fixtures. */
export async function createRegressionExecutionBoundary(input: {
	configuration: unknown
	ownedRoot: string
	policyDigest: string
	processRunner?: HarnessProcessRunner
	signal?: AbortSignal
}): Promise<RegressionExecutionBoundary> {
	const signal = input.signal
	signal?.throwIfAborted()
	const configuration = regressionExecutionConfigurationSchema.parse(input.configuration)
	const policyDigest = digest.parse(input.policyDigest)
	const ownedRoot = await realDirectory(input.ownedRoot)
	const sourceHelpers = await realDirectory(helperRoot)
	if (inside(ownedRoot, sourceHelpers)) throw new Error("Regression ownership must exclude grader helpers")
	const immutableHelpers = path.join(ownedRoot, `.grader-helpers-${randomUUID()}`)
	const dockerConfiguration = path.join(ownedRoot, `.docker-config-${randomUUID()}`)
	const removeRuntimeDirectories = async () => {
		for (const directory of [immutableHelpers, dockerConfiguration]) {
			if (path.dirname(directory) !== ownedRoot) throw new Error("Regression cleanup escaped its owner")
			await fs.rm(directory, { recursive: true, force: true })
		}
	}
	try {
		await fs.mkdir(immutableHelpers, { mode: 0o700 })
		await fs.mkdir(dockerConfiguration, { mode: 0o700 })
		for (const file of helperFiles) {
			const source = await realFile(sourceHelpers, path.join(sourceHelpers, file))
			await fs.writeFile(path.join(immutableHelpers, file), await fs.readFile(source), {
				flag: "wx",
				mode: 0o400,
			})
		}
		const baseRunner = input.processRunner ?? new ExecaHarnessProcessRunner()
		// PATH/SystemRoot resolve the local CLI; no caller, provider, or Docker endpoint environment is inherited.
		const transport: HarnessProcessRunner = {
			run: (spec) => baseRunner.run({ ...spec, env: transportEnvironment(dockerConfiguration) }),
		}
		const docker = new DockerCliAdapter(transport)
		const runId = `regression-${policyDigest.slice(7, 23)}`
		const trialId = randomUUID()
		const isolatedSpec = (args: string[], limits: ContainerLimits): ContainerSpec => ({
			name: `evals-control-${randomUUID()}`,
			image: configuration.image,
			owner: { runId, trialId, attemptId: randomUUID() },
			command: "/usr/bin/env",
			args: [
				"-i",
				"PATH=/usr/local/bin:/usr/bin:/bin",
				"HOME=/nonexistent",
				"TMPDIR=/workspace",
				"node",
				...args,
			],
			processEnv: {},
			network: "none",
			limits,
			pull: "never",
			readOnlyRootFilesystem: true,
			dropAllCapabilities: true,
			noNewPrivileges: true,
			maxOutputBytes: 65_536,
			signal,
		})
		signal?.throwIfAborted()
		const inspected = await transport.run({
			command: "docker",
			args: ["image", "inspect", configuration.image],
			timeoutMs: 10_000,
			maxOutputBytes: 65_536,
			signal,
		})
		assertCompleted(inspected, "Configured regression image is not available locally")
		signal?.throwIfAborted()
		const images = z
			.array(
				z.object({
					Id: digest,
					Os: z.literal("linux"),
					Config: z.object({ Volumes: z.record(z.unknown()).nullable().optional() }).optional(),
				}),
			)
			.length(1)
			.parse(JSON.parse(inspected.fullStdout ?? inspected.stdout))
		if (Object.keys(images[0]!.Config?.Volumes ?? {}).length)
			throw new Error("Regression images cannot declare additional writable volumes")
		// Inspection and --pull never prevent an implicit download; run the inspected immutable image ID.
		configuration.image = images[0]!.Id
		const probe = await docker.run(
			isolatedSpec(["-p", "JSON.stringify({node:process.versions.node,platform:process.platform})"], {
				...configuration.limits,
				timeoutMs: Math.min(configuration.limits.timeoutMs, 10_000),
			}),
		)
		assertCompleted(probe, "Regression Node runtime probe failed")
		signal?.throwIfAborted()
		z.object({ node: z.string().regex(/^24\.\d+\.\d+$/), platform: z.literal("linux") }).parse(
			JSON.parse(probe.fullStdout ?? probe.stdout),
		)
		let cleanupFailure: ContainerCleanupError | undefined
		let disposed = false
		return Object.freeze({
			policyDigest,
			network: "disabled" as const,
			dispose: async () => {
				disposed = true
				await removeRuntimeDirectories()
			},
			processRunner: {
				run: async (spec: HarnessProcessSpec) => {
					if (disposed) throw new Error("Regression execution boundary has been disposed")
					if (cleanupFailure) throw cleanupFailure
					const commandSignal =
						signal && spec.signal ? AbortSignal.any([signal, spec.signal]) : (signal ?? spec.signal)
					commandSignal?.throwIfAborted()
					if (spec.env && Object.keys(spec.env).length)
						throw new Error("Regression controls cannot inject environment values")
					if (
						spec.command !== process.execPath ||
						spec.args.length !== 3 ||
						spec.args[0] !== path.join(helperRoot, helperFiles[0]!)
					)
						throw new Error("Regression execution supports only the original Node assertion supervisor")
					if (
						!Number.isInteger(spec.timeoutMs) ||
						spec.timeoutMs < 1 ||
						spec.timeoutMs > configuration.limits.timeoutMs ||
						spec.args[2] !== String(spec.timeoutMs)
					)
						throw new Error("Regression command exceeds its captured time bound")
					if (
						!Number.isInteger(spec.maxOutputBytes) ||
						spec.maxOutputBytes < 1 ||
						spec.maxOutputBytes > 1024 * 1024
					)
						throw new Error("Regression command exceeds its output bound")
					if (!spec.cwd) throw new Error("Regression execution requires an owned fixture workspace")
					const cwd = await realDirectory(spec.cwd)
					if (cwd === ownedRoot || !inside(ownedRoot, cwd))
						throw new Error("Regression workspace escapes its owned root")
					if (spec.args[1]!.length > 262_144)
						throw new Error("Regression assertion contract exceeds its bound")
					const contract = expectedContractSchema.parse(JSON.parse(spec.args[1]!))
					const mapFile = async (file: string) => toContainerFile(cwd, await realFile(cwd, file))
					const expected = await Promise.all(
						contract.expected.map(async (item) => ({ ...item, file: await mapFile(item.file) })),
					)
					const sourceDigests = await Promise.all(
						contract.sourceDigests.map(async (item) => ({ ...item, file: await mapFile(item.file) })),
					)
					const sources = new Set(sourceDigests.map(({ file }) => file))
					if (
						sources.size !== sourceDigests.length ||
						expected.some(({ file }) => !sources.has(file)) ||
						[...sources].some((file) => !expected.some((item) => item.file === file))
					)
						throw new Error("Regression assertion sources must exactly match captured tests")
					commandSignal?.throwIfAborted()
					let result: HarnessProcessResult
					try {
						result = await docker.run({
							...isolatedSpec(
								[
									`${helperTarget}/${helperFiles[0]}`,
									JSON.stringify({ expected, sourceDigests }),
									String(spec.timeoutMs),
								],
								{ ...configuration.limits, timeoutMs: spec.timeoutMs },
							),
							workingDirectory: workspaceTarget,
							binds: [
								{ source: cwd, target: workspaceTarget, readOnly: false },
								{ source: immutableHelpers, target: helperTarget, readOnly: true },
							],
							maxOutputBytes: spec.maxOutputBytes,
							signal: commandSignal,
						})
					} catch (error) {
						if (error instanceof ContainerCleanupError) cleanupFailure = error
						throw error
					}
					const output = mapReceipt(result.fullStdout ?? result.stdout, cwd, sourceHelpers)
					return {
						...result,
						stdout: output,
						...(result.fullStdout === undefined ? {} : { fullStdout: output }),
					}
				},
			},
		})
	} catch (error) {
		try {
			await removeRuntimeDirectories()
		} catch (cleanup) {
			throw new AggregateError([error, cleanup], "Regression setup and owned-directory cleanup failed")
		}
		throw error
	}
}

function transportEnvironment(dockerConfiguration: string): Record<string, string> {
	const values = {
		PATH: process.env.PATH,
		DOCKER_CONFIG: dockerConfiguration,
		...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
	}
	return Object.fromEntries(
		Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	)
}

function inside(root: string, file: string): boolean {
	const relative = path.relative(root, file)
	return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
}

async function realDirectory(value: string): Promise<string> {
	const resolved = path.resolve(value)
	if (
		/[\r\n,]/.test(resolved) ||
		!(await fs.lstat(resolved)).isDirectory() ||
		path.relative(resolved, await fs.realpath(resolved))
	)
		throw new Error("Regression mounts require real, portable owned directories")
	return resolved
}

async function realFile(root: string, file: string): Promise<string> {
	if (!path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))
		throw new Error("Regression contract file must be an absolute contained path")
	const resolved = path.resolve(file)
	if (
		!inside(root, resolved) ||
		resolved === root ||
		!(await fs.lstat(resolved)).isFile() ||
		path.relative(resolved, await fs.realpath(resolved))
	)
		throw new Error("Regression contract file escapes its fixture or uses a symbolic link")
	return resolved
}

function toContainerFile(cwd: string, file: string): string {
	return path.posix.join(workspaceTarget, ...path.relative(cwd, file).split(path.sep))
}

function mapReceipt(output: string, cwd: string, helpers: string): string {
	let parsed: unknown
	try {
		parsed = JSON.parse(output)
	} catch {
		return output
	}
	if (!parsed || typeof parsed !== "object" || !("kind" in parsed) || parsed.kind !== "alpha-expected-node-tests")
		return output
	const receipt = parsed as Record<string, unknown>
	const map = (entries: unknown) =>
		Array.isArray(entries)
			? entries.map((entry: unknown) => {
					if (!entry || typeof entry !== "object" || !("file" in entry) || typeof entry.file !== "string")
						return entry
					const file = entry.file
					if (
						file.includes("\\") ||
						file.includes("\0") ||
						file.includes(":") ||
						file.split("/").includes("..") ||
						path.posix.normalize(file) !== file
					)
						throw new Error("Regression receipt contains an untrusted file path")
					if (file.startsWith(`${workspaceTarget}/`)) {
						const mapped = path.resolve(cwd, ...file.slice(workspaceTarget.length + 1).split("/"))
						if (!inside(cwd, mapped) || mapped === cwd)
							throw new Error("Regression receipt escaped its fixture")
						return { ...entry, file: mapped }
					}
					if (helperFiles.some((name) => file === `${helperTarget}/${name}`))
						return { ...entry, file: path.join(helpers, path.posix.basename(file)) }
					throw new Error("Regression receipt references an external file")
				})
			: entries
	return JSON.stringify({ ...receipt, tests: map(receipt.tests), completions: map(receipt.completions) })
}

function assertCompleted(result: HarnessProcessResult, message: string): void {
	if (result.timedOut || result.exitCode !== 0 || result.outputTruncated) throw new Error(message)
}
