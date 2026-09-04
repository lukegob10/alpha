import { EventEmitter } from "events"

import type { RooTerminalProcess, RooTerminalProcessEvents, ExitCodeDetails, TerminalOutputReceipt } from "./types"
import { DEFAULT_TERMINAL_OUTPUT_RECEIPT_MAX_CHARACTERS } from "./types"

type UnretrievedOutputRange = {
	endIndex: number
	output: string
	onCommit?: () => void
}

type OutputReceiptReservation = {
	generation: number
	startIndex: number
	endIndex: number
}

const EMPTY_TERMINAL_OUTPUT_RECEIPT: TerminalOutputReceipt = Object.freeze({
	output: "",
	commit: () => undefined,
	release: () => undefined,
})

export abstract class BaseTerminalProcess extends EventEmitter<RooTerminalProcessEvents> implements RooTerminalProcess {
	public command: string = ""

	public isHot: boolean = false
	public isSettled: boolean = false
	protected hotTimer: NodeJS.Timeout | null = null

	protected isListening: boolean = true
	protected lastEmitTime_ms: number = 0
	protected fullOutput: string = ""
	protected lastRetrievedIndex: number = 0
	private outputBufferGeneration = 0
	private activeOutputReceipt?: OutputReceiptReservation

	protected constructor() {
		super()
		this.once("completed", () => (this.isSettled = true))
		this.once("error", () => (this.isSettled = true))
	}

	static interpretExitCode(exitCode: number | undefined): ExitCodeDetails {
		if (exitCode === undefined) {
			return { exitCode }
		}

		if (exitCode <= 128) {
			return { exitCode }
		}

		const signal = exitCode - 128

		const signals: Record<number, string> = {
			// Standard signals
			1: "SIGHUP",
			2: "SIGINT",
			3: "SIGQUIT",
			4: "SIGILL",
			5: "SIGTRAP",
			6: "SIGABRT",
			7: "SIGBUS",
			8: "SIGFPE",
			9: "SIGKILL",
			10: "SIGUSR1",
			11: "SIGSEGV",
			12: "SIGUSR2",
			13: "SIGPIPE",
			14: "SIGALRM",
			15: "SIGTERM",
			16: "SIGSTKFLT",
			17: "SIGCHLD",
			18: "SIGCONT",
			19: "SIGSTOP",
			20: "SIGTSTP",
			21: "SIGTTIN",
			22: "SIGTTOU",
			23: "SIGURG",
			24: "SIGXCPU",
			25: "SIGXFSZ",
			26: "SIGVTALRM",
			27: "SIGPROF",
			28: "SIGWINCH",
			29: "SIGIO",
			30: "SIGPWR",
			31: "SIGSYS",

			// Real-time signals base
			34: "SIGRTMIN",

			// SIGRTMIN+n signals
			35: "SIGRTMIN+1",
			36: "SIGRTMIN+2",
			37: "SIGRTMIN+3",
			38: "SIGRTMIN+4",
			39: "SIGRTMIN+5",
			40: "SIGRTMIN+6",
			41: "SIGRTMIN+7",
			42: "SIGRTMIN+8",
			43: "SIGRTMIN+9",
			44: "SIGRTMIN+10",
			45: "SIGRTMIN+11",
			46: "SIGRTMIN+12",
			47: "SIGRTMIN+13",
			48: "SIGRTMIN+14",
			49: "SIGRTMIN+15",

			// SIGRTMAX-n signals
			50: "SIGRTMAX-14",
			51: "SIGRTMAX-13",
			52: "SIGRTMAX-12",
			53: "SIGRTMAX-11",
			54: "SIGRTMAX-10",
			55: "SIGRTMAX-9",
			56: "SIGRTMAX-8",
			57: "SIGRTMAX-7",
			58: "SIGRTMAX-6",
			59: "SIGRTMAX-5",
			60: "SIGRTMAX-4",
			61: "SIGRTMAX-3",
			62: "SIGRTMAX-2",
			63: "SIGRTMAX-1",
			64: "SIGRTMAX",
		}

		// These signals may produce core dumps:
		//   SIGQUIT, SIGILL, SIGABRT, SIGBUS, SIGFPE, SIGSEGV
		const coreDumpPossible = new Set([3, 4, 6, 7, 8, 11])

		return {
			exitCode,
			signal,
			signalName: signals[signal] || `Unknown Signal (${signal})`,
			coreDumpPossible: coreDumpPossible.has(signal),
		}
	}

	/**
	 * Runs a shell command.
	 * @param command The command to run
	 */
	abstract run(command: string): Promise<void>

	/**
	 * Continues the process in the background.
	 */
	abstract continue(): void

	/**
	 * Aborts the process using the provider's supported termination mechanism.
	 */
	abstract abort(): void | Promise<void>

	/**
	 * Checks if this process has unretrieved output.
	 * @returns true if there is output that hasn't been fully retrieved yet
	 */
	abstract hasUnretrievedOutput(): boolean

	/**
	 * Returns the next provider-specific raw range and its cleaned output without advancing the cursor.
	 * The range must be no larger than maxCharacters raw characters.
	 * Cleanup may carry a bounded ESC/CSI prefix into the next range, so the
	 * rendered output can be slightly larger than the raw range.
	 * @param includeTrailingOutput Receipts may include a completed final line;
	 * legacy line consumers keep their existing complete-line behavior.
	 */
	protected abstract getUnretrievedOutputRange(
		maxCharacters: number,
		includeTrailingOutput: boolean,
	): UnretrievedOutputRange

	/**
	 * Resets provider-specific cleanup state along with the raw output buffer.
	 */
	protected onOutputBufferReset(): void {}

	/**
	 * Captures a bounded output receipt without advancing the unread cursor.
	 *
	 * One receipt may reserve a process at a time. A concurrent capture receives
	 * an empty receipt and can retry after the active receipt is committed or
	 * released.
	 */
	public captureUnretrievedOutput(maxCharacters?: number): TerminalOutputReceipt {
		const limit = this.normalizeReceiptLimit(maxCharacters)

		if (limit === 0 || this.activeOutputReceipt) {
			return EMPTY_TERMINAL_OUTPUT_RECEIPT
		}

		const startIndex = this.clampRetrievedIndex()
		const range = this.getUnretrievedOutputRange(limit, true)
		const maxEndIndex = Math.min(this.fullOutput.length, startIndex + limit)
		const endIndex = Math.min(maxEndIndex, Math.max(startIndex, range.endIndex))

		if (endIndex <= startIndex) {
			return EMPTY_TERMINAL_OUTPUT_RECEIPT
		}

		const reservation: OutputReceiptReservation = {
			generation: this.outputBufferGeneration,
			startIndex,
			endIndex,
		}
		this.activeOutputReceipt = reservation

		let state: "active" | "committed" | "released" = "active"
		const finish = (commit: boolean): void => {
			if (state !== "active") return

			state = commit ? "committed" : "released"

			// Buffer reset/trim or a legacy consumer invalidated this receipt.
			if (this.activeOutputReceipt !== reservation) return
			this.activeOutputReceipt = undefined

			if (!commit) return
			if (this.outputBufferGeneration !== reservation.generation) return
			if (this.lastRetrievedIndex !== reservation.startIndex) return
			if (this.fullOutput.length < reservation.endIndex) return

			this.lastRetrievedIndex = reservation.endIndex
			range.onCommit?.()
		}

		return Object.freeze({
			output: range.output,
			commit: () => finish(true),
			release: () => finish(false),
		})
	}

	/**
	 * Returns the next provider-specific output and advances the unread cursor.
	 * Existing listeners use this consuming API; receipts use the range hook above.
	 */
	public getUnretrievedOutput(): string {
		const startIndex = this.clampRetrievedIndex()
		const range = this.getUnretrievedOutputRange(Number.POSITIVE_INFINITY, false)

		if (range.endIndex <= startIndex) {
			return range.output
		}

		this.lastRetrievedIndex = Math.min(this.fullOutput.length, range.endIndex)
		range.onCommit?.()

		// A legacy consumer took output reserved by a receipt. Do not let a later
		// receipt commit advance beyond the range that was actually consumed.
		if (this.activeOutputReceipt && this.lastRetrievedIndex !== this.activeOutputReceipt.startIndex) {
			this.activeOutputReceipt = undefined
		}

		return range.output
	}

	/**
	 * Clears the internal output buffer when all content has been retrieved.
	 *
	 * This prevents unbounded memory growth when processing large
	 * command outputs by discarding data that has already been
	 * consumed by callers of `getUnretrievedOutput`.
	 *
	 * Called after command completion when `lastRetrievedIndex` has been
	 * set to `fullOutput.length` to indicate all output has been processed.
	 */
	public trimRetrievedOutput(): void {
		if (
			this.lastRetrievedIndex >= this.fullOutput.length &&
			(this.fullOutput.length > 0 || this.activeOutputReceipt !== undefined)
		) {
			this.resetOutputBuffer()
		}
	}

	/**
	 * Starts a new output buffer. Receipts from the previous buffer become stale
	 * and cannot consume output written to the new buffer.
	 */
	protected resetOutputBuffer(): void {
		this.fullOutput = ""
		this.lastRetrievedIndex = 0
		this.outputBufferGeneration += 1
		this.activeOutputReceipt = undefined
		this.onOutputBufferReset()
	}

	private normalizeReceiptLimit(maxCharacters?: number): number {
		if (maxCharacters === undefined || Number.isNaN(maxCharacters)) {
			return DEFAULT_TERMINAL_OUTPUT_RECEIPT_MAX_CHARACTERS
		}

		if (maxCharacters <= 0) return 0
		if (!Number.isFinite(maxCharacters)) return DEFAULT_TERMINAL_OUTPUT_RECEIPT_MAX_CHARACTERS

		return Math.floor(maxCharacters)
	}

	private clampRetrievedIndex(): number {
		return Math.min(Math.max(0, this.lastRetrievedIndex), this.fullOutput.length)
	}

	protected startHotTimer(data: string) {
		this.isHot = true

		if (this.hotTimer) {
			clearTimeout(this.hotTimer)
		}

		this.hotTimer = setTimeout(() => (this.isHot = false), BaseTerminalProcess.isCompiling(data) ? 15_000 : 2_000)
	}

	protected stopHotTimer() {
		if (this.hotTimer) {
			clearTimeout(this.hotTimer)
		}

		this.isHot = false
	}

	// These markers indicate the command is some kind of local dev
	// server recompiling the app, which we want to wait for output
	// of before sending request to Alpha.
	private static compilingMarkers = ["compiling", "building", "bundling", "transpiling", "generating", "starting"]

	private static compilingMarkerNullifiers = [
		"compiled",
		"success",
		"finish",
		"complete",
		"succeed",
		"done",
		"end",
		"stop",
		"exit",
		"terminate",
		"error",
		"fail",
	]

	private static isCompiling(data: string): boolean {
		return (
			BaseTerminalProcess.compilingMarkers.some((marker) => data.toLowerCase().includes(marker.toLowerCase())) &&
			!BaseTerminalProcess.compilingMarkerNullifiers.some((nullifier) =>
				data.toLowerCase().includes(nullifier.toLowerCase()),
			)
		)
	}
}
