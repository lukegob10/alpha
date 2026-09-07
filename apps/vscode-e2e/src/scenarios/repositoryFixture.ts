import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { promisify } from "node:util"

import { assertOwnedTestRoot, TEST_ROOT_OWNERSHIP_MARKER } from "../testProfile"

const execFileAsync = promisify(execFile)

const FIXTURE_ID = "alpha-code-repository-fixture"
const COMMAND_TIMEOUT_MS = 30_000
const COMMAND_MAX_BUFFER = 1024 * 1024
const GIT_COMMON_CONFIG = [
	"-c",
	"core.autocrlf=false",
	"-c",
	"core.hooksPath=.git/alpha-empty-hooks",
	"-c",
	"commit.gpgSign=false",
]
const GIT_COMMIT_CONFIG = [
	"-c",
	"core.autocrlf=false",
	"-c",
	"core.hooksPath=.git/alpha-empty-hooks",
	"-c",
	"user.name=Alpha Code Fixture",
	"-c",
	"user.email=alpha-code-fixture@example.invalid",
	"-c",
	"commit.gpgSign=false",
]

export const FIXTURE_VERSION = 1 as const
export const FIXTURE_MARKER = ".alpha-workflow-fixture.json" as const

export const FIXTURE_FILES = Object.freeze({
	marker: FIXTURE_MARKER,
	runnerMarker: TEST_ROOT_OWNERSHIP_MARKER,
	alphaIgnore: ".alphaignore",
	gitIgnore: ".gitignore",
	checkpoint: ".alpha-workflow-checkpoint.json",
	resultsPrefix: ".alpha-workflow-results",
	readme: "README.md",
	packageJson: "package.json",
	module: "lib/stats.cjs",
	primaryTest: "test/stats.test.cjs",
	followupTest: "test/stats.followup.test.cjs",
	workflowCases: "test/workflow-cases.json",
})

const BASELINE_MODULE_CONTENT = `function sum(values) {
	return values.reduce((total, value) => total + value)
}

module.exports = { sum }
`

const ENHANCED_MODULE_CONTENT = `function sum(values) {
  return values.reduce((total, value) => total + value, 0)
}

module.exports = { sum }
`

const PRIMARY_TEST_CONTENT = `const assert = require("node:assert/strict")
const { test } = require("node:test")
const { sum } = require("../lib/stats.cjs")

test("sum returns zero for an empty list", () => {
	assert.equal(sum([]), 0)
})

test("sum adds numbers", () => {
	assert.equal(sum([1, 2, 3]), 6)
})
`

const FOLLOWUP_TEST_CONTENT = `const assert = require("node:assert/strict")
const { test } = require("node:test")
const { sum } = require("../lib/stats.cjs")

test("sum handles negative numbers", () => {
	assert.equal(sum([-5, 2, 3]), 0)
})
`

const SCRIPTED_ENHANCED_TEST_CONTENT = [
	'const assert = require("node:assert/strict")',
	'const test = require("node:test")',
	'const { sum } = require("../lib/stats.cjs")',
	'test("empty array", () => assert.equal(sum([]), 0))',
	'test("numbers", () => assert.equal(sum([1, 2, 3]), 6))',
	"",
].join("\n")

const SCRIPTED_FOLLOWUP_TEST_CONTENT = [
	SCRIPTED_ENHANCED_TEST_CONTENT.trimEnd(),
	'test("negative numbers", () => assert.equal(sum([-2, 1]), -1))',
	"",
].join("\n")

const SCRIPTED_EXTENDED_TEST_CONTENT = [
	SCRIPTED_FOLLOWUP_TEST_CONTENT.trimEnd(),
	'const cases = require("./workflow-cases.json")',
	"for (const item of cases) test(`accumulated step ${item.step}`, () => assert.equal(sum([item.left, item.right]), item.sum))",
	"",
].join("\n")

const PACKAGE_JSON_CONTENT = `{
	"name": "alpha-workflow-stats-fixture",
	"private": true,
	"version": "1.0.0",
	"scripts": {
		"test": "node --test"
	}
}
`

const README_CONTENT = `# Alpha Code repository fixture

This small Node fixture is intentionally created in a baseline state for a bounded workflow.

The baseline implementation of \`sum(values)\` calls \`reduce\` without an initial accumulator, so the empty-list
requirement fails. The enhanced implementation must make \`sum([])\` return \`0\` while preserving numeric sums.

The primary test covers the empty list and ordinary numbers. The follow-up test adds negative-number coverage in
\`test/stats.followup.test.cjs\`. Run the fixture with \`node --test\`.
`

const FOLLOWUP_README_CONTENT = "# Statistics fixture\n\nsum([]) = 0\nsum([1, 2, 3]) = 6\nsum([-2, 1]) = -1\n"

const IGNORE_RULES_CONTENT = `.alpha-workflow*
${TEST_ROOT_OWNERSHIP_MARKER}
`

export const BASELINE_MODULE_SOURCE = BASELINE_MODULE_CONTENT
export const ENHANCED_MODULE_SOURCE = ENHANCED_MODULE_CONTENT
export const BASELINE_TEST_SOURCE = PRIMARY_TEST_CONTENT
export const ENHANCED_TEST_SOURCE = SCRIPTED_ENHANCED_TEST_CONTENT
export const BASELINE_README = README_CONTENT
export const FOLLOWUP_README = FOLLOWUP_README_CONTENT
export const FOLLOWUP_TEST_SOURCE = SCRIPTED_FOLLOWUP_TEST_CONTENT
export const EXTENDED_TEST_SOURCE = SCRIPTED_EXTENDED_TEST_CONTENT
export const ALPHAIGNORE_CONTENT = IGNORE_RULES_CONTENT
export const GITIGNORE_CONTENT = IGNORE_RULES_CONTENT

/**
 * The generated files and their behavioral requirements are kept in an exported, dependency-free document so
 * scenario callers can verify the fixture without importing VS Code or relying on the fixture's own tests alone.
 */
export const FIXTURE_CONTENT = Object.freeze({
	baselineModule: BASELINE_MODULE_CONTENT,
	enhancedModule: ENHANCED_MODULE_CONTENT,
	primaryTest: PRIMARY_TEST_CONTENT,
	enhancedTest: SCRIPTED_ENHANCED_TEST_CONTENT,
	followupTest: FOLLOWUP_TEST_CONTENT,
	followupPrimaryTest: SCRIPTED_FOLLOWUP_TEST_CONTENT,
	extendedTest: SCRIPTED_EXTENDED_TEST_CONTENT,
	packageJson: PACKAGE_JSON_CONTENT,
	readme: README_CONTENT,
	followupReadme: FOLLOWUP_README_CONTENT,
	ignoreRules: IGNORE_RULES_CONTENT,
})

export const FIXTURE_REQUIREMENTS = Object.freeze({
	fixture: FIXTURE_ID,
	version: FIXTURE_VERSION,
	artifacts: Object.freeze([
		FIXTURE_MARKER,
		FIXTURE_FILES.runnerMarker,
		FIXTURE_FILES.alphaIgnore,
		FIXTURE_FILES.gitIgnore,
		FIXTURE_FILES.readme,
		FIXTURE_FILES.packageJson,
		FIXTURE_FILES.module,
		FIXTURE_FILES.primaryTest,
	]),
	baseline: Object.freeze({
		module: "sum(values) uses reduce without an initial accumulator and fails for an empty list",
		tests: "the primary test requires sum([]) === 0 and numeric addition, so baseline execution fails",
	}),
	enhanced: Object.freeze({
		module: "sum([]) === 0 and ordinary numeric inputs are summed",
		tests: "the primary test passes for the empty list and ordinary numbers",
	}),
	committed: Object.freeze({
		state: "the enhanced implementation and passing primary tests are committed with no remotes",
	}),
	followup: Object.freeze({
		artifacts: Object.freeze([FIXTURE_FILES.followupTest, `${FIXTURE_FILES.workflowCases} (optional)`]),
		coverage: "the follow-up test covers negative numbers and the full fixture test run passes",
	}),
})

export type FixtureExpectedState = "baseline" | "enhanced" | "committed" | "followup"

export interface FixtureVerification {
	name: string
	passed: boolean
}

interface FixtureMarker {
	fixture: typeof FIXTURE_ID
	root: string
	rootIdentity: string
	version: typeof FIXTURE_VERSION
}

interface CommandResult {
	stdout: string
	stderr: string
}

interface GitInspection {
	currentCommit: string
	initialCommit: string
	commitCount: number
	clean: boolean
	remotes: string[]
}

interface OwnedFixtureInspection {
	root: string
	marker: FixtureMarker
	git: GitInspection
	artifacts: {
		alphaIgnore: string
		gitIgnore: string
		module: string
		primaryTest: string
		followupTest?: string
		workflowCases?: string
		packageJson: string
		readme: string
	}
}

class FixtureError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string | number | undefined {
	if (!isRecord(error)) {
		return undefined
	}

	const code = error.code
	return typeof code === "string" || typeof code === "number" ? code : undefined
}

function commandOutput(error: unknown, stream: "stdout" | "stderr"): string {
	if (!isRecord(error)) {
		return ""
	}

	const output = error[stream]
	return typeof output === "string" ? output : ""
}

function isMissingError(error: unknown): boolean {
	return errorCode(error) === "ENOENT"
}

function comparablePath(value: string): string {
	const normalized = path.normalize(path.resolve(value))
	return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function pathsEqual(left: string, right: string): boolean {
	return comparablePath(left) === comparablePath(right)
}

function fixturePath(root: string, relativePath: string): string {
	const absoluteRoot = path.resolve(root)
	const absolutePath = path.resolve(absoluteRoot, relativePath)
	const relative = path.relative(absoluteRoot, absolutePath)

	if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
		throw new FixtureError(`Fixture path escapes workspace: ${relativePath}`)
	}

	return absolutePath
}

async function assertNoReparsePath(target: string, allowMissingLeaf: boolean): Promise<void> {
	const absolutePath = path.resolve(target)
	const parsed = path.parse(absolutePath)
	const relative = path.relative(parsed.root, absolutePath)
	const segments = relative ? relative.split(path.sep).filter(Boolean) : []
	let currentPath = parsed.root

	for (let index = 0; index < segments.length; index += 1) {
		currentPath = path.join(currentPath, segments[index]!)
		let stats: import("node:fs").Stats

		try {
			stats = await fs.lstat(currentPath)
		} catch (error) {
			if (isMissingError(error) && allowMissingLeaf && index === segments.length - 1) {
				return
			}

			throw new FixtureError(`Unable to validate fixture path: ${currentPath}`)
		}

		if (stats.isSymbolicLink()) {
			throw new FixtureError(`Fixture path cannot use a symbolic link or reparse point: ${currentPath}`)
		}

		if (index < segments.length - 1 && !stats.isDirectory()) {
			throw new FixtureError(`Fixture path parent is not a directory: ${currentPath}`)
		}

		let realPath: string
		try {
			realPath = await fs.realpath(currentPath)
		} catch {
			throw new FixtureError(`Unable to resolve fixture path: ${currentPath}`)
		}

		// Windows realpath canonicalizes ordinary 8.3 aliases (for example LUKEGO~1) as well as
		// reparse points. lstat above rejects symlinks/junctions; avoid treating a harmless alias as
		// a reparse point while retaining the stronger realpath check on Unix-like hosts.
		if (process.platform !== "win32" && !pathsEqual(realPath, currentPath)) {
			throw new FixtureError(`Fixture path cannot traverse a reparse point: ${currentPath}`)
		}
	}
}

async function readDirectoryEntries(directory: string): Promise<import("node:fs").Dirent[]> {
	await assertNoReparsePath(directory, false)

	let entries: import("node:fs").Dirent[]
	try {
		entries = await fs.readdir(directory, { withFileTypes: true })
	} catch {
		throw new FixtureError(`Unable to inspect fixture directory: ${directory}`)
	}

	for (const entry of entries) {
		if (entry.isSymbolicLink()) {
			throw new FixtureError(`Fixture directory contains a symbolic link: ${path.join(directory, entry.name)}`)
		}
	}

	return entries
}

async function readOwnedFile(root: string, relativePath: string, optional = false): Promise<string | undefined> {
	const absolutePath = fixturePath(root, relativePath)
	await assertNoReparsePath(absolutePath, optional)

	let stats
	try {
		stats = await fs.lstat(absolutePath)
	} catch (error) {
		if (optional && isMissingError(error)) {
			return undefined
		}

		throw new FixtureError(`Required fixture file is missing: ${relativePath}`)
	}

	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new FixtureError(`Fixture artifact is not a regular file: ${relativePath}`)
	}

	try {
		return await fs.readFile(absolutePath, "utf8")
	} catch {
		throw new FixtureError(`Unable to read fixture file: ${relativePath}`)
	}
}

async function ensureDirectory(root: string, relativePath: string): Promise<void> {
	const absolutePath = fixturePath(root, relativePath)
	await assertNoReparsePath(absolutePath, true)

	try {
		const stats = await fs.lstat(absolutePath)
		if (stats.isSymbolicLink() || !stats.isDirectory()) {
			throw new FixtureError(`Fixture directory is not a real directory: ${relativePath}`)
		}
	} catch (error) {
		if (!isMissingError(error)) {
			throw error
		}

		try {
			await fs.mkdir(absolutePath)
		} catch (mkdirError) {
			if (!isRecord(mkdirError) || mkdirError.code !== "EEXIST") {
				throw new FixtureError(`Unable to create fixture directory: ${relativePath}`)
			}
		}

		await assertNoReparsePath(absolutePath, false)
		const stats = await fs.lstat(absolutePath)
		if (stats.isSymbolicLink() || !stats.isDirectory()) {
			throw new FixtureError(`Fixture directory is not a real directory: ${relativePath}`)
		}
	}
}

async function writeNewFile(root: string, relativePath: string, content: string): Promise<void> {
	const absolutePath = fixturePath(root, relativePath)
	await assertNoReparsePath(absolutePath, true)

	try {
		await fs.writeFile(absolutePath, content, { encoding: "utf8", flag: "wx" })
	} catch (error) {
		if (isRecord(error) && error.code === "EEXIST") {
			throw new FixtureError(`Refusing to overwrite an existing fixture artifact: ${relativePath}`)
		}

		throw new FixtureError(`Unable to create fixture file: ${relativePath}`)
	}
}

async function runCommand(
	command: string,
	args: string[],
	cwd: string,
	envOverrides?: NodeJS.ProcessEnv,
	inheritEnvironment = true,
): Promise<CommandResult> {
	const result = await execFileAsync(command, args, {
		cwd,
		env: envOverrides ? (inheritEnvironment ? { ...process.env, ...envOverrides } : envOverrides) : process.env,
		encoding: "utf8",
		maxBuffer: COMMAND_MAX_BUFFER,
		shell: false,
		timeout: COMMAND_TIMEOUT_MS,
		windowsHide: true,
	})

	return {
		stdout: String(result.stdout),
		stderr: String(result.stderr),
	}
}

async function runGit(
	root: string,
	args: string[],
	useCommitIdentity = false,
	envOverrides?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
	return runCommand(
		"git",
		[...(useCommitIdentity ? GIT_COMMIT_CONFIG : GIT_COMMON_CONFIG), ...args],
		root,
		envOverrides,
	)
}

function nodeChildEnvironment(): NodeJS.ProcessEnv | undefined {
	const environment: NodeJS.ProcessEnv = {}
	for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "COMSPEC"]) {
		const value = process.env[key]
		if (value !== undefined) {
			environment[key] = value
		}
	}
	if (process.versions.electron) {
		environment.ELECTRON_RUN_AS_NODE = "1"
	}
	return environment
}

async function isIgnoredByGit(root: string, relativePath: string): Promise<boolean> {
	try {
		await runGit(root, ["check-ignore", "--quiet", "--no-index", "--", relativePath])
		return true
	} catch {
		return false
	}
}

function markerContent(root: string): string {
	const marker: FixtureMarker = {
		fixture: FIXTURE_ID,
		root,
		rootIdentity: root,
		version: FIXTURE_VERSION,
	}

	return `${JSON.stringify(marker, null, 2)}\n`
}

function validateMarker(value: unknown, root: string): FixtureMarker {
	if (!isRecord(value)) {
		throw new FixtureError("Fixture marker must contain a JSON object")
	}

	const keys = Object.keys(value).sort()
	const expectedKeys = ["fixture", "root", "rootIdentity", "version"].sort()
	if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
		throw new FixtureError("Fixture marker has an unexpected shape")
	}

	if (
		value.fixture !== FIXTURE_ID ||
		value.version !== FIXTURE_VERSION ||
		typeof value.root !== "string" ||
		typeof value.rootIdentity !== "string" ||
		!pathsEqual(value.root, root) ||
		!pathsEqual(value.rootIdentity, root)
	) {
		throw new FixtureError("Fixture marker is not owned by this workspace")
	}

	return {
		fixture: FIXTURE_ID,
		root: value.root,
		rootIdentity: value.rootIdentity,
		version: FIXTURE_VERSION,
	}
}

async function readMarker(root: string): Promise<FixtureMarker> {
	const content = await readOwnedFile(root, FIXTURE_MARKER)
	if (content === undefined) {
		throw new FixtureError("Fixture marker is missing")
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(content)
	} catch {
		throw new FixtureError("Fixture marker is not valid JSON")
	}

	return validateMarker(parsed, root)
}

async function inspectGit(root: string): Promise<GitInspection> {
	const gitPath = fixturePath(root, ".git")
	await assertNoReparsePath(gitPath, false)

	let gitStats
	try {
		gitStats = await fs.lstat(gitPath)
	} catch {
		throw new FixtureError("Fixture is missing its Git repository")
	}

	if (gitStats.isSymbolicLink() || !gitStats.isDirectory()) {
		throw new FixtureError("Fixture Git metadata must be a real .git directory")
	}

	let topLevel: CommandResult
	try {
		topLevel = await runGit(root, ["rev-parse", "--show-toplevel"])
	} catch {
		throw new FixtureError("Fixture Git repository is not readable")
	}

	if (!pathsEqual(topLevel.stdout.trim(), root)) {
		throw new FixtureError("Fixture Git repository resolves outside the workspace")
	}

	let currentCommit: string
	try {
		currentCommit = (await runGit(root, ["rev-parse", "--verify", "HEAD"])).stdout.trim()
	} catch {
		throw new FixtureError("Fixture Git repository has no readable HEAD commit")
	}

	if (!/^[0-9a-f]{40,64}$/.test(currentCommit)) {
		throw new FixtureError("Fixture Git HEAD is not a commit identifier")
	}

	const initialCommitOutput = await runGit(root, ["rev-list", "--max-parents=0", "--reverse", "HEAD"])
	const initialCommit = initialCommitOutput.stdout.trim().split(/\r?\n/)[0] ?? ""
	if (!/^[0-9a-f]{40,64}$/.test(initialCommit)) {
		throw new FixtureError("Fixture Git history has no root commit")
	}

	const countOutput = await runGit(root, ["rev-list", "--count", "HEAD"])
	const commitCount = Number.parseInt(countOutput.stdout.trim(), 10)
	if (!Number.isSafeInteger(commitCount) || commitCount < 1) {
		throw new FixtureError("Fixture Git history has an invalid commit count")
	}

	const status = await runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"])
	const remotes = (await runGit(root, ["remote"])).stdout

	return {
		currentCommit,
		initialCommit,
		commitCount,
		clean: status.stdout.trim().length === 0,
		remotes: remotes
			.split(/\r?\n/)
			.map((remote) => remote.trim())
			.filter(Boolean),
	}
}

async function inspectOwnedFixture(root: string): Promise<OwnedFixtureInspection> {
	await assertNoReparsePath(root, false)
	const marker = await readMarker(root)

	const entries = await readDirectoryEntries(root)
	const entryNames = new Set(entries.map((entry) => entry.name))
	if (entryNames.has(TEST_ROOT_OWNERSHIP_MARKER)) {
		await assertOwnedTestRoot(root, "workspace")
	}
	for (const requiredName of [".git", "lib", "test"]) {
		if (!entryNames.has(requiredName)) {
			throw new FixtureError(`Fixture is missing required directory: ${requiredName}`)
		}
	}

	for (const requiredFile of [
		FIXTURE_MARKER,
		FIXTURE_FILES.alphaIgnore,
		FIXTURE_FILES.gitIgnore,
		FIXTURE_FILES.readme,
		FIXTURE_FILES.packageJson,
	]) {
		if (!entryNames.has(requiredFile)) {
			throw new FixtureError(`Fixture is missing required file: ${requiredFile}`)
		}
	}

	await ensureDirectory(root, "lib")
	await ensureDirectory(root, "test")
	const libEntries = await readDirectoryEntries(fixturePath(root, "lib"))
	const testEntries = await readDirectoryEntries(fixturePath(root, "test"))

	const moduleContent = await readOwnedFile(root, FIXTURE_FILES.module)
	const primaryTestContent = await readOwnedFile(root, FIXTURE_FILES.primaryTest)
	const followupTestContent = await readOwnedFile(root, FIXTURE_FILES.followupTest, true)
	const workflowCasesContent = await readOwnedFile(root, FIXTURE_FILES.workflowCases, true)
	const alphaIgnore = await readOwnedFile(root, FIXTURE_FILES.alphaIgnore)
	const gitIgnore = await readOwnedFile(root, FIXTURE_FILES.gitIgnore)
	const packageJson = await readOwnedFile(root, FIXTURE_FILES.packageJson)
	const readme = await readOwnedFile(root, FIXTURE_FILES.readme)

	if (
		moduleContent === undefined ||
		primaryTestContent === undefined ||
		alphaIgnore === undefined ||
		gitIgnore === undefined ||
		packageJson === undefined ||
		readme === undefined
	) {
		throw new FixtureError("Fixture required artifact content is missing")
	}

	if (!libEntries.some((entry) => entry.name === "stats.cjs" && entry.isFile())) {
		throw new FixtureError("Fixture is missing lib/stats.cjs")
	}
	if (!testEntries.some((entry) => entry.name === "stats.test.cjs" && entry.isFile())) {
		throw new FixtureError("Fixture is missing test/stats.test.cjs")
	}

	let parsedPackage: unknown
	try {
		parsedPackage = JSON.parse(packageJson)
	} catch {
		throw new FixtureError("Fixture package.json is not valid JSON")
	}
	if (!isRecord(parsedPackage) || parsedPackage.private !== true) {
		throw new FixtureError("Fixture package.json is not the private fixture package")
	}

	const git = await inspectGit(root)
	if (git.remotes.length > 0) {
		throw new FixtureError("Fixture must not have Git remotes")
	}

	return {
		root,
		marker,
		git,
		artifacts: {
			alphaIgnore,
			gitIgnore,
			module: moduleContent,
			primaryTest: primaryTestContent,
			followupTest: followupTestContent,
			workflowCases: workflowCasesContent,
			packageJson,
			readme,
		},
	}
}

async function prepareWorkspace(workspace: string): Promise<{ root: string; empty: boolean }> {
	if (typeof workspace !== "string" || workspace.trim().length === 0) {
		throw new FixtureError("Workspace must be a non-empty path")
	}

	const requestedPath = path.resolve(workspace)
	if (pathsEqual(requestedPath, path.parse(requestedPath).root)) {
		throw new FixtureError("Refusing to use a filesystem root as a fixture workspace")
	}

	await assertNoReparsePath(requestedPath, true)

	let exists = true
	try {
		const stats = await fs.lstat(requestedPath)
		if (stats.isSymbolicLink() || !stats.isDirectory()) {
			throw new FixtureError("Workspace must be a real directory")
		}
	} catch (error) {
		if (!isMissingError(error)) {
			throw error
		}
		exists = false
	}

	if (!exists) {
		const parent = path.dirname(requestedPath)
		await assertNoReparsePath(parent, false)
		const parentStats = await fs.lstat(parent)
		if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
			throw new FixtureError("Workspace parent must be a real directory")
		}

		try {
			await fs.mkdir(requestedPath)
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") {
				throw new FixtureError("Unable to create the fixture workspace")
			}
		}
	}

	await assertNoReparsePath(requestedPath, false)
	const canonicalPath = await fs.realpath(requestedPath)
	if (pathsEqual(canonicalPath, path.parse(canonicalPath).root)) {
		throw new FixtureError("Refusing to use a filesystem root as a fixture workspace")
	}

	const entries = await readDirectoryEntries(canonicalPath)
	return { root: canonicalPath, empty: entries.length === 0 }
}

async function createInitialFixture(root: string): Promise<string> {
	await ensureDirectory(root, "lib")
	await ensureDirectory(root, "test")

	await writeNewFile(root, FIXTURE_FILES.module, BASELINE_MODULE_CONTENT)
	await writeNewFile(root, FIXTURE_FILES.primaryTest, PRIMARY_TEST_CONTENT)
	await writeNewFile(root, FIXTURE_FILES.packageJson, PACKAGE_JSON_CONTENT)
	await writeNewFile(root, FIXTURE_FILES.readme, README_CONTENT)
	await writeNewFile(root, FIXTURE_FILES.alphaIgnore, IGNORE_RULES_CONTENT)
	await writeNewFile(root, FIXTURE_FILES.gitIgnore, IGNORE_RULES_CONTENT)
	await writeNewFile(root, FIXTURE_MARKER, markerContent(root))

	await runGit(root, ["-c", "init.defaultBranch=main", "init", "--quiet", "--template="])
	await runGit(root, [
		"add",
		"--",
		FIXTURE_FILES.readme,
		FIXTURE_FILES.packageJson,
		FIXTURE_FILES.alphaIgnore,
		FIXTURE_FILES.gitIgnore,
		FIXTURE_FILES.module,
		FIXTURE_FILES.primaryTest,
	])
	await runGit(root, ["commit", "--quiet", "--no-verify", "-m", "fixture: baseline"], true, {
		GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
		GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
	})

	const inspection = await inspectOwnedFixture(root)
	if (inspection.artifacts.module !== BASELINE_MODULE_CONTENT || inspection.git.commitCount !== 1) {
		throw new FixtureError("Generated fixture did not match its deterministic baseline")
	}

	return inspection.git.initialCommit
}

async function runFixtureTestsInternal(root: string): Promise<{ exitCode: number }> {
	const testEntries = await readDirectoryEntries(fixturePath(root, "test"))
	const testArgs = ["--test", "--test-reporter=tap", FIXTURE_FILES.primaryTest]
	if (testEntries.some((entry) => entry.name === path.basename(FIXTURE_FILES.followupTest) && entry.isFile())) {
		testArgs.push(FIXTURE_FILES.followupTest)
	}

	try {
		const result = await runCommand(process.execPath, testArgs, root, nodeChildEnvironment(), false)
		if (!hasExecutedFixtureTests(result.stdout)) {
			throw new FixtureError("Fixture test runner reported no executed tests")
		}
		return { exitCode: 0 }
	} catch (error) {
		if (!hasExecutedFixtureTests(commandOutput(error, "stdout"))) {
			throw new FixtureError("Fixture test runner reported no executed tests")
		}
		const code = errorCode(error)
		if (typeof code !== "number") {
			throw new FixtureError("Unable to execute fixture tests")
		}
		return { exitCode: code }
	}
}

function hasExecutedFixtureTests(stdout: string): boolean {
	const match = stdout.match(/^# tests (\d+)$/m)
	return match !== null && Number.parseInt(match[1]!, 10) >= 2
}

async function runModuleContract(root: string, expected: "baseline" | "enhanced"): Promise<boolean> {
	const modulePath = fixturePath(root, FIXTURE_FILES.module)
	const script =
		expected === "enhanced"
			? "const { sum } = require(process.argv[1]); if (sum([]) !== 0 || sum([1, 2, 3]) !== 6) process.exit(1)"
			: "const { sum } = require(process.argv[1]); try { if (sum([]) === 0) process.exit(1) } catch {}"

	try {
		await runCommand(process.execPath, ["-e", script, modulePath], root, nodeChildEnvironment(), false)
		return true
	} catch (error) {
		if (typeof errorCode(error) !== "number") {
			throw new FixtureError("Unable to execute fixture module contract")
		}
		return false
	}
}

function hasEmptyListRequirement(content: string): boolean {
	return /sum\(\[\]\)/.test(content) && /(?:assert\.equal|assert\.strictEqual)\(sum\(\[\]\),\s*0\)/.test(content)
}

function hasNumberRequirement(content: string): boolean {
	return /sum\(\[\s*1\s*,\s*2\s*,\s*3\s*\]\)/.test(content) && /6/.test(content)
}

function hasNegativeNumberRequirement(content: string): boolean {
	return /sum\(\[\s*-\d+/.test(content) && /negative/i.test(content)
}

function hasFollowupReadmeRequirement(content: string): boolean {
	// Grade the documented example, not Markdown backticks or one exact prose template.
	return /sum\(\[\s*-2\s*,\s*1\s*\]\)\s*(?:\/\/\s*)?(?:=>|=|equals|returns|evaluates\s+to|is)\s*-1(?![\w]|\.\d)/i.test(
		content.replace(/`/g, ""),
	)
}

function hasExpectedEntry(entries: import("node:fs").Dirent[], name: string, kind: "file" | "directory"): boolean {
	const entry = entries.find((candidate) => candidate.name === name)
	return kind === "file" ? entry?.isFile() === true : entry?.isDirectory() === true
}

function hasExactlyTheseNames(entries: import("node:fs").Dirent[], names: string[]): boolean {
	const actual = entries.map((entry) => entry.name).sort()
	const expected = [...names].sort()
	return actual.length === expected.length && actual.every((name, index) => name === expected[index])
}

function isAllowedControllerArtifact(name: string): boolean {
	return name === FIXTURE_MARKER || name === FIXTURE_FILES.checkpoint || name.startsWith(FIXTURE_FILES.resultsPrefix)
}

async function hasApprovedArtifactLayout(root: string, expected: FixtureExpectedState): Promise<boolean> {
	try {
		const topEntries = await readDirectoryEntries(root)
		const fixedTopLevelNames = [
			".git",
			"lib",
			"test",
			TEST_ROOT_OWNERSHIP_MARKER,
			FIXTURE_FILES.alphaIgnore,
			FIXTURE_FILES.gitIgnore,
			FIXTURE_FILES.readme,
			FIXTURE_FILES.packageJson,
		]
		const requiredTopLevelNames = fixedTopLevelNames.filter((name) => name !== TEST_ROOT_OWNERSHIP_MARKER)
		if (
			!requiredTopLevelNames.every((name) => topEntries.some((entry) => entry.name === name)) ||
			!topEntries.every(
				(entry) => fixedTopLevelNames.includes(entry.name) || isAllowedControllerArtifact(entry.name),
			) ||
			!hasExpectedEntry(topEntries, ".git", "directory") ||
			!hasExpectedEntry(topEntries, "lib", "directory") ||
			!hasExpectedEntry(topEntries, "test", "directory") ||
			!hasExpectedEntry(topEntries, FIXTURE_FILES.alphaIgnore, "file") ||
			!hasExpectedEntry(topEntries, FIXTURE_FILES.gitIgnore, "file")
		) {
			return false
		}
		const checkpointEntry = topEntries.find((entry) => entry.name === FIXTURE_FILES.checkpoint)
		if (checkpointEntry !== undefined && !checkpointEntry.isFile()) {
			return false
		}

		const libEntries = await readDirectoryEntries(fixturePath(root, "lib"))
		if (!hasExactlyTheseNames(libEntries, ["stats.cjs"]) || !hasExpectedEntry(libEntries, "stats.cjs", "file")) {
			return false
		}

		const testEntries = await readDirectoryEntries(fixturePath(root, "test"))
		const allowedTestFiles: readonly string[] =
			expected === "followup"
				? [
						path.basename(FIXTURE_FILES.primaryTest),
						path.basename(FIXTURE_FILES.followupTest),
						path.basename(FIXTURE_FILES.workflowCases),
					]
				: [path.basename(FIXTURE_FILES.primaryTest)]
		const actualTestNames = testEntries.map((entry) => entry.name)
		if (!actualTestNames.every((name) => allowedTestFiles.includes(name))) {
			return false
		}
		if (!hasExpectedEntry(testEntries, path.basename(FIXTURE_FILES.primaryTest), "file")) {
			return false
		}
		if (
			actualTestNames.includes(path.basename(FIXTURE_FILES.workflowCases)) &&
			!hasExpectedEntry(testEntries, path.basename(FIXTURE_FILES.workflowCases), "file")
		) {
			return false
		}

		const marker = await readOwnedFile(root, FIXTURE_MARKER)
		const alphaIgnore = await readOwnedFile(root, FIXTURE_FILES.alphaIgnore)
		const gitIgnore = await readOwnedFile(root, FIXTURE_FILES.gitIgnore)
		const packageJson = await readOwnedFile(root, FIXTURE_FILES.packageJson)
		const readme = await readOwnedFile(root, FIXTURE_FILES.readme)
		const readmeMatches =
			readme !== undefined &&
			(expected === "baseline"
				? readme === README_CONTENT
				: expected === "followup"
					? hasFollowupReadmeRequirement(readme)
					: readme.startsWith(README_CONTENT))
		if (
			marker !== markerContent(root) ||
			alphaIgnore !== IGNORE_RULES_CONTENT ||
			gitIgnore !== IGNORE_RULES_CONTENT ||
			packageJson !== PACKAGE_JSON_CONTENT ||
			!readmeMatches
		) {
			return false
		}

		const inspection = await inspectOwnedFixture(root)
		if (expected === "baseline" && inspection.artifacts.module !== BASELINE_MODULE_CONTENT) {
			return false
		}
		if (expected === "baseline" && inspection.artifacts.primaryTest !== PRIMARY_TEST_CONTENT) {
			return false
		}
		if (
			expected === "followup" &&
			inspection.artifacts.followupTest !== undefined &&
			!hasNegativeNumberRequirement(inspection.artifacts.followupTest)
		) {
			return false
		}

		return true
	} catch {
		return false
	}
}

function validateWorkflowCases(content: string | undefined): boolean {
	if (content === undefined) {
		return true
	}

	try {
		const parsed: unknown = JSON.parse(content)
		if (!Array.isArray(parsed) || parsed.length === 0) {
			return false
		}

		return parsed.every((entry, index) => {
			if (!isRecord(entry)) {
				return false
			}

			const { step, left, right, sum } = entry
			return (
				typeof step === "number" &&
				Number.isSafeInteger(step) &&
				step === index + 1 &&
				typeof left === "number" &&
				Number.isFinite(left) &&
				typeof right === "number" &&
				Number.isFinite(right) &&
				typeof sum === "number" &&
				Number.isFinite(sum) &&
				sum === left + right
			)
		})
	} catch {
		return false
	}
}

function coversWorkflowCases(primaryTest: string, workflowCases: string | undefined): boolean {
	if (workflowCases === undefined) {
		return true
	}

	return (
		/workflow-cases\.json/.test(primaryTest) &&
		/(?:for\s*\(|\.forEach\s*\(|\.every\s*\(|\.map\s*\()/.test(primaryTest)
	)
}

/**
 * Create a baseline fixture in an explicitly empty directory, or safely rehydrate an owned fixture without resetting
 * any files. Existing non-empty directories without the exact marker ownership record are rejected.
 */
export async function createRepositoryFixture(
	workspace: string,
): Promise<{ workspace: string; initialCommit: string }> {
	const prepared = await prepareWorkspace(workspace)

	if (prepared.empty) {
		const initialCommit = await createInitialFixture(prepared.root)
		return { workspace: prepared.root, initialCommit }
	}

	const entries = await readDirectoryEntries(prepared.root)
	if (entries.length === 1 && entries[0]!.name === TEST_ROOT_OWNERSHIP_MARKER) {
		await assertOwnedTestRoot(prepared.root, "workspace")
		const initialCommit = await createInitialFixture(prepared.root)
		return { workspace: prepared.root, initialCommit }
	}
	if (!entries.some((entry) => entry.name === FIXTURE_MARKER)) {
		throw new FixtureError("Refusing to initialize a non-empty workspace without the fixture ownership marker")
	}

	const inspection = await inspectOwnedFixture(prepared.root)
	return { workspace: prepared.root, initialCommit: inspection.git.initialCommit }
}

/**
 * Verify fixture requirements independently from the fixture's own test runner. This function never changes the
 * workspace and reports named checks so callers can identify the failed contract.
 */
export async function verifyRepositoryFixture(
	workspace: string,
	expected: FixtureExpectedState,
): Promise<FixtureVerification[]> {
	if (!["baseline", "enhanced", "committed", "followup"].includes(expected)) {
		throw new FixtureError(`Unknown fixture expectation: ${expected}`)
	}

	const prepared = await prepareWorkspace(workspace)
	if (prepared.empty) {
		throw new FixtureError("Cannot verify an empty workspace as a repository fixture")
	}

	const inspection = await inspectOwnedFixture(prepared.root)
	const tests = await runFixtureTestsInternal(prepared.root)
	const baselineModule = inspection.artifacts.module === BASELINE_MODULE_CONTENT
	const primaryHasEmptyRequirement = hasEmptyListRequirement(inspection.artifacts.primaryTest)
	const primaryHasNumberRequirement = hasNumberRequirement(inspection.artifacts.primaryTest)
	const primaryHasNegativeRequirement = hasNegativeNumberRequirement(inspection.artifacts.primaryTest)
	const separateFollowupHasNegativeRequirement = inspection.artifacts.followupTest
		? hasNegativeNumberRequirement(inspection.artifacts.followupTest)
		: false
	const followupHasNegativeRequirement = primaryHasNegativeRequirement || separateFollowupHasNegativeRequirement
	const followupPresent = primaryHasNegativeRequirement || inspection.artifacts.followupTest !== undefined
	const followupReadmeRequirement = hasFollowupReadmeRequirement(inspection.artifacts.readme)
	const workflowCasesValid = validateWorkflowCases(inspection.artifacts.workflowCases)
	const workflowCasesCovered = coversWorkflowCases(
		inspection.artifacts.primaryTest,
		inspection.artifacts.workflowCases,
	)
	const enhancedBehavior = await runModuleContract(prepared.root, "enhanced")
	const baselineBehavior = await runModuleContract(prepared.root, "baseline")
	const approvedLayout = await hasApprovedArtifactLayout(prepared.root, expected)
	const controllerFilesIgnored = (
		await Promise.all([
			isIgnoredByGit(prepared.root, FIXTURE_MARKER),
			isIgnoredByGit(prepared.root, TEST_ROOT_OWNERSHIP_MARKER),
			isIgnoredByGit(prepared.root, FIXTURE_FILES.checkpoint),
			isIgnoredByGit(prepared.root, `${FIXTURE_FILES.resultsPrefix}.json`),
		])
	).every(Boolean)

	const checks: FixtureVerification[] = [
		{ name: "marker-owned", passed: inspection.marker.fixture === FIXTURE_ID },
		{
			name: "required-artifacts",
			passed:
				inspection.artifacts.packageJson === PACKAGE_JSON_CONTENT &&
				inspection.artifacts.alphaIgnore === IGNORE_RULES_CONTENT &&
				inspection.artifacts.gitIgnore === IGNORE_RULES_CONTENT,
		},
		{ name: "no-remotes", passed: inspection.git.remotes.length === 0 },
		{ name: "controller-files-ignored", passed: controllerFilesIgnored },
		{ name: "approved-artifact-layout", passed: approvedLayout },
	]

	if (expected === "baseline") {
		checks.push(
			{ name: "baseline-source", passed: baselineModule },
			{ name: "baseline-empty-list-bug", passed: baselineBehavior },
			{ name: "primary-empty-list-requirement", passed: primaryHasEmptyRequirement },
			{ name: "primary-number-requirement", passed: primaryHasNumberRequirement },
			{ name: "baseline-tests-fail", passed: tests.exitCode !== 0 },
			{ name: "baseline-commit", passed: inspection.git.currentCommit === inspection.git.initialCommit },
		)
	} else if (expected === "enhanced") {
		checks.push(
			{ name: "enhanced-source", passed: enhancedBehavior },
			{ name: "primary-empty-list-requirement", passed: primaryHasEmptyRequirement },
			{ name: "primary-number-requirement", passed: primaryHasNumberRequirement },
			{ name: "enhanced-tests-pass", passed: tests.exitCode === 0 },
		)
	} else if (expected === "committed") {
		checks.push(
			{ name: "enhanced-source", passed: enhancedBehavior },
			{ name: "primary-empty-list-requirement", passed: primaryHasEmptyRequirement },
			{ name: "primary-number-requirement", passed: primaryHasNumberRequirement },
			{ name: "enhanced-tests-pass", passed: tests.exitCode === 0 },
			{
				name: "committed-history",
				passed: inspection.git.commitCount > 1 && inspection.git.currentCommit !== inspection.git.initialCommit,
			},
			{ name: "committed-clean", passed: inspection.git.clean },
		)
	} else {
		checks.push(
			{ name: "enhanced-source", passed: enhancedBehavior },
			{ name: "primary-empty-list-requirement", passed: primaryHasEmptyRequirement },
			{ name: "primary-number-requirement", passed: primaryHasNumberRequirement },
			{ name: "followup-test-present", passed: followupPresent },
			{ name: "followup-negative-number-requirement", passed: followupHasNegativeRequirement },
			{ name: "followup-readme-requirement", passed: followupReadmeRequirement },
			{ name: "workflow-cases-valid", passed: workflowCasesValid },
			{ name: "workflow-cases-covered", passed: workflowCasesCovered },
			{ name: "followup-tests-pass", passed: tests.exitCode === 0 },
		)
	}

	return checks
}

export async function runFixtureTests(workspace: string): Promise<{ exitCode: number }> {
	const prepared = await prepareWorkspace(workspace)
	if (prepared.empty) {
		throw new FixtureError("Cannot run tests in an empty workspace")
	}

	await inspectOwnedFixture(prepared.root)
	return runFixtureTestsInternal(prepared.root)
}

export async function readFixtureCommit(workspace: string): Promise<string> {
	const prepared = await prepareWorkspace(workspace)
	if (prepared.empty) {
		throw new FixtureError("Cannot read a commit from an empty workspace")
	}

	const inspection = await inspectOwnedFixture(prepared.root)
	return inspection.git.currentCommit
}
