import crypto from "node:crypto"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

const publicRoot = path.resolve(import.meta.dirname, "..", "evals")
const require = createRequire(path.resolve(import.meta.dirname, "..", "packages", "evals", "package.json"))
const { parse, stringify } = require("yaml")
const privateRoot = process.env.EVALS_PRIVATE_BENCHMARK_ROOT
const bundleDigest = "sha256:0f94925970b79f1d3e0dcb65a8b15832711c014cd0e443c2c2ce36b40bd7072e"
const evidenceRequirements = [
	"final_workspace",
	"changed_paths",
	"normalized_trace",
	"usage",
	"environment",
	"final_response",
	"grader_evidence",
]

for (const suiteFile of ["smoke-v1.yaml", "frontier-v1.yaml"]) {
	const file = path.join(publicRoot, suiteFile)
	const suite = parse(await fs.readFile(file, "utf8"))
	for (const task of suite.tasks) {
		const contextBand =
			task.partition === "smoke"
				? "compact"
				: task.difficulty === "foundation"
					? "compact"
					: task.difficulty === "challenging"
						? "medium"
						: "long"
		const topology =
			contextBand === "compact"
				? { kind: "single-file", minFiles: 1, maxFiles: 2 }
				: contextBand === "medium"
					? { kind: "multi-file", minFiles: 2, maxFiles: 5 }
					: { kind: "cross-package", minFiles: 3, maxFiles: 10 }
		const validation = {
			commands: [{ command: "node", args: ["--test", "test/workflow.test.js"] }],
			network: "disabled",
		}
		task.contextBand ??= contextBand
		task.editTopology ??= { ...topology, allowedRoots: ["src", "test"] }
		task.validation ??= validation
		task.evidenceRequirements ??= evidenceRequirements
		for (const grader of task.graders)
			if (grader.bundleId && !grader.bundleDigest) grader.bundleDigest = bundleDigest
		task.graderReferenceDigest = sha256(canonicalJson(task.graders))
		task.environmentDigest = sha256(canonicalJson(task.validation))

		const fixture =
			task.partition === "holdout"
				? privateRoot && path.join(privateRoot, task.fixture)
				: path.join(publicRoot, task.fixture)
		if (!fixture) throw new Error(`EVALS_PRIVATE_BENCHMARK_ROOT is required to digest ${task.id}`)
		task.fixtureDigest = await digestDirectory(fixture)
		task.promptDigest = sha256(await fs.readFile(path.join(fixture, task.prompt)))
		task.repository.snapshotDigest = task.fixtureDigest
	}
	await fs.writeFile(file, stringify(suite, { lineWidth: 120 }))
	if (suite.status === "released") await writeReleaseLock(suite)
}

async function writeReleaseLock(suite) {
	const directory = path.join(publicRoot, "releases")
	await fs.mkdir(directory, { recursive: true })
	const taskSetDigest = sha256(
		canonicalJson(
			suite.tasks
				.map(({ id, version, fixtureDigest, promptDigest, graders }) => ({
					id,
					version,
					fixtureDigest,
					promptDigest,
					graders,
				}))
				.sort((left, right) => left.id.localeCompare(right.id)),
		),
	)
	const lock = {
		schemaVersion: 1,
		suiteIdentity: `${suite.id}@${suite.version}`,
		manifestDigest: sha256(canonicalJson(suite)),
		taskSetDigest,
		createdAt: "2026-07-13T00:00:00.000Z",
	}
	await fs.writeFile(
		path.join(directory, `${suite.id}@${suite.version}.lock.json`),
		JSON.stringify(lock, null, 2) + "\n",
	)
}

async function digestDirectory(root) {
	const files = []
	async function visit(directory) {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			if (["node_modules", ".git"].includes(entry.name)) continue
			const full = path.join(directory, entry.name)
			if (entry.isDirectory()) await visit(full)
			else files.push(full)
		}
	}
	await visit(root)
	const rows = []
	for (const file of files.sort())
		rows.push([path.relative(root, file).replaceAll("\\", "/"), sha256(await fs.readFile(file))])
	return sha256(JSON.stringify(rows))
}

function canonicalJson(value) {
	return JSON.stringify(sortValue(value))
}

function sortValue(value) {
	if (Array.isArray(value)) return value.map(sortValue)
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, sortValue(child)]),
		)
	return value
}

function sha256(value) {
	return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`
}
