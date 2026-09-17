import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { test } from "node:test"
import assert from "node:assert/strict"

import {
	FIXTURE_CONTENT,
	FIXTURE_FILES,
	createRepositoryFixture,
	readFixtureCommit,
	runFixtureTests,
	verifyRepositoryFixture,
} from "./repositoryFixture"

const execFileAsync = promisify(execFile)
const TEST_COMMAND_OPTIONS = {
	encoding: "utf8" as const,
	maxBuffer: 1024 * 1024,
	shell: false as const,
	timeout: 30_000,
	windowsHide: true,
}
const RUNNER_WORKSPACE_MARKER = `${JSON.stringify({ schemaVersion: 1, purpose: "alpha-vscode-e2e", kind: "workspace" }, null, 2)}\n`

async function createOwnedTempDirectory(): Promise<string> {
	return fs.mkdtemp(path.join(tmpdir(), "alpha-code-repository-fixture-"))
}

async function removeOwnedTempDirectory(directory: string): Promise<void> {
	const stats = await fs.lstat(directory)
	assert.equal(stats.isSymbolicLink(), false)
	assert.equal(stats.isDirectory(), true)
	const canonical = await fs.realpath(directory)
	const canonicalParent = path.dirname(canonical)
	const expectedParent = await fs.realpath(path.dirname(directory))
	assert.equal(
		process.platform === "win32" ? canonicalParent.toLowerCase() : canonicalParent,
		process.platform === "win32" ? expectedParent.toLowerCase() : expectedParent,
	)
	assert.match(path.basename(canonical), /^alpha-code-repository-fixture-/)
	await fs.rm(canonical, { force: true, recursive: true })
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await createOwnedTempDirectory()
	try {
		await run(directory)
	} finally {
		await removeOwnedTempDirectory(directory)
	}
}

async function commitEnhancedState(workspace: string): Promise<void> {
	await execFileAsync(
		"git",
		[
			"-c",
			"core.autocrlf=false",
			"-c",
			"core.hooksPath=.git/alpha-empty-hooks",
			"add",
			"--",
			FIXTURE_FILES.module,
			FIXTURE_FILES.primaryTest,
		],
		{ cwd: workspace, ...TEST_COMMAND_OPTIONS },
	)
	await execFileAsync(
		"git",
		[
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
			"commit",
			"--quiet",
			"--no-verify",
			"-m",
			"fixture: enhanced",
		],
		{
			cwd: workspace,
			...TEST_COMMAND_OPTIONS,
			env: {
				...process.env,
				GIT_AUTHOR_DATE: "2000-01-02T00:00:00Z",
				GIT_COMMITTER_DATE: "2000-01-02T00:00:00Z",
			},
		},
	)
}

function allChecksPassed(checks: Array<{ name: string; passed: boolean }>): boolean {
	return checks.length > 0 && checks.every((check) => check.passed)
}

test("creates and independently verifies the deterministic baseline", async () => {
	await withTempDirectory(async (directory) => {
		const workspace = path.join(directory, "fixture")
		await fs.mkdir(workspace)
		await fs.writeFile(path.join(workspace, FIXTURE_FILES.runnerMarker), RUNNER_WORKSPACE_MARKER, "utf8")
		const created = await createRepositoryFixture(workspace)

		assert.equal(created.workspace, await fs.realpath(workspace))
		assert.match(created.initialCommit, /^[0-9a-f]{40,64}$/)
		assert.equal(await readFixtureCommit(workspace), created.initialCommit)
		const baselineTests = await runFixtureTests(workspace)
		assert.equal(
			baselineTests.exitCode !== 0,
			true,
			`Expected baseline tests to fail: ${JSON.stringify(baselineTests)}`,
		)
		await fs.writeFile(path.join(workspace, FIXTURE_FILES.checkpoint), '{"phase":"baseline"}\n', "utf8")
		assert.equal(allChecksPassed(await verifyRepositoryFixture(workspace, "baseline")), true)

		assert.equal(
			await fs.readFile(path.join(workspace, FIXTURE_FILES.module), "utf8"),
			FIXTURE_CONTENT.baselineModule,
		)
	})
})

test("rejects an unrelated non-empty workspace without changing its file", async () => {
	await withTempDirectory(async (directory) => {
		const workspace = path.join(directory, "unrelated")
		await fs.mkdir(workspace)
		const userFile = path.join(workspace, "user-file.txt")
		await fs.writeFile(userFile, "user data\n", "utf8")

		await assert.rejects(createRepositoryFixture(workspace), /non-empty workspace|ownership marker/)
		assert.equal(await fs.readFile(userFile, "utf8"), "user data\n")
		assert.equal(await fs.readdir(workspace).then((entries) => entries.sort().join(",")), "user-file.txt")
	})
})

test("rehydration preserves an edited owned fixture instead of resetting it", async () => {
	await withTempDirectory(async (directory) => {
		const workspace = path.join(directory, "fixture")
		await fs.mkdir(workspace)
		await fs.writeFile(path.join(workspace, FIXTURE_FILES.runnerMarker), RUNNER_WORKSPACE_MARKER, "utf8")
		const created = await createRepositoryFixture(workspace)
		const readmePath = path.join(workspace, FIXTURE_FILES.readme)
		const editedReadme = `${await fs.readFile(readmePath, "utf8")}user edit\n`
		await fs.writeFile(readmePath, editedReadme, "utf8")

		const rehydrated = await createRepositoryFixture(workspace)
		assert.deepEqual(rehydrated, created)
		assert.equal(await fs.readFile(readmePath, "utf8"), editedReadme)
	})
})

test("verifies enhanced, committed, and follow-up states", async () => {
	await withTempDirectory(async (directory) => {
		const workspace = path.join(directory, "fixture")
		await fs.mkdir(workspace)
		await fs.writeFile(path.join(workspace, FIXTURE_FILES.runnerMarker), RUNNER_WORKSPACE_MARKER, "utf8")
		const created = await createRepositoryFixture(workspace)

		await fs.writeFile(path.join(workspace, FIXTURE_FILES.module), FIXTURE_CONTENT.enhancedModule, "utf8")
		await fs.writeFile(path.join(workspace, FIXTURE_FILES.primaryTest), FIXTURE_CONTENT.enhancedTest, "utf8")
		assert.equal(allChecksPassed(await verifyRepositoryFixture(workspace, "enhanced")), true)
		assert.equal((await runFixtureTests(workspace)).exitCode, 0)

		await commitEnhancedState(workspace)
		assert.notEqual(await readFixtureCommit(workspace), created.initialCommit)
		assert.equal(allChecksPassed(await verifyRepositoryFixture(workspace, "committed")), true)

		await fs.writeFile(path.join(workspace, FIXTURE_FILES.primaryTest), FIXTURE_CONTENT.followupPrimaryTest, "utf8")
		await fs.writeFile(path.join(workspace, FIXTURE_FILES.readme), FIXTURE_CONTENT.followupReadme, "utf8")
		assert.equal(allChecksPassed(await verifyRepositoryFixture(workspace, "followup")), true)
		assert.equal((await runFixtureTests(workspace)).exitCode, 0)

		await fs.writeFile(
			path.join(workspace, FIXTURE_FILES.workflowCases),
			'[{"step":1,"left":0,"right":1,"sum":1}]\n',
			"utf8",
		)
		await fs.writeFile(path.join(workspace, FIXTURE_FILES.primaryTest), FIXTURE_CONTENT.extendedTest, "utf8")
		assert.equal(allChecksPassed(await verifyRepositoryFixture(workspace, "followup")), true)
	})
})

test("follow-up documentation accepts equivalent wording but rejects incorrect negative-number results", async () => {
	await withTempDirectory(async (directory) => {
		const workspace = path.join(directory, "fixture")
		await fs.mkdir(workspace)
		await fs.writeFile(path.join(workspace, FIXTURE_FILES.runnerMarker), RUNNER_WORKSPACE_MARKER)
		await createRepositoryFixture(workspace)
		await fs.writeFile(path.join(workspace, FIXTURE_FILES.module), FIXTURE_CONTENT.enhancedModule)
		await fs.writeFile(path.join(workspace, FIXTURE_FILES.primaryTest), FIXTURE_CONTENT.enhancedTest)
		await commitEnhancedState(workspace)
		await fs.writeFile(path.join(workspace, FIXTURE_FILES.primaryTest), FIXTURE_CONTENT.followupPrimaryTest)
		for (const [sentence, accepted] of [
			["sum([-2, 1]) = -1", true],
			["`sum([-2, 1])` equals `-1`.", true],
			["`sum([-2, 1])`\nreturns `-1`.", true],
			["sum([-2, 1]) // => -1", true],
			["sum([-2, 1]) = -10", false],
			["sum([-2, 1]) = -1.5", false],
			["sum([-2, 1]) = -1e2", false],
			["sum([-2, 1]) does not equal -1", false],
			["sum([-2, 2]) = -1", false],
		] as const) {
			await fs.writeFile(path.join(workspace, FIXTURE_FILES.readme), `${sentence}\n`)
			const checks = await verifyRepositoryFixture(workspace, "followup")
			assert.equal(allChecksPassed(checks), accepted, `${sentence}: ${JSON.stringify(checks)}`)
		}
	})
})
