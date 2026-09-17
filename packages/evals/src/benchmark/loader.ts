import fs from "node:fs/promises"
import path from "node:path"

import { parse } from "yaml"

import { canonicalJson, sha256 } from "../evidence/index"
import { isSupportedGraderAlias } from "../grading/index"
import {
	benchmarkReleaseLockSchema,
	benchmarkSuiteManifestSchema,
	graderBundleManifestSchema,
	publicPrivateBundleRegistrySchema,
	type BenchmarkCatalog,
	type BenchmarkReleaseLock,
	type BenchmarkTaskManifest,
	type GraderBundleManifest,
} from "./contracts"

export async function loadBenchmarkCatalog(root: string): Promise<BenchmarkCatalog> {
	const index = parse(await fs.readFile(path.join(root, "benchmark-suites.yaml"), "utf8"), { merge: true }) as {
		suites?: string[]
	}
	if (!Array.isArray(index.suites) || index.suites.length === 0)
		throw new Error("benchmark-suites.yaml must list at least one suite")
	const suites = await Promise.all(
		index.suites.map(async (relative) =>
			benchmarkSuiteManifestSchema.parse(
				parse(await fs.readFile(resolveInside(root, relative), "utf8"), { merge: true }),
			),
		),
	)
	const bundleRegistry = await loadPublicPrivateBundleRegistry(root)
	const tasks = new Map<string, { suite: (typeof suites)[number]; task: BenchmarkTaskManifest }>()
	for (const suite of suites) {
		if (suite.status === "released") await validateReleasedSuiteLock(root, suite)
		for (const task of suite.tasks) {
			const identity = `${task.id}@${task.version}`
			if (tasks.has(identity)) throw new Error(`Duplicate benchmark task identity: ${identity}`)
			await validateTaskFiles(root, task, bundleRegistry)
			tasks.set(identity, { suite, task })
		}
	}
	return { suites, tasks }
}

export async function findBenchmarkTask(root: string, fixture: string) {
	const catalog = await loadBenchmarkCatalog(root)
	const normalized = normalize(fixture)
	const requestedId = normalized.split("/").at(-1)
	const matches = [...catalog.tasks.values()].filter(
		({ task }) =>
			normalize(task.fixture) === normalized || (task.partition === "holdout" && task.id === requestedId),
	)
	if (matches.length !== 1)
		throw new Error(`Expected exactly one benchmark manifest for fixture ${fixture}; found ${matches.length}`)
	return matches[0]!
}

export async function loadPrivateGraderBundle(
	task: BenchmarkTaskManifest,
	privateRoot = process.env.EVALS_PRIVATE_BENCHMARK_ROOT,
): Promise<{ root: string; manifest: GraderBundleManifest } | undefined> {
	const bundleIds = [...new Set(task.graders.flatMap(({ bundleId }) => (bundleId ? [bundleId] : [])))]
	const bundleVersions = [
		...new Set(task.graders.flatMap(({ bundleVersion }) => (bundleVersion ? [bundleVersion] : []))),
	]
	if (bundleIds.length === 0) return undefined
	if (!privateRoot) throw new Error(`EVALS_PRIVATE_BENCHMARK_ROOT is required for task ${task.id}`)
	const publicRoot = path.resolve(process.env.ALPHA_EVALS_REPO_PATH ?? path.resolve(process.cwd(), "../../evals"))
	const privateBase = path.resolve(privateRoot)
	if (privateBase === publicRoot || privateBase.startsWith(`${publicRoot}${path.sep}`))
		throw new Error("Private benchmark root must be disjoint from the public benchmark root")
	if (bundleIds.length !== 1) throw new Error(`Task ${task.id} references multiple private bundles`)
	const root = resolveInside(privateRoot, bundleIds[0]!)
	const manifest = graderBundleManifestSchema.parse(
		JSON.parse(await fs.readFile(path.join(root, "bundle.json"), "utf8")),
	)
	if (manifest.id !== bundleIds[0]) throw new Error(`Private bundle identity mismatch for ${task.id}`)
	if (bundleVersions.length !== 1 || manifest.version !== bundleVersions[0]) {
		throw new Error(
			`Private bundle version mismatch for ${task.id}: expected ${bundleVersions.join(",") || "missing"}, got ${manifest.version}`,
		)
	}
	const required = task.graders
		.filter(({ bundleId }) => bundleId)
		.map(({ id, version }) => ({ id: `${task.id}.${id}`, version }))
	const available = new Map(manifest.graders.map((grader) => [grader.id, grader.version]))
	for (const grader of required) {
		if (!available.has(grader.id)) throw new Error(`Private bundle ${manifest.id} is missing ${grader.id}`)
		if (available.get(grader.id) !== grader.version) {
			throw new Error(
				`Private grader version mismatch for ${grader.id}: expected ${grader.version}, got ${available.get(grader.id)}`,
			)
		}
	}
	for (const grader of manifest.graders) {
		const entrypoint = resolveInside(root, grader.entrypoint)
		await fs.access(entrypoint)
		const real = await fs.realpath(entrypoint)
		const realRoot = await fs.realpath(root)
		if (!real.startsWith(`${realRoot}${path.sep}`))
			throw new Error(`Private grader symlink escapes bundle: ${grader.entrypoint}`)
	}
	if (manifest.schemaVersion === 1) {
		const actualDigest = await digestDirectory(root, new Set(["bundle.json"]))
		if (actualDigest !== manifest.digest) {
			throw new Error(`Private bundle digest mismatch: expected ${manifest.digest}, got ${actualDigest}`)
		}
	} else {
		const digestRows: string[] = []
		for (const grader of manifest.graders) {
			const actual = sha256(await fs.readFile(resolveInside(root, grader.entrypoint)))
			if (actual !== grader.digest) {
				throw new Error(
					`Private grader digest mismatch for ${grader.id}: expected ${grader.digest}, got ${actual}`,
				)
			}
			digestRows.push(`${grader.entrypoint}\0${grader.digest}`)
		}
		const actualContentDigest = sha256(digestRows.sort().join("\0"))
		if (actualContentDigest !== manifest.contentDigest) {
			throw new Error(
				`Private bundle digest mismatch: expected ${manifest.contentDigest}, got ${actualContentDigest}`,
			)
		}
	}
	return { root, manifest }
}

async function validateTaskFiles(
	root: string,
	task: BenchmarkTaskManifest,
	bundleRegistry: Map<string, { version: number; contentDigest: string }>,
): Promise<void> {
	for (const grader of task.graders) {
		if (!isSupportedGraderAlias(grader.alias))
			throw new Error(`Unknown grader alias for ${task.id}: ${grader.alias}`)
		if (grader.bundleId) {
			const registered = bundleRegistry.get(grader.bundleId)
			if (!registered) throw new Error(`Private bundle registry is missing ${grader.bundleId}`)
			if (registered.version !== grader.bundleVersion || registered.contentDigest !== grader.bundleDigest) {
				throw new Error(`Private bundle reference mismatch for ${task.id}.${grader.id}`)
			}
		}
	}
	const graderDigest = sha256(canonicalJson(task.graders))
	if (task.graderReferenceDigest !== graderDigest) throw new Error(`Grader reference digest mismatch for ${task.id}`)
	const environmentDigest = sha256(canonicalJson(task.validation))
	if (task.environmentDigest !== environmentDigest) throw new Error(`Environment digest mismatch for ${task.id}`)
	if (task.partition === "holdout") {
		if (!task.graders.some(({ bundleId }) => bundleId))
			throw new Error(`Holdout task ${task.id} requires a private grader bundle`)
		return
	}
	const fixture = resolveInside(root, task.fixture)
	const prompt = resolveInside(fixture, task.prompt)
	await Promise.all([fs.access(fixture), fs.access(prompt)])
	const [realRoot, realFixture, realPrompt] = await Promise.all([
		fs.realpath(root),
		fs.realpath(fixture),
		fs.realpath(prompt),
	])
	if (!realFixture.startsWith(`${realRoot}${path.sep}`) || !realPrompt.startsWith(`${realFixture}${path.sep}`)) {
		throw new Error(`Task ${task.id} contains a symlink escaping the public benchmark root`)
	}
	if (task.promptDigest) {
		const actual = sha256(await fs.readFile(prompt))
		if (actual !== task.promptDigest) throw new Error(`Prompt digest mismatch for ${task.id}`)
	}
	if (task.fixtureDigest) {
		const actual = await digestDirectory(fixture, new Set(["node_modules", ".git"]))
		if (actual !== task.fixtureDigest) throw new Error(`Fixture digest mismatch for ${task.id}`)
		if (task.repository.snapshotDigest !== actual)
			throw new Error(`Repository snapshot digest mismatch for ${task.id}`)
	}
}

async function loadPublicPrivateBundleRegistry(
	root: string,
): Promise<Map<string, { version: number; contentDigest: string }>> {
	const file = path.join(root, "private-bundles.yaml")
	let source: string
	try {
		source = await fs.readFile(file, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map()
		throw error
	}
	const registry = publicPrivateBundleRegistrySchema.parse(parse(source, { merge: true }))
	const output = new Map<string, { version: number; contentDigest: string }>()
	for (const bundle of registry.bundles) {
		if (output.has(bundle.id)) throw new Error(`Duplicate private bundle registry identity: ${bundle.id}`)
		output.set(bundle.id, bundle)
	}
	return output
}

async function validateReleasedSuiteLock(root: string, suite: BenchmarkCatalog["suites"][number]): Promise<void> {
	const file = path.join(root, "releases", `${suite.id}@${suite.version}.lock.json`)
	let lock: BenchmarkReleaseLock
	try {
		lock = benchmarkReleaseLockSchema.parse(JSON.parse(await fs.readFile(file, "utf8")))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			throw new Error(`Released suite lock is missing for ${suite.id}@${suite.version}`)
		throw error
	}
	if (lock.suiteIdentity !== `${suite.id}@${suite.version}`)
		throw new Error(`Released suite lock identity mismatch for ${suite.id}`)
	if (lock.manifestDigest !== sha256(canonicalJson(suite)))
		throw new Error(`Released suite ${suite.id}@${suite.version} was modified in place`)
	if (lock.taskSetDigest !== benchmarkTaskSetDigest(suite.tasks))
		throw new Error(`Released task set ${suite.id}@${suite.version} was modified in place`)
}

export async function writeBenchmarkReleaseLock(
	root: string,
	suite: BenchmarkCatalog["suites"][number],
	createdAt = new Date().toISOString(),
): Promise<string> {
	const directory = path.join(root, "releases")
	const file = path.join(directory, `${suite.id}@${suite.version}.lock.json`)
	const lock: BenchmarkReleaseLock = {
		schemaVersion: 1,
		suiteIdentity: `${suite.id}@${suite.version}`,
		manifestDigest: sha256(canonicalJson(suite)),
		taskSetDigest: benchmarkTaskSetDigest(suite.tasks),
		createdAt,
	}
	await fs.mkdir(directory, { recursive: true })
	await fs.writeFile(file, JSON.stringify(lock, null, 2) + "\n")
	return file
}

function resolveInside(root: string, relative: string): string {
	const base = path.resolve(root)
	const resolved = path.resolve(base, relative)
	if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`))
		throw new Error(`Path escapes benchmark root: ${relative}`)
	return resolved
}

function normalize(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "")
}

async function digestDirectory(root: string, excluded: Set<string>): Promise<string> {
	const files: string[] = []
	async function visit(directory: string) {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			const full = path.join(directory, entry.name)
			if (entry.isDirectory()) {
				if (!excluded.has(entry.name)) await visit(full)
			} else if (!excluded.has(normalize(path.relative(root, full)))) files.push(full)
		}
	}
	await visit(root)
	const rows: Array<[string, string]> = []
	for (const file of files.sort()) rows.push([normalize(path.relative(root, file)), sha256(await fs.readFile(file))])
	return sha256(JSON.stringify(rows))
}

export function benchmarkTaskSetDigest(tasks: BenchmarkTaskManifest[]): string {
	return sha256(
		canonicalJson(
			tasks
				.map(({ id, version, fixtureDigest, promptDigest, graders }) => ({
					id,
					version,
					fixtureDigest,
					promptDigest,
					graders,
				}))
				.sort((a, b) => a.id.localeCompare(b.id)),
		),
	)
}

export function scoredBenchmarkTasks(catalog: BenchmarkCatalog): BenchmarkTaskManifest[] {
	return [...catalog.tasks.values()]
		.map(({ task }) => task)
		.filter(({ partition, admission }) => partition !== "smoke" && admission === "admitted")
}

export function runnableBenchmarkFixtures(catalog: BenchmarkCatalog): string[] {
	return [...catalog.tasks.values()]
		.map(({ task }) => task)
		.filter(({ partition, admission }) => partition === "smoke" || admission === "admitted")
		.filter(({ partition }) => partition !== "holdout")
		.map(({ fixture }) => normalize(fixture))
		.sort()
}

export async function digestBenchmarkDirectory(root: string): Promise<string> {
	return digestDirectory(path.resolve(root), new Set(["node_modules", ".git"]))
}
