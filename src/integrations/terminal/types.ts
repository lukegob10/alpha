import EventEmitter from "events"

export type AlphaTerminalProvider = "vscode" | "execa"

export const DEFAULT_TERMINAL_OUTPUT_RECEIPT_MAX_CHARACTERS = 50_000
/** Maximum cleanup prefix carried into a later receipt's rendered output. */
export const MAX_TERMINAL_OUTPUT_RECEIPT_CARRY_CHARACTERS = 32

export interface TerminalOutputReceipt {
	readonly output: string
	commit(): void
	release(): void
}

export interface AlphaTerminal {
	provider: AlphaTerminalProvider
	id: number
	busy: boolean
	running: boolean
	taskId?: string
	process?: AlphaTerminalProcess
	getCurrentWorkingDirectory(): string
	isClosed: () => boolean
	runCommand: (command: string, callbacks: AlphaTerminalCallbacks) => AlphaTerminalProcessResultPromise
	setActiveStream(stream: AsyncIterable<string> | undefined, pid?: number): void
	shellExecutionComplete(exitDetails: ExitCodeDetails): void
	getProcessesWithOutput(): AlphaTerminalProcess[]
	getUnretrievedOutput(): string
	getLastCommand(): string
	cleanCompletedProcessQueue(): void
}

export interface AlphaTerminalCallbacks {
	onLine: (line: string, process: AlphaTerminalProcess) => void
	onCompleted: (output: string | undefined, process: AlphaTerminalProcess) => void | Promise<void>
	onShellExecutionStarted: (pid: number | undefined, process: AlphaTerminalProcess) => void
	onShellExecutionComplete: (details: ExitCodeDetails, process: AlphaTerminalProcess) => void
	onNoShellIntegration?: (message: string, process: AlphaTerminalProcess) => void
}

export interface AlphaTerminalProcess extends EventEmitter<AlphaTerminalProcessEvents> {
	executionId?: string
	writeInput?: (input: string) => void | Promise<void>
	command: string
	isHot: boolean
	/** True only after the process emitted its terminal completed/error event. */
	isSettled?: boolean
	run: (command: string) => Promise<void>
	continue: () => void
	abort: () => void | Promise<void>
	hasUnretrievedOutput: () => boolean
	getUnretrievedOutput: () => string
	/**
	 * Captures at most maxCharacters raw characters without consuming them.
	 * Cleanup may emit up to MAX_TERMINAL_OUTPUT_RECEIPT_CARRY_CHARACTERS
	 * additional deferred ESC/CSI prefix characters in a later receipt.
	 */
	captureUnretrievedOutput(maxCharacters?: number): TerminalOutputReceipt
	trimRetrievedOutput: () => void
}

export type AlphaTerminalProcessResultPromise = AlphaTerminalProcess & Promise<void>

export interface AlphaTerminalProcessEvents {
	output_available: []
	line: [line: string]
	continue: []
	completed: [output?: string]
	stream_available: [stream: AsyncIterable<string>]
	shell_execution_started: [pid: number | undefined]
	shell_execution_complete: [exitDetails: ExitCodeDetails]
	error: [error: Error]
	no_shell_integration: [message: string]
}

export interface ExitCodeDetails {
	exitCode: number | undefined
	signal?: number | undefined
	signalName?: string
	coreDumpPossible?: boolean
}
