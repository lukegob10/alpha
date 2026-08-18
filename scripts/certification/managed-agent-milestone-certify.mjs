#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..", "..")
const matrixPath = path.join(path.dirname(scriptPath), "managed-agent-milestone.matrix.json")
const argumentsSet = new Set(process.argv.slice(2))
const strict = argumentsSet.has("--strict")
const listOnly = argumentsSet.has("--list")
const help = argumentsSet.has("--help") || argumentsSet.has("-h")
const supportedArguments = new Set(["--strict", "--list", "--help", "-h"])

for (const argument of argumentsSet) {
	if (!supportedArguments.has(argument)) fail(`Unknown argument: ${argument}`)
}

if (help) {
	console.log(`Usage: node scripts/certification/managed-agent-milestone-certify.mjs [--strict] [--list]

  --strict  Fail when deterministic merge-dependent evidence is still missing.
  --list    Print resolved commands and pending integration rows without running tests.`)
	process.exit(0)
}

const matrix = loadMatrix()
const tracks = prepareTracks(matrix.tracks)

printCommands(matrix.prerequisites, tracks, matrix.integrationPending)

if (listOnly) {
	printReadinessPreview(matrix.rows, tracks)
	process.exit(0)
}

const prerequisiteResults = runPrerequisites(matrix.prerequisites)
const trackResults = prerequisiteResults.some(({ status }) => status === "FAIL")
	? failedTrackResults(tracks, "prerequisite failed")
	: runTracks(tracks)
const rowResults = matrix.rows.map((row) => evaluateRow(row, tracks, trackResults, strict))
const integrationResults = matrix.integrationPending.map((row) => ({
	...row,
	status: "PENDING-INTEGRATION",
	detail: row.reason,
}))

printMatrix(rowResults, integrationResults)

const failedTracks = [...trackResults.values()].filter((result) => result.status === "FAIL")
const failedRows = rowResults.filter((result) => result.status === "FAIL")
process.exitCode = failedTracks.length > 0 || failedRows.length > 0 ? 1 : 0

function loadMatrix() {
	let parsed
	try {
		parsed = JSON.parse(readFileSync(matrixPath, "utf8"))
	} catch (error) {
		fail(`Cannot load ${relative(matrixPath)}: ${error instanceof Error ? error.message : String(error)}`)
	}

	if (parsed.schemaVersion !== 1) fail("Certification matrix schemaVersion must be 1")
	if (!Array.isArray(parsed.tracks) || parsed.tracks.length === 0) fail("Certification matrix requires tracks")
	if (!Array.isArray(parsed.prerequisites)) fail("Certification matrix requires prerequisites")
	if (!Array.isArray(parsed.rows) || parsed.rows.length === 0) fail("Certification matrix requires rows")
	if (!Array.isArray(parsed.integrationPending)) fail("Certification matrix requires integrationPending")

	assertUniqueIds(parsed.tracks, "track")
	assertUniqueIds(parsed.prerequisites, "prerequisite")
	assertUniqueIds([...parsed.rows, ...parsed.integrationPending], "matrix row")
	const trackIds = new Set(parsed.tracks.map((track) => track.id))
	for (const prerequisite of parsed.prerequisites) {
		if (!prerequisite.label || !Array.isArray(prerequisite.args) || prerequisite.args.length === 0) {
			fail(`${prerequisite.id} has an invalid prerequisite definition`)
		}
	}
	for (const row of parsed.rows) {
		if (!Array.isArray(row.trackIds) || row.trackIds.length === 0) fail(`${row.id} requires trackIds`)
		for (const trackId of row.trackIds) {
			if (!trackIds.has(trackId)) fail(`${row.id} references unknown track ${trackId}`)
		}
		if (!new Set(["baseline", "merge-dependent", "known-debt"]).has(row.classification)) {
			fail(`${row.id} has unsupported classification ${row.classification}`)
		}
		validatePatternEntries(row.id, row.probes)
		validatePatternEntries(row.id, row.testBlockers)
		validateSourceEntries(row.id, row.sourceProbes)
		validateSourceEntries(row.id, row.sourceBlockers)
	}

	return parsed
}

function assertUniqueIds(items, label) {
	const seen = new Set()
	for (const item of items) {
		if (typeof item.id !== "string" || item.id.length === 0) fail(`Every ${label} requires an id`)
		if (seen.has(item.id)) fail(`Duplicate ${label} id: ${item.id}`)
		seen.add(item.id)
	}
}

function validatePatternEntries(rowId, entries = []) {
	if (!Array.isArray(entries)) fail(`${rowId} pattern entries must be an array`)
	for (const entry of entries) {
		if (!entry.label || !Array.isArray(entry.patterns) || entry.patterns.length === 0) {
			fail(`${rowId} has an invalid pattern entry`)
		}
		if (entry.match !== undefined && entry.match !== "all" && entry.match !== "any") {
			fail(`${rowId} pattern entry ${entry.label} has unsupported match mode ${entry.match}`)
		}
		for (const pattern of entry.patterns) compilePattern(rowId, pattern)
	}
}

function validateSourceEntries(rowId, entries = []) {
	validatePatternEntries(rowId, entries)
	for (const entry of entries) {
		resolveRepositoryPath(entry.path)
	}
}

function prepareTracks(configuredTracks) {
	return configuredTracks.map((track) => {
		if (!track.label || !track.packageDir || !Array.isArray(track.include) || track.include.length === 0) {
			fail(`${track.id} has an invalid track definition`)
		}

		const packagePath = resolveRepositoryPath(track.packageDir)
		if (!existsSync(packagePath)) fail(`${track.id} package directory does not exist: ${track.packageDir}`)
		const includePatterns = track.include.map((pattern) => compilePattern(track.id, pattern))
		const files = walkFiles(packagePath)
			.map((file) => normalizePath(path.relative(packagePath, file)))
			.filter((file) => includePatterns.some((pattern) => pattern.test(file)))
			.sort((left, right) => left.localeCompare(right))

		if (files.length === 0) fail(`${track.id} did not discover any test files`)
		const contents = files.map((file) => ({
			file: normalizePath(path.join(track.packageDir, file)),
			text: readFileSync(path.join(packagePath, file), "utf8"),
		}))

		return { ...track, packagePath, files, contents }
	})
}

function walkFiles(directory) {
	const files = []
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (
			entry.isDirectory() &&
			new Set([".git", ".turbo", "coverage", "dist", "node_modules", "out"]).has(entry.name)
		) {
			continue
		}
		const candidate = path.join(directory, entry.name)
		if (entry.isDirectory()) files.push(...walkFiles(candidate))
		else if (entry.isFile()) files.push(candidate)
	}
	return files
}

function printCommands(prerequisites, resolvedTracks, integrationPending) {
	console.log("=== ALPHA MANAGED-AGENT CERTIFICATION COMMANDS BEGIN ===")
	for (const prerequisite of prerequisites) {
		console.log(`${prerequisite.id} :: pnpm ${prerequisite.args.map(quote).join(" ")}`)
	}
	for (const track of resolvedTracks) {
		console.log(
			`${track.id} :: pnpm --dir ${quote(track.packageDir)} exec vitest run ${track.files.map(quote).join(" ")}`,
		)
	}
	console.log("snapshot :: node scripts/certification/managed-agent-milestone-certify.mjs")
	console.log("final-merged :: node scripts/certification/managed-agent-milestone-certify.mjs --strict")
	console.log(
		"format-check :: pnpm exec prettier --check scripts/certification docs/certification src/core/agent/__tests__/certification",
	)
	console.log("syntax-check :: node --check scripts/certification/managed-agent-milestone-certify.mjs")
	console.log("=== ALPHA MANAGED-AGENT CERTIFICATION COMMANDS END ===")

	console.log("=== EXPECTED INTEGRATION PENDING BEGIN ===")
	for (const row of integrationPending) {
		console.log(`${row.id} :: ${row.prerequisiteCommand} :: ${row.reason}`)
	}
	console.log("=== EXPECTED INTEGRATION PENDING END ===")
}

function printReadinessPreview(rows, resolvedTracks) {
	console.log("=== DETERMINISTIC READINESS PREVIEW BEGIN ===")
	for (const row of rows) {
		const evidence = collectEvidence(row, resolvedTracks)
		const missing = [...evidence.missingTestProbes, ...evidence.missingSourceProbes]
		const blockers = [...evidence.testBlockers, ...evidence.sourceBlockers]
		const state = blockers.length > 0 ? "BLOCKED" : missing.length > 0 ? "PENDING" : "READY"
		console.log(`${state} ${row.id} :: ${[...missing, ...blockers].join("; ") || "evidence discovered"}`)
	}
	console.log("=== DETERMINISTIC READINESS PREVIEW END ===")
}

function runTracks(resolvedTracks) {
	const pnpm = resolvePnpmExecutable()
	const childEnvironment = deterministicEnvironment()
	const results = new Map()

	for (const track of resolvedTracks) {
		console.log(`\n==> ${track.label} [${track.id}]`)
		const result = spawnSync(pnpm, ["--dir", track.packageDir, "exec", "vitest", "run", ...track.files], {
			cwd: repositoryRoot,
			env: childEnvironment,
			stdio: "inherit",
			shell: false,
		})
		if (result.error) {
			console.error(`${track.id}: ${result.error.message}`)
			results.set(track.id, { status: "FAIL", exitCode: null })
			continue
		}
		const status = result.status === 0 ? "PASS" : "FAIL"
		console.log(`${status} ${track.id} (exit ${result.status ?? "unknown"})`)
		results.set(track.id, { status, exitCode: result.status })
	}

	return results
}

function runPrerequisites(prerequisites) {
	const pnpm = resolvePnpmExecutable()
	const childEnvironment = deterministicEnvironment()
	return prerequisites.map((prerequisite) => {
		console.log(`\n==> ${prerequisite.label} [${prerequisite.id}]`)
		const result = spawnSync(pnpm, prerequisite.args, {
			cwd: repositoryRoot,
			env: childEnvironment,
			stdio: "inherit",
			shell: false,
		})
		if (result.error) {
			console.error(`${prerequisite.id}: ${result.error.message}`)
			return { id: prerequisite.id, status: "FAIL", exitCode: null }
		}
		const status = result.status === 0 ? "PASS" : "FAIL"
		console.log(`${status} ${prerequisite.id} (exit ${result.status ?? "unknown"})`)
		return { id: prerequisite.id, status, exitCode: result.status }
	})
}

function failedTrackResults(resolvedTracks, detail) {
	return new Map(resolvedTracks.map((track) => [track.id, { status: "FAIL", exitCode: null, detail }]))
}

function deterministicEnvironment() {
	const environment = { ...process.env, CI: "true", ALPHA_MANAGED_AGENT_CERTIFICATION: "1" }
	for (const name of [
		"ANTHROPIC_API_KEY",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"DEEPSEEK_API_KEY",
		"GOOGLE_API_KEY",
		"MISTRAL_API_KEY",
		"OPENAI_API_KEY",
		"OPENROUTER_API_KEY",
		"VERCEL_AI_GATEWAY_API_KEY",
	]) {
		delete environment[name]
	}
	return environment
}

function resolvePnpmExecutable() {
	if (process.platform !== "win32") return "pnpm"
	const pnpmHome = process.env.PNPM_HOME
	if (pnpmHome) {
		const versionsRoot = path.join(pnpmHome, ".tools", "pnpm-exe")
		if (existsSync(versionsRoot)) {
			const executable = readdirSync(versionsRoot)
				.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
				.map((version) => path.join(versionsRoot, version, "pnpm.exe"))
				.find(existsSync)
			if (executable) return executable
		}
	}
	return "pnpm.cmd"
}

function evaluateRow(row, resolvedTracks, trackResults, strictMode) {
	const failedTrackIds = row.trackIds.filter((trackId) => trackResults.get(trackId)?.status !== "PASS")
	const evidence = collectEvidence(row, resolvedTracks)
	const missing = [...evidence.missingTestProbes, ...evidence.missingSourceProbes]
	const blockers = [...evidence.testBlockers, ...evidence.sourceBlockers]

	if (failedTrackIds.length > 0) {
		return { ...row, status: "FAIL", detail: `failed tracks: ${failedTrackIds.join(", ")}` }
	}
	if (evidence.sourceBlockers.length > 0) {
		return { ...row, status: "FAIL", detail: evidence.sourceBlockers.join("; ") }
	}
	if (blockers.length > 0) {
		const status = row.classification === "known-debt" ? "PENDING-BASELINE-DEBT" : "FAIL"
		return { ...row, status, detail: blockers.join("; ") }
	}
	if (missing.length > 0) {
		if (row.classification === "merge-dependent" && !strictMode) {
			return { ...row, status: "PENDING-MERGE", detail: missing.join("; ") }
		}
		if (row.classification === "known-debt") {
			return { ...row, status: "PENDING-BASELINE-DEBT", detail: missing.join("; ") }
		}
		return { ...row, status: "FAIL", detail: `missing deterministic evidence: ${missing.join("; ")}` }
	}
	return { ...row, status: "PASS", detail: "all declared evidence passed" }
}

function collectEvidence(row, resolvedTracks) {
	const selectedTracks = resolvedTracks.filter((track) => row.trackIds.includes(track.id))
	const testCorpus = selectedTracks.flatMap((track) => track.contents)
	const missingTestProbes = findMissingEntries(row.id, row.probes ?? [], testCorpus)
	const testBlockers = findMatchingEntries(row.id, row.testBlockers ?? [], testCorpus)
	const missingSourceProbes = []
	const sourceBlockers = []

	for (const entry of row.sourceProbes ?? []) {
		const corpus = [{ file: entry.path, text: readFileSync(resolveRepositoryPath(entry.path), "utf8") }]
		if (!matchesEntry(row.id, entry, corpus)) missingSourceProbes.push(entry.label)
	}
	for (const entry of row.sourceBlockers ?? []) {
		const corpus = [{ file: entry.path, text: readFileSync(resolveRepositoryPath(entry.path), "utf8") }]
		if (matchesEntry(row.id, entry, corpus)) sourceBlockers.push(entry.label)
	}

	return { missingTestProbes, testBlockers, missingSourceProbes, sourceBlockers }
}

function findMissingEntries(rowId, entries, corpus) {
	return entries.filter((entry) => !matchesEntry(rowId, entry, corpus)).map((entry) => entry.label)
}

function findMatchingEntries(rowId, entries, corpus) {
	return entries.filter((entry) => matchesEntry(rowId, entry, corpus)).map((entry) => entry.label)
}

function matchesEntry(rowId, entry, corpus) {
	const results = entry.patterns.map((pattern) => {
		const expression = compilePattern(rowId, pattern)
		return corpus.some(({ text }) => expression.test(text))
	})
	return entry.match === "all" ? results.every(Boolean) : results.some(Boolean)
}

function printMatrix(rowResults, integrationResults) {
	console.log("\n=== CERTIFICATION MATRIX BEGIN ===")
	for (const row of [...rowResults, ...integrationResults]) {
		console.log(`${row.status} ${row.id} :: ${row.requirement} :: ${row.detail}`)
	}
	console.log("=== CERTIFICATION MATRIX END ===")

	const all = [...rowResults, ...integrationResults]
	const counts = all.reduce((result, row) => {
		result[row.status] = (result[row.status] ?? 0) + 1
		return result
	}, {})
	console.log(
		`SUMMARY ${Object.entries(counts)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([status, count]) => `${status}=${count}`)
			.join(" ")}`,
	)
}

function compilePattern(owner, pattern) {
	try {
		return new RegExp(pattern, "ims")
	} catch (error) {
		fail(`${owner} contains invalid pattern ${JSON.stringify(pattern)}: ${String(error)}`)
	}
}

function resolveRepositoryPath(repositoryRelativePath) {
	if (typeof repositoryRelativePath !== "string" || path.isAbsolute(repositoryRelativePath)) {
		fail(`Expected a repository-relative path, received: ${String(repositoryRelativePath)}`)
	}
	const resolved = path.resolve(repositoryRoot, repositoryRelativePath)
	const relativePath = path.relative(repositoryRoot, resolved)
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		fail(`Path escapes the repository: ${repositoryRelativePath}`)
	}
	if (!existsSync(resolved)) fail(`Required certification path is missing: ${repositoryRelativePath}`)
	return resolved
}

function normalizePath(value) {
	return value.split(path.sep).join("/")
}

function relative(value) {
	return normalizePath(path.relative(repositoryRoot, value))
}

function quote(value) {
	return /\s/.test(value) ? JSON.stringify(value) : value
}

function fail(message) {
	console.error(`Certification harness error: ${message}`)
	process.exit(2)
}
