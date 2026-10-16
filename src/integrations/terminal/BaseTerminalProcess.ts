import { EventEmitter } from "events"

import type { AlphaTerminalProcess, AlphaTerminalProcessEvents, ExitCodeDetails, TerminalOutputReceipt } from "./types"
import { DEFAULT_TERMINAL_OUTPUT_RECEIPT_MAX_CHARACTERS, MAX_TERMINAL_OUTPUT_BUFFER_BYTES } from "./types"
import {
	TerminalOutputBuffer,
	copyTerminalOutput,
	terminalOutputOmissionMarker,
	terminalOutputPrefix,
	terminalOutputSuffix,
} from "./TerminalOutputBuffer"

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

type OutputOmission = { start: number; end: number; bytes: number }

const EMPTY_TERMINAL_OUTPUT_RECEIPT: TerminalOutputReceipt = Object.freeze({
	output: "",
	hasMoreOutput: false,
	commit: () => undefined,
	release: () => undefined,
})

export abstract class BaseTerminalProcess
	extends EventEmitter<AlphaTerminalProcessEvents>
	implements AlphaTerminalProcess
{
	public executionId?: string
	public outputArtifactId?: string
	public outputArchiveInterrupted = false
	public command: string = ""

	public isHot: boolean = false
	public isSettled: boolean = false
	public isOutputFinalized: boolean = false
	protected hotTimer: NodeJS.Timeout | null = null

	protected isListening: boolean = true
	protected lastEmitTime_ms: number = 0
	protected fullOutput: string = ""
	protected lastRetrievedIndex: number = 0
	private outputBufferGeneration = 0
	private activeOutputReceipt?: OutputReceiptReservation
	protected outputOmissions: OutputOmission[] = []
	private readonly outputTranscript = new TerminalOutputBuffer()
	private outputWriter?: (chunk: string, signal: AbortSignal) => void | Promise<void>
	private readonly outputCancellation = new AbortController()
	private outputWritePending = false
	private outputFinalizer?: () => void | Promise<void>
	private outputFinalization?: Promise<void>
	private readonly outputFinalizationCompletion: Promise<void>
	private resolveOutputFinalization!: () => void
	private rejectOutputFinalization!: (reason: unknown) => void

	protected constructor(options?: ConstructorParameters<typeof EventEmitter>[0]) {
		super(options)
		this.outputFinalizationCompletion = new Promise((resolve, reject) => {
			this.resolveOutputFinalization = resolve
			this.rejectOutputFinalization = reject
		})
		// A command need not have a Stop observer when its archival owner fails.
		void this.outputFinalizationCompletion.catch(() => undefined)
		this.once("completed", () => (this.isSettled = true))
		this.once("error", () => (this.isSettled = true))
	}

	public setOutputWriter(writer: (chunk: string, signal: AbortSignal) => void | Promise<void>): void {
		this.outputWriter = writer
	}

	public setOutputFinalizer(finalizer: () => void | Promise<void>): void {
		this.outputFinalizer = finalizer
	}

	/** Waiting never detaches a live writer or starts the adapter's finalizer. */
	public waitForOutputFinalization(): Promise<void> {
		return this.outputFinalizationCompletion
	}

	/** Archival settlement is distinct from output events and physical process exit. */
	public finalizeOutput(): Promise<void> {
		if (this.outputFinalization) return this.outputFinalization
		const finalizer = this.outputFinalizer
		this.outputFinalizer = undefined
		this.outputWriter = undefined
		this.outputFinalization = Promise.resolve()
			.then(() => finalizer?.())
			.catch((error) => {
				this.outputArchiveInterrupted = true
				this.outputArtifactId = undefined
				throw error
			})
			.finally(() => this.markOutputFinalized())
		void this.outputFinalization.then(this.resolveOutputFinalization, this.rejectOutputFinalization)
		return this.outputFinalization
	}

	public get outputCancellationSignal(): AbortSignal {
		return this.outputCancellation.signal
	}

	/** Release only a blocked raw write; a healthy held finalizer stays intact. */
	public cancelPendingOutputWrite(): void {
		if (!this.outputFinalization) this.cancelOutputWriter()
	}

	protected cancelOutputWriter(): void {
		if (this.outputWritePending && !this.outputCancellation.signal.aborted) {
			this.outputCancellation.abort(new Error("Command output persistence was interrupted"))
		}
	}

	/** One producer awaits the archival sink before it can read another chunk. */
	protected async appendOutput(chunk: string, transcriptChunk = chunk): Promise<void> {
		if (!chunk) {
			if (transcriptChunk) this.appendOutputTranscript(transcriptChunk)
			return
		}
		this.fullOutput += chunk
		this.appendOutputTranscript(transcriptChunk)
		this.boundUnreadOutput()
		this.emit("output_available")
		if (!this.outputWriter) return
		this.outputWritePending = true
		const signal = this.outputCancellation.signal
		let onAbort!: () => void
		const cancelled = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(signal.reason)
			signal.addEventListener("abort", onAbort, { once: true })
		})
		try {
			signal.throwIfAborted()
			await Promise.race([this.outputWriter(chunk, signal), cancelled])
		} catch (error) {
			if (!this.outputCancellation.signal.aborted || error !== this.outputCancellation.signal.reason) throw error
			// Stop may interrupt a blocked archive without losing process ownership.
			// Keep bounded terminal collection alive and never advertise a complete file.
			this.outputArchiveInterrupted = true
			this.outputWriter = undefined
		} finally {
			signal.removeEventListener("abort", onAbort)
			this.outputWritePending = false
		}
	}

	protected appendOutputTranscript(chunk: string): void {
		this.outputTranscript.append(chunk)
	}

	/** Keep each bounded receipt at a Unicode scalar boundary. */
	protected safeOutputRangeEnd(endIndex: number): number {
		if (endIndex <= 0 || endIndex >= this.fullOutput.length) return endIndex
		const previous = this.fullOutput.charCodeAt(endIndex - 1)
		const next = this.fullOutput.charCodeAt(endIndex)
		return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? endIndex - 1 : endIndex
	}

	protected getOutputTranscriptParts(): ReadonlyArray<{ output: string; omitted: boolean }> {
		return this.outputTranscript.parts()
	}

	protected getOutputTranscript(): string {
		return this.getOutputTranscriptParts()
			.map((part) => part.output)
			.join("")
	}

	public hasActiveOutputReceipt(): boolean {
		return this.activeOutputReceipt !== undefined
	}

	protected markOutputFinalized(): void {
		if (this.isOutputFinalized) return
		this.isOutputFinalized = true
		this.outputWriter = undefined
		this.outputTranscript.clear()
		this.emit("finalized")
	}

	protected async emitCompletedAndWait(output: string): Promise<Error | undefined> {
		// Native once wrappers retain listener order and remove themselves normally.
		const pending = this.rawListeners("completed").map((listener) => {
			try {
				return Promise.resolve(listener.call(this, output))
			} catch (error) {
				return Promise.reject(error)
			}
		})
		const failures = (await Promise.allSettled(pending)).flatMap((outcome) =>
			outcome.status === "rejected"
				? [outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason))]
				: [],
		)
		if (failures.length === 1) return failures[0]
		if (failures.length > 1) return new AggregateError(failures, "Command completion observers failed")
		return undefined
	}

	/**
	 * Keep pending head/tail bytes bounded without changing an in-flight receipt.
	 * Delivered prefixes can be reclaimed; a reservation pins only its raw range.
	 */
	private boundUnreadOutput(): void {
		if (Buffer.byteLength(this.fullOutput, "utf8") <= MAX_TERMINAL_OUTPUT_BUFFER_BYTES) return
		const retrieved = this.clampRetrievedIndex()
		if (retrieved > 0) {
			this.fullOutput = this.fullOutput.slice(retrieved)
			this.lastRetrievedIndex = 0
			if (this.activeOutputReceipt) {
				this.activeOutputReceipt.startIndex -= retrieved
				this.activeOutputReceipt.endIndex -= retrieved
			}
			this.outputOmissions = this.outputOmissions.flatMap((omission) =>
				omission.end <= retrieved
					? []
					: [{ ...omission, start: Math.max(0, omission.start - retrieved), end: omission.end - retrieved }],
			)
		}
		if (Buffer.byteLength(this.fullOutput, "utf8") <= MAX_TERMINAL_OUTPUT_BUFFER_BYTES) return

		// Reserve enough room for an omission count through Number.MAX_SAFE_INTEGER.
		const retainedBudget = MAX_TERMINAL_OUTPUT_BUFFER_BYTES - 96
		let headEnd = Math.max(
			this.activeOutputReceipt?.endIndex ?? 0,
			terminalOutputPrefix(this.fullOutput, Math.floor(retainedBudget / 2)).length,
		)
		for (const omission of this.outputOmissions) {
			if (headEnd > omission.start && headEnd < omission.end) headEnd = omission.end
		}
		const head = copyTerminalOutput(this.fullOutput.slice(0, headEnd))
		const tailBudget = Math.max(0, retainedBudget - Buffer.byteLength(head, "utf8"))
		let tailStart = this.fullOutput.length - terminalOutputSuffix(this.fullOutput, tailBudget).length
		for (const omission of this.outputOmissions) {
			if (tailStart > omission.start && tailStart < omission.end) tailStart = omission.end
		}
		const tail = copyTerminalOutput(this.fullOutput.slice(tailStart))
		let omittedBytes = Buffer.byteLength(this.fullOutput.slice(headEnd, tailStart), "utf8")
		for (const omission of this.outputOmissions) {
			if (omission.start >= headEnd && omission.end <= tailStart) {
				omittedBytes +=
					omission.bytes - Buffer.byteLength(this.fullOutput.slice(omission.start, omission.end), "utf8")
			}
		}
		const marker = terminalOutputOmissionMarker(omittedBytes)
		const tailShift = headEnd + marker.length - tailStart
		this.outputOmissions = [
			...this.outputOmissions.filter((omission) => omission.end <= headEnd),
			{ start: headEnd, end: headEnd + marker.length, bytes: omittedBytes },
			...this.outputOmissions
				.filter((omission) => omission.start >= tailStart)
				.map((omission) => ({ ...omission, start: omission.start + tailShift, end: omission.end + tailShift })),
		]
		this.fullOutput = head + marker + tail
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
	 * @param includeTrailingOutput Explicit receipts include active partial text;
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
			return this.hasUnretrievedOutput()
				? { ...EMPTY_TERMINAL_OUTPUT_RECEIPT, hasMoreOutput: true }
				: EMPTY_TERMINAL_OUTPUT_RECEIPT
		}

		const startIndex = this.clampRetrievedIndex()
		const range = this.getUnretrievedOutputRange(limit, true)
		const maxEndIndex = this.safeOutputRangeEnd(Math.min(this.fullOutput.length, startIndex + limit))
		const endIndex = Math.min(maxEndIndex, Math.max(startIndex, range.endIndex))

		if (endIndex <= startIndex) {
			return this.hasUnretrievedOutput()
				? { ...EMPTY_TERMINAL_OUTPUT_RECEIPT, hasMoreOutput: true }
				: EMPTY_TERMINAL_OUTPUT_RECEIPT
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

			try {
				if (!commit) return
				if (this.outputBufferGeneration !== reservation.generation) return
				if (this.lastRetrievedIndex !== reservation.startIndex) return
				if (this.fullOutput.length < reservation.endIndex) return

				this.lastRetrievedIndex = reservation.endIndex
				range.onCommit?.()
			} finally {
				this.emit("output_receipt_released")
			}
		}

		return Object.freeze({
			output: copyTerminalOutput(range.output),
			hasMoreOutput: endIndex < this.fullOutput.length,
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
			this.emit("output_receipt_released")
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
			this.resetOutputBuffer(false)
		}
	}

	/**
	 * Starts a new output buffer. Receipts from the previous buffer become stale
	 * and cannot consume output written to the new buffer.
	 */
	protected resetOutputBuffer(resetTranscript = true): void {
		this.fullOutput = ""
		this.lastRetrievedIndex = 0
		this.outputBufferGeneration += 1
		this.activeOutputReceipt = undefined
		this.outputOmissions = []
		if (resetTranscript) this.outputTranscript.clear()
		this.onOutputBufferReset()
	}

	private normalizeReceiptLimit(maxCharacters?: number): number {
		if (maxCharacters === undefined || Number.isNaN(maxCharacters)) {
			return DEFAULT_TERMINAL_OUTPUT_RECEIPT_MAX_CHARACTERS
		}

		if (maxCharacters <= 0) return 0
		if (!Number.isFinite(maxCharacters)) return DEFAULT_TERMINAL_OUTPUT_RECEIPT_MAX_CHARACTERS

		return Math.min(DEFAULT_TERMINAL_OUTPUT_RECEIPT_MAX_CHARACTERS, Math.floor(maxCharacters))
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
