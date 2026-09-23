import fs from "fs/promises"
import os from "os"
import path from "path"

import { simpleGit } from "simple-git"

import * as fileSearch from "../../../services/search/file-search"
import { RepoPerTaskCheckpointService } from "../RepoPerTaskCheckpointService"

const enabled = process.env.ALPHA_CHECKPOINT_PERF === "1"
const sampleCount = Math.min(
	10,
	Math.max(3, Number.parseInt(process.env.ALPHA_CHECKPOINT_PERF_SAMPLES ?? "3", 10) || 3),
)
const sourceFileCount = 100
const nodeModuleFileCount = 10_000
const dataFileCount = 16
const sourceFileSize = 16 * 1024
const dataFileSize = 1024 * 1024
const nodeModulePackageCount = 100
const nodeModuleFilesPerPackage = nodeModuleFileCount / nodeModulePackageCount
const suppliedWorkspaceDir = process.env.ALPHA_CHECKPOINT_PERF_WORKSPACE?.trim()

const median = (values: number[]) => {
	const ordered = [...values].sort((left, right) => left - right)
	return ordered[Math.floor(ordered.length / 2)]
}

const durationMs = async <T>(operation: () => Promise<T>) => {
	const started = performance.now()
	const result = await operation()
	return { result, duration: performance.now() - started }
}

const writeInBatches = async (writes: Array<() => Promise<void>>) => {
	const batchSize = 256
	for (let start = 0; start < writes.length; start += batchSize) {
		await Promise.all(writes.slice(start, start + batchSize).map((write) => write()))
	}
}

const createWorkspaceFixture = async (root: string) => {
	const workspaceDir = path.join(root, "workspace")
	await fs.mkdir(workspaceDir, { recursive: true })

	const workspaceGit = simpleGit(workspaceDir)
	await workspaceGit.init()
	await workspaceGit.addConfig("user.name", "Alpha benchmark")
	await workspaceGit.addConfig("user.email", "benchmark@alpha.invalid")
	await fs.mkdir(path.join(workspaceDir, "src"), { recursive: true })
	await fs.mkdir(path.join(workspaceDir, "data"), { recursive: true })

	const sourceContent = Buffer.alloc(sourceFileSize, 0x73)
	const dataContent = Buffer.alloc(dataFileSize, 0x64)
	const nodeModuleContent = Buffer.from("module fixture\n")
	const nodeModuleDirectories = new Set<string>()
	for (let packageIndex = 0; packageIndex < nodeModulePackageCount; packageIndex++) {
		const packageName = `package-${packageIndex.toString().padStart(3, "0")}`
		for (let fileIndex = 0; fileIndex < nodeModuleFilesPerPackage; fileIndex++) {
			const directory = path.join(
				workspaceDir,
				"node_modules",
				packageName,
				fileIndex % 2 === 0 ? "lib" : "runtime",
				"nested",
			)
			nodeModuleDirectories.add(directory)
		}
	}

	await Promise.all([...nodeModuleDirectories].map((directory) => fs.mkdir(directory, { recursive: true })))
	const writes: Array<() => Promise<void>> = []
	for (let index = 0; index < sourceFileCount; index++) {
		writes.push(() =>
			fs.writeFile(
				path.join(workspaceDir, "src", `module-${index.toString().padStart(3, "0")}.ts`),
				sourceContent,
			),
		)
	}
	for (let index = 0; index < dataFileCount; index++) {
		writes.push(() =>
			fs.writeFile(
				path.join(workspaceDir, "data", `record-${index.toString().padStart(2, "0")}.txt`),
				dataContent,
			),
		)
	}
	for (let packageIndex = 0; packageIndex < nodeModulePackageCount; packageIndex++) {
		const packageName = `package-${packageIndex.toString().padStart(3, "0")}`
		for (let fileIndex = 0; fileIndex < nodeModuleFilesPerPackage; fileIndex++) {
			const directory = path.join(
				workspaceDir,
				"node_modules",
				packageName,
				fileIndex % 2 === 0 ? "lib" : "runtime",
				"nested",
			)
			writes.push(() =>
				fs.writeFile(
					path.join(directory, `file-${fileIndex.toString().padStart(3, "0")}.js`),
					nodeModuleContent,
				),
			)
		}
	}
	await writeInBatches(writes)

	return { workspaceDir, sourceContent, dataContent }
}

const assertOwnedTemporaryRoot = (root: string) => {
	const resolvedRoot = path.resolve(root)
	const resolvedTemp = path.resolve(os.tmpdir())
	const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
	expect(normalize(path.dirname(resolvedRoot))).toBe(normalize(resolvedTemp))
}

describe.skipIf(!enabled)("checkpoint performance benchmark", () => {
	it.skipIf(!suppliedWorkspaceDir)(
		"measures initialization against a live workspace without changing it",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-checkpoint-live-perf-"))
			assertOwnedTemporaryRoot(root)

			try {
				const initializationMs: number[] = []
				const breakdowns: string[] = []
				for (let sample = 0; sample < sampleCount; sample++) {
					const serviceLogs: string[] = []
					const service = new RepoPerTaskCheckpointService(
						`live-workspace-benchmark-${sample}`,
						path.join(root, `shadow-${sample}`),
						suppliedWorkspaceDir!,
						(message) => serviceLogs.push(message),
					)
					const initialization = await durationMs(() => service.initShadowGit())
					const breakdown = serviceLogs.find((message) => message.includes("initialized shadow repo"))
					if (!breakdown) throw new Error("Checkpoint initialization did not report its phase timings")
					initializationMs.push(initialization.duration)
					breakdowns.push(breakdown)
				}

				console.info(
					"CHECKPOINT_LIVE_WORKSPACE_RESULT",
					JSON.stringify({
						samples: sampleCount,
						initializationMs: initializationMs.map((value) => Number(value.toFixed(2))),
						medianInitializationMs: Number(median(initializationMs).toFixed(2)),
						breakdowns,
						shadowDirectory: "temporary",
					}),
				)
			} finally {
				await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
				await expect(fs.access(root)).rejects.toThrow()
			}
		},
		180_000,
	)

	it("measures cold initialization, nested repository scanning, and historical diffs", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-checkpoint-perf-"))
		assertOwnedTemporaryRoot(root)

		try {
			const { workspaceDir, sourceContent, dataContent } = await createWorkspaceFixture(root)
			const initializationMs: number[] = []
			const initializationBreakdowns: string[] = []
			const nestedScanMs: number[] = []
			const historicalDiffMs: number[] = []
			const originalExecuteRipgrep = fileSearch.executeRipgrep

			for (let sample = 0; sample < sampleCount; sample++) {
				const shadowDir = path.join(root, `shadow-${sample}`)
				let scanDuration = 0
				const searchSpy = vi.spyOn(fileSearch, "executeRipgrep").mockImplementation(async (options) => {
					const scan = await durationMs(() => originalExecuteRipgrep(options))
					scanDuration += scan.duration
					return scan.result
				})

				try {
					const serviceLogs: string[] = []
					const service = new RepoPerTaskCheckpointService(
						`benchmark-${sample}`,
						shadowDir,
						workspaceDir,
						(message) => serviceLogs.push(message),
					)
					const initialization = await durationMs(() => service.initShadowGit())
					initializationMs.push(initialization.duration)
					const initializationBreakdown = serviceLogs.find((message) =>
						message.includes("initialized shadow repo"),
					)
					if (!initializationBreakdown)
						throw new Error("Checkpoint initialization did not report its phase timings")
					initializationBreakdowns.push(initializationBreakdown)
					nestedScanMs.push(scanDuration)

					const changedSourceContent = Buffer.alloc(sourceFileSize, 0x63)
					const changedFiles: string[] = []
					const changes: Array<() => Promise<void>> = []
					const changedSourceFile = path.join(workspaceDir, "src", "module-000.ts")
					changedFiles.push(changedSourceFile)
					changes.push(() => fs.writeFile(changedSourceFile, changedSourceContent))
					for (let index = 0; index < dataFileCount; index++) {
						const file = path.join(workspaceDir, "data", `record-${index.toString().padStart(2, "0")}.txt`)
						changedFiles.push(file)
					}
					await writeInBatches(changes)

					const checkpoint = await service.saveCheckpoint(`Benchmark historical checkpoint ${sample}`)
					expect(checkpoint?.commit).toBeTruthy()

					const currentDataContent = Buffer.alloc(dataFileSize, 0x66)
					await writeInBatches(
						Array.from(
							{ length: dataFileCount },
							(_, index) => () =>
								fs.writeFile(
									path.join(workspaceDir, "data", `record-${index.toString().padStart(2, "0")}.txt`),
									currentDataContent,
								),
						),
					)

					const historicalDiff = await durationMs(() =>
						service.getDiff({ from: service.baseHash, to: checkpoint!.commit }),
					)
					historicalDiffMs.push(historicalDiff.duration)
					expect(historicalDiff.result.length).toBe(1)

					await writeInBatches(
						changedFiles.map(
							(file, index) => () => fs.writeFile(file, index === 0 ? sourceContent : dataContent),
						),
					)
				} finally {
					searchSpy.mockRestore()
				}
			}

			console.info(
				"CHECKPOINT_PERFORMANCE_RESULT",
				JSON.stringify({
					service: "ShadowCheckpointService",
					fixture: {
						sourceFiles: sourceFileCount,
						nodeModuleFiles: nodeModuleFileCount,
						unignoredDataMiB: dataFileCount,
					},
					samples: sampleCount,
					initializationMs: initializationMs.map((value) => Number(value.toFixed(2))),
					initializationBreakdowns,
					nestedScanMs: nestedScanMs.map((value) => Number(value.toFixed(2))),
					historicalDiffMs: historicalDiffMs.map((value) => Number(value.toFixed(2))),
					medianMs: {
						initialization: Number(median(initializationMs).toFixed(2)),
						nestedScan: Number(median(nestedScanMs).toFixed(2)),
						historicalDiff: Number(median(historicalDiffMs).toFixed(2)),
					},
				}),
			)
		} finally {
			await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
			await expect(fs.access(root)).rejects.toThrow()
		}
	}, 180_000)
})
