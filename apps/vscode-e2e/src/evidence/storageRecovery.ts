import * as fs from "node:fs/promises"
import * as path from "node:path"

import { assertSafeRoot, isWithin, readBounded, rejectSymlinkComponents } from "./paths"

export const RECOVERY_FIXTURE_MARKER = ".alpha-vscode-e2e-storage-recovery-fixture.json"
export const AGENT_CONTROL_TRANSACTION_LOCK = "agent_control.json.transaction.lock"
export const OFFLINE_QUARANTINE_SUFFIX = ".offline-quarantine"

const MARKER_KIND = "alpha-vscode-e2e-storage-recovery-fixture"
const MARKER_VERSION = 1
const MAX_MARKER_BYTES = 512
const MAX_OWNER_METADATA_BYTES = 1_024
const MAX_PID = 2_147_483_647
const OWNER_FILE_NAME = "owner.json"
const AGENT_CONTROL_FILE_NAME = "agent_control.json"
const OWNER_LEASE_DIRECTORY_NAME = "agent_control.json.owners"
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

const markerBytes = Buffer.from(`${JSON.stringify({ kind: MARKER_KIND, version: MARKER_VERSION })}\n`, "utf8")

/**
 * An error from the fail-closed evidence boundary. No repair operation should
 * treat this error as permission to delete or replace any other storage.
 */
export class StorageRecoverySafetyError extends Error {
	readonly name = "StorageRecoverySafetyError"

	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options)
	}
}

export interface RecoveryFixture {
	readonly fixtureRoot: string
	readonly markerPath: string
	readonly controller: RecoveryFixtureController
}

export interface RecoveryHostRecord {
	readonly pid: number
	/** Diagnostic input only. This flag is never used as a liveness proof. */
	readonly exited?: boolean
}

/**
 * An opaque capability issued by the owned fixture controller. The object
 * identity is checked through a module-private WeakMap; copying its token or
 * constructing an object with the same shape cannot authorize recovery.
 */
export interface RecoveryRegistrySeal {
	readonly token: string
}

export interface RecoveryFixtureHostHandle {
	readonly pid: number
	readonly close: () => void
}

/**
 * The fixture controller is the exclusive lifecycle gate for the newly
 * initialized test root. It permits one owned campaign host at a time, keeps
 * every PID ever issued, and refuses new hosts after sealing. Closing a host
 * only removes it from the active-launch set; the recovery operation still
 * probes every retained PID, so child.close cannot masquerade as quiescence.
 */
export interface RecoveryFixtureController {
	readonly openHost: (pid: number) => RecoveryFixtureHostHandle
	readonly sealForOfflineRecovery: () => RecoveryRegistrySeal
	readonly resumeAfterOfflineRecovery: (seal: RecoveryRegistrySeal) => void
	readonly dispose: () => void
}

export interface QuarantineOfflineAgentControlLockOptions {
	readonly fixtureRoot: string
	readonly storagePath: string
	readonly hosts: readonly RecoveryHostRecord[]
	readonly fixtureController: RecoveryFixtureController
	readonly registrySeal: RecoveryRegistrySeal
	readonly isProcessLive?: (pid: number) => boolean | undefined | Promise<boolean | undefined>
}

export type OfflineAgentControlLockRecoveryOutcome =
	| {
			readonly outcome: "quarantined"
			readonly canonicalLockPath: string
			readonly quarantinePath: string
	  }
	| {
			readonly outcome: "already-absent"
			readonly canonicalLockPath: string
	  }

interface PathInspection {
	absolutePath: string
	exists: boolean
}

interface ParsedOwner {
	readonly token: string
	readonly pid: number
}

interface OwnerMetadataSnapshot {
	readonly kind: "valid" | "unknown"
	readonly owner?: ParsedOwner
	readonly bytes?: Buffer
}

interface FixtureControllerState {
	readonly fixtureRoot: string
	readonly knownPids: Set<number>
	readonly activePids: Set<number>
	activeOperations: number
	sealed: boolean
	disposed: boolean
	seal?: RecoveryRegistrySeal
	recoveryVerifiedSeal?: RecoveryRegistrySeal
}

const fixtureControllers = new WeakMap<RecoveryFixtureController, FixtureControllerState>()
const registrySeals = new WeakMap<RecoveryRegistrySeal, FixtureControllerState>()
const activeFixtures = new Map<string, RecoveryFixture>()
const fixtureInitializations = new Map<string, Promise<RecoveryFixture>>()

interface LockSnapshot {
	readonly stat: Awaited<ReturnType<typeof fs.lstat>>
	readonly ownerMetadata: OwnerMetadataSnapshot
}

/**
 * Create the marker used to prove that a storage root belongs to a test-owned
 * recovery fixture. A new marker is written only into a new or empty root; a
 * previously initialized root is accepted only with its original live controller
 * and valid marker. A marker cannot restore forgotten process ownership.
 */
export async function initializeRecoveryFixture(root: string): Promise<RecoveryFixture> {
	const requestedRoot = normalizeAbsolutePath(root, "fixture root")
	const canonicalExistingRoot = await canonicalPathIfExists(requestedRoot, "fixture root")
	const fixtureRoot = canonicalExistingRoot ?? requestedRoot
	const existingFixture = activeFixtures.get(fixtureRoot)
	if (existingFixture) {
		await revalidateOwnedFixture(existingFixture)
		return existingFixture
	}
	const pendingInitialization = fixtureInitializations.get(fixtureRoot)
	if (pendingInitialization) return pendingInitialization

	const initialization = initializeFixtureRoot(fixtureRoot)
	fixtureInitializations.set(fixtureRoot, initialization)
	try {
		const fixture = await initialization
		activeFixtures.set(fixture.fixtureRoot, fixture)
		return fixture
	} finally {
		fixtureInitializations.delete(fixtureRoot)
	}
}

async function initializeFixtureRoot(fixtureRoot: string): Promise<RecoveryFixture> {
	const canonicalRoot = (await canonicalPathIfExists(fixtureRoot, "fixture root")) ?? fixtureRoot
	const rootInspection = await inspectPathComponents(canonicalRoot, "fixture root")

	if (!rootInspection.exists) {
		await fs.mkdir(canonicalRoot, { recursive: true })
	}

	const verifiedRoot = await requireCanonicalDirectory(canonicalRoot, "fixture root")
	const markerPath = path.join(verifiedRoot, RECOVERY_FIXTURE_MARKER)
	const markerInspection = await inspectPathComponents(markerPath, "fixture marker")
	if (markerInspection.exists) {
		await readAndValidateMarker(markerPath)
		throw new StorageRecoverySafetyError(
			"The marked recovery fixture is not owned by an active controller; controller-restart recovery is unsupported",
		)
	}

	const entries = await fs.readdir(verifiedRoot)
	if (entries.length !== 0) {
		throw new StorageRecoverySafetyError("Recovery fixture marker may only be created in an empty or new root")
	}

	try {
		await fs.writeFile(markerPath, markerBytes, { flag: "wx" })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw new StorageRecoverySafetyError("Unable to create the recovery fixture marker", { cause: error })
		}
		await readAndValidateMarker(markerPath)
		throw new StorageRecoverySafetyError(
			"The marked recovery fixture was created by another lifecycle; controller-restart recovery is unsupported",
		)
	}

	return { fixtureRoot: verifiedRoot, markerPath, controller: createFixtureController(verifiedRoot) }
}

async function revalidateOwnedFixture(fixture: RecoveryFixture): Promise<void> {
	const state = fixtureControllers.get(fixture.controller)
	if (!state || state.disposed || state.fixtureRoot !== fixture.fixtureRoot) {
		throw new StorageRecoverySafetyError("The managed recovery fixture controller is no longer active")
	}
	await requireDirectory(fixture.fixtureRoot, "fixture root")
	await readAndValidateMarker(fixture.markerPath)
}

function createFixtureController(fixtureRoot: string): RecoveryFixtureController {
	const state: FixtureControllerState = {
		fixtureRoot,
		knownPids: new Set<number>(),
		activePids: new Set<number>(),
		activeOperations: 0,
		sealed: false,
		disposed: false,
	}

	const controller: RecoveryFixtureController = Object.freeze({
		openHost(pid: number): RecoveryFixtureHostHandle {
			assertValidPid(pid, "fixture host")
			if (state.disposed) throw new StorageRecoverySafetyError("The fixture controller has been disposed")
			if (state.sealed) throw new StorageRecoverySafetyError("The fixture lifecycle is already sealed")
			if (state.activePids.size !== 0) {
				throw new StorageRecoverySafetyError("The fixture controller permits only one active campaign host")
			}
			state.activePids.add(pid)
			state.knownPids.add(pid)
			let closed = false
			return Object.freeze({
				pid,
				close: () => {
					if (closed) return
					closed = true
					state.activePids.delete(pid)
				},
			})
		},
		sealForOfflineRecovery(): RecoveryRegistrySeal {
			if (state.disposed) throw new StorageRecoverySafetyError("The fixture controller has been disposed")
			if (state.activePids.size !== 0) {
				throw new StorageRecoverySafetyError(
					"The fixture lifecycle is not quiescent while a campaign host is active",
				)
			}
			if (state.seal) return state.seal
			state.sealed = true
			const seal = Object.freeze({ token: "storage-recovery-fixture-quiescence" })
			state.seal = seal
			registrySeals.set(seal, state)
			return seal
		},
		resumeAfterOfflineRecovery(seal: RecoveryRegistrySeal): void {
			if (state.disposed) throw new StorageRecoverySafetyError("The fixture controller has been disposed")
			if (
				!state.sealed ||
				state.activePids.size !== 0 ||
				state.activeOperations !== 0 ||
				state.seal !== seal ||
				state.recoveryVerifiedSeal !== seal ||
				registrySeals.get(seal) !== state
			) {
				throw new StorageRecoverySafetyError("Offline recovery has not been verified for this lifecycle seal")
			}
			registrySeals.delete(seal)
			state.seal = undefined
			state.recoveryVerifiedSeal = undefined
			state.sealed = false
		},
		dispose(): void {
			if (state.disposed) return
			if (state.activePids.size !== 0 || state.activeOperations !== 0) {
				throw new StorageRecoverySafetyError("The fixture controller cannot be disposed while it is active")
			}
			state.disposed = true
			if (state.seal) registrySeals.delete(state.seal)
			state.seal = undefined
			state.recoveryVerifiedSeal = undefined
			activeFixtures.delete(fixtureRoot)
		},
	})
	fixtureControllers.set(controller, state)
	return controller
}

/**
 * Move only the exact canonical transaction-lock directory into a recoverable
 * sibling quarantine. The fixture marker, a sealed host registry, and actual
 * process-liveness checks are all required. The operation never uses lock age
 * and never removes a directory or file.
 */
export async function quarantineOfflineAgentControlLock(
	options: QuarantineOfflineAgentControlLockOptions,
): Promise<OfflineAgentControlLockRecoveryOutcome> {
	const fixtureRoot = await requireManagedFixtureRoot(options?.fixtureRoot)
	const controllerState = requireFixtureController(options?.fixtureController, fixtureRoot)
	controllerState.activeOperations++
	try {
		return await quarantineOwnedLock(options, fixtureRoot, controllerState)
	} finally {
		controllerState.activeOperations--
	}
}

async function quarantineOwnedLock(
	options: QuarantineOfflineAgentControlLockOptions,
	fixtureRoot: string,
	controllerState: FixtureControllerState,
): Promise<OfflineAgentControlLockRecoveryOutcome> {
	const requestedStoragePath = normalizeAbsolutePath(options?.storagePath, "storage path")
	assertStrictDescendant(fixtureRoot, requestedStoragePath, "storage path")
	const hosts = mergeControllerHosts(validateHostRegistry(options?.hosts), controllerState)
	const registrySeal = validateRegistrySeal(options?.registrySeal, controllerState)
	const processProbe = options?.isProcessLive ?? defaultIsProcessLive

	assertRegistrySealed(registrySeal, controllerState)

	const storageInspection = await inspectPathComponents(requestedStoragePath, "storage path")
	const storagePath = storageInspection.absolutePath
	assertStrictDescendant(fixtureRoot, storagePath, "canonical storage path")
	const canonicalLockCandidate = path.join(storagePath, AGENT_CONTROL_TRANSACTION_LOCK)
	if (!storageInspection.exists) {
		await assertNoLiveHosts(undefined, hosts, processProbe)
		assertRegistrySealed(registrySeal, controllerState)
		return markRecoveryVerified(controllerState, registrySeal, {
			outcome: "already-absent",
			canonicalLockPath: canonicalLockCandidate,
		})
	}
	await requireDirectory(storagePath, "storage path")
	await validateUntouchedStorageSiblings(storagePath)

	const lockInspection = await inspectPathComponents(canonicalLockCandidate, "canonical transaction lock")
	const canonicalLockPath = lockInspection.absolutePath
	if (!lockInspection.exists) {
		await assertNoLiveHosts(undefined, hosts, processProbe)
		assertRegistrySealed(registrySeal, controllerState)
		return markRecoveryVerified(controllerState, registrySeal, { outcome: "already-absent", canonicalLockPath })
	}

	const lockSnapshot = await readLockSnapshot(canonicalLockPath)
	assertRegistrySealed(registrySeal, controllerState)
	await assertNoLiveHosts(lockSnapshot.ownerMetadata.owner, hosts, processProbe)
	assertRegistrySealed(registrySeal, controllerState)

	const unchanged = await lockStillMatches(canonicalLockPath, lockSnapshot)
	if (!unchanged) {
		return markRecoveryVerified(controllerState, registrySeal, { outcome: "already-absent", canonicalLockPath })
	}

	const quarantinePath = `${canonicalLockPath}${OFFLINE_QUARANTINE_SUFFIX}`
	const quarantineInspection = await inspectPathComponents(quarantinePath, "offline quarantine")
	if (quarantineInspection.exists) {
		throw new StorageRecoverySafetyError("The offline quarantine destination already exists")
	}
	assertRegistrySealed(registrySeal, controllerState)

	try {
		await fs.rename(canonicalLockPath, quarantinePath)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			const currentLock = await inspectPathComponents(canonicalLockPath, "canonical transaction lock")
			if (!currentLock.exists) {
				return markRecoveryVerified(controllerState, registrySeal, {
					outcome: "already-absent",
					canonicalLockPath,
				})
			}
		}
		throw new StorageRecoverySafetyError("Unable to quarantine the exact canonical transaction lock", {
			cause: error,
		})
	}

	const movedLock = await inspectPathComponents(quarantinePath, "offline quarantine")
	if (!movedLock.exists) {
		throw new StorageRecoverySafetyError(
			"The canonical transaction lock was moved but quarantine cannot be verified",
		)
	}
	const movedStat = await fs.lstat(quarantinePath)
	if (!movedStat.isDirectory() || movedStat.isSymbolicLink()) {
		throw new StorageRecoverySafetyError("Offline quarantine is not a regular lock directory")
	}

	return markRecoveryVerified(controllerState, registrySeal, {
		outcome: "quarantined",
		canonicalLockPath,
		quarantinePath,
	})
}

function markRecoveryVerified<T extends OfflineAgentControlLockRecoveryOutcome>(
	controllerState: FixtureControllerState,
	seal: RecoveryRegistrySeal,
	outcome: T,
): T {
	if (registrySeals.get(seal) !== controllerState || !controllerState.sealed) {
		throw new StorageRecoverySafetyError("Offline recovery outcome cannot be verified against the active seal")
	}
	controllerState.recoveryVerifiedSeal = seal
	return outcome
}

function normalizeAbsolutePath(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
		throw new StorageRecoverySafetyError(`Invalid ${label}`)
	}
	let absolutePath: string
	try {
		absolutePath = assertSafeRoot(value)
	} catch (error) {
		throw new StorageRecoverySafetyError(`Invalid ${label}`, { cause: error })
	}
	if (!path.isAbsolute(value)) throw new StorageRecoverySafetyError(`${label} must be absolute`)
	if (value.split(/[\\/]+/u).some((segment) => segment === "." || segment === "..")) {
		throw new StorageRecoverySafetyError(`${label} contains a traversal segment`)
	}
	return absolutePath
}

async function inspectPathComponents(inputPath: string, label: string): Promise<PathInspection> {
	const absolutePath = path.resolve(inputPath)
	try {
		await rejectSymlinkComponents(absolutePath)
	} catch (error) {
		throw new StorageRecoverySafetyError(`${label} traverses a symbolic link`, { cause: error })
	}
	try {
		return { absolutePath: await fs.realpath(absolutePath), exists: true }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { absolutePath, exists: false }
		throw new StorageRecoverySafetyError(`Unable to inspect ${label}`, { cause: error })
	}
}

async function requireDirectory(inputPath: string, label: string): Promise<string> {
	const inspection = await inspectPathComponents(inputPath, label)
	if (!inspection.exists) throw new StorageRecoverySafetyError(`${label} does not exist`)
	let stat: Awaited<ReturnType<typeof fs.lstat>>
	try {
		stat = await fs.lstat(inspection.absolutePath)
	} catch (error) {
		throw new StorageRecoverySafetyError(`Unable to inspect ${label}`, { cause: error })
	}
	if (stat.isSymbolicLink() || !stat.isDirectory())
		throw new StorageRecoverySafetyError(`${label} is not a directory`)
	return inspection.absolutePath
}

async function requireManagedFixtureRoot(inputRoot: unknown): Promise<string> {
	const requestedRoot = normalizeAbsolutePath(inputRoot, "fixture root")
	const fixtureRoot = await requireCanonicalDirectory(requestedRoot, "fixture root")
	await readAndValidateMarker(path.join(fixtureRoot, RECOVERY_FIXTURE_MARKER))
	return fixtureRoot
}

async function canonicalPathIfExists(inputPath: string, label: string): Promise<string | undefined> {
	try {
		await rejectSymlinkComponents(inputPath)
	} catch (error) {
		throw new StorageRecoverySafetyError(`${label} traverses a symbolic link`, { cause: error })
	}
	try {
		const canonical = await fs.realpath(inputPath)
		try {
			assertSafeRoot(canonical)
		} catch (error) {
			throw new StorageRecoverySafetyError(`Invalid canonical ${label}`, { cause: error })
		}
		return canonical
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		if (error instanceof StorageRecoverySafetyError) throw error
		throw new StorageRecoverySafetyError(`Unable to resolve canonical ${label}`, { cause: error })
	}
}

async function requireCanonicalDirectory(inputPath: string, label: string): Promise<string> {
	const canonical = (await canonicalPathIfExists(inputPath, label)) ?? inputPath
	return requireDirectory(canonical, label)
}

async function readAndValidateMarker(markerPath: string): Promise<void> {
	const inspection = await inspectPathComponents(markerPath, "fixture marker")
	if (!inspection.exists) throw new StorageRecoverySafetyError("The managed recovery fixture marker is missing")
	const stat = await lstatOrSafetyError(markerPath, "fixture marker")
	if (stat.isSymbolicLink() || !stat.isFile())
		throw new StorageRecoverySafetyError("The fixture marker is not a regular file")

	const serialized = await readBoundedSafely(markerPath, MAX_MARKER_BYTES, "fixture marker")
	let marker: unknown
	try {
		marker = JSON.parse(serialized.toString("utf8"))
	} catch (error) {
		throw new StorageRecoverySafetyError("The managed recovery fixture marker is invalid", { cause: error })
	}
	if (
		typeof marker !== "object" ||
		marker === null ||
		!("kind" in marker) ||
		marker.kind !== MARKER_KIND ||
		!("version" in marker) ||
		marker.version !== MARKER_VERSION
	) {
		throw new StorageRecoverySafetyError("The managed recovery fixture marker is invalid")
	}
}

function assertStrictDescendant(root: string, candidate: string, label: string): void {
	if (!isWithin(root, candidate) || path.resolve(root) === path.resolve(candidate)) {
		throw new StorageRecoverySafetyError(`${label} must be a strict descendant of the managed fixture root`)
	}
}

function assertValidPid(pid: unknown, label: string): asserts pid is number {
	if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || (pid as number) > MAX_PID) {
		throw new StorageRecoverySafetyError(`The ${label} contains an invalid process identifier`)
	}
}

function validateHostRegistry(hosts: unknown): readonly RecoveryHostRecord[] {
	if (!Array.isArray(hosts)) throw new StorageRecoverySafetyError("An explicit host registry snapshot is required")
	const seen = new Set<number>()
	for (const host of hosts) {
		if (typeof host !== "object" || host === null || !("pid" in host)) {
			throw new StorageRecoverySafetyError("The host registry contains an invalid process identifier")
		}
		const record = host as { pid: unknown; exited?: unknown }
		assertValidPid(record.pid, "host registry")
		if ("exited" in record && record.exited !== undefined && typeof record.exited !== "boolean") {
			throw new StorageRecoverySafetyError("The host registry contains an invalid exited flag")
		}
		if (seen.has(record.pid))
			throw new StorageRecoverySafetyError("The host registry contains a duplicate process identifier")
		seen.add(record.pid)
	}
	return hosts as RecoveryHostRecord[]
}

function requireFixtureController(controller: unknown, fixtureRoot: string): FixtureControllerState {
	if (typeof controller !== "object" || controller === null) {
		throw new StorageRecoverySafetyError("An unforgeable fixture controller capability is required")
	}
	const state = fixtureControllers.get(controller as RecoveryFixtureController)
	if (!state || state.disposed || state.fixtureRoot !== fixtureRoot) {
		throw new StorageRecoverySafetyError("The fixture controller is not owned by this managed fixture root")
	}
	return state
}

function validateRegistrySeal(seal: unknown, controllerState: FixtureControllerState): RecoveryRegistrySeal {
	if (typeof seal !== "object" || seal === null) {
		throw new StorageRecoverySafetyError("An unforgeable registry seal is required")
	}
	const sealState = registrySeals.get(seal as RecoveryRegistrySeal)
	if (!sealState || sealState !== controllerState) {
		throw new StorageRecoverySafetyError("The registry seal was not issued by this fixture controller")
	}
	return seal as RecoveryRegistrySeal
}

function assertRegistrySealed(seal: RecoveryRegistrySeal, controllerState: FixtureControllerState): void {
	if (
		registrySeals.get(seal) !== controllerState ||
		!controllerState.sealed ||
		controllerState.activePids.size !== 0
	) {
		throw new StorageRecoverySafetyError("The host registry is not sealed for offline recovery")
	}
}

function mergeControllerHosts(
	hosts: readonly RecoveryHostRecord[],
	controllerState: FixtureControllerState,
): readonly RecoveryHostRecord[] {
	const merged = [...hosts]
	const supplied = new Set(hosts.map((host) => host.pid))
	for (const pid of controllerState.knownPids) {
		if (!supplied.has(pid)) merged.push({ pid })
	}
	return merged
}

async function validateUntouchedStorageSiblings(storagePath: string): Promise<void> {
	await validateOptionalSibling(path.join(storagePath, AGENT_CONTROL_FILE_NAME), "agent_control.json", false)
	await validateOptionalSibling(
		path.join(storagePath, OWNER_LEASE_DIRECTORY_NAME),
		"agent control owner leases",
		true,
	)
}

async function validateOptionalSibling(inputPath: string, label: string, directory: boolean): Promise<void> {
	const inspection = await inspectPathComponents(inputPath, label)
	if (!inspection.exists) return
	const stat = await lstatOrSafetyError(inputPath, label)
	if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
		throw new StorageRecoverySafetyError(`${label} is not a safe regular ${directory ? "directory" : "file"}`)
	}
}

async function readLockSnapshot(lockPath: string): Promise<LockSnapshot> {
	const stat = await lstatOrSafetyError(lockPath, "canonical transaction lock")
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new StorageRecoverySafetyError("The canonical transaction lock is not a regular directory")
	}
	return { stat, ownerMetadata: await readOwnerMetadata(lockPath) }
}

async function readOwnerMetadata(lockPath: string): Promise<OwnerMetadataSnapshot> {
	const ownerPath = path.join(lockPath, OWNER_FILE_NAME)
	const inspection = await inspectPathComponents(ownerPath, "lock owner metadata")
	if (!inspection.exists) return { kind: "unknown" }
	const stat = await lstatOrSafetyError(ownerPath, "lock owner metadata")
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new StorageRecoverySafetyError("Lock owner metadata is not a regular file")
	}
	const bytes = await readBoundedSafely(ownerPath, MAX_OWNER_METADATA_BYTES, "lock owner metadata")
	if (bytes.length === 0) return { kind: "unknown", bytes }

	let candidate: unknown
	try {
		candidate = JSON.parse(bytes.toString("utf8"))
	} catch {
		return { kind: "unknown", bytes }
	}
	if (
		typeof candidate !== "object" ||
		candidate === null ||
		!("token" in candidate) ||
		typeof candidate.token !== "string" ||
		!TOKEN_PATTERN.test(candidate.token) ||
		!("pid" in candidate) ||
		typeof candidate.pid !== "number" ||
		!Number.isSafeInteger(candidate.pid) ||
		candidate.pid <= 0 ||
		candidate.pid > MAX_PID
	) {
		return { kind: "unknown", bytes }
	}
	return { kind: "valid", owner: { token: candidate.token, pid: candidate.pid }, bytes }
}

async function assertNoLiveHosts(
	owner: ParsedOwner | undefined,
	hosts: readonly RecoveryHostRecord[],
	processProbe: (pid: number) => boolean | undefined | Promise<boolean | undefined>,
): Promise<void> {
	const pids = new Set<number>(hosts.map((host) => host.pid))
	if (owner) pids.add(owner.pid)

	for (const pid of pids) {
		let live: boolean | undefined
		try {
			live = await processProbe(pid)
		} catch (error) {
			throw new StorageRecoverySafetyError(`Unable to prove that process ${pid} is offline`, { cause: error })
		}
		if (live === undefined) throw new StorageRecoverySafetyError(`Process ${pid} liveness is unknown`)
		if (typeof live !== "boolean") throw new StorageRecoverySafetyError(`Process ${pid} liveness is invalid`)
		if (live) throw new StorageRecoverySafetyError(`Process ${pid} is still live; offline recovery is rejected`)
	}
}

async function lockStillMatches(lockPath: string, snapshot: LockSnapshot): Promise<boolean> {
	let current: LockSnapshot
	try {
		current = await readLockSnapshot(lockPath)
	} catch (error) {
		if (hasErrnoCode(error, "ENOENT")) return false
		throw error
	}

	if (
		snapshot.stat.dev !== current.stat.dev ||
		snapshot.stat.ino !== current.stat.ino ||
		snapshot.ownerMetadata.kind !== current.ownerMetadata.kind ||
		!buffersEqual(snapshot.ownerMetadata.bytes, current.ownerMetadata.bytes)
	) {
		throw new StorageRecoverySafetyError("The canonical transaction lock changed during offline recovery")
	}
	return true
}

function hasErrnoCode(error: unknown, code: string): boolean {
	let current: unknown = error
	for (let depth = 0; depth < 3 && current; depth++) {
		if (typeof current === "object" && current !== null && "code" in current && current.code === code) return true
		if (typeof current === "object" && current !== null && "cause" in current) current = current.cause
		else break
	}
	return false
}

function buffersEqual(left: Buffer | undefined, right: Buffer | undefined): boolean {
	if (left === undefined || right === undefined) return left === right
	return left.equals(right)
}

async function lstatOrSafetyError(inputPath: string, label: string): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
	try {
		return await fs.lstat(inputPath)
	} catch (error) {
		throw new StorageRecoverySafetyError(`Unable to inspect ${label}`, { cause: error })
	}
}

async function readBoundedSafely(inputPath: string, limit: number, label: string): Promise<Buffer> {
	try {
		return await readBounded(inputPath, limit)
	} catch (error) {
		if (error instanceof StorageRecoverySafetyError) throw error
		throw new StorageRecoverySafetyError(`Unable to read ${label}`, { cause: error })
	}
}

function defaultIsProcessLive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === "ESRCH") return false
		if (code === "EPERM") return true
		throw error
	}
}
