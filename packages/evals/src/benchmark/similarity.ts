import fs from "node:fs/promises"
import path from "node:path"

import type { BenchmarkCatalog, PrivateAuthoringFingerprints } from "./contracts"

export type SimilarityPair = {
	left: string
	right: string
	prompt: number
	source: number
	tests: number
	capabilities: number
	duplicate: boolean
	reasons: string[]
}

type Fingerprint = {
	id: string
	prompt: Set<string>
	source: Set<string>
	tests: Set<string>
	capabilities: Set<string>
}

export async function analyzeBenchmarkSimilarity(
	catalog: BenchmarkCatalog,
	root: string,
	privateFingerprints?: PrivateAuthoringFingerprints,
): Promise<{ pairs: SimilarityPair[]; duplicatePairs: SimilarityPair[]; privateDuplicatePairs: string[][] }> {
	const tasks = [...catalog.tasks.values()]
		.map(({ task }) => task)
		.filter(({ partition }) => partition === "development" || partition === "regression")
	const fingerprints = await Promise.all(tasks.map((task) => fingerprintTask(root, task)))
	const pairs: SimilarityPair[] = []
	for (let left = 0; left < fingerprints.length; left++) {
		for (let right = left + 1; right < fingerprints.length; right++) {
			const a = fingerprints[left]!
			const b = fingerprints[right]!
			const prompt = jaccard(a.prompt, b.prompt)
			const source = jaccard(a.source, b.source)
			const tests = jaccard(a.tests, b.tests)
			const capabilities = jaccard(a.capabilities, b.capabilities)
			const reasons: string[] = []
			if (prompt >= 0.88) reasons.push("prompt-near-duplicate")
			if (source >= 0.92) reasons.push("source-structure-near-duplicate")
			if (tests >= 0.92) reasons.push("test-structure-near-duplicate")
			if (capabilities === 1) reasons.push("identical-capabilities")
			const duplicate = (prompt >= 0.88 && source >= 0.85) || (source >= 0.92 && tests >= 0.92)
			pairs.push({ left: a.id, right: b.id, prompt, source, tests, capabilities, duplicate, reasons })
		}
	}
	const privateDuplicatePairs = duplicatePrivateFingerprints(privateFingerprints)
	return { pairs, duplicatePairs: pairs.filter(({ duplicate }) => duplicate), privateDuplicatePairs }
}

async function fingerprintTask(
	root: string,
	task: BenchmarkCatalog["suites"][number]["tasks"][number],
): Promise<Fingerprint> {
	const fixture = path.resolve(root, task.fixture)
	const prompt = await fs.readFile(path.join(fixture, task.prompt), "utf8")
	const files = await listFiles(fixture)
	const source = await readGroup(
		fixture,
		files.filter((file) => /(^|\/)src\//.test(file)),
	)
	const tests = await readGroup(
		fixture,
		files.filter((file) => /(^|\/)(test|tests|__tests__)\//.test(file)),
	)
	return {
		id: `${task.id}@${task.version}`,
		prompt: shingles(normalize(prompt, task.id), 3),
		source: shingles(normalize(source, task.id), 4),
		tests: shingles(normalize(tests, task.id), 4),
		capabilities: new Set(task.capabilities),
	}
}

async function listFiles(root: string): Promise<string[]> {
	const output: string[] = []
	async function visit(directory: string): Promise<void> {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			if ([".git", "node_modules", "dist", "build"].includes(entry.name)) continue
			const full = path.join(directory, entry.name)
			if (entry.isDirectory()) await visit(full)
			else output.push(path.relative(root, full).replaceAll("\\", "/"))
		}
	}
	await visit(root)
	return output.sort()
}

async function readGroup(root: string, files: string[]): Promise<string> {
	return (
		await Promise.all(files.map(async (file) => `${file}\n${await fs.readFile(path.join(root, file), "utf8")}`))
	).join("\n")
}

function normalize(value: string, taskId: string): string {
	return value
		.toLowerCase()
		.replaceAll(taskId.toLowerCase(), " task-id ")
		.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, " string ")
		.replace(/\b\d+(?:\.\d+)?\b/g, " number ")
		.replace(/[^a-z0-9_/-]+/g, " ")
		.trim()
}

function shingles(value: string, width: number): Set<string> {
	const words = value.split(/\s+/).filter(Boolean)
	if (words.length < width) return new Set(words)
	return new Set(
		Array.from({ length: words.length - width + 1 }, (_, index) => words.slice(index, index + width).join(" ")),
	)
}

function jaccard(left: Set<string>, right: Set<string>): number {
	if (!left.size && !right.size) return 1
	let intersection = 0
	for (const value of left) if (right.has(value)) intersection++
	return intersection / (left.size + right.size - intersection)
}

function duplicatePrivateFingerprints(input?: PrivateAuthoringFingerprints): string[][] {
	if (!input) return []
	const output: string[][] = []
	for (const key of ["goldDiffDigest", "graderStructureDigest"] as const) {
		const byDigest = new Map<string, string[]>()
		for (const task of input.tasks) byDigest.set(task[key], [...(byDigest.get(task[key]) ?? []), task.taskIdentity])
		for (const identities of byDigest.values()) if (identities.length > 1) output.push(identities.sort())
	}
	return output
}
