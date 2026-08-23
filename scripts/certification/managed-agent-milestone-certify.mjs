#!/usr/bin/env node

import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..", "..")
const matrixPath = path.join(path.dirname(scriptPath), "managed-agent-milestone.matrix.json")
const livePreflightPath = path.join(path.dirname(scriptPath), "managed-agent-live-playbook-preflight.mjs")
const defaultEvidencePath = "artifacts/certification/managed-agent-milestone-evidence.json"
const options = parseArguments(process.argv.slice(2))
const { strict, listOnly, help, selfCheck } = options

if (help) {
	console.log(`Usage: node scripts/certification/managed-agent-milestone-certify.mjs [--strict] [--list] [--evidence <path>]

  --strict  Fail when deterministic merge-dependent evidence is still missing.
  --list    Print resolved commands and pending integration rows without running tests.
  --self-check
			Verify evidence output-path confinement and strict debt handling without running tests.
  --evidence <path>
            Write deterministic, commit/source-bound JSON evidence inside the repository.
            Default: ${defaultEvidencePath}`)
	process.exit(0)
}

if (selfCheck) {
	runSelfCheck()
	process.exit(0)
}

const evidencePath = resolveRepositoryOutputPath(options.evidencePath)
assertEvidenceOutputIsGenerated(evidencePath)

const matrix = loadMatrix()
const tracks = prepareTracks(matrix.tracks)

printCommands(matrix.prerequisites, tracks, matrix.integrationPending, options.evidencePath)

if (listOnly) {
	printReadinessPreview(matrix.rows, tracks)
	process.exit(0)
}

const certificationStartedAt = Date.now()
const sourceStateAtStart = collectSourceState(evidencePath)
const prerequisiteResults = runPrerequisites(matrix.prerequisites)
const trackResults = prerequisiteResults.some(({ status }) => status === "FAIL")
	? failedTrackResults(tracks, "prerequisite failed")
	: runTracks(tracks, strict)
const rowResults = matrix.rows.map((row) => evaluateRow(row, tracks, trackResults, strict))
const integrationResults = matrix.integrationPending.map((row) => ({
	...row,
	status: "PENDING-INTEGRATION",
	detail: row.reason,
}))

printMatrix(rowResults, integrationResults)

const failedTracks = [...trackResults.values()].filter((result) => result.status === "FAIL")
const failedRows = rowResults.filter((result) => result.status === "FAIL")
const sourceStateAtEnd = collectSourceState(evidencePath)
const sourceStateStable = sourceStateAtStart.sourceStateSha256 === sourceStateAtEnd.sourceStateSha256
if (!sourceStateStable) {
	console.error("FAIL source-state-stability (the working tree changed while certification was running)")
}
const deterministicExitCode = failedTracks.length > 0 || failedRows.length > 0 || !sourceStateStable ? 1 : 0
const evidence = buildEvidence({
	matrix,
	prerequisiteResults,
	trackResults,
	rowResults,
	integrationResults,
	sourceStateAtStart,
	sourceStateAtEnd,
	sourceStateStable,
	startedAt: certificationStartedAt,
	finishedAt: Date.now(),
	deterministicExitCode,
})
writeEvidence(evidencePath, evidence)
console.log(`EVIDENCE ${relative(evidencePath)} :: ${evidence.outcome.status}`)
process.exitCode = deterministicExitCode

function parseArguments(args) {
	const parsed = {
		strict: false,
		listOnly: false,
		help: false,
		selfCheck: false,
		evidencePath: defaultEvidencePath,
		evidencePathSpecified: false,
	}

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index]
		if (argument === "--strict") parsed.strict = true
		else if (argument === "--list") parsed.listOnly = true
		else if (argument === "--self-check") parsed.selfCheck = true
		else if (argument === "--help" || argument === "-h") parsed.help = true
		else if (argument === "--evidence") {
			const value = args[index + 1]
			if (!value || value.startsWith("--")) fail("--evidence requires a repository-relative path")
			parsed.evidencePath = value
			parsed.evidencePathSpecified = true
			index += 1
		} else if (argument.startsWith("--evidence=")) {
			const value = argument.slice("--evidence=".length)
			if (!value) fail("--evidence requires a repository-relative path")
			parsed.evidencePath = value
			parsed.evidencePathSpecified = true
		} else fail(`Unknown argument: ${argument}`)
	}

	if (!parsed.help && parsed.selfCheck && (parsed.strict || parsed.listOnly || parsed.evidencePathSpecified)) {
		fail("--self-check cannot be combined with --strict, --list, or --evidence")
	}
	if (!parsed.help && parsed.listOnly && parsed.strict) fail("--list cannot be combined with --strict")

	return parsed
}

function runSelfCheck() {
	const checkedMatrix = loadMatrix()
	prepareTracks(checkedMatrix.tracks)
	const livePreflightMode = runLivePlaybookPreflightSelfCheck()
	const accepted = ["artifacts/certification/managed-agent-milestone-evidence.json"]
	const rejected = [
		".git/config",
		"package.json",
		"artifacts/certification",
		"artifacts/certification/evidence.txt",
		"artifacts/certification/evidence.JSON",
		"artifacts/certification/local/evidence.json",
		"artifacts/certification/../evidence.json",
	]

	for (const candidate of accepted) {
		assertEvidenceOutputIsGenerated(validateEvidenceOutputPath(candidate))
	}
	for (const candidate of rejected) {
		let rejectedAsExpected = false
		try {
			validateEvidenceOutputPath(candidate)
		} catch {
			rejectedAsExpected = true
		}
		if (!rejectedAsExpected) fail(`Evidence path safety self-check accepted ${candidate}`)
	}

	const syntheticTrack = {
		id: "synthetic-track",
		contents: [{ file: "synthetic.spec.ts", text: "KNOWN_DEBT_BLOCKER" }],
	}
	const passingTrackResults = new Map([[syntheticTrack.id, { status: "PASS" }]])
	const missingKnownDebt = {
		id: "SYNTHETIC-MISSING-DEBT",
		classification: "known-debt",
		trackIds: [syntheticTrack.id],
		probes: [{ label: "required coverage", patterns: ["REQUIRED_COVERAGE"] }],
	}
	const blockedKnownDebt = {
		id: "SYNTHETIC-BLOCKED-DEBT",
		classification: "known-debt",
		trackIds: [syntheticTrack.id],
		testBlockers: [{ label: "declared blocker", patterns: ["KNOWN_DEBT_BLOCKER"] }],
	}
	for (const row of [missingKnownDebt, blockedKnownDebt]) {
		if (evaluateRow(row, [syntheticTrack], passingTrackResults, true).status !== "FAIL") {
			fail(`Strict debt self-check did not fail ${row.id}`)
		}
		if (evaluateRow(row, [syntheticTrack], passingTrackResults, false).status !== "PENDING-BASELINE-DEBT") {
			fail(`Non-strict debt self-check did not preserve diagnostic pending status for ${row.id}`)
		}
	}

	console.log(
		`PASS certification-self-check (tracks=${checkedMatrix.tracks.length}; deterministicRows=${checkedMatrix.rows.length}; integrationRows=${checkedMatrix.integrationPending.length}; documentation=aligned; livePreflight=${livePreflightMode}; evidencePaths accepted=${accepted.length} rejected=${rejected.length}; strictDebt=2)`,
	)
}

function runLivePlaybookPreflightSelfCheck() {
	const executionMode = process.platform === "win32" ? "windows" : "static-only"
	const expectedReceipt = `PASS managed-agent-live-playbook-preflight (platform=${process.platform} commandExecution=${executionMode})`
	const result = spawnSync(process.execPath, [livePreflightPath], {
		cwd: repositoryRoot,
		env: deterministicEnvironment(),
		encoding: "utf8",
		shell: false,
		windowsHide: true,
		timeout: 90_000,
		maxBuffer: 1024 * 1024,
	})

	if (result.error) {
		fail(`Live playbook preflight self-check could not run: ${result.error.message}`)
	}
	if (result.status !== 0) {
		const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim()
		fail(`Live playbook preflight self-check failed: ${detail}`)
	}
	if (!result.stdout.split(/\r?\n/).includes(expectedReceipt)) {
		fail(`Live playbook preflight self-check did not emit its ${executionMode} PASS receipt`)
	}

	return executionMode
}

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
	if (!Number.isInteger(parsed.minimumTestCount) || parsed.minimumTestCount <= 0) {
		fail("Certification matrix requires a positive integer minimumTestCount")
	}
	if (!Number.isInteger(parsed.expectedDeterministicRowCount) || parsed.expectedDeterministicRowCount <= 0) {
		fail("Certification matrix requires a positive integer expectedDeterministicRowCount")
	}
	if (parsed.rows.length !== parsed.expectedDeterministicRowCount) {
		fail(
			`Certification matrix requires exactly ${parsed.expectedDeterministicRowCount} deterministic rows; found ${parsed.rows.length}`,
		)
	}
	if (!Number.isInteger(parsed.expectedIntegrationPendingCount) || parsed.expectedIntegrationPendingCount <= 0) {
		fail("Certification matrix requires a positive integer expectedIntegrationPendingCount")
	}
	if (parsed.integrationPending.length !== parsed.expectedIntegrationPendingCount) {
		fail(
			`Certification matrix requires exactly ${parsed.expectedIntegrationPendingCount} pending integration rows; found ${parsed.integrationPending.length}`,
		)
	}

	assertUniqueIds(parsed.tracks, "track")
	assertUniqueIds(parsed.prerequisites, "prerequisite")
	assertUniqueIds([...parsed.rows, ...parsed.integrationPending], "matrix row")
	const trackIds = new Set(parsed.tracks.map((track) => track.id))
	const declaredMinimumTestCount = parsed.tracks.reduce((total, track) => {
		if (!Number.isInteger(track.minimumTestCount) || track.minimumTestCount <= 0) {
			fail(`${track.id} requires a positive integer minimumTestCount`)
		}
		return total + track.minimumTestCount
	}, 0)
	if (declaredMinimumTestCount !== parsed.minimumTestCount) {
		fail(
			`Track minimumTestCount total ${declaredMinimumTestCount} does not match matrix minimumTestCount ${parsed.minimumTestCount}`,
		)
	}
	for (const prerequisite of parsed.prerequisites) {
		if (
			!prerequisite.label ||
			!Array.isArray(prerequisite.args) ||
			prerequisite.args.length === 0 ||
			prerequisite.args.some((argument) => typeof argument !== "string" || !argument)
		) {
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
	for (const row of parsed.integrationPending) {
		if (!row || !row.requirement || !row.reason) {
			fail(`${row?.id ?? "integration row"} has an invalid pending-integration definition`)
		}
		if (
			row.evidenceCommand !== null &&
			row.evidenceCommand !== undefined &&
			(typeof row.evidenceCommand !== "string" || !row.evidenceCommand.trim())
		) {
			fail(`${row.id} has an invalid evidenceCommand`)
		}
	}
	validateCertificationDocumentation(parsed)

	return parsed
}

function validateCertificationDocumentation(matrix) {
	const certificationPath = path.join(
		repositoryRoot,
		"docs",
		"certification",
		"managed-agent-milestone-certification.md",
	)
	const architecturePath = path.join(repositoryRoot, "docs", "multi-agent-concurrency-spec.md")
	const certification = readFileSync(certificationPath, "utf8").replace(/\r\n/g, "\n")
	const architecture = readFileSync(architecturePath, "utf8").replace(/\r\n/g, "\n")
	const deterministicSection = extractMarkdownSection(certification, "## Deterministic matrix")
	const documentedDeterministicIds = [...deterministicSection.matchAll(/^\|\s*`([A-Z0-9-]+)`\s*\|/gm)].map(
		(match) => match[1],
	)
	const expectedDeterministicIds = matrix.rows.map((row) => row.id)
	if (JSON.stringify(documentedDeterministicIds) !== JSON.stringify(expectedDeterministicIds)) {
		fail("Certification deterministic row table does not match matrix row IDs and order")
	}

	const integrationSection = extractMarkdownSection(certification, "## Expected integration-dependent rows")
	const integrationBlock = /```text\n([\s\S]*?)\n```/.exec(integrationSection)
	const documentedIntegrationIds = integrationBlock
		? integrationBlock[1]
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
		: []
	const expectedIntegrationIds = matrix.integrationPending.map((row) => row.id)
	if (JSON.stringify(documentedIntegrationIds) !== JSON.stringify(expectedIntegrationIds)) {
		fail("Certification pending-integration list does not match matrix row IDs and order")
	}

	const sectionMarker = "## Latest deterministic execution\n"
	const sectionStart = certification.indexOf(sectionMarker)
	const sectionEnd = certification.indexOf("\n## ", sectionStart + sectionMarker.length)
	if (sectionStart < 0 || sectionEnd < 0) fail("Certification document is missing its execution table")
	const executionSection = certification.slice(sectionStart, sectionEnd)
	const trackCounts = [...executionSection.matchAll(/^\|\s*[^*|][^|]*\|\s*(\d+)\s*\|$/gm)].map((match) =>
		Number(match[1]),
	)
	const totalMatch = /^\|\s*\*\*Total\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|$/m.exec(executionSection)
	if (trackCounts.length !== matrix.tracks.length || !totalMatch) {
		fail(`Certification execution table must contain ${matrix.tracks.length} track rows and one bold total row`)
	}
	const documentedTestCount = Number(totalMatch[1])
	const calculatedTestCount = trackCounts.reduce((total, count) => total + count, 0)
	if (calculatedTestCount !== documentedTestCount) {
		fail(
			`Certification execution table rows sum to ${calculatedTestCount}, but its total claims ${documentedTestCount}`,
		)
	}
	if (documentedTestCount < matrix.minimumTestCount) {
		fail(
			`Certification execution table total ${documentedTestCount} is below matrix floor ${matrix.minimumTestCount}`,
		)
	}
	for (const expected of [
		`**${matrix.expectedDeterministicRowCount} PASS, 0 FAIL, 0 pending merge, 0 baseline-debt exceptions**`,
		`**${matrix.tracks.length} tracks, ${documentedTestCount} tests passed, 0 failed, 0 skipped, 0 todo**`,
		`**${matrix.expectedIntegrationPendingCount} PENDING-INTEGRATION**`,
	]) {
		if (!certification.includes(expected)) fail(`Certification verdict is missing ${expected}`)
	}
	const architectureSummary = new RegExp(
		`passes all ${matrix.expectedDeterministicRowCount} deterministic rows:\\s+${matrix.tracks.length} tracks,\\s+${documentedTestCount} tests`,
	)
	if (!architectureSummary.test(architecture)) {
		fail("Architecture spec deterministic summary does not match the certification execution table")
	}
}

function extractMarkdownSection(document, heading) {
	const marker = `${heading}\n`
	const start = document.indexOf(marker)
	const end = document.indexOf("\n## ", start + marker.length)
	if (start < 0 || end < 0) fail(`Documentation is missing section ${heading}`)
	return document.slice(start, end)
}

function assertUniqueIds(items, label) {
	const seen = new Set()
	for (const item of items) {
		if (!item || typeof item.id !== "string" || item.id.length === 0) fail(`Every ${label} requires an id`)
		if (seen.has(item.id)) fail(`Duplicate ${label} id: ${item.id}`)
		seen.add(item.id)
	}
}

function validatePatternEntries(rowId, entries = []) {
	if (!Array.isArray(entries)) fail(`${rowId} pattern entries must be an array`)
	for (const entry of entries) {
		if (
			!entry ||
			!entry.label ||
			!Array.isArray(entry.patterns) ||
			entry.patterns.length === 0 ||
			entry.patterns.some((pattern) => typeof pattern !== "string" || !pattern)
		) {
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
	const resolvedTracks = configuredTracks.map((track) => {
		if (!track.label || !track.packageDir || !Array.isArray(track.include) || track.include.length === 0) {
			fail(`${track.id} has an invalid track definition`)
		}

		const packagePath = resolveRepositoryPath(track.packageDir)
		if (!existsSync(packagePath)) fail(`${track.id} package directory does not exist: ${track.packageDir}`)
		if (!lstatSync(packagePath).isDirectory())
			fail(`${track.id} packageDir is not a directory: ${track.packageDir}`)
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
	const fileOwners = new Map()
	for (const track of resolvedTracks) {
		for (const file of track.files) {
			const repositoryFile = normalizePath(path.join(track.packageDir, file))
			const previousOwner = fileOwners.get(repositoryFile)
			if (previousOwner) {
				fail(`Certification test file ${repositoryFile} is counted by both ${previousOwner} and ${track.id}`)
			}
			fileOwners.set(repositoryFile, track.id)
		}
	}
	return resolvedTracks
}

function walkFiles(directory) {
	const files = []
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (
			entry.isDirectory() &&
			new Set([".git", ".turbo", ".vscode-test", "coverage", "dist", "node_modules", "out"]).has(entry.name)
		) {
			continue
		}
		const candidate = path.join(directory, entry.name)
		if (entry.isDirectory()) files.push(...walkFiles(candidate))
		else if (entry.isFile()) files.push(candidate)
	}
	return files
}

function printCommands(prerequisites, resolvedTracks, integrationPending, evidenceRelativePath) {
	console.log("=== ALPHA MANAGED-AGENT CERTIFICATION COMMANDS BEGIN ===")
	for (const prerequisite of prerequisites) {
		console.log(`${prerequisite.id} :: pnpm ${prerequisite.args.map(quote).join(" ")}`)
	}
	for (const track of resolvedTracks) {
		console.log(
			`${track.id} :: pnpm --dir ${quote(track.packageDir)} exec vitest run ${track.files.map(quote).join(" ")}`,
		)
	}
	console.log(
		`non-strict-diagnostic :: node scripts/certification/managed-agent-milestone-certify.mjs --evidence ${quote(evidenceRelativePath)}`,
	)
	console.log(
		`strict-release-gate :: node scripts/certification/managed-agent-milestone-certify.mjs --strict --evidence ${quote(evidenceRelativePath)}`,
	)
	console.log(
		"format-check :: pnpm exec prettier --check .prettierrc.json package.json scripts/certification docs/certification docs/multi-agent-concurrency-spec.md src/core/agent/__tests__/certification",
	)
	console.log("harness-syntax-check :: node --check scripts/certification/managed-agent-milestone-certify.mjs")
	console.log(
		"playbook-preflight-syntax-check :: node --check scripts/certification/managed-agent-live-playbook-preflight.mjs",
	)
	console.log("=== ALPHA MANAGED-AGENT CERTIFICATION COMMANDS END ===")

	console.log("=== EXPECTED INTEGRATION PENDING BEGIN ===")
	for (const row of integrationPending) {
		console.log(`${row.id} :: ${row.evidenceCommand ?? "NOT AUTOMATED"} :: ${row.reason}`)
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

function runTracks(resolvedTracks, strictMode) {
	const pnpm = resolvePnpmExecutable()
	const childEnvironment = deterministicEnvironment()
	const results = new Map()
	const reportDirectory = mkdtempSync(path.join(tmpdir(), "alpha-managed-agent-certification-"))

	try {
		for (const track of resolvedTracks) {
			console.log(`\n==> ${track.label} [${track.id}]`)
			const reportPath = path.join(reportDirectory, `${track.id}.json`)
			const startedAt = Date.now()
			const result = spawnSync(
				pnpm,
				[
					"--dir",
					track.packageDir,
					"exec",
					"vitest",
					"run",
					...track.files,
					"--reporter=json",
					`--outputFile=${reportPath}`,
				],
				{
					cwd: repositoryRoot,
					env: childEnvironment,
					stdio: "inherit",
					shell: false,
				},
			)
			const durationMs = Date.now() - startedAt
			if (result.error) {
				console.error(`${track.id}: ${result.error.message}`)
				results.set(track.id, {
					status: "FAIL",
					exitCode: null,
					detail: result.error.message,
					files: track.files,
					minimumTestCount: track.minimumTestCount,
					durationMs,
					testCounts: null,
				})
				continue
			}

			const summary = readVitestSummary(track.id, reportPath)
			if (summary.error) {
				console.error(`${track.id}: ${summary.error}`)
				results.set(track.id, {
					status: "FAIL",
					exitCode: result.status,
					detail: summary.error,
					files: track.files,
					minimumTestCount: track.minimumTestCount,
					durationMs,
					testCounts: null,
				})
				continue
			}
			const skipped = summary.tests.skipped + summary.tests.todo
			const unexpectedSkips = strictMode && skipped > 0
			const belowBaseline = summary.tests.total < track.minimumTestCount
			const failures = []
			if (unexpectedSkips) failures.push(`${skipped} skipped/todo tests are not allowed in strict mode`)
			if (belowBaseline) {
				failures.push(
					`test count ${summary.tests.total} is below the declared regression floor ${track.minimumTestCount}`,
				)
			}
			const status = result.status === 0 && failures.length === 0 ? "PASS" : "FAIL"
			const detail = failures.length > 0 ? failures.join("; ") : undefined
			console.log(
				`${status} ${track.id} (exit ${result.status ?? "unknown"}; tests ${formatTestCounts(summary.tests)})`,
			)
			results.set(track.id, {
				status,
				exitCode: result.status,
				detail,
				files: track.files,
				minimumTestCount: track.minimumTestCount,
				durationMs,
				...summary,
			})
		}
	} finally {
		removeReportDirectory(reportDirectory)
	}

	return results
}

function readVitestSummary(trackId, reportPath) {
	let report
	try {
		report = JSON.parse(readFileSync(reportPath, "utf8"))
	} catch (error) {
		return {
			error: `${trackId} did not emit readable Vitest JSON: ${error instanceof Error ? error.message : String(error)}`,
		}
	}

	const numericFields = [
		"numTotalTestSuites",
		"numPassedTestSuites",
		"numFailedTestSuites",
		"numPendingTestSuites",
		"numTotalTests",
		"numPassedTests",
		"numFailedTests",
		"numPendingTests",
		"numTodoTests",
	]
	for (const field of numericFields) {
		if (!Number.isInteger(report[field]) || report[field] < 0) {
			return { error: `${trackId} emitted an invalid Vitest JSON count for ${field}` }
		}
	}

	const assertions = Array.isArray(report.testResults)
		? report.testResults.flatMap((testResult) =>
				Array.isArray(testResult.assertionResults) ? testResult.assertionResults : [],
			)
		: []
	return {
		suites: {
			total: report.numTotalTestSuites,
			passed: report.numPassedTestSuites,
			failed: report.numFailedTestSuites,
			skipped: report.numPendingTestSuites,
		},
		tests: {
			total: report.numTotalTests,
			passed: report.numPassedTests,
			failed: report.numFailedTests,
			skipped: report.numPendingTests,
			todo: report.numTodoTests,
		},
		failedTests: assertions
			.filter((assertion) => assertion.status === "failed")
			.map((assertion) => assertion.fullName),
		skippedTests: assertions
			.filter((assertion) => assertion.status === "pending" || assertion.status === "todo")
			.map((assertion) => assertion.fullName),
	}
}

function formatTestCounts(counts) {
	return `total=${counts.total} passed=${counts.passed} failed=${counts.failed} skipped=${counts.skipped} todo=${counts.todo}`
}

function removeReportDirectory(reportDirectory) {
	const resolved = path.resolve(reportDirectory)
	const temporaryRoot = `${path.resolve(tmpdir())}${path.sep}`
	if (
		!resolved.startsWith(temporaryRoot) ||
		!path.basename(resolved).startsWith("alpha-managed-agent-certification-")
	) {
		fail(`Refusing to remove unexpected report directory: ${resolved}`)
	}
	rmSync(resolved, { recursive: true, force: true })
}

function runPrerequisites(prerequisites) {
	const pnpm = resolvePnpmExecutable()
	const childEnvironment = deterministicEnvironment()
	return prerequisites.map((prerequisite) => {
		console.log(`\n==> ${prerequisite.label} [${prerequisite.id}]`)
		const startedAt = Date.now()
		const result = spawnSync(pnpm, prerequisite.args, {
			cwd: repositoryRoot,
			env: childEnvironment,
			stdio: "inherit",
			shell: false,
		})
		if (result.error) {
			console.error(`${prerequisite.id}: ${result.error.message}`)
			return {
				id: prerequisite.id,
				status: "FAIL",
				exitCode: null,
				detail: result.error.message,
				durationMs: Date.now() - startedAt,
			}
		}
		const status = result.status === 0 ? "PASS" : "FAIL"
		console.log(`${status} ${prerequisite.id} (exit ${result.status ?? "unknown"})`)
		return { id: prerequisite.id, status, exitCode: result.status, durationMs: Date.now() - startedAt }
	})
}

function failedTrackResults(resolvedTracks, detail) {
	return new Map(
		resolvedTracks.map((track) => [
			track.id,
			{
				status: "FAIL",
				exitCode: null,
				detail,
				files: track.files,
				minimumTestCount: track.minimumTestCount,
				durationMs: 0,
				testCounts: null,
			},
		]),
	)
}

function deterministicEnvironment() {
	const environment = { ...process.env, CI: "true", ALPHA_MANAGED_AGENT_CERTIFICATION: "1" }
	const credentialName = /(?:api[_-]?key|access[_-]?key|credential|password|secret|token)/i
	for (const name of Object.keys(environment)) {
		if (credentialName.test(name) || name === "AWS_PROFILE" || name === "AWS_DEFAULT_PROFILE") {
			delete environment[name]
		}
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
		const status = row.classification === "known-debt" && !strictMode ? "PENDING-BASELINE-DEBT" : "FAIL"
		return { ...row, status, detail: blockers.join("; ") }
	}
	if (missing.length > 0) {
		if (row.classification === "merge-dependent" && !strictMode) {
			return { ...row, status: "PENDING-MERGE", detail: missing.join("; ") }
		}
		if (row.classification === "known-debt" && !strictMode) {
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

function buildEvidence({
	matrix,
	prerequisiteResults,
	trackResults,
	rowResults,
	integrationResults,
	sourceStateAtStart,
	sourceStateAtEnd,
	sourceStateStable,
	startedAt,
	finishedAt,
	deterministicExitCode,
}) {
	const serializedTracks = [...trackResults.entries()].map(([id, result]) => ({ id, ...result }))
	const testTotals = serializedTracks.reduce(
		(totals, track) => {
			if (!track.tests) return totals
			for (const key of ["total", "passed", "failed", "skipped", "todo"]) {
				totals[key] += track.tests[key]
			}
			return totals
		},
		{ total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
	)
	const rowStatusCounts = countStatuses([...rowResults, ...integrationResults])
	const deterministicStatus =
		deterministicExitCode !== 0 ? "FAIL" : strict ? "PASS-DETERMINISTIC" : "SNAPSHOT-DETERMINISTIC"

	return {
		schemaVersion: 1,
		suiteId: matrix.suiteId,
		scope: "deterministic-offline-only",
		generatedAt: new Date(finishedAt).toISOString(),
		durationMs: finishedAt - startedAt,
		invocation: {
			strict,
			arguments: process.argv.slice(2),
			node: process.version,
			platform: process.platform,
			architecture: process.arch,
		},
		source: {
			stableDuringRun: sourceStateStable,
			start: sourceStateAtStart,
			end: sourceStateAtEnd,
			matrixSha256: sha256(readFileSync(matrixPath)),
		},
		outcome: {
			status: deterministicStatus,
			exitCode: deterministicExitCode,
			testCounts: testTotals,
			testBaseline: {
				minimum: matrix.minimumTestCount,
				actual: testTotals.total,
				satisfied: testTotals.total >= matrix.minimumTestCount,
			},
			rowStatusCounts,
			rowBaseline: {
				deterministic: matrix.expectedDeterministicRowCount,
				pendingIntegration: matrix.expectedIntegrationPendingCount,
			},
			liveAcceptance: "NOT_RUN",
			integrationRowsPending: integrationResults.length,
			note: "Passing deterministic rows do not satisfy real provider, VS Code host, multi-window, or live UI acceptance.",
		},
		prerequisites: prerequisiteResults,
		tracks: serializedTracks,
		deterministicRows: rowResults.map(compactRowResult),
		integrationRows: integrationResults.map(compactRowResult),
	}
}

function compactRowResult(row) {
	return {
		id: row.id,
		requirement: row.requirement,
		classification: row.classification,
		status: row.status,
		detail: row.detail,
	}
}

function countStatuses(rows) {
	return rows.reduce((counts, row) => {
		counts[row.status] = (counts[row.status] ?? 0) + 1
		return counts
	}, {})
}

function collectSourceState(excludedEvidencePath) {
	const headCommit = runGit(["rev-parse", "HEAD"]).toString("utf8").trim()
	const trackedDiff = runGit(["diff", "--binary", "HEAD", "--", "."])
	const excludedRelativePath = relative(excludedEvidencePath)
	const untrackedFiles = runGit(["ls-files", "--others", "--exclude-standard", "-z"])
		.toString("utf8")
		.split("\0")
		.filter(Boolean)
		.map(normalizePath)
		.filter((file) => file !== excludedRelativePath)
		.sort((left, right) => left.localeCompare(right))
	const sourceHash = createHash("sha256")
		.update("HEAD\0")
		.update(headCommit)
		.update("\0TRACKED-DIFF\0")
		.update(trackedDiff)
		.update("\0UNTRACKED\0")

	for (const file of untrackedFiles) {
		sourceHash.update(file).update("\0")
		const absolutePath = resolveRepositoryPath(file)
		sourceHash.update(readFileSync(absolutePath)).update("\0")
	}

	return {
		headCommit,
		workingTreeDirty: trackedDiff.length > 0 || untrackedFiles.length > 0,
		sourceStateSha256: sourceHash.digest("hex"),
		trackedDiffSha256: sha256(trackedDiff),
		untrackedFilesSha256: sha256(Buffer.from(untrackedFiles.join("\0"))),
		untrackedFileCount: untrackedFiles.length,
		excludedEvidencePath: excludedRelativePath,
	}
}

function runGit(args) {
	const result = spawnSync("git", args, {
		cwd: repositoryRoot,
		encoding: "buffer",
		maxBuffer: 64 * 1024 * 1024,
		shell: false,
	})
	if (result.error) fail(`git ${args.join(" ")} failed: ${result.error.message}`)
	if (result.status !== 0) {
		fail(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8").trim() || `exit ${result.status}`}`)
	}
	return result.stdout
}

function assertEvidenceOutputIsGenerated(outputPath) {
	const repositoryPath = relative(outputPath)
	const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", repositoryPath], {
		cwd: repositoryRoot,
		encoding: "utf8",
		shell: false,
	})
	if (tracked.error) fail(`Could not inspect evidence tracking state: ${tracked.error.message}`)
	if (tracked.status === 0) fail(`Evidence output must not be tracked: ${repositoryPath}`)
	if (tracked.status !== 1) {
		fail(`Could not inspect evidence tracking state: ${tracked.stderr.trim() || `git exit ${tracked.status}`}`)
	}

	const ignored = spawnSync("git", ["check-ignore", "--quiet", "--", repositoryPath], {
		cwd: repositoryRoot,
		encoding: "utf8",
		shell: false,
	})
	if (ignored.error) fail(`Could not inspect evidence ignore state: ${ignored.error.message}`)
	if (ignored.status !== 0) {
		fail(`Evidence output must be gitignored before certification: ${repositoryPath}`)
	}
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex")
}

function writeEvidence(outputPath, evidence) {
	const allowedRoot = ensureSafeEvidenceDirectory()
	const actualParent = realpathSync(path.dirname(outputPath))
	if (path.relative(allowedRoot, actualParent) !== "") {
		fail(`Evidence output parent resolves outside artifacts/certification: ${actualParent}`)
	}
	const temporaryPath = `${outputPath}.tmp-${process.pid}`
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8")
		if (existsSync(outputPath)) rmSync(outputPath, { force: true })
		renameSync(temporaryPath, outputPath)
	} finally {
		if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true })
	}
}

function ensureSafeEvidenceDirectory() {
	const artifactsRoot = path.join(repositoryRoot, "artifacts")
	const evidenceRoot = path.join(artifactsRoot, "certification")
	for (const candidate of [artifactsRoot, evidenceRoot]) {
		if (!existsSync(candidate)) continue
		const stats = lstatSync(candidate)
		if (stats.isSymbolicLink() || !stats.isDirectory()) {
			fail(`Evidence directory must be a real directory, not a link or file: ${candidate}`)
		}
	}
	mkdirSync(evidenceRoot, { recursive: true })
	const actualRoot = realpathSync(evidenceRoot)
	const expectedRoot = path.join(realpathSync(repositoryRoot), "artifacts", "certification")
	if (path.relative(expectedRoot, actualRoot) !== "") {
		fail(`Evidence directory resolves outside the repository: ${actualRoot}`)
	}
	return actualRoot
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

function resolveRepositoryOutputPath(repositoryRelativePath) {
	try {
		return validateEvidenceOutputPath(repositoryRelativePath)
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error))
	}
}

function validateEvidenceOutputPath(repositoryRelativePath) {
	if (
		typeof repositoryRelativePath !== "string" ||
		!repositoryRelativePath ||
		path.isAbsolute(repositoryRelativePath)
	) {
		throw new Error(`Expected a repository-relative evidence path, received: ${String(repositoryRelativePath)}`)
	}
	const resolved = path.resolve(repositoryRoot, repositoryRelativePath)
	const allowedRoot = path.resolve(repositoryRoot, "artifacts", "certification")
	const relativePath = path.relative(allowedRoot, resolved)
	if (
		!relativePath ||
		relativePath.startsWith("..") ||
		path.isAbsolute(relativePath) ||
		path.dirname(resolved) !== allowedRoot
	) {
		throw new Error(`Evidence output must remain inside artifacts/certification: ${repositoryRelativePath}`)
	}
	if (path.extname(resolved) !== ".json") {
		throw new Error(`Evidence output must use a .json filename: ${repositoryRelativePath}`)
	}
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
