import * as crypto from "crypto"
import * as path from "path"

import { digestContent, fileExists, readJson, writeAtomic, writeJsonAtomic } from "./artifacts"
import { BudgetExceededError, CampaignBudget } from "./budget"
import { assertCommandAllowed, resolveContainedPath } from "./schema"
import { ExecaProcessRunner } from "./process"
import type { CampaignAttempt, CampaignConfig, CampaignState, Clock, CommandArtifact, ProcessRunner } from "./types"

export class SystemClock implements Clock {
	now(): Date {
		return new Date()
	}
	monotonicMs(): number {
		return performance.now()
	}
}

export interface CampaignRunnerOptions {
	repositoryRoot: string
	config: CampaignConfig
	processRunner?: ProcessRunner
	clock?: Clock
}

export interface DryRunCommand {
	id: string
	command: string
	args: string[]
	cwd: string
	timeoutMs: number
}

export class CampaignRunner {
	private readonly processRunner: ProcessRunner
	private readonly clock: Clock
	private readonly repositoryRoot: string
	private readonly artifactRoot: string
	private readonly campaignRoot: string
	private readonly statePath: string
	private readonly configDigest: string

	constructor(private readonly options: CampaignRunnerOptions) {
		this.processRunner = options.processRunner ?? new ExecaProcessRunner()
		this.clock = options.clock ?? new SystemClock()
		this.repositoryRoot = path.resolve(options.repositoryRoot)
		this.artifactRoot = resolveContainedPath(this.repositoryRoot, options.config.artifactRoot)
		this.campaignRoot = path.join(this.artifactRoot, options.config.id)
		this.statePath = path.join(this.campaignRoot, "campaign.json")
		this.configDigest = digestContent(JSON.stringify(options.config))
		this.validateConfigPathsAndCommands()
	}

	private validateConfigPathsAndCommands(): void {
		resolveContainedPath(this.repositoryRoot, this.options.config.target)
		if (this.options.config.suite) resolveContainedPath(this.repositoryRoot, this.options.config.suite)
		for (const command of this.options.config.validationCommands) {
			assertCommandAllowed(command, this.options.config.allowedCommandPrefixes)
			resolveContainedPath(this.repositoryRoot, command.cwd)
		}
	}

	async initialize(): Promise<CampaignState> {
		if (await fileExists(this.statePath)) {
			const state = await this.readState()
			if (state.configDigest !== this.configDigest) {
				throw new Error("Campaign configuration changed after initialization; use a new campaign id")
			}
			return state
		}
		const now = this.clock.now().toISOString()
		const state: CampaignState = {
			version: 1,
			id: this.options.config.id,
			configDigest: this.configDigest,
			status: "created",
			createdAt: now,
			updatedAt: now,
			attempts: [],
		}
		await writeJsonAtomic(this.statePath, state)
		return state
	}

	async readState(): Promise<CampaignState> {
		if (!(await fileExists(this.statePath))) throw new Error("Campaign is not initialized")
		return readJson<CampaignState>(this.statePath)
	}

	dryRun(): DryRunCommand[] {
		return this.options.config.validationCommands.map((command) => ({
			...command,
			cwd: resolveContainedPath(this.repositoryRoot, command.cwd),
			timeoutMs: this.options.config.budgets.maxCommandWallMs,
		}))
	}

	async runValidation(options: { resume?: boolean } = {}): Promise<CampaignAttempt> {
		const state = await this.initialize()
		const runningAttempt = state.attempts.find((attempt) => attempt.status === "running")
		if (options.resume && !runningAttempt) {
			throw new Error("No running attempt is available to resume")
		}
		if (runningAttempt && !options.resume) {
			throw new Error("Campaign contains a running attempt; rerun with --resume to continue it")
		}

		const nowMonotonic = this.clock.monotonicMs()
		const now = this.clock.now()
		let attempt: CampaignAttempt
		let startedAtMonotonic: number
		if (runningAttempt) {
			attempt = runningAttempt
			if (attempt.commands.some((command) => command.status !== "passed")) {
				throw new Error("Running attempt contains a non-passing command and cannot be resumed")
			}
			const elapsedWallMs = Math.max(0, now.getTime() - Date.parse(attempt.startedAt))
			startedAtMonotonic = nowMonotonic - elapsedWallMs
		} else {
			const startedAt = now.toISOString()
			startedAtMonotonic = nowMonotonic
			attempt = {
				id: `${startedAt.replace(/[:.]/g, "")}-${crypto.randomUUID().slice(0, 8)}`,
				status: "running",
				startedAt,
				commands: [],
			}
			state.status = "running"
			state.updatedAt = startedAt
			state.attempts.push(attempt)
			await this.writeState(state)
		}

		const budget = new CampaignBudget(this.options.config.budgets, startedAtMonotonic, attempt.commands.length)

		try {
			for (const command of this.options.config.validationCommands.slice(attempt.commands.length)) {
				budget.beforeCommand(this.clock.monotonicMs())
				const artifact = await this.runCommand(
					attempt.id,
					command,
					budget.remainingCommandWallMs(this.clock.monotonicMs()),
				)
				attempt.commands.push(artifact)
				await this.writeState(state)
				if (artifact.status !== "passed") {
					const status =
						artifact.status === "infrastructure_error" ? "infrastructure_error" : "validation_failed"
					return this.finishAttempt(state, attempt, status, `Command ${command.id} ${artifact.status}`)
				}
			}
			return this.finishAttempt(state, attempt, "passed", "All validation commands passed")
		} catch (error) {
			if (error instanceof BudgetExceededError) {
				return this.finishAttempt(state, attempt, "budget_exhausted", error.message)
			}
			return this.finishAttempt(
				state,
				attempt,
				"infrastructure_error",
				error instanceof Error ? error.message : String(error),
			)
		}
	}

	private async runCommand(
		attemptId: string,
		command: CampaignConfig["validationCommands"][number],
		timeoutMs: number,
	): Promise<CommandArtifact> {
		const startedAtMonotonic = this.clock.monotonicMs()
		const startedAt = this.clock.now().toISOString()
		const commandRoot = path.join(this.campaignRoot, "attempts", attemptId, "commands", command.id)
		try {
			const result = await this.processRunner.run({
				command: command.command,
				args: command.args,
				cwd: resolveContainedPath(this.repositoryRoot, command.cwd),
				timeoutMs,
				maxOutputBytes: this.options.config.budgets.maxOutputBytesPerCommand,
			})
			const stdoutPath = path.join(commandRoot, "stdout.txt")
			const stderrPath = path.join(commandRoot, "stderr.txt")
			await writeAtomic(stdoutPath, result.stdout)
			await writeAtomic(stderrPath, result.stderr)
			const finishedAt = this.clock.now().toISOString()
			const artifact: CommandArtifact = {
				id: command.id,
				command: command.command,
				args: command.args,
				cwd: command.cwd,
				startedAt,
				finishedAt,
				durationMs: result.durationMs || Math.round(this.clock.monotonicMs() - startedAtMonotonic),
				exitCode: result.exitCode,
				status: result.timedOut ? "timed_out" : result.exitCode === 0 ? "passed" : "failed",
				stdoutArtifact: path.relative(this.campaignRoot, stdoutPath).replaceAll(path.sep, "/"),
				stderrArtifact: path.relative(this.campaignRoot, stderrPath).replaceAll(path.sep, "/"),
				stdoutDigest: digestContent(result.stdout),
				stderrDigest: digestContent(result.stderr),
				stdoutBytes: Buffer.byteLength(result.stdout),
				stderrBytes: Buffer.byteLength(result.stderr),
				outputTruncated: result.outputTruncated,
			}
			await writeJsonAtomic(path.join(commandRoot, "result.json"), artifact)
			return artifact
		} catch (error) {
			const finishedAt = this.clock.now().toISOString()
			const message = error instanceof Error ? error.message : String(error)
			const stderrPath = path.join(commandRoot, "stderr.txt")
			const stdoutPath = path.join(commandRoot, "stdout.txt")
			await writeAtomic(stdoutPath, "")
			await writeAtomic(stderrPath, message)
			const artifact: CommandArtifact = {
				id: command.id,
				command: command.command,
				args: command.args,
				cwd: command.cwd,
				startedAt,
				finishedAt,
				durationMs: Math.round(this.clock.monotonicMs() - startedAtMonotonic),
				exitCode: null,
				status: "infrastructure_error",
				stdoutArtifact: path.relative(this.campaignRoot, stdoutPath).replaceAll(path.sep, "/"),
				stderrArtifact: path.relative(this.campaignRoot, stderrPath).replaceAll(path.sep, "/"),
				stdoutDigest: digestContent(""),
				stderrDigest: digestContent(message),
				stdoutBytes: 0,
				stderrBytes: Buffer.byteLength(message),
				outputTruncated: false,
				error: message,
			}
			await writeJsonAtomic(path.join(commandRoot, "result.json"), artifact)
			return artifact
		}
	}

	private async finishAttempt(
		state: CampaignState,
		attempt: CampaignAttempt,
		status: Exclude<CampaignAttempt["status"], "running">,
		reason: string,
	): Promise<CampaignAttempt> {
		attempt.status = status
		attempt.reason = reason
		attempt.finishedAt = this.clock.now().toISOString()
		attempt.durationMs = Math.max(0, Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt))
		state.status = status === "passed" ? "completed" : status === "budget_exhausted" ? "budget_exhausted" : "failed"
		state.updatedAt = attempt.finishedAt
		await this.writeState(state)
		return attempt
	}

	private async writeState(state: CampaignState): Promise<void> {
		await writeJsonAtomic(this.statePath, state)
	}
}
