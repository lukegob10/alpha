import EventEmitter from "events"
import type { PytestVerificationLaunch } from "./PytestVerificationLauncher"

/** Host-owned observation attached to one approved physical command. */
export interface TerminalExecutionOptions {
	pytestVerification?: PytestVerificationLaunch
}

export type RooTerminalProvider = "vscode" | "execa"

export const DEFAULT_TERMINAL_OUTPUT_RECEIPT_MAX_CHARACTERS = 50_000
/** Maximum cleanup prefix carried into a later receipt's rendered output. */
export const MAX_TERMINAL_OUTPUT_RECEIPT_CARRY_CHARACTERS = 32

export interface TerminalOutputReceipt {
	readonly output: string
	commit(): void
	release(): void
}

export interface RooTerminal {
	provider: RooTerminalProvider
	id: number
	busy: boolean
	running: boolean
	taskId?: string
	process?: RooTerminalProcess
	getCurrentWorkingDirectory(): string
	isClosed: () => boolean
	runCommand: (
		command: string,
		callbacks: RooTerminalCallbacks,
		options?: TerminalExecutionOptions,
	) => RooTerminalProcessResultPromise
	setActiveStream(stream: AsyncIterable<string> | undefined, pid?: number): void
	shellExecutionComplete(exitDetails: ExitCodeDetails): void
	getProcessesWithOutput(): RooTerminalProcess[]
	getUnretrievedOutput(): string
	getLastCommand(): string
	cleanCompletedProcessQueue(): void
}

export interface RooTerminalCallbacks {
	onLine: (line: string, process: RooTerminalProcess) => void
	onCompleted: (output: string | undefined, process: RooTerminalProcess) => void | Promise<void>
	onShellExecutionStarted: (pid: number | undefined, process: RooTerminalProcess) => void
	onShellExecutionComplete: (details: ExitCodeDetails, process: RooTerminalProcess) => void
	onNoShellIntegration?: (message: string, process: RooTerminalProcess) => void
	onVerificationUnavailable?: (reason: string) => void
}

export interface RooTerminalProcess extends EventEmitter<RooTerminalProcessEvents> {
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

export type RooTerminalProcessResultPromise = RooTerminalProcess & Promise<void>

export interface RooTerminalProcessEvents {
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
