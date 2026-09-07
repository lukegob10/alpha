import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"

import { assertOwnedTestRoot, TEST_ROOT_OWNERSHIP_MARKER } from "../testProfile"
import { readBounded } from "../evidence/paths"
import {
	DEVELOPMENT_FILES,
	DEVELOPMENT_REFERENCE_CONTENT,
	DEVELOPMENT_SCENARIO_IDS,
	DEVELOPMENT_SCENARIOS,
	type DevelopmentPhaseId,
	type DevelopmentScenarioId,
} from "./developmentCatalog"

const execFileAsync = promisify(execFile)
const FIXTURE_ID = "alpha-code-development-bank"
const COMMAND_TIMEOUT_MS = 30_000
const COMMAND_MAX_BUFFER = 2 * 1024 * 1024
const MAX_FILE_BYTES = 512 * 1024
const MAX_INVENTORY_FILES = 256
const MAX_INVENTORY_ENTRIES = 1024
const MAX_INVENTORY_DEPTH = 16
const MIGRATION_ORACLE_PREFIX = "alpha-development-migration-oracle-"

const GIT_COMMON_CONFIG = [
	"-c",
	"core.autocrlf=false",
	"-c",
	"core.hooksPath=.git/alpha-empty-hooks",
	"-c",
	"commit.gpgSign=false",
	"-c",
	"tag.gpgSign=false",
]
const GIT_COMMIT_CONFIG = [
	...GIT_COMMON_CONFIG,
	"-c",
	"user.name=AlphaDevelopmentFixture",
	"-c",
	"user.email=alpha-development@example.invalid",
]

export const DEVELOPMENT_FIXTURE_VERSION = 1 as const
export const DEVELOPMENT_FIXTURE_MARKER = DEVELOPMENT_FILES.marker

export interface DevelopmentVerification {
	name: string
	passed: boolean
}

interface CommandResult {
	exitCode: number | null
	stdout: string
	stderr: string
}

interface GitBaseline {
	head: string
	branch: string
	statusDigest: string
	stagedDiffDigest: string
	worktreeDiffDigest: string
	mergeHead: string | null
}

interface FixtureState {
	root: string
	rootIdentity: string
	scenarioId: DevelopmentScenarioId
	runnerMarkerDigest: string
	readmeDigest: string
	migrationPhaseOneDigest: string | null
	baseline: {
		workspaceDigest: string
		git: GitBaseline | null
	}
}

const inMemoryStates = new Map<string, FixtureState>()

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string | number | undefined {
	if (!isRecord(error)) return undefined
	const code = error.code
	return typeof code === "string" || typeof code === "number" ? code : undefined
}

function isMissingError(error: unknown): boolean {
	return errorCode(error) === "ENOENT"
}

function digest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex")
}

function comparablePath(value: string): string {
	const normalized = path.normalize(path.resolve(value))
	return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function pathsEqual(left: string, right: string): boolean {
	return comparablePath(left) === comparablePath(right)
}

function normalizeRelativePath(value: string): string {
	return value.split(path.sep).join("/")
}

function fixturePath(root: string, relativePath: string): string {
	if (typeof relativePath !== "string" || relativePath.trim().length === 0 || relativePath.includes("\0")) {
		throw new Error("Fixture relative path must be non-empty")
	}
	if (path.isAbsolute(relativePath)) throw new Error(`Fixture path must be relative: ${relativePath}`)

	const absoluteRoot = path.resolve(root)
	const absolutePath = path.resolve(absoluteRoot, relativePath)
	const relative = path.relative(absoluteRoot, absolutePath)
	if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
		throw new Error(`Fixture path escapes workspace: ${relativePath}`)
	}
	return absolutePath
}

async function assertNoReparsePath(target: string, allowMissingLeaf: boolean): Promise<void> {
	const absolutePath = path.resolve(target)
	const parsed = path.parse(absolutePath)
	const segments = path.relative(parsed.root, absolutePath).split(path.sep).filter(Boolean)
	let currentPath = parsed.root

	for (let index = 0; index < segments.length; index += 1) {
		currentPath = path.join(currentPath, segments[index]!)
		let stats
		try {
			stats = await fs.lstat(currentPath)
		} catch (error) {
			if (isMissingError(error) && allowMissingLeaf && index === segments.length - 1) return
			if (isMissingError(error)) throw error
			throw new Error(`Unable to validate fixture path: ${currentPath}`)
		}

		if (stats.isSymbolicLink()) throw new Error(`Fixture path cannot use a link or reparse point: ${currentPath}`)
		if (index < segments.length - 1 && !stats.isDirectory()) {
			throw new Error(`Fixture path parent is not a directory: ${currentPath}`)
		}

		const realPath = await fs.realpath(currentPath).catch(() => {
			throw new Error(`Unable to resolve fixture path: ${currentPath}`)
		})
		if (process.platform !== "win32" && !pathsEqual(realPath, currentPath)) {
			throw new Error(`Fixture path cannot traverse a reparse point: ${currentPath}`)
		}
	}
}

async function readDirectoryEntries(directory: string): Promise<import("node:fs").Dirent[]> {
	await assertNoReparsePath(directory, false)
	let entries: import("node:fs").Dirent[]
	try {
		entries = await fs.readdir(directory, { withFileTypes: true })
	} catch {
		throw new Error(`Unable to inspect fixture directory: ${directory}`)
	}
	for (const entry of entries) {
		if (entry.isSymbolicLink())
			throw new Error(`Fixture directory contains a link: ${path.join(directory, entry.name)}`)
		if (!entry.isDirectory() && !entry.isFile()) {
			throw new Error(`Fixture directory contains a special entry: ${path.join(directory, entry.name)}`)
		}
	}
	return entries
}

async function readFileBounded(filePath: string): Promise<string> {
	await assertNoReparsePath(filePath, false)
	return (await readBounded(filePath, MAX_FILE_BYTES)).toString("utf8")
}

async function readFixtureFile(root: string, relativePath: string, optional = false): Promise<string | undefined> {
	const filePath = fixturePath(root, relativePath)
	try {
		return await readFileBounded(filePath)
	} catch (error) {
		if (optional && isMissingError(error)) return undefined
		throw error
	}
}

async function writeNewFixtureFile(root: string, relativePath: string, content: string): Promise<void> {
	const filePath = fixturePath(root, relativePath)
	await assertNoReparsePath(filePath, true)
	try {
		await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" })
	} catch (error) {
		if (isRecord(error) && error.code === "EEXIST") {
			throw new Error(`Refusing to overwrite existing fixture file: ${relativePath}`)
		}
		throw error
	}
}

async function replaceFixtureFile(root: string, relativePath: string, content: string): Promise<void> {
	const filePath = fixturePath(root, relativePath)
	await assertNoReparsePath(filePath, false)
	const stats = await fs.lstat(filePath)
	if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Fixture file is not replaceable: ${relativePath}`)
	await fs.writeFile(filePath, content, "utf8")
}

async function ensureFixtureDirectory(root: string, relativePath: string): Promise<void> {
	const directory = fixturePath(root, relativePath)
	await assertNoReparsePath(directory, true)
	try {
		const stats = await fs.lstat(directory)
		if (stats.isSymbolicLink() || !stats.isDirectory())
			throw new Error(`Fixture path is not a directory: ${relativePath}`)
	} catch (error) {
		if (!isMissingError(error)) throw error
		await fs.mkdir(directory)
		await assertNoReparsePath(directory, false)
	}
}

function childEnvironment(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {}
	for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "COMSPEC"]) {
		const value = process.env[key]
		if (value !== undefined) environment[key] = value
	}
	// Node's test runner sets this internal variable; forwarding it makes nested node:test invocations unreliable.
	delete environment.NODE_TEST_CONTEXT
	if (process.versions.electron) environment.ELECTRON_RUN_AS_NODE = "1"
	return environment
}

function gitEnvironment(root: string, overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		...childEnvironment(),
		GIT_CONFIG_NOSYSTEM: "1",
		// A missing per-fixture path disables global configuration without changing the user's real config.
		GIT_CONFIG_GLOBAL: path.join(root, ".alpha-development-empty-gitconfig"),
		GIT_TERMINAL_PROMPT: "0",
		...(overrides ?? {}),
	}
}

async function runCommand(
	command: string,
	args: string[],
	cwd: string,
	environment: NodeJS.ProcessEnv,
): Promise<CommandResult> {
	try {
		const result = await execFileAsync(command, args, {
			cwd,
			env: environment,
			encoding: "utf8",
			maxBuffer: COMMAND_MAX_BUFFER,
			shell: false,
			timeout: COMMAND_TIMEOUT_MS,
			windowsHide: true,
		})
		return { exitCode: 0, stdout: String(result.stdout), stderr: String(result.stderr) }
	} catch (error) {
		const stdout = isRecord(error) && typeof error.stdout === "string" ? error.stdout : ""
		const stderr = isRecord(error) && typeof error.stderr === "string" ? error.stderr : ""
		const code = errorCode(error)
		return { exitCode: typeof code === "number" ? code : null, stdout, stderr }
	}
}

async function runGit(
	root: string,
	args: string[],
	commitIdentity = false,
	environmentOverrides?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
	return runCommand(
		"git",
		[...(commitIdentity ? GIT_COMMIT_CONFIG : GIT_COMMON_CONFIG), ...args],
		root,
		gitEnvironment(root, environmentOverrides),
	)
}

async function requireGit(
	root: string,
	args: string[],
	commitIdentity = false,
	environment?: NodeJS.ProcessEnv,
): Promise<string> {
	const result = await runGit(root, args, commitIdentity, environment)
	if (result.exitCode !== 0) throw new Error(`Git command failed: git ${args.join(" ")}`)
	return result.stdout
}

async function requireNode(root: string, args: string[]): Promise<CommandResult> {
	const result = await runCommand(process.execPath, args, root, childEnvironment())
	if (result.exitCode !== 0) throw new Error(`Node command failed: ${args.join(" ")}`)
	return result
}

async function readJson(root: string, relativePath: string): Promise<unknown> {
	const content = await readFixtureFile(root, relativePath)
	if (content === undefined) throw new Error(`Missing JSON fixture file: ${relativePath}`)
	try {
		return JSON.parse(content)
	} catch {
		throw new Error(`Invalid JSON fixture file: ${relativePath}`)
	}
}

function markerContent(root: string, scenarioId: DevelopmentScenarioId): string {
	return `${JSON.stringify(
		{
			fixture: FIXTURE_ID,
			root,
			rootIdentity: root,
			scenarioId,
			version: DEVELOPMENT_FIXTURE_VERSION,
		},
		null,
	)}\n`
}

function validateMarker(value: unknown, root: string): { scenarioId: DevelopmentScenarioId } {
	if (!isRecord(value)) throw new Error("Development fixture marker must be an object")
	const keys = Object.keys(value).sort()
	const expectedKeys = ["fixture", "root", "rootIdentity", "scenarioId", "version"].sort()
	if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
		throw new Error("Development fixture marker has an unexpected schema")
	}
	if (
		value.fixture !== FIXTURE_ID ||
		value.version !== DEVELOPMENT_FIXTURE_VERSION ||
		typeof value.root !== "string" ||
		typeof value.rootIdentity !== "string" ||
		!pathsEqual(value.root, root) ||
		!pathsEqual(value.rootIdentity, root) ||
		!DEVELOPMENT_SCENARIO_IDS.includes(value.scenarioId as DevelopmentScenarioId)
	) {
		throw new Error("Development fixture marker is not owned by this workspace")
	}
	return { scenarioId: value.scenarioId as DevelopmentScenarioId }
}

async function readMarker(root: string): Promise<{ scenarioId: DevelopmentScenarioId; raw: string }> {
	const raw = await readFixtureFile(root, DEVELOPMENT_FIXTURE_MARKER)
	if (raw === undefined) throw new Error("Development fixture marker is missing")
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		throw new Error("Development fixture marker is invalid JSON")
	}
	return { ...validateMarker(parsed, root), raw }
}

function validateCommit(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/.test(value)) throw new Error(`Invalid ${label}`)
	return value
}

function readState(root: string, scenarioId: DevelopmentScenarioId): FixtureState {
	const state = inMemoryStates.get(comparablePath(root))
	if (state === undefined) throw new Error("Development fixture baseline is unavailable in this host process")
	if (
		!pathsEqual(state.root, root) ||
		!pathsEqual(state.rootIdentity, root) ||
		state.scenarioId !== scenarioId ||
		state.rootIdentity !== state.root
	) {
		throw new Error("Development fixture baseline is not owned by this workspace")
	}
	return state
}

async function collectWorkspaceFiles(
	root: string,
	relativeDirectory = "",
	budget: { entries: number; files: number } = { entries: 0, files: 0 },
	depth = 0,
): Promise<Array<{ relative: string; contentDigest: string }>> {
	if (depth > MAX_INVENTORY_DEPTH) throw new Error("Fixture workspace directory nesting is too deep")
	const directory = relativeDirectory ? fixturePath(root, relativeDirectory) : root
	const entries = await readDirectoryEntries(directory)
	budget.entries += entries.length
	if (budget.entries > MAX_INVENTORY_ENTRIES) throw new Error("Fixture workspace has too many directory entries")
	const files: Array<{ relative: string; contentDigest: string }> = []
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!relativeDirectory && entry.name === ".git") continue
		if (!relativeDirectory && entry.name === DEVELOPMENT_FIXTURE_MARKER) continue
		const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name
		if (entry.isDirectory()) {
			files.push(...(await collectWorkspaceFiles(root, relative, budget, depth + 1)))
		} else {
			budget.files += 1
			if (budget.files > MAX_INVENTORY_FILES) throw new Error("Fixture workspace has too many files")
			const content = await readFixtureFile(root, relative)
			if (content === undefined) throw new Error(`Fixture file disappeared: ${relative}`)
			files.push({ relative: normalizeRelativePath(relative), contentDigest: digest(content) })
		}
	}
	return files
}

async function workspaceDigest(root: string): Promise<string> {
	const files = (await collectWorkspaceFiles(root)).sort((left, right) => left.relative.localeCompare(right.relative))
	const hash = createHash("sha256")
	for (const file of files) hash.update(`${file.relative}\0${file.contentDigest}\0`)
	return hash.digest("hex")
}

async function readMergeHead(root: string): Promise<string | null> {
	const mergeHeadPath = path.join(root, ".git", "MERGE_HEAD")
	try {
		const value = (await readFileBounded(mergeHeadPath)).trim()
		return validateCommit(value.split(/\r?\n/)[0] ?? "", "MERGE_HEAD")
	} catch (error) {
		if (isMissingError(error)) return null
		throw error
	}
}

async function captureGitBaseline(root: string): Promise<GitBaseline> {
	const head = (await requireGit(root, ["rev-parse", "--verify", "HEAD"])).trim()
	const branch = (await requireGit(root, ["branch", "--show-current"])).trim()
	const status = await requireGit(root, ["status", "--porcelain=v1", "--untracked-files=all"])
	const stagedDiff = await requireGit(root, ["diff", "--no-ext-diff", "--binary", "--cached"])
	const worktreeDiff = await requireGit(root, ["diff", "--no-ext-diff", "--binary"])
	return {
		head: validateCommit(head, "fixture HEAD"),
		branch: branch || "(detached)",
		statusDigest: digest(status),
		stagedDiffDigest: digest(stagedDiff),
		worktreeDiffDigest: digest(worktreeDiff),
		mergeHead: await readMergeHead(root),
	}
}

async function hasGitDirectory(root: string): Promise<boolean> {
	try {
		const stats = await fs.lstat(path.join(root, ".git"))
		return stats.isDirectory() && !stats.isSymbolicLink()
	} catch (error) {
		if (isMissingError(error)) return false
		throw error
	}
}

async function captureBaseline(root: string): Promise<FixtureState["baseline"]> {
	return {
		workspaceDigest: await workspaceDigest(root),
		git: (await hasGitDirectory(root)) ? await captureGitBaseline(root) : null,
	}
}

async function prepareWorkspace(workspace: string): Promise<string> {
	if (typeof workspace !== "string" || workspace.trim().length === 0)
		throw new Error("Workspace must be a non-empty path")
	const requested = path.resolve(workspace)
	if (pathsEqual(requested, path.parse(requested).root))
		throw new Error("Fixture workspace cannot be a filesystem root")
	await assertOwnedTestRoot(requested, "workspace")
	await assertNoReparsePath(requested, false)
	const canonical = await fs.realpath(requested)
	if (pathsEqual(canonical, path.parse(canonical).root))
		throw new Error("Fixture workspace cannot be a filesystem root")
	return canonical
}

async function assertSeedableWorkspace(root: string): Promise<void> {
	const entries = await readDirectoryEntries(root)
	const allowed = new Set([TEST_ROOT_OWNERSHIP_MARKER, DEVELOPMENT_FILES.readme, DEVELOPMENT_FILES.alphaIgnore])
	for (const entry of entries) {
		if (!allowed.has(entry.name))
			throw new Error(`Refusing to initialize non-empty development workspace: ${entry.name}`)
	}
	await assertOwnedTestRoot(root, "workspace")
}

async function writeIfMissing(root: string, relativePath: string, content: string): Promise<void> {
	const existing = await readFixtureFile(root, relativePath, true)
	if (existing === undefined) await writeNewFixtureFile(root, relativePath, content)
}

async function initializeRepository(root: string, scenarioId: DevelopmentScenarioId): Promise<void> {
	await ensureFixtureDirectory(root, "lib")
	await ensureFixtureDirectory(root, "test")
	await writeNewFixtureFile(root, DEVELOPMENT_FILES.alphaIgnore, DEVELOPMENT_REFERENCE_CONTENT.alphaIgnore)
	await writeNewFixtureFile(root, DEVELOPMENT_FILES.gitIgnore, DEVELOPMENT_REFERENCE_CONTENT.gitIgnore)
	await writeNewFixtureFile(root, DEVELOPMENT_FILES.packageJson, DEVELOPMENT_REFERENCE_CONTENT.packageJson)
	await writeIfMissing(root, DEVELOPMENT_FILES.readme, DEVELOPMENT_REFERENCE_CONTENT.readme)

	const trackedFiles: string[] = [
		DEVELOPMENT_FILES.alphaIgnore,
		DEVELOPMENT_FILES.gitIgnore,
		DEVELOPMENT_FILES.packageJson,
		DEVELOPMENT_FILES.readme,
	]
	if (scenarioId === "dev-local-migration") {
		await ensureFixtureDirectory(root, "data")
		await ensureFixtureDirectory(root, "scripts")
		await writeNewFixtureFile(root, DEVELOPMENT_FILES.data, DEVELOPMENT_REFERENCE_CONTENT.dataV1)
		await writeNewFixtureFile(root, DEVELOPMENT_FILES.migration, DEVELOPMENT_REFERENCE_CONTENT.migrationStub)
		await writeNewFixtureFile(root, DEVELOPMENT_FILES.migrationTest, DEVELOPMENT_REFERENCE_CONTENT.migrationTest)
		trackedFiles.push(DEVELOPMENT_FILES.data, DEVELOPMENT_FILES.migration, DEVELOPMENT_FILES.migrationTest)
	} else {
		const selective = scenarioId === "dev-selective-commit"
		await writeNewFixtureFile(
			root,
			DEVELOPMENT_FILES.cart,
			selective ? DEVELOPMENT_REFERENCE_CONTENT.selectiveBrokenCart : DEVELOPMENT_REFERENCE_CONTENT.baseCart,
		)
		const tests = selective
			? DEVELOPMENT_REFERENCE_CONTENT.baseCartTest.replace(/test\("empty carts total zero"[\s\S]*?\n\}\)\n\n/, "")
			: DEVELOPMENT_REFERENCE_CONTENT.baseCartTest
		await writeNewFixtureFile(root, DEVELOPMENT_FILES.cartTest, tests)
		trackedFiles.push(DEVELOPMENT_FILES.cart, DEVELOPMENT_FILES.cartTest)
		if (scenarioId === "dev-selective-commit") {
			await ensureFixtureDirectory(root, "notes")
			await writeNewFixtureFile(
				root,
				DEVELOPMENT_FILES.selectiveUnstaged,
				DEVELOPMENT_REFERENCE_CONTENT.selectiveUnstagedBase,
			)
			trackedFiles.push(DEVELOPMENT_FILES.selectiveUnstaged)
		}
	}

	await requireGit(root, ["-c", "init.defaultBranch=main", "init", "--quiet", "--template="])
	await requireGit(root, ["add", "--", ...trackedFiles])
	await requireGit(root, ["commit", "--quiet", "--no-verify", "-m", `fixture: ${scenarioId}`], true, {
		GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
		GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
	})
}

async function seedInspectState(root: string): Promise<void> {
	const readme = await readFixtureFile(root, DEVELOPMENT_FILES.readme)
	if (readme === undefined) throw new Error("Inspect fixture README is missing")
	await replaceFixtureFile(root, DEVELOPMENT_FILES.readme, `${readme.trimEnd()}\n\nStaged handoff note.\n`)
	await requireGit(root, ["add", "--", DEVELOPMENT_FILES.readme])
	const cart = await readFixtureFile(root, DEVELOPMENT_FILES.cart)
	if (cart === undefined) throw new Error("Inspect fixture cart is missing")
	await replaceFixtureFile(root, DEVELOPMENT_FILES.cart, `${cart}\n// Unstaged whitespace-only review note.\n`)
	await ensureFixtureDirectory(root, "notes")
	await writeNewFixtureFile(root, DEVELOPMENT_FILES.inspectNote, DEVELOPMENT_REFERENCE_CONTENT.inspectNote)
}

async function seedSelectiveState(root: string): Promise<void> {
	await replaceFixtureFile(root, DEVELOPMENT_FILES.selectiveUnstaged, DEVELOPMENT_REFERENCE_CONTENT.selectiveUnstaged)
	await ensureFixtureDirectory(root, "notes")
	await writeNewFixtureFile(root, DEVELOPMENT_FILES.selectiveStaged, DEVELOPMENT_REFERENCE_CONTENT.selectiveStaged)
	await requireGit(root, ["add", "--", DEVELOPMENT_FILES.selectiveStaged])
	await ensureFixtureDirectory(root, "scratch")
	await writeNewFixtureFile(
		root,
		DEVELOPMENT_FILES.selectiveUntracked,
		DEVELOPMENT_REFERENCE_CONTENT.selectiveUntracked,
	)
}

async function seedMergeConflict(root: string): Promise<void> {
	await requireGit(root, ["switch", "-c", "feature/cart-discounts"])
	await replaceFixtureFile(root, DEVELOPMENT_FILES.cart, DEVELOPMENT_REFERENCE_CONTENT.featureCart)
	await writeNewFixtureFile(root, DEVELOPMENT_FILES.discountTest, DEVELOPMENT_REFERENCE_CONTENT.featureDiscountTest)
	await requireGit(root, ["add", "--", DEVELOPMENT_FILES.cart, DEVELOPMENT_FILES.discountTest])
	await requireGit(root, ["commit", "--quiet", "--no-verify", "-m", "feature: add cart discounts"], true, {
		GIT_AUTHOR_DATE: "2000-01-02T00:00:00Z",
		GIT_COMMITTER_DATE: "2000-01-02T00:00:00Z",
	})
	await requireGit(root, ["switch", "main"])
	await replaceFixtureFile(root, DEVELOPMENT_FILES.cart, DEVELOPMENT_REFERENCE_CONTENT.mainCart)
	await writeNewFixtureFile(root, DEVELOPMENT_FILES.taxTest, DEVELOPMENT_REFERENCE_CONTENT.mainTaxTest)
	await requireGit(root, ["add", "--", DEVELOPMENT_FILES.cart, DEVELOPMENT_FILES.taxTest])
	await requireGit(root, ["commit", "--quiet", "--no-verify", "-m", "main: add cart tax"], true, {
		GIT_AUTHOR_DATE: "2000-01-03T00:00:00Z",
		GIT_COMMITTER_DATE: "2000-01-03T00:00:00Z",
	})
	const merge = await runGit(root, ["merge", "--no-ff", "--no-commit", "--no-edit", "feature/cart-discounts"], true)
	if (merge.exitCode === 0) throw new Error("Expected the merge fixture to contain a real conflict")
	const mergeHead = await readMergeHead(root)
	if (mergeHead === null) throw new Error("Expected Git to leave MERGE_HEAD for the conflict fixture")
}

async function seedScenario(root: string, scenarioId: DevelopmentScenarioId): Promise<void> {
	await initializeRepository(root, scenarioId)
	if (scenarioId === "dev-git-inspect") await seedInspectState(root)
	if (scenarioId === "dev-selective-commit") await seedSelectiveState(root)
	if (scenarioId === "dev-merge-conflict") await seedMergeConflict(root)
}

function validScenarioId(value: unknown): value is DevelopmentScenarioId {
	return typeof value === "string" && DEVELOPMENT_SCENARIO_IDS.includes(value as DevelopmentScenarioId)
}

async function createFixtureMarker(root: string, scenarioId: DevelopmentScenarioId): Promise<void> {
	await writeNewFixtureFile(root, DEVELOPMENT_FIXTURE_MARKER, markerContent(root, scenarioId))
}

async function makeState(root: string, scenarioId: DevelopmentScenarioId): Promise<FixtureState> {
	const runnerMarker = await readFixtureFile(root, TEST_ROOT_OWNERSHIP_MARKER)
	const readme = await readFixtureFile(root, DEVELOPMENT_FILES.readme)
	if (runnerMarker === undefined || readme === undefined)
		throw new Error("Development fixture markers are incomplete")
	return {
		root,
		rootIdentity: root,
		scenarioId,
		runnerMarkerDigest: digest(runnerMarker),
		readmeDigest: digest(readme),
		migrationPhaseOneDigest: null,
		baseline: await captureBaseline(root),
	}
}

export async function createDevelopmentFixture(workspace: string, scenarioId: DevelopmentScenarioId): Promise<void> {
	if (!validScenarioId(scenarioId)) throw new Error(`Unknown development scenario: ${String(scenarioId)}`)
	const root = await prepareWorkspace(workspace)
	const existingMarker = await readFixtureFile(root, DEVELOPMENT_FIXTURE_MARKER, true)
	if (existingMarker !== undefined) {
		const marker = await readMarker(root)
		if (marker.scenarioId !== scenarioId) throw new Error("Development workspace belongs to another scenario")
		await readState(root, scenarioId)
		return
	}

	await assertSeedableWorkspace(root)
	if (scenarioId === "dev-repo-bootstrap") {
		await writeIfMissing(root, DEVELOPMENT_FILES.readme, DEVELOPMENT_REFERENCE_CONTENT.taskReadme)
		await writeIfMissing(root, DEVELOPMENT_FILES.alphaIgnore, DEVELOPMENT_REFERENCE_CONTENT.alphaIgnore)
	} else {
		await seedScenario(root, scenarioId)
	}
	await createFixtureMarker(root, scenarioId)
	inMemoryStates.set(comparablePath(root), await makeState(root, scenarioId))
}

export function disposeDevelopmentFixture(workspace: string): void {
	if (typeof workspace !== "string" || workspace.trim().length === 0) return
	inMemoryStates.delete(comparablePath(workspace))
}

function check(name: string, passed: boolean): DevelopmentVerification {
	return { name, passed }
}

async function currentStatus(root: string): Promise<string> {
	return requireGit(root, ["status", "--porcelain=v1", "--untracked-files=all"])
}

async function trackedFiles(root: string): Promise<string[]> {
	return (await requireGit(root, ["ls-files"]))
		.split(/\r?\n/)
		.map((value) => value.trim())
		.filter(Boolean)
}

async function untrackedFiles(root: string): Promise<string[]> {
	return (await requireGit(root, ["ls-files", "--others", "--exclude-standard"]))
		.split(/\r?\n/)
		.map((value) => value.trim())
		.filter(Boolean)
}

async function changedFiles(root: string, args: string[]): Promise<string[]> {
	return (await requireGit(root, args))
		.split(/\r?\n/)
		.map((value) => value.trim())
		.filter(Boolean)
}

function sortedEqual(left: readonly string[], right: readonly string[]): boolean {
	const a = [...left].sort()
	const b = [...right].sort()
	return a.length === b.length && a.every((value, index) => value === b[index])
}

async function commitCount(root: string): Promise<number> {
	const value = Number.parseInt((await requireGit(root, ["rev-list", "--count", "HEAD"])).trim(), 10)
	return Number.isSafeInteger(value) ? value : -1
}

async function parentIds(root: string): Promise<string[]> {
	return (await requireGit(root, ["rev-list", "--parents", "-n", "1", "HEAD"])).trim().split(/\s+/).slice(1)
}

async function commitChangedFiles(root: string, base: string): Promise<string[]> {
	return changedFiles(root, ["diff", "--name-only", "--no-renames", base, "HEAD"])
}

async function readGitBlob(root: string, revision: string, relativePath: string): Promise<string | undefined> {
	const result = await runGit(root, ["show", `${revision}:${relativePath}`])
	return result.exitCode === 0 ? result.stdout : undefined
}

async function readGitIndexBlob(root: string, relativePath: string): Promise<string | undefined> {
	const result = await runGit(root, ["show", `:${relativePath}`])
	return result.exitCode === 0 ? result.stdout : undefined
}

async function validateWorkspaceFiles(root: string, expectedFiles: readonly string[]): Promise<boolean> {
	const actual = (await collectWorkspaceFiles(root)).map((file) => file.relative)
	return sortedEqual(actual, expectedFiles.map(normalizeRelativePath))
}

async function packageContract(root: string): Promise<boolean> {
	const value = await readJson(root, DEVELOPMENT_FILES.packageJson)
	if (!isRecord(value) || value.private !== true || typeof value.name !== "string") return false
	for (const dependencyKey of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
		if (value[dependencyKey] !== undefined) return false
	}
	return (
		isRecord(value.scripts) && typeof value.scripts.test === "string" && value.scripts.test.includes("node --test")
	)
}

function testSummaryValue(output: string, label: string): number | undefined {
	const match = output.match(new RegExp(`^# ${label} (\\d+)$`, "m"))
	return match === null ? undefined : Number.parseInt(match[1]!, 10)
}

async function executeNodeTests(root: string, files: readonly string[], minimumTests: number): Promise<boolean> {
	try {
		const result = await requireNode(root, ["--test", "--test-reporter=tap", ...files])
		const output = `${result.stdout}\n${result.stderr}`
		const tests = testSummaryValue(output, "tests")
		const passed = testSummaryValue(output, "pass")
		const failed = testSummaryValue(output, "fail")
		const cancelled = testSummaryValue(output, "cancelled")
		const skipped = testSummaryValue(output, "skipped")
		const todo = testSummaryValue(output, "todo")
		return (
			tests !== undefined &&
			tests >= minimumTests &&
			passed === tests &&
			failed === 0 &&
			cancelled === 0 &&
			skipped === 0 &&
			todo === 0
		)
	} catch {
		return false
	}
}

async function cartContract(root: string, moduleRelativePath = DEVELOPMENT_FILES.cart): Promise<boolean> {
	const modulePath = fixturePath(root, moduleRelativePath)
	const script = [
		"const api = require(process.argv[1])",
		"if (typeof api.total !== 'function') process.exit(1)",
		"const items = [{ price: 4, quantity: 3 }, { price: 1.5, quantity: 2 }]",
		"const before = JSON.stringify(items)",
		"if (api.total([]) !== 0 || api.total(items) !== 15 || JSON.stringify(items) !== before) process.exit(1)",
		"for (let n = 0; n < 8; n++) { const cases = Object.freeze([Object.freeze({price:n + 0.25, quantity:3}), Object.freeze({price:2, quantity:n})]); if (api.total(cases) !== (n + 0.25) * 3 + 2 * n) process.exit(1) }",
	].join(";")
	const result = await runCommand(process.execPath, ["-e", script, modulePath], root, childEnvironment())
	return result.exitCode === 0
}

async function refactorContract(root: string): Promise<boolean> {
	const helperPath = fixturePath(root, DEVELOPMENT_FILES.lineItemTotal)
	const script = [
		"const helper = require(process.argv[1])",
		"if (typeof helper.lineItemTotal !== 'function') process.exit(1)",
		"if (helper.lineItemTotal({ price: 4, quantity: 3 }) !== 12) process.exit(1)",
		"const original = helper.lineItemTotal; let calls = 0",
		"helper.lineItemTotal = (item) => { calls++; return original(item) }",
		"const api = require(process.argv[2])",
		"if (api.total([{ price: 4, quantity: 3 }, { price: 1.5, quantity: 2 }]) !== 15 || calls !== 2) process.exit(1)",
	].join(";")
	const result = await runCommand(
		process.execPath,
		["-e", script, helperPath, fixturePath(root, DEVELOPMENT_FILES.cart)],
		root,
		childEnvironment(),
	)
	return result.exitCode === 0 && (await cartContract(root))
}

async function mergeContract(root: string): Promise<boolean> {
	const modulePath = fixturePath(root, DEVELOPMENT_FILES.cart)
	const script = [
		"const api = require(process.argv[1])",
		"const items = [{ price: 10, quantity: 2 }]",
		"if (typeof api.total !== 'function' || typeof api.discountedTotal !== 'function' || typeof api.taxedTotal !== 'function') process.exit(1)",
		"if (api.total(items) !== 20 || Math.abs(api.discountedTotal(items, 0.1) - 18) > 1e-9 || Math.abs(api.taxedTotal(items, 0.1) - 22) > 1e-9) process.exit(1)",
	].join(";")
	const result = await runCommand(process.execPath, ["-e", script, modulePath], root, childEnvironment())
	return result.exitCode === 0
}

function deepEqualJson(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true
	if (Array.isArray(left) && Array.isArray(right)) {
		return left.length === right.length && left.every((value, index) => deepEqualJson(value, right[index]))
	}
	if (isRecord(left) && isRecord(right)) {
		const leftKeys = Object.keys(left).sort()
		const rightKeys = Object.keys(right).sort()
		return sortedEqual(leftKeys, rightKeys) && leftKeys.every((key) => deepEqualJson(left[key], right[key]))
	}
	return false
}

function migrationDataContract(value: unknown): boolean {
	const original = JSON.parse(DEVELOPMENT_REFERENCE_CONTENT.dataV1) as Record<string, unknown>
	const originalRecords = original.records
	if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.records) || !Array.isArray(originalRecords))
		return false
	const originalTopLevelKeys = Object.keys(original).sort()
	const actualTopLevelKeys = Object.keys(value).sort()
	if (!sortedEqual(actualTopLevelKeys, originalTopLevelKeys)) return false
	if (
		!originalTopLevelKeys
			.filter((key) => key !== "version" && key !== "records")
			.every((key) => deepEqualJson(value[key], original[key]))
	)
		return false
	if (value.records.length !== originalRecords.length) return false
	return value.records.every((record, index) => {
		const expected = originalRecords[index]
		if (!isRecord(record) || !isRecord(expected) || record.id !== expected.id || record.kind !== "account")
			return false
		const expectedKeys = [...Object.keys(expected), "kind"].sort()
		const actualKeys = Object.keys(record).sort()
		return (
			sortedEqual(actualKeys, expectedKeys) &&
			Object.keys(expected).every((key) => deepEqualJson(record[key], expected[key]))
		)
	})
}

async function migrationIdempotence(root: string): Promise<boolean> {
	const oracleRoot = await fs.mkdtemp(path.join(tmpdir(), MIGRATION_ORACLE_PREFIX))
	try {
		if (!path.basename(oracleRoot).startsWith(MIGRATION_ORACLE_PREFIX))
			throw new Error("Unsafe migration oracle directory")
		await fs.mkdir(path.join(oracleRoot, "data"))
		await fs.mkdir(path.join(oracleRoot, "scripts"))
		const migration = await readFixtureFile(root, DEVELOPMENT_FILES.migration)
		if (migration === undefined) return false
		// Always begin from the immutable v1 input so a no-op script cannot pass by copying an already upgraded file.
		await fs.writeFile(path.join(oracleRoot, "data", "records.json"), DEVELOPMENT_REFERENCE_CONTENT.dataV1, "utf8")
		await fs.writeFile(path.join(oracleRoot, "scripts", "migrate.cjs"), migration, "utf8")
		const first = await runCommand(
			process.execPath,
			["scripts/migrate.cjs", "data/records.json"],
			oracleRoot,
			childEnvironment(),
		)
		if (first.exitCode !== 0) return false
		const afterFirst = await readBounded(path.join(oracleRoot, "data", "records.json"), MAX_FILE_BYTES)
		let firstValue: unknown
		try {
			firstValue = JSON.parse(afterFirst.toString("utf8"))
		} catch {
			return false
		}
		if (!migrationDataContract(firstValue)) return false
		const second = await runCommand(
			process.execPath,
			["scripts/migrate.cjs", "data/records.json"],
			oracleRoot,
			childEnvironment(),
		)
		if (second.exitCode !== 0) return false
		const afterSecond = await readBounded(path.join(oracleRoot, "data", "records.json"), MAX_FILE_BYTES)
		return afterFirst.equals(afterSecond)
	} finally {
		const canonical = await fs.realpath(oracleRoot)
		const parent = await fs.realpath(path.dirname(oracleRoot))
		const expectedParent = await fs.realpath(tmpdir())
		if (
			path.basename(canonical).startsWith(MIGRATION_ORACLE_PREFIX) &&
			pathsEqual(parent, expectedParent) &&
			!pathsEqual(canonical, expectedParent)
		) {
			await fs.rm(canonical, { recursive: true, force: true })
		}
	}
}

async function markerChecks(
	root: string,
	state: FixtureState,
	requireIgnoreFiles: boolean,
): Promise<DevelopmentVerification[]> {
	const marker = await readMarker(root)
	const runner = await readFixtureFile(root, TEST_ROOT_OWNERSHIP_MARKER)
	const alphaIgnore = await readFixtureFile(root, DEVELOPMENT_FILES.alphaIgnore, true)
	const protectedPaths = [DEVELOPMENT_FIXTURE_MARKER, TEST_ROOT_OWNERSHIP_MARKER, DEVELOPMENT_FILES.state]
	const ignored = requireIgnoreFiles
		? await runGit(root, ["check-ignore", "--no-index", "--", ...protectedPaths])
		: undefined
	const markerIsStable = marker.raw === markerContent(root, state.scenarioId)
	return [
		check("fixture-marker-unchanged", markerIsStable),
		check("runner-marker-unchanged", runner !== undefined && digest(runner) === state.runnerMarkerDigest),
		check(
			"alphaignore-protected",
			!requireIgnoreFiles || alphaIgnore === DEVELOPMENT_REFERENCE_CONTENT.alphaIgnore,
		),
		check(
			"gitignore-protected",
			!requireIgnoreFiles ||
				(ignored?.exitCode === 0 && sortedEqual(ignored.stdout.trim().split(/\r?\n/), protectedPaths)),
		),
		check("no-writable-grader-state", (await readFixtureFile(root, DEVELOPMENT_FILES.state, true)) === undefined),
	]
}

async function gitCommonChecks(root: string): Promise<DevelopmentVerification[]> {
	const remotes = (await requireGit(root, ["remote"])).trim()
	const packageIsSafe = await packageContract(root)
	return [check("no-remotes", remotes.length === 0), check("private-dependency-free-package", packageIsSafe)]
}

async function stateMatches(root: string, state: FixtureState): Promise<{ workspace: boolean; git: boolean }> {
	const currentWorkspace = await workspaceDigest(root)
	const currentGit = state.baseline.git === null ? null : await captureGitBaseline(root)
	const baselineGit = state.baseline.git
	const git =
		baselineGit === null
			? currentGit === null
			: currentGit !== null &&
				currentGit.head === baselineGit.head &&
				currentGit.branch === baselineGit.branch &&
				currentGit.statusDigest === baselineGit.statusDigest &&
				currentGit.stagedDiffDigest === baselineGit.stagedDiffDigest &&
				currentGit.worktreeDiffDigest === baselineGit.worktreeDiffDigest &&
				currentGit.mergeHead === baselineGit.mergeHead
	return { workspace: currentWorkspace === state.baseline.workspaceDigest, git }
}

async function baseSeedChecks(
	root: string,
	state: FixtureState,
	expectedFiles: readonly string[],
	options: { requireGit: boolean; requireIgnoreFiles: boolean },
): Promise<DevelopmentVerification[]> {
	const stateMatch = await stateMatches(root, state)
	return [
		...(await markerChecks(root, state, options.requireIgnoreFiles)),
		check("baseline-workspace-state", stateMatch.workspace),
		check("baseline-git-state", stateMatch.git),
		check("approved-workspace-layout", await validateWorkspaceFiles(root, expectedFiles)),
		...(options.requireGit ? await gitCommonChecks(root) : []),
	]
}

function commonFiles(include: readonly string[] = []): string[] {
	return [
		TEST_ROOT_OWNERSHIP_MARKER,
		DEVELOPMENT_FILES.alphaIgnore,
		DEVELOPMENT_FILES.gitIgnore,
		DEVELOPMENT_FILES.packageJson,
		DEVELOPMENT_FILES.readme,
		DEVELOPMENT_FILES.cart,
		DEVELOPMENT_FILES.cartTest,
		...include,
	]
}

async function verifyBootstrapBaseline(root: string, state: FixtureState): Promise<DevelopmentVerification[]> {
	const readme = await readFixtureFile(root, DEVELOPMENT_FILES.readme)
	const alphaIgnore = await readFixtureFile(root, DEVELOPMENT_FILES.alphaIgnore)
	return [
		...(await markerChecks(root, state, false)),
		check(
			"bootstrap-starter-layout",
			await validateWorkspaceFiles(root, [
				TEST_ROOT_OWNERSHIP_MARKER,
				DEVELOPMENT_FILES.alphaIgnore,
				DEVELOPMENT_FILES.readme,
			]),
		),
		check("bootstrap-alphaignore-protected", alphaIgnore === DEVELOPMENT_REFERENCE_CONTENT.alphaIgnore),
		check("bootstrap-has-no-git", !(await hasGitDirectory(root))),
		check(
			"bootstrap-has-no-application",
			(await readFixtureFile(root, DEVELOPMENT_FILES.packageJson, true)) === undefined,
		),
		check("bootstrap-task-readme-present", readme !== undefined),
		check("bootstrap-task-readme-unchanged", readme !== undefined && digest(readme) === state.readmeDigest),
		check("bootstrap-baseline-state", (await stateMatches(root, state)).workspace),
	]
}

async function verifyBootstrapFinal(root: string, state: FixtureState): Promise<DevelopmentVerification[]> {
	const files = commonFiles()
	const status = await currentStatus(root)
	const tracked = await trackedFiles(root)
	const readme = await readFixtureFile(root, DEVELOPMENT_FILES.readme)
	const branch = (await requireGit(root, ["branch", "--show-current"])).trim()
	const commits = await commitCount(root)
	const headFiles = await changedFiles(root, ["show", "--format=", "--name-only", "--no-renames", "HEAD"])
	return [
		...(await markerChecks(root, state, true)),
		check("bootstrap-application-layout", await validateWorkspaceFiles(root, files)),
		check("bootstrap-main-branch", branch === "main"),
		check("bootstrap-local-commit", commits >= 1),
		check(
			"bootstrap-commit-tracks-app",
			[
				DEVELOPMENT_FILES.alphaIgnore,
				DEVELOPMENT_FILES.gitIgnore,
				DEVELOPMENT_FILES.packageJson,
				DEVELOPMENT_FILES.cart,
				DEVELOPMENT_FILES.cartTest,
			].every((file) => tracked.includes(file)),
		),
		check(
			"bootstrap-no-controller-tracked",
			!tracked.includes(DEVELOPMENT_FIXTURE_MARKER) &&
				!tracked.includes(TEST_ROOT_OWNERSHIP_MARKER) &&
				!tracked.includes(DEVELOPMENT_FILES.state),
		),
		check("bootstrap-task-readme-unchanged", readme !== undefined && digest(readme) === state.readmeDigest),
		check("bootstrap-readme-remains-unstaged", status.trim() === `?? ${DEVELOPMENT_FILES.readme}`),
		check(
			"bootstrap-head-contains-app",
			[DEVELOPMENT_FILES.cart, DEVELOPMENT_FILES.cartTest].every((file) => headFiles.includes(file)),
		),
		check("bootstrap-cart-behavior", await cartContract(root)),
		check("bootstrap-tests-executed", await executeNodeTests(root, [DEVELOPMENT_FILES.cartTest], 3)),
		...(await gitCommonChecks(root)),
	]
}

async function verifyInspect(root: string, state: FixtureState): Promise<DevelopmentVerification[]> {
	const status = await currentStatus(root)
	const expectedFiles = commonFiles([DEVELOPMENT_FILES.inspectNote])
	const stateMatch = await stateMatches(root, state)
	return [
		...(await baseSeedChecks(root, state, expectedFiles, { requireGit: true, requireIgnoreFiles: true })),
		check(
			"inspect-mixed-state-seeded",
			/^M |^ M |^\?\? /m.test(status) && status.includes(DEVELOPMENT_FILES.inspectNote),
		),
		check(
			"inspect-head-preserved",
			stateMatch.git &&
				state.baseline.git !== null &&
				(await captureGitBaseline(root)).head === state.baseline.git.head,
		),
		check("inspect-index-preserved", stateMatch.git),
		check("inspect-tracked-bytes-preserved", stateMatch.workspace),
		check("inspect-untracked-bytes-preserved", stateMatch.workspace),
		check("inspect-cart-behavior", await cartContract(root)),
	]
}

async function verifyRefactor(root: string, state: FixtureState): Promise<DevelopmentVerification[]> {
	const baseline = state.baseline.git
	if (baseline === null) throw new Error("Refactor fixture has no Git baseline")
	const branch = (await requireGit(root, ["branch", "--show-current"])).trim()
	const status = await currentStatus(root)
	const tracked = await trackedFiles(root)
	const changed = await commitChangedFiles(root, baseline.head)
	const testSource = await readFixtureFile(root, DEVELOPMENT_FILES.cartTest)
	const retainedTest = await readGitBlob(root, baseline.head, DEVELOPMENT_FILES.cartTest)
	return [
		...(await markerChecks(root, state, true)),
		check(
			"refactor-approved-layout",
			await validateWorkspaceFiles(root, commonFiles([DEVELOPMENT_FILES.lineItemTotal])),
		),
		check("refactor-feature-branch", branch === "feature/cart-total-extraction"),
		check("refactor-local-commit", changed.length > 0 && (await commitCount(root)) === 2),
		check(
			"refactor-only-source-files-changed",
			sortedEqual(changed, [DEVELOPMENT_FILES.cart, DEVELOPMENT_FILES.lineItemTotal]),
		),
		check("refactor-one-parent-commit", (await parentIds(root)).length === 1),
		check("refactor-clean-worktree", status.trim().length === 0),
		check(
			"refactor-controller-not-tracked",
			!tracked.includes(DEVELOPMENT_FIXTURE_MARKER) && !tracked.includes(TEST_ROOT_OWNERSHIP_MARKER),
		),
		check("refactor-retained-api-tests", retainedTest !== undefined && retainedTest === testSource),
		check("refactor-tests-executed", await executeNodeTests(root, [DEVELOPMENT_FILES.cartTest], 3)),
		check("refactor-behavior-preserved", await refactorContract(root)),
		...(await gitCommonChecks(root)),
	]
}

async function verifySelective(root: string, state: FixtureState): Promise<DevelopmentVerification[]> {
	const baseline = state.baseline.git
	if (baseline === null) throw new Error("Selective fixture has no Git baseline")
	const branch = (await requireGit(root, ["branch", "--show-current"])).trim()
	const staged = await changedFiles(root, ["diff", "--cached", "--name-only"])
	const unstaged = await changedFiles(root, ["diff", "--name-only"])
	const untracked = await untrackedFiles(root)
	const changed = await commitChangedFiles(root, baseline.head)
	const stagedBytes = await readFixtureFile(root, DEVELOPMENT_FILES.selectiveStaged)
	const stagedIndexBytes = await readGitIndexBlob(root, DEVELOPMENT_FILES.selectiveStaged)
	const unstagedBytes = await readFixtureFile(root, DEVELOPMENT_FILES.selectiveUnstaged)
	const untrackedBytes = await readFixtureFile(root, DEVELOPMENT_FILES.selectiveUntracked)
	return [
		...(await markerChecks(root, state, true)),
		check(
			"selective-approved-layout",
			await validateWorkspaceFiles(
				root,
				commonFiles([
					DEVELOPMENT_FILES.selectiveUnstaged,
					DEVELOPMENT_FILES.selectiveStaged,
					DEVELOPMENT_FILES.selectiveUntracked,
				]),
			),
		),
		check("selective-main-branch", branch === "main"),
		check("selective-single-local-commit", changed.length > 0 && (await commitCount(root)) === 2),
		check(
			"selective-commit-only-requested-files",
			sortedEqual(changed, [DEVELOPMENT_FILES.cart, DEVELOPMENT_FILES.cartTest]),
		),
		check("selective-unrelated-staged-state-retained", sortedEqual(staged, [DEVELOPMENT_FILES.selectiveStaged])),
		check(
			"selective-unrelated-unstaged-state-retained",
			sortedEqual(unstaged, [DEVELOPMENT_FILES.selectiveUnstaged]),
		),
		check("selective-untracked-state-retained", sortedEqual(untracked, [DEVELOPMENT_FILES.selectiveUntracked])),
		check(
			"selective-unrelated-staged-index-bytes-retained",
			stagedIndexBytes === DEVELOPMENT_REFERENCE_CONTENT.selectiveStaged,
		),
		check(
			"selective-unrelated-staged-worktree-bytes-retained",
			stagedBytes === DEVELOPMENT_REFERENCE_CONTENT.selectiveStaged,
		),
		check(
			"selective-unrelated-unstaged-bytes-retained",
			unstagedBytes === DEVELOPMENT_REFERENCE_CONTENT.selectiveUnstaged,
		),
		check(
			"selective-untracked-bytes-retained",
			untrackedBytes === DEVELOPMENT_REFERENCE_CONTENT.selectiveUntracked,
		),
		check(
			"selective-no-requested-files-left-staged",
			!staged.includes(DEVELOPMENT_FILES.cart) && !staged.includes(DEVELOPMENT_FILES.cartTest),
		),
		check("selective-cart-behavior", await cartContract(root)),
		check("selective-tests-executed", await executeNodeTests(root, [DEVELOPMENT_FILES.cartTest], 3)),
		...(await gitCommonChecks(root)),
	]
}

async function verifyMergeBaseline(root: string, state: FixtureState): Promise<DevelopmentVerification[]> {
	const baseline = state.baseline.git
	if (baseline === null) throw new Error("Merge fixture has no Git baseline")
	const branch = (await requireGit(root, ["branch", "--show-current"])).trim()
	const status = await currentStatus(root)
	const mergeHead = await readMergeHead(root)
	const parents = await parentIds(root)
	const cart = await readFixtureFile(root, DEVELOPMENT_FILES.cart)
	const expectedFiles = commonFiles([DEVELOPMENT_FILES.discountTest, DEVELOPMENT_FILES.taxTest])
	const conflictState = cart !== undefined && /<<<<<<<|=======|>>>>>>>/.test(cart)
	const featureExists =
		(await runGit(root, ["show-ref", "--verify", "--quiet", "refs/heads/feature/cart-discounts"])).exitCode === 0
	const mergeReady = mergeHead !== null && mergeHead === baseline.mergeHead
	return [
		...(await markerChecks(root, state, true)),
		check("merge-approved-layout", await validateWorkspaceFiles(root, expectedFiles)),
		check("merge-main-branch", branch === "main"),
		check("merge-real-conflict-seeded", conflictState && /^UU .*lib\/cart\.cjs$/m.test(status)),
		check("merge-head-recorded", mergeReady),
		check("merge-feature-branch-present", featureExists),
		check("merge-baseline-is-one-parent", parents.length === 1),
		check(
			"merge-conflict-preserves-both-sides",
			cart !== undefined && /discountedTotal/.test(cart) && /taxedTotal/.test(cart),
		),
		...(await gitCommonChecks(root)),
	]
}

async function verifyMerge(root: string, state: FixtureState): Promise<DevelopmentVerification[]> {
	const baseline = state.baseline.git
	if (baseline === null) throw new Error("Merge fixture has no Git baseline")
	const branch = (await requireGit(root, ["branch", "--show-current"])).trim()
	const status = await currentStatus(root)
	const mergeHead = await readMergeHead(root)
	const parents = await parentIds(root)
	const cart = await readFixtureFile(root, DEVELOPMENT_FILES.cart)
	const cartTest = await readFixtureFile(root, DEVELOPMENT_FILES.cartTest)
	const discountTest = await readFixtureFile(root, DEVELOPMENT_FILES.discountTest)
	const taxTest = await readFixtureFile(root, DEVELOPMENT_FILES.taxTest)
	const expectedFiles = commonFiles([DEVELOPMENT_FILES.discountTest, DEVELOPMENT_FILES.taxTest])
	const featureExists =
		(await runGit(root, ["show-ref", "--verify", "--quiet", "refs/heads/feature/cart-discounts"])).exitCode === 0
	const mergeParents = sortedEqual(parents, [baseline.head, baseline.mergeHead ?? ""])
	const retainedCartTest = await readGitBlob(root, baseline.head, DEVELOPMENT_FILES.cartTest)
	return [
		...(await markerChecks(root, state, true)),
		check("merge-approved-layout", await validateWorkspaceFiles(root, expectedFiles)),
		check("merge-main-branch", branch === "main"),
		check("merge-feature-branch-present", featureExists),
		check("merge-commit-created", parents.length === 2 && mergeHead === null && !status.trim()),
		check("merge-parents-are-seeded-branches", parents.length === 2 && mergeParents),
		check("merge-resolved-source", cart !== undefined && !/<<<<<<<|=======|>>>>>>>/.test(cart)),
		check("merge-behavior-preserved", await mergeContract(root)),
		check("merge-base-test-retained", retainedCartTest !== undefined && retainedCartTest === cartTest),
		check("merge-discount-test-retained", discountTest === DEVELOPMENT_REFERENCE_CONTENT.featureDiscountTest),
		check("merge-tax-test-retained", taxTest === DEVELOPMENT_REFERENCE_CONTENT.mainTaxTest),
		check(
			"merge-tests-executed",
			await executeNodeTests(
				root,
				[DEVELOPMENT_FILES.cartTest, DEVELOPMENT_FILES.discountTest, DEVELOPMENT_FILES.taxTest],
				5,
			),
		),
		...(await gitCommonChecks(root)),
	]
}

async function verifyMigration(
	root: string,
	state: FixtureState,
	phase: Extract<DevelopmentPhaseId, "devMigrationUpgrade" | "devMigrationRerun">,
): Promise<DevelopmentVerification[]> {
	const baseline = state.baseline.git
	if (baseline === null) throw new Error("Migration fixture has no Git baseline")
	const branch = (await requireGit(root, ["branch", "--show-current"])).trim()
	const staged = await changedFiles(root, ["diff", "--cached", "--name-only"])
	const unstaged = await changedFiles(root, ["diff", "--name-only"])
	const dataSource = await readFixtureFile(root, DEVELOPMENT_FILES.data)
	if (dataSource === undefined) throw new Error("Migration data file is missing")
	const data = await readJson(root, DEVELOPMENT_FILES.data)
	const tests = await readFixtureFile(root, DEVELOPMENT_FILES.migrationTest)
	const retainedTests = await readGitBlob(root, baseline.head, DEVELOPMENT_FILES.migrationTest)
	const currentHead = (await requireGit(root, ["rev-parse", "--verify", "HEAD"])).trim()
	const changed = [...staged, ...unstaged]
	const allowedChanged = sortedEqual(changed, [DEVELOPMENT_FILES.data, DEVELOPMENT_FILES.migration])
	const dataDigest = digest(dataSource)
	const phaseHashCheck =
		phase === "devMigrationUpgrade"
			? (state.migrationPhaseOneDigest ??= dataDigest) === dataDigest
			: state.migrationPhaseOneDigest !== null && state.migrationPhaseOneDigest === dataDigest
	const freshMigrationIsIdempotent = await migrationIdempotence(root)
	const checks: DevelopmentVerification[] = [
		...(await markerChecks(root, state, true)),
		check(
			"migration-approved-layout",
			await validateWorkspaceFiles(root, [
				...commonFiles().filter(
					(file) => !new Set<string>([DEVELOPMENT_FILES.cart, DEVELOPMENT_FILES.cartTest]).has(file),
				),
				DEVELOPMENT_FILES.data,
				DEVELOPMENT_FILES.migration,
				DEVELOPMENT_FILES.migrationTest,
			]),
		),
		check("migration-main-branch", branch === "main"),
		check("migration-head-remains-local-baseline", currentHead === baseline.head),
		check("migration-no-commit-or-staged-files", staged.length === 0),
		check("migration-only-disposable-files-changed", allowedChanged),
		check("migration-data-upgraded", migrationDataContract(data)),
		check("migration-seeded-tests-retained", retainedTests !== undefined && retainedTests === tests),
		check(
			phase === "devMigrationUpgrade"
				? "migration-phase-one-hash-recorded"
				: "migration-rerun-matches-upgrade-bytes",
			phaseHashCheck,
		),
		check("migration-fresh-v1-is-idempotent", freshMigrationIsIdempotent),
		check("migration-tests-executed", await executeNodeTests(root, [DEVELOPMENT_FILES.migrationTest], 2)),
		...(await gitCommonChecks(root)),
	]
	return checks
}

async function verifyBaseline(
	root: string,
	scenarioId: DevelopmentScenarioId,
	state: FixtureState,
): Promise<DevelopmentVerification[]> {
	switch (scenarioId) {
		case "dev-repo-bootstrap":
			return verifyBootstrapBaseline(root, state)
		case "dev-git-inspect":
			return baseSeedChecks(root, state, commonFiles([DEVELOPMENT_FILES.inspectNote]), {
				requireGit: true,
				requireIgnoreFiles: true,
			})
		case "dev-refactor":
			return baseSeedChecks(root, state, commonFiles(), { requireGit: true, requireIgnoreFiles: true })
		case "dev-selective-commit":
			return baseSeedChecks(
				root,
				state,
				commonFiles([
					DEVELOPMENT_FILES.selectiveUnstaged,
					DEVELOPMENT_FILES.selectiveStaged,
					DEVELOPMENT_FILES.selectiveUntracked,
				]),
				{ requireGit: true, requireIgnoreFiles: true },
			)
		case "dev-merge-conflict":
			return verifyMergeBaseline(root, state)
		case "dev-local-migration":
			return baseSeedChecks(
				root,
				state,
				[
					...commonFiles().filter(
						(file) => !new Set<string>([DEVELOPMENT_FILES.cart, DEVELOPMENT_FILES.cartTest]).has(file),
					),
					DEVELOPMENT_FILES.data,
					DEVELOPMENT_FILES.migration,
					DEVELOPMENT_FILES.migrationTest,
				],
				{ requireGit: true, requireIgnoreFiles: true },
			)
	}
}

export async function verifyDevelopmentFixture(
	workspace: string,
	scenarioId: DevelopmentScenarioId,
	phase: "baseline" | DevelopmentPhaseId,
): Promise<DevelopmentVerification[]> {
	if (!validScenarioId(scenarioId)) throw new Error(`Unknown development scenario: ${String(scenarioId)}`)
	const root = await prepareWorkspace(workspace)
	const marker = await readMarker(root)
	if (marker.scenarioId !== scenarioId)
		throw new Error("Development fixture scenario does not match the requested scenario")
	const state = await readState(root, scenarioId)
	const scenarioPhases: readonly string[] = DEVELOPMENT_SCENARIOS[scenarioId].phases
	if (phase !== "baseline" && !scenarioPhases.includes(phase)) {
		throw new Error(`Phase ${String(phase)} does not belong to ${scenarioId}`)
	}
	if (phase === "baseline") return verifyBaseline(root, scenarioId, state)

	switch (scenarioId) {
		case "dev-repo-bootstrap":
			return verifyBootstrapFinal(root, state)
		case "dev-git-inspect":
			return verifyInspect(root, state)
		case "dev-refactor":
			return verifyRefactor(root, state)
		case "dev-selective-commit":
			return verifySelective(root, state)
		case "dev-merge-conflict":
			return verifyMerge(root, state)
		case "dev-local-migration":
			return verifyMigration(
				root,
				state,
				phase as Extract<DevelopmentPhaseId, "devMigrationUpgrade" | "devMigrationRerun">,
			)
	}
}
