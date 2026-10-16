import type { AlphaTerminalCallbacks, AlphaTerminalProcessResultPromise, DirectTerminalCommand } from "./types"
import { BaseTerminal } from "./BaseTerminal"
import { ExecaTerminalProcess } from "./ExecaTerminalProcess"
import { mergePromise } from "./mergePromise"

export class ExecaTerminal extends BaseTerminal {
	constructor(
		id: number,
		cwd: string,
		readonly commandEnv: Record<string, string> = {},
	) {
		super("execa", id, cwd)
	}

	/**
	 * Unlike the VSCode terminal, this is never closed.
	 */
	public override isClosed(): boolean {
		return false
	}

	public override runCommand(
		command: string,
		callbacks: AlphaTerminalCallbacks,
		directCommand?: DirectTerminalCommand,
	): AlphaTerminalProcessResultPromise {
		this.busy = true

		const process = new ExecaTerminalProcess(this)
		process.command = command
		this.process = process
		if (callbacks.onOutput) process.setOutputWriter((chunk, signal) => callbacks.onOutput!(chunk, process, signal))
		if (callbacks.onOutputClosed) process.setOutputFinalizer(() => callbacks.onOutputClosed!(process))
		try {
			callbacks.onProcessCreated?.(process)
		} catch (error) {
			if (this.process === process) {
				this.process = undefined
				this.running = false
				this.busy = false
			}
			// The hook precedes spawn. Observe this archive's cleanup without
			// replacing the original throw or touching a replacement process.
			void process.finalizeOutput().catch((failure: unknown) => {
				console.error(`[ExecaTerminal ${this.id}] output finalization after creation failed`, failure)
			})
			throw error
		}

		process.on("line", (line) => callbacks.onLine(line, process))
		process.once("completed", (output) => callbacks.onCompleted(output, process))
		process.once("shell_execution_started", (pid) => callbacks.onShellExecutionStarted(pid, process))
		process.once("shell_execution_complete", (details) => callbacks.onShellExecutionComplete(details, process))

		const promise = new Promise<void>((resolve, reject) => {
			process.once("continue", () => resolve())
			process.once("error", (error) => reject(error))
			process.run(command, directCommand)
		})

		return mergePromise(process, promise)
	}
}
