import EventEmitter from "events"

export type AlphaTerminalProvider = "vscode" | "execa"

export const DEFAULT_TERMINAL_OUTPUT_RECEIPT_MAX_CHARACTERS = 50_000
export const MAX_TERMINAL_OUTPUT_BUFFER_BYTES = 1_048_576
export const MAX_RETAINED_TERMINAL_PROCESSES = 64
/** Maximum cleanup prefix carried into a later receipt's rendered output. */
export const MAX_TERMINAL_OUTPUT_RECEIPT_CARRY_CHARACTERS = 32

export interface TerminalOutputReceipt {
	readonly output: string
	/** Unread raw output remains outside this reservation at capture time. */
	readonly hasMoreOutput?: boolean
	commit(): void
	release(): void
}

/** Captured host-only argv. Model arguments cannot select this transport. */
export interface DirectTerminalCommand {
	readonly executable: string
	readonly args: readonly string[]
	readonly env: Readonly<Record<string, string>>
}

export interface AlphaTerminal {
	provider: AlphaTerminalProvider
	id: number
	busy: boolean
	running: boolean
	taskId?: string
	commandEnv?: Record<string, string>
	process?: AlphaTerminalProcess
	getCurrentWorkingDirectory(): string
	isClosed: () => boolean
	runCommand: (
		command: string,
		callbacks: AlphaTerminalCallbacks,
		directCommand?: DirectTerminalCommand,
	) => AlphaTerminalProcessResultPromise
	setActiveStream(stream: AsyncIterable<string> | undefined, pid?: number): void
	shellExecutionComplete(exitDetails: ExitCodeDetails): void
	getProcessesWithOutput(): AlphaTerminalProcess[]
	getUnretrievedOutput(): string
	getLastCommand(): string
	cleanCompletedProcessQueue(): void
}

export interface AlphaTerminalCallbacks {
	/** Binds task-owned archival lifetime before launch or any transport callback. */
	onProcessCreated?: (process: AlphaTerminalProcess) => void
	/** Lossless archival sink, independent of detachable line/UI listeners. */
	onOutput?: (chunk: string, process: AlphaTerminalProcess, signal: AbortSignal) => void | Promise<void>
	/** Closes archival ownership on success, reader failure, and terminal disposal. */
	onOutputClosed?: (process: AlphaTerminalProcess) => void | Promise<void>
	onLine: (line: string, process: AlphaTerminalProcess) => void
	onCompleted: (output: string | undefined, process: AlphaTerminalProcess) => void | Promise<void>
	onShellExecutionStarted: (pid: number | undefined, process: AlphaTerminalProcess) => void
	onShellExecutionComplete: (details: ExitCodeDetails, process: AlphaTerminalProcess) => void
	onNoShellIntegration?: (message: string, process: AlphaTerminalProcess) => void
}

export interface AlphaTerminalProcess extends EventEmitter<AlphaTerminalProcessEvents> {
	executionId?: string
	/** Advertised only after the lossless artifact has finished flushing. */
	outputArtifactId?: string
	outputArchiveInterrupted?: boolean
	writeInput?: (input: string) => void | Promise<void>
	interrupt?: () => void | Promise<void>
	setOutputWriter?: (writer: (chunk: string, signal: AbortSignal) => void | Promise<void>) => void
	setOutputFinalizer?: (finalizer: () => void | Promise<void>) => void
	finalizeOutput?: () => Promise<void>
	/** Passive archival barrier; never starts finalization or observes the UI/yield thenable. */
	waitForOutputFinalization?: () => Promise<void>
	/** Interrupt only an outstanding raw write before finalization, without physical control. */
	cancelPendingOutputWrite?: () => void
	readonly outputCancellationSignal?: AbortSignal
	hasActiveOutputReceipt?: () => boolean
	command: string
	isHot: boolean
	/** True only after the process emitted its terminal completed/error event. */
	isSettled?: boolean
	/** Completed observers and output persistence have released their ownership. */
	isOutputFinalized?: boolean
	run: (command: string, directCommand?: DirectTerminalCommand) => Promise<void>
	continue: () => void
	abort: () => void | Promise<void>
	hasUnretrievedOutput: () => boolean
	getUnretrievedOutput: () => string
	/**
	 * Captures at most maxCharacters raw characters without consuming them.
	 * A cap cannot split a surrogate pair; a one-unit budget may return empty.
	 * Cleanup may emit up to MAX_TERMINAL_OUTPUT_RECEIPT_CARRY_CHARACTERS
	 * additional deferred ESC/CSI prefix characters in a later receipt.
	 */
	captureUnretrievedOutput(maxCharacters?: number): TerminalOutputReceipt
	trimRetrievedOutput: () => void
}

export type AlphaTerminalProcessResultPromise = AlphaTerminalProcess & Promise<void>

export interface AlphaTerminalProcessEvents {
	output_available: []
	output_receipt_released: []
	finalized: []
	terminal_closed: []
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
