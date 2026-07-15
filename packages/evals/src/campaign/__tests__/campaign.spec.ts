import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, describe, expect, it } from "vitest"

import { CampaignRunner } from "../runner"
import { findRepositoryRoot } from "../cli"
import { assertCommandAllowed, campaignConfigSchema, resolveContainedPath } from "../schema"
import type { CampaignConfig, Clock, ProcessResult, ProcessRunner, ProcessSpec } from "../types"

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-campaign-"))
	roots.push(root)
	await fs.mkdir(path.join(root, "docs"), { recursive: true })
	await fs.writeFile(path.join(root, "docs", "core-harness-comparison.md"), "target")
	await fs.writeFile(path.join(root, "package.json"), "{}")
	return root
}

function config(overrides: Partial<CampaignConfig> = {}): CampaignConfig {
	return {
		version: 1,
		id: "test-campaign",
		target: "target.md",
		artifactRoot: ".frontier-campaign/campaigns",
		budgets: {
			maxCampaignWallMs: 10_000,
			maxCommandWallMs: 1_000,
			maxCommands: 3,
			maxOutputBytesPerCommand: 1_024,
		},
		allowedCommandPrefixes: [["pnpm", "check"]],
		validationCommands: [{ id: "check", command: "pnpm", args: ["check"], cwd: "." }],
		model: { enabled: false },
		...overrides,
	}
}

class FakeClock implements Clock {
	constructor(private value = 0) {}
	now(): Date {
		return new Date(this.value)
	}
	monotonicMs(): number {
		return this.value
	}
	advance(ms: number): void {
		this.value += ms
	}
}

class FakeProcessRunner implements ProcessRunner {
	calls: ProcessSpec[] = []
	constructor(
		private readonly results: Array<ProcessResult | Error>,
		private readonly clock: FakeClock,
	) {}
	async run(spec: ProcessSpec): Promise<ProcessResult> {
		this.calls.push(spec)
		this.clock.advance(10)
		const result = this.results.shift()
		if (result instanceof Error) throw result
		if (!result) throw new Error("No fake result")
		return result
	}
}

const passedResult: ProcessResult = {
	exitCode: 0,
	stdout: "ok\n",
	stderr: "",
	durationMs: 10,
	timedOut: false,
	outputTruncated: false,
}

describe("campaign configuration", () => {
	it("finds the repository root from a nested package directory", async () => {
		const root = await makeRoot()
		const nested = path.join(root, "packages", "evals")
		await fs.mkdir(nested, { recursive: true })
		expect(findRepositoryRoot(nested)).toBe(root)
	})

	it("rejects model-enabled campaigns", () => {
		expect(() => campaignConfigSchema.parse({ ...config(), model: { enabled: true } })).toThrow()
	})

	it("contains paths inside the repository", async () => {
		const root = await makeRoot()
		expect(resolveContainedPath(root, ".frontier-campaign")).toBe(path.join(root, ".frontier-campaign"))
		expect(() => resolveContainedPath(root, "../outside")).toThrow(/escapes repository/)
	})

	it("requires structured commands to match an explicit prefix", () => {
		const command = config().validationCommands[0]!
		expect(() => assertCommandAllowed(command, [["pnpm", "check"]])).not.toThrow()
		expect(() => assertCommandAllowed(command, [["pnpm", "test"]])).toThrow(/not allowlisted/)
	})
})

describe("CampaignRunner", () => {
	it("runs validation and records durable command artifacts", async () => {
		const root = await makeRoot()
		const clock = new FakeClock()
		const processRunner = new FakeProcessRunner([passedResult], clock)
		const runner = new CampaignRunner({ repositoryRoot: root, config: config(), processRunner, clock })
		const attempt = await runner.runValidation()

		expect(attempt.status).toBe("passed")
		expect(attempt.commands).toHaveLength(1)
		expect(processRunner.calls).toHaveLength(1)
		const state = await runner.readState()
		expect(state.status).toBe("completed")
		const commandRoot = path.join(
			root,
			".frontier-campaign/campaigns/test-campaign/attempts",
			attempt.id,
			"commands/check",
		)
		expect(await fs.readFile(path.join(commandRoot, "stdout.txt"), "utf8")).toBe("ok\n")
		const result = JSON.parse(await fs.readFile(path.join(commandRoot, "result.json"), "utf8"))
		expect(result.stdoutDigest).toMatch(/^[a-f0-9]{64}$/)
	})

	it("stops on validation failure and does not run later commands", async () => {
		const root = await makeRoot()
		const clock = new FakeClock()
		const processRunner = new FakeProcessRunner(
			[{ ...passedResult, exitCode: 1, stderr: "failed" }, passedResult],
			clock,
		)
		const campaign = config({
			validationCommands: [
				{ id: "first", command: "pnpm", args: ["check"], cwd: "." },
				{ id: "second", command: "pnpm", args: ["check"], cwd: "." },
			],
		})
		const attempt = await new CampaignRunner({
			repositoryRoot: root,
			config: campaign,
			processRunner,
			clock,
		}).runValidation()
		expect(attempt.status).toBe("validation_failed")
		expect(processRunner.calls).toHaveLength(1)
	})

	it("classifies process spawn failures as infrastructure errors", async () => {
		const root = await makeRoot()
		const clock = new FakeClock()
		const processRunner = new FakeProcessRunner([new Error("spawn failed")], clock)
		const attempt = await new CampaignRunner({
			repositoryRoot: root,
			config: config(),
			processRunner,
			clock,
		}).runValidation()
		expect(attempt.status).toBe("infrastructure_error")
		expect(attempt.commands[0]?.status).toBe("infrastructure_error")
	})

	it("enforces the command-count budget before executing excess commands", async () => {
		const root = await makeRoot()
		const clock = new FakeClock()
		const processRunner = new FakeProcessRunner([passedResult, passedResult], clock)
		const campaign = config({
			budgets: { ...config().budgets, maxCommands: 1 },
			validationCommands: [
				{ id: "first", command: "pnpm", args: ["check"], cwd: "." },
				{ id: "second", command: "pnpm", args: ["check"], cwd: "." },
			],
		})
		const attempt = await new CampaignRunner({
			repositoryRoot: root,
			config: campaign,
			processRunner,
			clock,
		}).runValidation()
		expect(attempt.status).toBe("budget_exhausted")
		expect(processRunner.calls).toHaveLength(1)
	})

	it("dry run performs no child-process execution", async () => {
		const root = await makeRoot()
		const clock = new FakeClock()
		const processRunner = new FakeProcessRunner([], clock)
		const commands = new CampaignRunner({ repositoryRoot: root, config: config(), processRunner, clock }).dryRun()
		expect(commands).toHaveLength(1)
		expect(processRunner.calls).toHaveLength(0)
	})

	it("resumes a running attempt without rerunning completed commands", async () => {
		const root = await makeRoot()
		const clock = new FakeClock()
		const campaign = config({
			validationCommands: [
				{ id: "first", command: "pnpm", args: ["check"], cwd: "." },
				{ id: "second", command: "pnpm", args: ["check"], cwd: "." },
			],
		})
		const firstProcess = new FakeProcessRunner([passedResult], clock)
		const firstRunner = new CampaignRunner({
			repositoryRoot: root,
			config: campaign,
			processRunner: firstProcess,
			clock,
		})
		await firstRunner.initialize()
		const state = await firstRunner.readState()
		state.status = "running"
		state.attempts.push({
			id: "interrupted",
			status: "running",
			startedAt: clock.now().toISOString(),
			commands: [
				{
					id: "first",
					command: "pnpm",
					args: ["check"],
					cwd: ".",
					startedAt: clock.now().toISOString(),
					finishedAt: clock.now().toISOString(),
					durationMs: 1,
					exitCode: 0,
					status: "passed",
					stdoutArtifact: "first/stdout.txt",
					stderrArtifact: "first/stderr.txt",
					stdoutDigest: "a".repeat(64),
					stderrDigest: "b".repeat(64),
					stdoutBytes: 0,
					stderrBytes: 0,
					outputTruncated: false,
				},
			],
		})
		await fs.writeFile(
			path.join(root, ".frontier-campaign/campaigns/test-campaign/campaign.json"),
			JSON.stringify(state),
		)
		const resumeProcess = new FakeProcessRunner([passedResult], clock)
		const attempt = await new CampaignRunner({
			repositoryRoot: root,
			config: campaign,
			processRunner: resumeProcess,
			clock,
		}).runValidation({ resume: true })
		expect(attempt.status).toBe("passed")
		expect(attempt.commands.map((command) => command.id)).toEqual(["first", "second"])
		expect(resumeProcess.calls).toHaveLength(1)
	})

	it("does not turn --resume into an accidental new attempt", async () => {
		const root = await makeRoot()
		const runner = new CampaignRunner({ repositoryRoot: root, config: config() })
		await runner.initialize()
		await expect(runner.runValidation({ resume: true })).rejects.toThrow(/No running attempt/)
		expect((await runner.readState()).attempts).toHaveLength(0)
	})

	it("rejects silent configuration changes after initialization", async () => {
		const root = await makeRoot()
		const runner = new CampaignRunner({ repositoryRoot: root, config: config() })
		await runner.initialize()
		const changed = new CampaignRunner({ repositoryRoot: root, config: config({ target: ".frontier-campaign" }) })
		await expect(changed.initialize()).rejects.toThrow(/configuration changed/)
	})
})
