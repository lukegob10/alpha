import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { test } from "node:test"

import {
	DEVELOPMENT_FILES,
	DEVELOPMENT_PHASES,
	DEVELOPMENT_REFERENCE_CONTENT,
	DEVELOPMENT_SCENARIOS,
	DEVELOPMENT_SCENARIO_IDS,
	developmentScript,
	type DevelopmentPhaseId,
} from "./developmentCatalog"
import { createDevelopmentFixture, disposeDevelopmentFixture, verifyDevelopmentFixture } from "./developmentFixture"
import { TEST_ROOT_OWNERSHIP_MARKER } from "../testProfile"

const execFileAsync = promisify(execFile)
const TEST_ROOT_PREFIX = "alpha-code-development-bank-test-"
const RUNNER_WORKSPACE_MARKER = `${JSON.stringify(
	{ schemaVersion: 1, purpose: "alpha-vscode-e2e", kind: "workspace" },
	null,
)}\n`
const COMMAND_OPTIONS = {
	encoding: "utf8" as const,
	maxBuffer: 2 * 1024 * 1024,
	shell: false as const,
	timeout: 30_000,
	windowsHide: true,
}

function allChecksPassed(checks: readonly { name: string; passed: boolean }[]): boolean {
	return checks.length > 0 && checks.every((check) => check.passed)
}

function failedCheckNames(checks: readonly { name: string; passed: boolean }[]): string[] {
	return checks.filter((check) => !check.passed).map((check) => check.name)
}

function tokenize(command: string): string[] {
	return (command.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+/g) ?? []).map((token) => {
		if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
			return token.slice(1, -1)
		}
		return token
	})
}

function safeChildEnvironment(workspace: string): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { ...process.env }
	for (const key of Object.keys(environment)) {
		if (key.startsWith("GIT_CONFIG_")) delete environment[key]
	}
	environment.GIT_CONFIG_NOSYSTEM = "1"
	environment.GIT_CONFIG_GLOBAL = path.join(workspace, ".alpha-development-test-global-config")
	environment.GIT_TERMINAL_PROMPT = "0"
	delete environment.NODE_TEST_CONTEXT
	if (process.versions.electron) environment.ELECTRON_RUN_AS_NODE = "1"
	return environment
}

function relativeWorkspacePath(workspace: string, value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
		throw new Error("scripted file path must be non-empty")
	}
	const resolved = path.resolve(workspace, value)
	const relative = path.relative(workspace, resolved)
	if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
		throw new Error(`scripted file path escapes workspace: ${value}`)
	}
	return resolved
}

async function applyDevelopmentScript(workspace: string, phase: DevelopmentPhaseId): Promise<string[]> {
	const calls = developmentScript(phase, workspace)
	const executedCommands: string[] = []
	for (const call of calls) {
		const args = call.arguments
		switch (call.name) {
			case "read_file":
				await fs.readFile(relativeWorkspacePath(workspace, args.path), "utf8")
				break
			case "write_to_file": {
				const filePath = relativeWorkspacePath(workspace, args.path)
				if (typeof args.content !== "string") throw new Error("scripted file content must be a string")
				await fs.mkdir(path.dirname(filePath), { recursive: true })
				await fs.writeFile(filePath, args.content, "utf8")
				break
			}
			case "execute_command": {
				if (typeof args.command !== "string" || args.cwd !== workspace || args.timeout !== 30) {
					throw new Error("scripted command arguments are outside the development harness")
				}
				const tokens = tokenize(args.command)
				const program = tokens.shift()
				if (program === undefined) throw new Error("scripted command is empty")
				const executable = program === "node" ? process.execPath : program
				try {
					await execFileAsync(executable, tokens, {
						cwd: workspace,
						env: safeChildEnvironment(workspace),
						...COMMAND_OPTIONS,
					})
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error)
					throw new Error(`scripted command failed: ${args.command}: ${detail}`)
				}
				executedCommands.push(args.command)
				break
			}
			default:
				throw new Error(`unexpected scripted tool: ${call.name}`)
		}
	}

	const required = DEVELOPMENT_PHASES[phase].requiredCommands
	assert.ok(
		required.every((command) => executedCommands.includes(command)),
		`script did not execute required commands: ${required.filter((command) => !executedCommands.includes(command)).join(" | ")}`,
	)
	return executedCommands
}

async function createOwnedWorkspace(): Promise<{ container: string; workspace: string }> {
	const container = await fs.mkdtemp(path.join(tmpdir(), TEST_ROOT_PREFIX))
	const workspace = path.join(container, "workspace")
	await fs.mkdir(workspace)
	await fs.writeFile(path.join(workspace, TEST_ROOT_OWNERSHIP_MARKER), RUNNER_WORKSPACE_MARKER, "utf8")
	return { container, workspace }
}

async function removeOwnedWorkspace(container: string): Promise<void> {
	const stats = await fs.lstat(container)
	assert.equal(stats.isSymbolicLink(), false)
	assert.equal(stats.isDirectory(), true)
	const canonical = await fs.realpath(container)
	const expectedParent = await fs.realpath(path.dirname(container))
	assert.equal(
		process.platform === "win32" ? path.dirname(canonical).toLowerCase() : path.dirname(canonical),
		process.platform === "win32" ? expectedParent.toLowerCase() : expectedParent,
	)
	assert.match(path.basename(canonical), new RegExp(`^${TEST_ROOT_PREFIX}`))
	await fs.rm(canonical, { force: true, recursive: true })
}

async function withOwnedWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
	const { container, workspace } = await createOwnedWorkspace()
	try {
		await run(workspace)
	} finally {
		disposeDevelopmentFixture(workspace)
		await removeOwnedWorkspace(container)
	}
}

async function assertChecksPass(
	workspace: string,
	scenarioId: (typeof DEVELOPMENT_SCENARIO_IDS)[number],
	phase: "baseline" | DevelopmentPhaseId,
) {
	const checks = await verifyDevelopmentFixture(workspace, scenarioId, phase)
	assert.equal(
		allChecksPassed(checks),
		true,
		`${scenarioId}/${phase} failed checks: ${failedCheckNames(checks).join(", ")}`,
	)
}

test("keeps the development catalog typed, bounded, and scriptable", () => {
	assert.deepEqual(Object.keys(DEVELOPMENT_SCENARIOS), [...DEVELOPMENT_SCENARIO_IDS])
	const phaseIds = Object.keys(DEVELOPMENT_PHASES)
	assert.equal(new Set(phaseIds).size, phaseIds.length)
	for (const phaseId of phaseIds as DevelopmentPhaseId[]) {
		assert.match(phaseId, /^dev[A-Z]/)
		const phase = DEVELOPMENT_PHASES[phaseId]
		const allowedCommands: readonly string[] = phase.commands
		const requiredCommands: readonly string[] = phase.requiredCommands
		assert.ok(phase.commands.length > 0)
		assert.ok(phase.requiredCommands.length > 0)
		assert.ok(requiredCommands.every((command) => allowedCommands.includes(command)))
		assert.ok(requiredCommands.every((command) => phase.prompt.includes(command)))
		const calls = developmentScript(phaseId, path.join(tmpdir(), "alpha-code-development-script-preview"))
		const scriptCommands: string[] = calls
			.filter((call) => call.name === "execute_command")
			.map((call) => {
				if (typeof call.arguments.command !== "string") throw new Error("script command must be a string")
				return call.arguments.command
			})
		assert.ok(requiredCommands.every((command) => scriptCommands.includes(command)))
	}
	assert.match(DEVELOPMENT_PHASES.devRefactorExtract.prompt, /lib\/lineItemTotal\.cjs/)
	assert.match(DEVELOPMENT_PHASES.devRefactorExtract.prompt, /lineItemTotal\(item\)/)
	assert.match(DEVELOPMENT_PHASES.devMigrationUpgrade.prompt, /kind = "account"/)
})

for (const scenarioId of ["dev-search-recovery", "dev-verification-unavailable"] as const) {
	test(`${scenarioId} seeds a real tested repository and detects changed data`, async () => {
		await withOwnedWorkspace(async (workspace) => {
			await createDevelopmentFixture(workspace, scenarioId)
			await assertChecksPass(workspace, scenarioId, "baseline")
			for (const phase of DEVELOPMENT_SCENARIOS[scenarioId].phases)
				await assertChecksPass(workspace, scenarioId, phase)
			await fs.writeFile(path.join(workspace, "config/local-integration.json"), "{}")
			const checks = await verifyDevelopmentFixture(
				workspace,
				scenarioId,
				DEVELOPMENT_SCENARIOS[scenarioId].phases[0],
			)
			assert.ok(failedCheckNames(checks).includes("recovery-all-workspace-bytes-preserved"))
			assert.ok(failedCheckNames(checks).includes("recovery-integration-config-remains-absent"))
		})
	})
}

test("creates, builds, and independently verifies the bootstrap scenario", async () => {
	await withOwnedWorkspace(async (workspace) => {
		await createDevelopmentFixture(workspace, "dev-repo-bootstrap")
		await assertChecksPass(workspace, "dev-repo-bootstrap", "baseline")
		assert.deepEqual(
			(await fs.readdir(workspace)).sort(),
			[
				TEST_ROOT_OWNERSHIP_MARKER,
				DEVELOPMENT_FILES.alphaIgnore,
				DEVELOPMENT_FILES.marker,
				DEVELOPMENT_FILES.readme,
			].sort(),
		)
		await applyDevelopmentScript(workspace, "devBootstrapBuild")
		await assertChecksPass(workspace, "dev-repo-bootstrap", "devBootstrapBuild")
		// Actual VS Code file tools may use CRLF. Ignore semantics, not one spelling, are the contract.
		await fs.writeFile(
			path.join(workspace, DEVELOPMENT_FILES.gitIgnore),
			"# controller files\r\n.alpha-development-*\r\n.alpha-e2e-owned.json\r\n",
		)
		await execFileAsync(
			"git",
			[
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"-c",
				"commit.gpgSign=false",
				"-c",
				"core.hooksPath=.git/alpha-empty-hooks",
				"commit",
				"--only",
				"--no-verify",
				"-m",
				"ignore formatting",
				"--",
				".gitignore",
			],
			{ cwd: workspace, env: safeChildEnvironment(workspace), ...COMMAND_OPTIONS },
		)
		const formattedChecks = await verifyDevelopmentFixture(workspace, "dev-repo-bootstrap", "devBootstrapBuild")
		assert.equal(formattedChecks.find((check) => check.name === "gitignore-protected")?.passed, true)
		await fs.appendFile(path.join(workspace, DEVELOPMENT_FILES.gitIgnore), "!.alpha-e2e-owned.json\n")
		const exposedChecks = await verifyDevelopmentFixture(workspace, "dev-repo-bootstrap", "devBootstrapBuild")
		assert.equal(exposedChecks.find((check) => check.name === "gitignore-protected")?.passed, false)
		await fs.appendFile(
			path.join(workspace, DEVELOPMENT_FILES.cartTest),
			'\ntest("a real failure", () => assert.fail("failure"))\n',
		)
		const failingTests = await verifyDevelopmentFixture(workspace, "dev-repo-bootstrap", "devBootstrapBuild")
		assert.equal(failingTests.find((check) => check.name === "bootstrap-tests-executed")?.passed, false)
		assert.equal(
			await fs.readFile(path.join(workspace, DEVELOPMENT_FILES.alphaIgnore), "utf8"),
			DEVELOPMENT_REFERENCE_CONTENT.alphaIgnore,
		)
	})
})

test("verifies inspection preserves every seeded Git and file byte", async () => {
	await withOwnedWorkspace(async (workspace) => {
		await createDevelopmentFixture(workspace, "dev-git-inspect")
		await assertChecksPass(workspace, "dev-git-inspect", "baseline")
		await applyDevelopmentScript(workspace, "devInspectReadOnly")
		await assertChecksPass(workspace, "dev-git-inspect", "devInspectReadOnly")
		await assertChecksPass(workspace, "dev-git-inspect", "baseline")
		await fs.appendFile(path.join(workspace, DEVELOPMENT_FILES.inspectNote), "changed\n")
		const failures = failedCheckNames(
			await verifyDevelopmentFixture(workspace, "dev-git-inspect", "devInspectReadOnly"),
		)
		assert.ok(failures.includes("inspect-untracked-bytes-preserved"))
	})
})

test("requires a substantive behavior-preserving refactor commit", async () => {
	await withOwnedWorkspace(async (workspace) => {
		await createDevelopmentFixture(workspace, "dev-refactor")
		await assertChecksPass(workspace, "dev-refactor", "baseline")
		assert.equal(
			allChecksPassed(await verifyDevelopmentFixture(workspace, "dev-refactor", "devRefactorExtract")),
			false,
		)
		await applyDevelopmentScript(workspace, "devRefactorExtract")
		await assertChecksPass(workspace, "dev-refactor", "devRefactorExtract")
	})
})

test("requires selective commit scope while preserving the real index blob", async () => {
	await withOwnedWorkspace(async (workspace) => {
		await createDevelopmentFixture(workspace, "dev-selective-commit")
		await assertChecksPass(workspace, "dev-selective-commit", "baseline")
		assert.equal(
			allChecksPassed(await verifyDevelopmentFixture(workspace, "dev-selective-commit", "devSelectiveCommit")),
			false,
		)
		await applyDevelopmentScript(workspace, "devSelectiveCommit")
		await assertChecksPass(workspace, "dev-selective-commit", "devSelectiveCommit")
		const staged = path.join(workspace, DEVELOPMENT_FILES.selectiveStaged)
		await fs.writeFile(staged, "index changed\n")
		await execFileAsync("git", ["add", "--", DEVELOPMENT_FILES.selectiveStaged], {
			cwd: workspace,
			env: safeChildEnvironment(workspace),
			...COMMAND_OPTIONS,
		})
		await fs.writeFile(staged, DEVELOPMENT_REFERENCE_CONTENT.selectiveStaged)
		const failures = failedCheckNames(
			await verifyDevelopmentFixture(workspace, "dev-selective-commit", "devSelectiveCommit"),
		)
		assert.ok(failures.includes("selective-unrelated-staged-index-bytes-retained"))
	})
})

test("requires a true two-parent merge that resolves the seeded conflict", async () => {
	await withOwnedWorkspace(async (workspace) => {
		await createDevelopmentFixture(workspace, "dev-merge-conflict")
		await assertChecksPass(workspace, "dev-merge-conflict", "baseline")
		await applyDevelopmentScript(workspace, "devMergeResolve")
		await assertChecksPass(workspace, "dev-merge-conflict", "devMergeResolve")
	})
})

test("requires a fresh-v1 migration, executed tests, and idempotent rerun", async () => {
	await withOwnedWorkspace(async (workspace) => {
		await createDevelopmentFixture(workspace, "dev-local-migration")
		await assertChecksPass(workspace, "dev-local-migration", "baseline")
		await applyDevelopmentScript(workspace, "devMigrationUpgrade")
		await assertChecksPass(workspace, "dev-local-migration", "devMigrationUpgrade")
		const upgraded = await fs.readFile(path.join(workspace, DEVELOPMENT_FILES.data))
		await applyDevelopmentScript(workspace, "devMigrationRerun")
		await assertChecksPass(workspace, "dev-local-migration", "devMigrationRerun")
		assert.deepEqual(await fs.readFile(path.join(workspace, DEVELOPMENT_FILES.data)), upgraded)
		await fs.appendFile(path.join(workspace, DEVELOPMENT_FILES.data), "\n")
		let failures = failedCheckNames(
			await verifyDevelopmentFixture(workspace, "dev-local-migration", "devMigrationRerun"),
		)
		assert.ok(failures.includes("migration-rerun-matches-upgrade-bytes"))
		await fs.writeFile(path.join(workspace, DEVELOPMENT_FILES.data), upgraded)
		await fs.writeFile(path.join(workspace, DEVELOPMENT_FILES.migration), "// Pretend the migration succeeded.\n")
		failures = failedCheckNames(
			await verifyDevelopmentFixture(workspace, "dev-local-migration", "devMigrationRerun"),
		)
		assert.ok(failures.includes("migration-fresh-v1-is-idempotent"))
		assert.ok(
			!failures.includes("migration-tests-executed"),
			"already-upgraded data can fool the visible tests alone",
		)
		const altered = JSON.parse(upgraded.toString("utf8"))
		delete altered.metadata
		await fs.writeFile(path.join(workspace, DEVELOPMENT_FILES.data), JSON.stringify(altered))
		failures = failedCheckNames(
			await verifyDevelopmentFixture(workspace, "dev-local-migration", "devMigrationRerun"),
		)
		assert.ok(failures.includes("migration-data-upgraded"))
	})
})

test("rejects unsafe or corrupted fixture state without silently repairing it", async () => {
	await withOwnedWorkspace(async (workspace) => {
		const userFile = path.join(workspace, "user-file.txt")
		await fs.writeFile(userFile, "user data\n", "utf8")
		await assert.rejects(createDevelopmentFixture(workspace, "dev-repo-bootstrap"), /owned|non-empty|marker/i)
		assert.equal(await fs.readFile(userFile, "utf8"), "user data\n")
	})

	await withOwnedWorkspace(async (workspace) => {
		await createDevelopmentFixture(workspace, "dev-repo-bootstrap")
		const markerPath = path.join(workspace, DEVELOPMENT_FILES.marker)
		await fs.writeFile(markerPath, "{}\n", "utf8")
		await assert.rejects(verifyDevelopmentFixture(workspace, "dev-repo-bootstrap", "baseline"), /marker/i)
	})

	await withOwnedWorkspace(async (workspace) => {
		await assert.rejects(createDevelopmentFixture(path.parse(workspace).root, "dev-repo-bootstrap"), /root|owned/i)
	})
})
