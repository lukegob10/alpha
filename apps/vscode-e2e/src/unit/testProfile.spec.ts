import { test, type TestContext } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { TestRunError } from "../runFailure"
import {
	assertOwnedTestRoot,
	cleanupTestProfile,
	prepareTestProfile,
	TEST_ROOT_OWNERSHIP_MARKER,
	TEST_ROOT_OWNERSHIP_PURPOSE,
	type TestProfileOptions,
} from "../testProfile"

const VERSION = "1.122.1"

const removeTestArea = async (root: string): Promise<void> => {
	await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 })
}

const createTestArea = async (context: TestContext): Promise<string> => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-test-profile-spec-"))
	context.after(() => removeTestArea(root))
	return root
}

const persistentOptions = (root: string, overrides: Partial<TestProfileOptions> = {}): TestProfileOptions => ({
	profileDir: path.join(root, "profile"),
	workspace: path.join(root, "workspace"),
	artifactsDir: path.join(root, "artifacts"),
	vscodeVersion: VERSION,
	initializeProfile: true,
	...overrides,
})

const assertProfileInvalid = async (operation: Promise<unknown>, message?: RegExp): Promise<void> => {
	await assert.rejects(operation, (error: unknown) => {
		assert.ok(error instanceof TestRunError)
		assert.equal(error.code, "profile-invalid")
		if (message) assert.match(error.message, message)
		return true
	})
}

const readMarker = async (root: string): Promise<unknown> =>
	JSON.parse(await fs.readFile(path.join(root, TEST_ROOT_OWNERSHIP_MARKER), "utf8"))

test("initializes and reuses marked persistent profile/workspace roots by exact host version", async (context) => {
	const root = await createTestArea(context)
	const first = await prepareTestProfile(persistentOptions(root))
	const expectedProfileRoot = await fs.realpath(path.join(root, "profile"))
	const expectedWorkspace = await fs.realpath(path.join(root, "workspace"))
	const expectedArtifacts = await fs.realpath(path.join(root, "artifacts"))

	assert.equal(first.profileDir, expectedProfileRoot)
	assert.equal(first.userDataDir, path.join(expectedProfileRoot, VERSION, "user-data"))
	assert.equal(first.extensionsDir, path.join(expectedProfileRoot, VERSION, "extensions"))
	assert.equal(first.workspace, expectedWorkspace)
	assert.equal(first.artifactsDir, expectedArtifacts)
	assert.deepEqual(await readMarker(first.profileDir), {
		schemaVersion: 1,
		purpose: TEST_ROOT_OWNERSHIP_PURPOSE,
		kind: "profile",
	})
	assert.deepEqual(await readMarker(first.workspace), {
		schemaVersion: 1,
		purpose: TEST_ROOT_OWNERSHIP_PURPOSE,
		kind: "workspace",
	})
	await assertOwnedTestRoot(first.profileDir, "profile")
	await assertOwnedTestRoot(first.workspace, "workspace")
	await assert.rejects(assertOwnedTestRoot(first.artifactsDir), /missing/)

	await fs.writeFile(path.join(first.workspace, "fixture.txt"), "fixture\n")
	const second = await prepareTestProfile(persistentOptions(root, { initializeProfile: false }))
	assert.equal(second.profileDir, first.profileDir)
	assert.equal(second.workspace, first.workspace)
	assert.equal(await fs.readFile(path.join(second.workspace, "fixture.txt"), "utf8"), "fixture\n")
})

test("normal-host shared data extends existing marked profiles without changing saved data or marker versions", async (context) => {
	const root = await createTestArea(context)
	const old = await prepareTestProfile(persistentOptions(root))
	const marker = await readMarker(old.profileDir!)
	await fs.writeFile(path.join(old.userDataDir, "keep.txt"), "existing data")
	for (const version of ["1.122.1", "1.136.1"]) {
		const options = persistentOptions(root, { vscodeVersion: version, initializeProfile: false, sharedData: true })
		const current = await prepareTestProfile(options)
		assert.equal(current.sharedDataDir, path.join(current.profileDir!, version, "shared-data"))
		await fs.writeFile(path.join(current.sharedDataDir!, "sentinel.txt"), version)
		const reopened = await prepareTestProfile(options)
		assert.equal(await fs.readFile(path.join(reopened.sharedDataDir!, "sentinel.txt"), "utf8"), version)
		assert.deepEqual(await readMarker(current.profileDir!), marker)
	}
	assert.equal(await fs.readFile(path.join(old.userDataDir, "keep.txt"), "utf8"), "existing data")
})

test("shared data rejects disposable scope and symlink/reparse escapes before writing outside the profile", async (context) => {
	await assertProfileInvalid(prepareTestProfile({ vscodeVersion: VERSION, sharedData: true }))
	const root = await createTestArea(context)
	const profile = await prepareTestProfile(persistentOptions(root))
	const outside = path.join(root, "outside")
	await fs.mkdir(outside)
	const alias = path.join(profile.profileDir!, VERSION, "shared-data")
	await fs.symlink(outside, alias, process.platform === "win32" ? "junction" : "dir")
	await assertProfileInvalid(
		prepareTestProfile(persistentOptions(root, { sharedData: true, initializeProfile: false })),
	)
	assert.deepEqual(await fs.readdir(outside), [])
})

test("creates a provenance-marked disposable root and removes only that root on success", async () => {
	const profile = await prepareTestProfile({ vscodeVersion: "stable" })
	assert.ok(profile.temporaryRoot)
	assert.deepEqual(await readMarker(profile.temporaryRoot), {
		schemaVersion: 1,
		purpose: TEST_ROOT_OWNERSHIP_PURPOSE,
		kind: "temporary",
	})
	await assertOwnedTestRoot(profile.temporaryRoot, "temporary")
	for (const directory of [profile.workspace, profile.userDataDir, profile.extensionsDir, profile.artifactsDir]) {
		assert.equal((await fs.lstat(directory)).isDirectory(), true)
	}

	const temporaryRoot = profile.temporaryRoot
	await cleanupTestProfile(profile, true)
	await assert.rejects(fs.access(temporaryRoot), { code: "ENOENT" })
	await cleanupTestProfile(profile, true)
	await removeTestArea(temporaryRoot)
})

test("retains disposable evidence on failure and never deletes explicit persistent roots", async (context) => {
	const disposable = await prepareTestProfile({ vscodeVersion: VERSION })
	assert.ok(disposable.temporaryRoot)
	await fs.writeFile(path.join(disposable.artifactsDir, "failure.txt"), "evidence\n")
	await cleanupTestProfile(disposable, false)
	assert.equal(await fs.readFile(path.join(disposable.artifactsDir, "failure.txt"), "utf8"), "evidence\n")
	await cleanupTestProfile(disposable, true)
	await assert.rejects(fs.access(disposable.temporaryRoot), { code: "ENOENT" })

	const root = await createTestArea(context)
	const persistent = await prepareTestProfile(persistentOptions(root))
	await fs.writeFile(path.join(persistent.workspace, "keep.txt"), "keep\n")
	await fs.writeFile(path.join(persistent.artifactsDir, "keep.json"), "{}\n")
	await cleanupTestProfile(persistent, true)
	assert.equal(await fs.readFile(path.join(persistent.workspace, "keep.txt"), "utf8"), "keep\n")
	assert.equal(await fs.readFile(path.join(persistent.artifactsDir, "keep.json"), "utf8"), "{}\n")
})

test("rejects an existing nonempty unmarked profile or workspace", async (context) => {
	const root = await createTestArea(context)
	const options = persistentOptions(root)
	await fs.mkdir(options.profileDir!, { recursive: true })
	await fs.writeFile(path.join(options.profileDir!, "foreign.txt"), "do not claim\n")
	await assertProfileInvalid(prepareTestProfile(options), /marker|unknown|initialized/i)
	assert.equal(await fs.readFile(path.join(options.profileDir!, "foreign.txt"), "utf8"), "do not claim\n")

	const workspaceRoot = path.join(root, "workspace-with-foreign-content")
	const workspaceOptions = persistentOptions(root, { workspace: workspaceRoot })
	await fs.mkdir(workspaceRoot, { recursive: true })
	await fs.writeFile(path.join(workspaceRoot, "repository-file.txt"), "do not claim\n")
	await assertProfileInvalid(prepareTestProfile(workspaceOptions), /workspace|marker|initialized/i)
	assert.equal(await fs.readFile(path.join(workspaceRoot, "repository-file.txt"), "utf8"), "do not claim\n")
})

test("rejects symlink/reparse aliases for explicit roots", async (context) => {
	const root = await createTestArea(context)
	const target = path.join(root, "real-target")
	const alias = path.join(root, "profile-alias")
	await fs.mkdir(target)
	try {
		await fs.symlink(target, alias, process.platform === "win32" ? "junction" : "dir")
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			["EPERM", "EACCES", "ENOSYS"].includes(String(error.code))
		) {
			context.skip(`symlink creation is unavailable: ${String(error.code)}`)
			return
		}
		throw error
	}

	await assertProfileInvalid(
		prepareTestProfile(persistentOptions(root, { profileDir: alias })),
		/symlink|reparse|alias/i,
	)
})

test("rejects nonexact persistent versions before creating persistent state", async (context) => {
	const root = await createTestArea(context)
	for (const vscodeVersion of ["stable", "insiders", "1.122", "1.122.1-beta.1", "01.122.1"]) {
		await assertProfileInvalid(
			prepareTestProfile(persistentOptions(root, { vscodeVersion })),
			/exact|major\.minor\.patch/i,
		)
	}
	assert.equal(await fs.readdir(root).then((entries) => entries.length), 0)
})

test("rejects broad, source-repository, VS Code data, and overlapping explicit paths", async (context) => {
	const root = await createTestArea(context)
	const candidates = [
		os.homedir(),
		path.parse(os.homedir()).root,
		process.cwd(),
		path.join(process.cwd(), "profile-child"),
		path.join(os.homedir(), ".config", "Code"),
		...(process.platform === "win32" ? ["Z:\\"] : []),
	]
	for (const profileDir of candidates) {
		await assertProfileInvalid(
			prepareTestProfile(persistentOptions(root, { profileDir })),
			/cannot|overlap|broad|root/i,
		)
	}

	await assertProfileInvalid(
		prepareTestProfile(
			persistentOptions(root, {
				profileDir: path.join(root, "shared"),
				workspace: path.join(root, "shared", "workspace"),
			}),
		),
		/overlap/i,
	)
	await assertProfileInvalid(
		prepareTestProfile(
			persistentOptions(root, {
				workspace: path.join(root, "same"),
				artifactsDir: path.join(root, "same"),
			}),
		),
		/overlap/i,
	)
})

test("does not claim artifact roots with the profile/workspace marker", async (context) => {
	const root = await createTestArea(context)
	const artifactsDir = path.join(root, "artifacts")
	await fs.mkdir(artifactsDir)
	await fs.writeFile(path.join(artifactsDir, ".alpha-evidence-owned.json"), "prior evidence\n")

	const profile = await prepareTestProfile(persistentOptions(root, { artifactsDir }))
	assert.equal(await fs.readFile(path.join(artifactsDir, ".alpha-evidence-owned.json"), "utf8"), "prior evidence\n")
	await assert.rejects(assertOwnedTestRoot(profile.artifactsDir), /missing|marker/i)
})

test("bounds ownership marker reads", async (context) => {
	const root = await createTestArea(context)
	const profileRoot = path.join(root, "profile")
	await fs.mkdir(profileRoot)
	await fs.writeFile(
		path.join(profileRoot, TEST_ROOT_OWNERSHIP_MARKER),
		JSON.stringify({
			schemaVersion: 1,
			purpose: TEST_ROOT_OWNERSHIP_PURPOSE,
			kind: "profile",
			padding: "x".repeat(4096),
		}),
	)
	await assertProfileInvalid(assertOwnedTestRoot(profileRoot, "profile"), /exceeds|bytes/i)
})
