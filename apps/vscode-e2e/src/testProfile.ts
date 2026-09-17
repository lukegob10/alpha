import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"

import { TestRunError } from "./runFailure"

export const TEST_ROOT_OWNERSHIP_MARKER = ".alpha-e2e-owned.json"
export const TEST_ROOT_OWNERSHIP_PURPOSE = "alpha-vscode-e2e"
const OWNERSHIP_SCHEMA_VERSION = 1
const OWNERSHIP_MARKER_MAX_BYTES = 4 * 1024
const TEMPORARY_ROOT_PREFIX = "alpha-vscode-e2e-"
const EXACT_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export const TEST_ROOT_KINDS = ["profile", "workspace", "temporary"] as const
export type TestRootKind = (typeof TEST_ROOT_KINDS)[number]

export type TestProfileOptions = {
	/** Normal development hosts need an isolated cross-application storage directory too. */
	sharedData?: boolean
	profileDir?: string
	workspace?: string
	artifactsDir?: string
	vscodeVersion: string
	initializeProfile?: boolean
}

export type TestProfile = {
	sharedDataDir?: string
	workspace: string
	userDataDir: string
	extensionsDir: string
	artifactsDir: string
	profileDir?: string
	temporaryRoot?: string
}

type ScopeRoots = {
	home: string
	repository: string
	temporary: string
	vsCodeData: string[]
}

type TemporaryOwnership = {
	root: string
	device: number
	inode: number
}

const temporaryOwnership = new WeakMap<TestProfile, TemporaryOwnership>()

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const withProfileInvalid = async <T>(action: () => Promise<T>): Promise<T> => {
	try {
		return await action()
	} catch (error) {
		if (error instanceof TestRunError) throw error
		throw new TestRunError("profile-invalid", errorMessage(error))
	}
}

const isErrno = (error: unknown, code: string): boolean =>
	typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code

const normalizeAbsolutePath = (value: string): string => {
	const resolved = path.normalize(path.resolve(value))
	const root = path.parse(resolved).root
	return resolved.length > root.length ? resolved.replace(/[\\/]+$/, "") : root
}

const normalizePathForComparison = (value: string): string => {
	const normalized = normalizeAbsolutePath(value)
	return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

const isSamePath = (left: string, right: string): boolean =>
	normalizePathForComparison(left) === normalizePathForComparison(right)

const isSameOrDescendant = (candidate: string, ancestor: string): boolean => {
	const normalizedCandidate = normalizePathForComparison(candidate)
	const normalizedAncestor = normalizePathForComparison(ancestor)
	if (normalizedCandidate === normalizedAncestor) return true
	if (normalizedAncestor.endsWith(path.sep)) return normalizedCandidate.startsWith(normalizedAncestor)
	return normalizedCandidate.startsWith(`${normalizedAncestor}${path.sep}`)
}

const isSameOrAncestor = (candidate: string, descendant: string): boolean => isSameOrDescendant(descendant, candidate)

const isRelatedPath = (left: string, right: string): boolean =>
	isSameOrDescendant(left, right) || isSameOrDescendant(right, left)

const absolutePath = (value: string, label: string): string => {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${label} must be a non-empty path`)
	}
	if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path: ${value}`)
	return normalizeAbsolutePath(value)
}

const inspectRealPath = async (candidate: string, label: string): Promise<string> => {
	try {
		return normalizeAbsolutePath(await fs.realpath(candidate))
	} catch (error) {
		throw new Error(`Unable to resolve ${label} ${candidate}: ${errorMessage(error)}`)
	}
}

const resolveForComparison = async (candidate: string, label: string): Promise<string> => {
	let current = normalizeAbsolutePath(candidate)
	const suffix: string[] = []

	while (true) {
		try {
			const resolved = await fs.realpath(current)
			return normalizeAbsolutePath(path.join(resolved, ...suffix))
		} catch (error) {
			if (!isErrno(error, "ENOENT") && !isErrno(error, "ENOTDIR")) {
				throw new Error(`Unable to resolve ${label} ${candidate}: ${errorMessage(error)}`)
			}
		}

		const parent = path.dirname(current)
		if (parent === current) return current
		suffix.unshift(path.basename(current))
		current = parent
	}
}

const assertNoLinkComponents = async (candidate: string, label: string): Promise<void> => {
	const absolute = path.resolve(candidate)
	const parsed = path.parse(absolute)
	let current = parsed.root

	const rootStats = await fs.lstat(current).catch((error: unknown) => {
		if (isErrno(error, "ENOENT")) return undefined
		throw error
	})
	if (rootStats?.isSymbolicLink()) {
		throw new Error(`${label} uses a symlink/reparse-point root: ${candidate}`)
	}

	const segments = path.relative(parsed.root, absolute).split(path.sep).filter(Boolean)
	for (const segment of segments) {
		current = path.join(current, segment)
		let stats
		try {
			stats = await fs.lstat(current)
		} catch (error) {
			if (isErrno(error, "ENOENT")) return
			throw new Error(`Unable to inspect ${label} ${candidate}: ${errorMessage(error)}`)
		}

		if (stats.isSymbolicLink()) {
			throw new Error(`${label} uses a symlink/reparse-point component: ${current}`)
		}

		let resolved: string
		try {
			resolved = await fs.realpath(current)
		} catch (error) {
			if (isErrno(error, "ENOENT")) return
			throw new Error(`Unable to resolve ${label} ${current}: ${errorMessage(error)}`)
		}
		if (process.platform !== "win32" && !isSamePath(resolved, current)) {
			throw new Error(`${label} is a symlink/reparse alias: ${current}`)
		}
	}
}

const findRepositoryRoot = async (): Promise<string> => {
	let current = path.resolve(process.cwd())
	while (true) {
		try {
			await fs.lstat(path.join(current, ".git"))
			return inspectRealPath(current, "the current repository")
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error
		}

		const parent = path.dirname(current)
		if (parent === current) break
		current = parent
	}

	return inspectRealPath(process.cwd(), "the current working directory")
}

const addUniquePath = (set: Set<string>, candidate: string | undefined): void => {
	if (candidate && candidate.trim().length > 0) set.add(normalizePathForComparison(candidate))
}

const getVsCodeDataRoots = (home: string): string[] => {
	const roots = new Set<string>()
	const dataNames = ["Code", "Code - Insiders", "VSCodium", "VSCodium - Insiders"]
	const dataParents = [
		path.join(home, ".config"),
		path.join(home, ".cache"),
		path.join(home, ".local", "share"),
		path.join(home, "Library", "Application Support"),
		path.join(home, "AppData", "Roaming"),
		path.join(home, "AppData", "Local"),
	]

	for (const parent of dataParents) {
		for (const name of dataNames) addUniquePath(roots, path.join(parent, name))
	}

	for (const variable of [
		"APPDATA",
		"LOCALAPPDATA",
		"VSCODE_PORTABLE",
		"VSCODE_USER_DATA_DIR",
		"VSCODE_EXTENSIONS",
	]) {
		if (variable.startsWith("VSCODE_")) addUniquePath(roots, process.env[variable])
		if ((variable === "APPDATA" || variable === "LOCALAPPDATA") && process.env[variable]) {
			for (const name of dataNames) addUniquePath(roots, path.join(process.env[variable]!, name))
		}
	}

	addUniquePath(roots, path.join(home, ".vscode"))
	return [...roots]
}

const getScopeRoots = async (): Promise<ScopeRoots> => {
	const home = normalizePathForComparison(await resolveForComparison(os.homedir(), "home directory"))
	const repository = await findRepositoryRoot()
	const temporary = normalizePathForComparison(await resolveForComparison(os.tmpdir(), "system temporary root"))
	return {
		home,
		repository,
		temporary,
		vsCodeData: getVsCodeDataRoots(home),
	}
}

const assertWithinSafeScope = (candidate: string, label: string, scope: ScopeRoots): void => {
	const normalized = normalizePathForComparison(candidate)
	if (normalized === normalizePathForComparison(path.parse(candidate).root)) {
		throw new Error(`${label} cannot be the filesystem root: ${candidate}`)
	}
	if (isSameOrAncestor(normalized, scope.home)) {
		throw new Error(`${label} cannot be the home or a broad parent of home: ${candidate}`)
	}
	if (isRelatedPath(normalized, scope.repository)) {
		throw new Error(`${label} cannot be the current repository or a path related to it: ${candidate}`)
	}
	if (normalized === scope.temporary) {
		throw new Error(`${label} cannot be the system temporary root: ${candidate}`)
	}
	if (scope.vsCodeData.some((root) => isRelatedPath(normalized, root))) {
		throw new Error(`${label} cannot overlap normal VS Code data: ${candidate}`)
	}
}

const validateExplicitLocation = async (candidate: string, label: string, scope: ScopeRoots): Promise<string> => {
	const normalized = absolutePath(candidate, label)
	assertWithinSafeScope(normalized, label, scope)
	await assertNoLinkComponents(normalized, label)
	const resolved = await resolveForComparison(normalized, label)
	assertWithinSafeScope(resolved, label, scope)
	return resolved
}

const inspectDirectory = async (candidate: string, label: string): Promise<string | undefined> => {
	let stats
	try {
		stats = await fs.lstat(candidate)
	} catch (error) {
		if (isErrno(error, "ENOENT")) return undefined
		throw new Error(`Unable to inspect ${label} ${candidate}: ${errorMessage(error)}`)
	}

	if (stats.isSymbolicLink()) {
		throw new Error(`${label} is a symlink/reparse alias: ${candidate}`)
	}
	if (!stats.isDirectory()) throw new Error(`${label} must be a directory: ${candidate}`)

	const resolved = await inspectRealPath(candidate, label)
	if (process.platform !== "win32" && !isSamePath(resolved, candidate)) {
		throw new Error(`${label} is a symlink/reparse alias: ${candidate}`)
	}
	return resolved
}

const ensureDirectory = async (candidate: string, label: string): Promise<string> => {
	const existing = await inspectDirectory(candidate, label)
	if (existing) return existing

	await fs.mkdir(candidate, { recursive: true })
	const created = await inspectDirectory(candidate, label)
	if (!created) throw new Error(`${label} disappeared after creation: ${candidate}`)
	return created
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const readOwnershipMarker = async (root: string, expectedKind?: TestRootKind): Promise<TestRootKind> => {
	const markerPath = path.join(root, TEST_ROOT_OWNERSHIP_MARKER)
	const stats = await fs.lstat(markerPath).catch((error: unknown) => {
		if (isErrno(error, "ENOENT")) return undefined
		throw error
	})
	if (!stats) throw new Error(`Owned test root is not initialized; missing ${TEST_ROOT_OWNERSHIP_MARKER}: ${root}`)
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new Error(`Owned test root marker is not a regular file: ${markerPath}`)
	}
	if (stats.size > OWNERSHIP_MARKER_MAX_BYTES) {
		throw new Error(`Owned test root marker exceeds ${OWNERSHIP_MARKER_MAX_BYTES} bytes: ${markerPath}`)
	}

	let value: unknown
	let markerText: string
	try {
		const handle = await fs.open(markerPath, "r")
		try {
			const buffer = Buffer.alloc(OWNERSHIP_MARKER_MAX_BYTES + 1)
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
			if (bytesRead > OWNERSHIP_MARKER_MAX_BYTES) {
				throw new Error(`Owned test root marker exceeds ${OWNERSHIP_MARKER_MAX_BYTES} bytes: ${markerPath}`)
			}
			markerText = buffer.subarray(0, bytesRead).toString("utf8")
		} finally {
			await handle.close()
		}
		value = JSON.parse(markerText)
	} catch (error) {
		throw new Error(`Owned test root marker is invalid JSON at ${markerPath}: ${errorMessage(error)}`)
	}
	if (!isRecord(value)) throw new Error(`Owned test root marker must contain an object: ${markerPath}`)
	const keys = Object.keys(value).sort()
	if (keys.join("\0") !== ["kind", "purpose", "schemaVersion"].join("\0")) {
		throw new Error(`Owned test root marker has an unexpected schema: ${markerPath}`)
	}
	if (value.schemaVersion !== OWNERSHIP_SCHEMA_VERSION || value.purpose !== TEST_ROOT_OWNERSHIP_PURPOSE) {
		throw new Error(`Owned test root marker has an unexpected purpose or schema version: ${markerPath}`)
	}
	if (!TEST_ROOT_KINDS.includes(value.kind as TestRootKind)) {
		throw new Error(`Owned test root marker has an unexpected kind: ${markerPath}`)
	}
	const kind = value.kind as TestRootKind
	if (expectedKind !== undefined && kind !== expectedKind) {
		throw new Error(`Owned test root marker kind ${kind} does not match expected ${expectedKind}: ${markerPath}`)
	}
	return kind
}

const writeOwnershipMarker = async (root: string, kind: TestRootKind): Promise<void> => {
	const markerPath = path.join(root, TEST_ROOT_OWNERSHIP_MARKER)
	const marker = {
		schemaVersion: OWNERSHIP_SCHEMA_VERSION,
		purpose: TEST_ROOT_OWNERSHIP_PURPOSE,
		kind,
	}
	try {
		await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
	} catch (error) {
		if (!isErrno(error, "EEXIST")) throw error
		await readOwnershipMarker(root, kind)
	}
}

const validatePersistentRootEntries = async (root: string): Promise<void> => {
	const entries = await fs.readdir(root)
	for (const name of entries) {
		const entryPath = path.join(root, name)
		const stats = await fs.lstat(entryPath)
		if (stats.isSymbolicLink()) {
			throw new Error(`Persistent profile root contains a symlink/reparse alias: ${entryPath}`)
		}
		if (name === TEST_ROOT_OWNERSHIP_MARKER) {
			if (!stats.isFile()) throw new Error(`Persistent profile marker is not a regular file: ${entryPath}`)
			continue
		}
		if (!stats.isDirectory() || !EXACT_VERSION_PATTERN.test(name)) {
			throw new Error(`Persistent profile root contains an unknown entry: ${entryPath}`)
		}
		const resolved = await inspectRealPath(entryPath, "persistent version profile")
		if (!isSamePath(resolved, entryPath)) {
			throw new Error(`Persistent version profile is a symlink/reparse alias: ${entryPath}`)
		}
	}
}

const preparePersistentRoot = async (root: string, initialize: boolean): Promise<string> => {
	let resolvedRoot = await inspectDirectory(root, "persistent profile root")
	if (!resolvedRoot) {
		if (!initialize) {
			throw new Error(`Persistent profile root does not exist; pass initializeProfile to create it: ${root}`)
		}
		await fs.mkdir(root, { recursive: true })
		resolvedRoot = await inspectDirectory(root, "persistent profile root")
		if (!resolvedRoot) throw new Error(`Persistent profile root disappeared after creation: ${root}`)
	}

	const entries = await fs.readdir(resolvedRoot)
	if (entries.length === 0) {
		if (!initialize) {
			throw new Error(`Persistent profile root is empty and uninitialized: ${root}`)
		}
		await writeOwnershipMarker(resolvedRoot, "profile")
	} else {
		await readOwnershipMarker(resolvedRoot, "profile")
	}

	await readOwnershipMarker(resolvedRoot, "profile")
	await validatePersistentRootEntries(resolvedRoot)
	return resolvedRoot
}

const prepareMarkedDirectory = async (
	root: string,
	label: string,
	kind: TestRootKind,
	initialize: boolean,
): Promise<string> => {
	let resolvedRoot = await inspectDirectory(root, label)
	if (!resolvedRoot) {
		if (!initialize) throw new Error(`${label} does not exist and is not initialized: ${root}`)
		await fs.mkdir(root, { recursive: true })
		resolvedRoot = await inspectDirectory(root, label)
		if (!resolvedRoot) throw new Error(`${label} disappeared after creation: ${root}`)
	}

	const entries = await fs.readdir(resolvedRoot)
	if (entries.length === 0) {
		if (!initialize) throw new Error(`${label} is empty and uninitialized: ${root}`)
		await writeOwnershipMarker(resolvedRoot, kind)
	} else {
		await readOwnershipMarker(resolvedRoot, kind)
	}
	await readOwnershipMarker(resolvedRoot, kind)
	return resolvedRoot
}

const createTemporaryProfile = async (): Promise<TestProfile> => {
	let ownership: TemporaryOwnership | undefined
	try {
		const createdRoot = await fs.mkdtemp(path.join(os.tmpdir(), TEMPORARY_ROOT_PREFIX))
		const root = await inspectRealPath(createdRoot, "temporary profile root")
		const rootStats = await fs.lstat(root)
		if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
			throw new Error(`Temporary profile root is not a regular directory: ${root}`)
		}
		ownership = { root, device: rootStats.dev, inode: rootStats.ino }
		await writeOwnershipMarker(root, "temporary")

		const workspace = await ensureDirectory(path.join(root, "workspace"), "temporary workspace")
		const userDataDir = await ensureDirectory(path.join(root, "user-data"), "temporary user data directory")
		const extensionsDir = await ensureDirectory(path.join(root, "extensions"), "temporary extensions directory")
		const artifactsDir = await ensureDirectory(path.join(root, "artifacts"), "temporary artifacts directory")
		const profile: TestProfile = { workspace, userDataDir, extensionsDir, artifactsDir, temporaryRoot: root }
		temporaryOwnership.set(profile, ownership)
		return profile
	} catch (error) {
		if (ownership) await removeOwnedTemporaryRoot(ownership).catch(() => undefined)
		throw error
	}
}

const removeOwnedTemporaryRoot = async (ownership: TemporaryOwnership): Promise<void> => {
	let temporaryRoot: string
	try {
		temporaryRoot = await inspectRealPath(os.tmpdir(), "system temporary root")
	} catch {
		temporaryRoot = normalizeAbsolutePath(os.tmpdir())
	}
	if (!isSameOrDescendant(ownership.root, temporaryRoot) || isSamePath(ownership.root, temporaryRoot)) return
	if (!path.basename(ownership.root).toLowerCase().startsWith(TEMPORARY_ROOT_PREFIX.toLowerCase())) return

	let stats
	try {
		stats = await fs.lstat(ownership.root)
	} catch (error) {
		if (isErrno(error, "ENOENT")) return
		throw error
	}
	if (stats.isSymbolicLink() || !stats.isDirectory()) return
	if (
		ownership.device !== 0 &&
		ownership.inode !== 0 &&
		(stats.dev !== ownership.device || stats.ino !== ownership.inode)
	) {
		return
	}

	const resolved = await fs.realpath(ownership.root)
	if (!isSamePath(resolved, ownership.root)) return
	await fs.rm(ownership.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

const assertOwnedTestRootInternal = async (root: string, expectedKind?: TestRootKind): Promise<void> => {
	if (expectedKind !== undefined && !TEST_ROOT_KINDS.includes(expectedKind)) {
		throw new Error(`Unknown owned test root kind: ${String(expectedKind)}`)
	}
	const scope = await getScopeRoots()
	const candidate = absolutePath(root, "owned test root")
	assertWithinSafeScope(candidate, "owned test root", scope)
	await assertNoLinkComponents(candidate, "owned test root")
	const resolved = await inspectDirectory(candidate, "owned test root")
	if (!resolved) throw new Error(`Owned test root does not exist: ${candidate}`)
	assertWithinSafeScope(resolved, "owned test root", scope)
	await readOwnershipMarker(resolved, expectedKind)
}

export async function assertOwnedTestRoot(root: string, expectedKind?: TestRootKind): Promise<void> {
	return withProfileInvalid(() => assertOwnedTestRootInternal(root, expectedKind))
}

export async function prepareTestProfile(options: TestProfileOptions): Promise<TestProfile> {
	return withProfileInvalid(async () => {
		if (!options || typeof options !== "object") throw new Error("Test profile options are required")
		if (options.sharedData !== undefined && typeof options.sharedData !== "boolean")
			throw new Error("sharedData must be a boolean")
		if (options.sharedData && !options.profileDir)
			throw new Error("Shared data requires an owned persistent profile")
		if (typeof options.vscodeVersion !== "string" || options.vscodeVersion.length === 0) {
			throw new Error("vscodeVersion must be a non-empty string")
		}
		if (options.initializeProfile !== undefined && typeof options.initializeProfile !== "boolean") {
			throw new Error("initializeProfile must be a boolean when provided")
		}

		const profileDir = options.profileDir
		const workspaceOption = options.workspace
		const artifactsOption = options.artifactsDir
		if (profileDir !== undefined) {
			if (workspaceOption === undefined || artifactsOption === undefined) {
				throw new TestRunError(
					"profile-invalid",
					"workspace and artifactsDir are required when profileDir is provided",
					"profile-paths-required",
				)
			}
			if (!EXACT_VERSION_PATTERN.test(options.vscodeVersion)) {
				throw new TestRunError(
					"profile-invalid",
					`Persistent profiles require an exact major.minor.patch VS Code version: ${options.vscodeVersion}`,
					"exact-profile-host-required",
				)
			}

			const scope = await getScopeRoots()
			const profileRoot = await validateExplicitLocation(profileDir, "profileDir", scope)
			const workspacePath = await validateExplicitLocation(workspaceOption, "workspace", scope)
			const artifactsPath = await validateExplicitLocation(artifactsOption, "artifactsDir", scope)
			if (isRelatedPath(profileRoot, workspacePath)) {
				throw new Error("profileDir and workspace must not overlap")
			}
			if (isRelatedPath(profileRoot, artifactsPath)) {
				throw new Error("profileDir and artifactsDir must not overlap")
			}
			if (isRelatedPath(workspacePath, artifactsPath)) {
				throw new Error("workspace and artifactsDir must not overlap")
			}

			const initialize = options.initializeProfile === true
			const artifactsDir = await ensureDirectory(artifactsPath, "persistent artifacts directory")
			const workspace = await prepareMarkedDirectory(
				workspacePath,
				"persistent workspace",
				"workspace",
				initialize,
			)
			const initializedRoot = await preparePersistentRoot(profileRoot, initialize)
			const versionRoot = await ensureDirectory(
				path.join(initializedRoot, options.vscodeVersion),
				`persistent profile for VS Code ${options.vscodeVersion}`,
			)
			const userDataDir = await ensureDirectory(
				path.join(versionRoot, "user-data"),
				"persistent user data directory",
			)
			const extensionsDir = await ensureDirectory(
				path.join(versionRoot, "extensions"),
				"persistent extensions directory",
			)

			let sharedDataDir: string | undefined
			if (options.sharedData) {
				const candidate = path.join(versionRoot, "shared-data")
				await assertNoLinkComponents(candidate, "persistent shared data directory")
				sharedDataDir = await ensureDirectory(candidate, "persistent shared data directory")
				await assertNoLinkComponents(candidate, "persistent shared data directory")
				if (!isSamePath(sharedDataDir, candidate) || !isSameOrDescendant(sharedDataDir, initializedRoot))
					throw new Error("Shared data escaped the owned profile")
			}
			return {
				workspace,
				userDataDir,
				extensionsDir,
				artifactsDir,
				profileDir: initializedRoot,
				...(sharedDataDir ? { sharedDataDir } : {}),
			}
		}

		if (workspaceOption !== undefined || artifactsOption !== undefined) {
			throw new TestRunError(
				"profile-invalid",
				"workspace and artifactsDir require profileDir; disposable mode owns all three roots",
				"profile-paths-required",
			)
		}
		if (options.initializeProfile === true) {
			throw new TestRunError(
				"profile-invalid",
				"initializeProfile requires profileDir",
				"profile-initialization-needs-profile",
			)
		}
		return createTemporaryProfile()
	})
}

export async function cleanupTestProfile(profile: TestProfile, successful: boolean): Promise<void> {
	return withProfileInvalid(async () => {
		if (!successful || !profile || typeof profile !== "object") return
		const ownership = temporaryOwnership.get(profile)
		if (!ownership) return
		await removeOwnedTemporaryRoot(ownership)
		temporaryOwnership.delete(profile)
	})
}
