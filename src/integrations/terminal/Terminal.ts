import * as vscode from "vscode"

import type { AlphaTerminalCallbacks, AlphaTerminalProcessResultPromise, CommandShellLaunch } from "./types"
import { terminalShellArgs } from "../../utils/shell"
import { BaseTerminal } from "./BaseTerminal"
import { TerminalProcess } from "./TerminalProcess"
import { ShellIntegrationManager } from "./ShellIntegrationManager"
import { mergePromise } from "./mergePromise"
import { t } from "../../i18n"

export class Terminal extends BaseTerminal {
	public terminal: vscode.Terminal
	private readonly pendingProcesses = new Set<TerminalProcess>()

	public cmdCounter: number = 0

	constructor(
		id: number,
		terminal: vscode.Terminal | undefined,
		cwd: string,
		commandEnv: Record<string, string> = {},
		readonly shellLaunch?: CommandShellLaunch,
	) {
		super("vscode", id, cwd)

		const env = { ...Terminal.getEnv(), ...commandEnv }
		const iconPath = new vscode.ThemeIcon("rocket")
		this.terminal =
			terminal ??
			vscode.window.createTerminal({
				cwd,
				name: "Alpha",
				iconPath,
				env,
				...(shellLaunch ? { shellPath: shellLaunch.shellPath, shellArgs: terminalShellArgs(shellLaunch) } : {}),
			})

		if (Terminal.getTerminalZdotdir()) {
			ShellIntegrationManager.terminalTmpDirs.set(id, env.ZDOTDIR)
		}
	}

	/**
	 * Gets the current working directory from shell integration or falls back to initial cwd.
	 * @returns The current working directory
	 */
	public override getCurrentWorkingDirectory(): string {
		return this.terminal.shellIntegration?.cwd ? this.terminal.shellIntegration.cwd.fsPath : this.initialCwd
	}

	/**
	 * The exit status of the terminal will be undefined while the terminal is
	 * active. (This value is set when onDidCloseTerminal is fired.)
	 */
	public override isClosed(): boolean {
		return this.terminal.exitStatus !== undefined
	}

	public notifyTerminalClosed(): void {
		// Shell exit releases process ownership before the output reader drains.
		// Keep those readers reachable until their physical run has finished.
		const processes = new Set(this.pendingProcesses)
		if (this.process instanceof TerminalProcess) processes.add(this.process)
		for (const process of processes) process.notifyTerminalClosed()
		this.pendingProcesses.clear()
		this.running = false
		this.busy = false
	}

	private waitForShellIntegration(
		process: TerminalProcess,
		timeoutMs: number,
	): Promise<"ready" | "timeout" | "settled"> {
		if (process.isSettled || process.terminalClosedSignal.aborted) return Promise.resolve("settled")
		if (this.terminal.shellIntegration) return Promise.resolve("ready")

		return new Promise((resolve, reject) => {
			let settled = false
			let subscription: vscode.Disposable | undefined
			let timer: ReturnType<typeof setTimeout> | undefined
			const cleanup = () => {
				clearTimeout(timer)
				subscription?.dispose()
				process.removeListener("completed", onSettled)
				process.removeListener("error", onSettled)
				process.terminalClosedSignal.removeEventListener("abort", onSettled)
			}
			const finish = (result: "ready" | "timeout" | "settled") => {
				if (settled) return
				settled = true
				cleanup()
				resolve(result)
			}
			const onSettled = () => finish("settled")
			// Release startup resources even when a later public observer throws.
			process.prependOnceListener("completed", onSettled)
			process.prependOnceListener("error", onSettled)
			process.terminalClosedSignal.addEventListener("abort", onSettled, { once: true })
			try {
				// VS Code's activation event avoids rejecting readiness between the last poll and deadline.
				subscription = vscode.window.onDidChangeTerminalShellIntegration?.(({ terminal }) => {
					if (terminal === this.terminal && terminal.shellIntegration) finish("ready")
				})
				if (settled) {
					subscription?.dispose()
					return
				}
				timer = setTimeout(() => finish(this.terminal.shellIntegration ? "ready" : "timeout"), timeoutMs)
				if (process.isSettled || process.terminalClosedSignal.aborted) finish("settled")
				else if (this.terminal.shellIntegration) finish("ready")
			} catch (error) {
				cleanup()
				reject(error)
			}
		})
	}

	public override runCommand(command: string, callbacks: AlphaTerminalCallbacks): AlphaTerminalProcessResultPromise {
		// We set busy before the command is running because the terminal may be
		// waiting on terminal integration, and we must prevent another instance
		// from selecting the terminal for use during that time.
		this.busy = true

		const process = new TerminalProcess(this)
		process.command = command
		this.process = process
		this.pendingProcesses.add(process)
		if (callbacks.onOutput) process.setOutputWriter((chunk, signal) => callbacks.onOutput!(chunk, process, signal))
		if (callbacks.onOutputClosed) process.setOutputFinalizer(() => callbacks.onOutputClosed!(process))
		try {
			callbacks.onProcessCreated?.(process)
		} catch (error) {
			this.pendingProcesses.delete(process)
			if (this.process === process) {
				this.process = undefined
				this.running = false
				this.busy = false
			}
			// No physical run or public event exists yet. Close only this archive,
			// preserving the creation failure even if its cleanup also rejects.
			void process.finalizeOutput().catch((failure: unknown) => {
				console.error(`[Terminal ${this.id}] output finalization after creation failed`, failure)
			})
			throw error
		}

		// Set up event handlers from callbacks before starting process.
		// This ensures that we don't miss any events because they are
		// configured before the process starts.
		process.on("line", (line) => callbacks.onLine(line, process))
		process.once("completed", (output) => callbacks.onCompleted(output, process))
		process.once("shell_execution_started", (pid) => callbacks.onShellExecutionStarted(pid, process))
		process.once("shell_execution_complete", (details) => callbacks.onShellExecutionComplete(details, process))
		process.once("no_shell_integration", (msg) => callbacks.onNoShellIntegration?.(msg, process))

		const promise = new Promise<void>((resolve, reject) => {
			// Set up event handlers
			process.once("continue", () => resolve())
			process.once("error", (error) => {
				console.error(`[Terminal ${this.id}] error:`, error)
				reject(error)
			})

			const timeoutMs = Terminal.getShellIntegrationTimeout()
			this.waitForShellIntegration(process, timeoutMs)
				.then((readiness) => {
					if (readiness === "settled" || process.isSettled || process.terminalClosedSignal.aborted) {
						// The shell can still need its startup script after a command is cancelled.
						resolve()
						return
					}
					ShellIntegrationManager.zshCleanupTmpDir(this.id)
					if (readiness === "timeout") {
						process.emit(
							"no_shell_integration",
							t("common:errors.command_shell_integration_timeout", { seconds: timeoutMs / 1_000 }),
						)
						return
					}
					// Closing during async completed observers may remove continue listeners.
					return process.run(command).then(() => resolve())
				})
				.catch((error: unknown) => {
					if (process.terminalClosedSignal.aborted) {
						// Preserve an observer failure after close without emitting a second error.
						reject(error)
						return
					}
					// A stream failure does not prove the shell command stopped. Keep a
					// running terminal reserved until its physical end event arrives.
					if (this.process === process) {
						if (!this.running) this.busy = false
						this.setActiveStream(undefined)
					}
					process.emit("error", error instanceof Error ? error : new Error(String(error)))
				})
				.finally(async () => {
					try {
						await process.finalizeOutput()
					} finally {
						this.pendingProcesses.delete(process)
						this.cleanCompletedProcessQueue()
					}
				})
				.catch((error: unknown) => {
					// The command already published its completed/error outcome. The
					// archival owner reports this separate failure without a second one.
					console.error(`[Terminal ${this.id}] output finalization failed`, error)
				})
		})

		return mergePromise(process, promise)
	}

	public static getEnv(): Record<string, string> {
		const env: Record<string, string> = {
			ALPHA_ACTIVE: "true",
			PAGER: process.platform === "win32" ? "" : "cat",

			// VTE must be disabled because it prevents the prompt command from executing
			// See https://wiki.gnome.org/Apps/Terminal/VTE
			VTE_VERSION: "0",
		}

		// Set Oh My Zsh shell integration if enabled
		if (Terminal.getTerminalZshOhMy()) {
			env.ITERM_SHELL_INTEGRATION_INSTALLED = "Yes"
		}

		// Set Powerlevel10k shell integration if enabled
		if (Terminal.getTerminalZshP10k()) {
			env.POWERLEVEL9K_TERM_SHELL_INTEGRATION = "true"
		}

		// VSCode bug#237208: Command output can be lost due to a race between completion
		// sequences and consumers. Add delay via PROMPT_COMMAND to ensure the
		// \x1b]633;D escape sequence arrives after command output is processed.
		// Only add this if commandDelay is not zero
		if (Terminal.getCommandDelay() > 0) {
			env.PROMPT_COMMAND = `sleep ${Terminal.getCommandDelay() / 1000}`
		}

		// Clear the ZSH EOL mark to prevent issues with command output interpretation
		// when output ends with special characters like '%'
		if (Terminal.getTerminalZshClearEolMark()) {
			env.PROMPT_EOL_MARK = ""
		}

		// Handle ZDOTDIR for zsh if enabled
		if (Terminal.getTerminalZdotdir()) {
			env.ZDOTDIR = ShellIntegrationManager.zshInitTmpDir(env)
		}

		return env
	}
}
