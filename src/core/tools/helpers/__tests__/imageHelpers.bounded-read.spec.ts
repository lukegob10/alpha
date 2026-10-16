import { beforeEach, describe, expect, it, vi } from "vitest"

const transport = vi.hoisted(() => ({
	pathBytes: Buffer.alloc(0),
	statSize: 0,
	maxChunk: Number.POSITIVE_INFINITY,
	growAfterFirstRead: undefined as Buffer | undefined,
	onOpen: undefined as (() => void) | undefined,
	onRead: undefined as ((index: number) => void | Promise<void>) | undefined,
	onClose: undefined as (() => void | Promise<void>) | undefined,
	readError: undefined as Error | undefined,
	closeError: undefined as Error | undefined,
	openError: undefined as Error | undefined,
	handles: [] as Array<{ kind: "open" | "readFile"; closeCalls: number; closeSettled: boolean; closed: boolean }>,
	reads: [] as Array<{
		offset: number
		position: number
		requested: number
		allocation: number
		backingAllocation: number
		returned: number
	}>,
	allocations: [] as number[],
	readFileCalls: 0,
	decoderBytes: [] as number[],
	decoderAfterClose: [] as boolean[],
}))

// Both the baseline whole-file read and native opened-handle reads have working transports.
// A readFile call models its internal open/close so barriers work on either production version.
vi.mock("fs/promises", () => {
	const openHandle = (kind: "open" | "readFile") => {
		if (transport.openError) throw transport.openError
		let bytes = transport.pathBytes
		let readIndex = 0
		const handle = { kind, closeCalls: 0, closeSettled: false, closed: false }
		transport.handles.push(handle)
		transport.onOpen?.()
		const close = async () => {
			handle.closeCalls += 1
			await transport.onClose?.()
			handle.closeSettled = true
			if (transport.closeError) throw transport.closeError
			handle.closed = true
		}
		return {
			close,
			stat: async () => ({ size: bytes.length, isFile: () => true }),
			read: async (buffer: Buffer, offset: number, length: number, position: number) => {
				readIndex += 1
				const entry = {
					offset,
					position,
					requested: length,
					allocation: buffer.length,
					backingAllocation: buffer.buffer.byteLength,
					returned: 0,
				}
				transport.reads.push(entry)
				transport.allocations.push(buffer.buffer.byteLength)
				await transport.onRead?.(readIndex)
				if (transport.readError) throw transport.readError
				entry.returned = Math.max(0, Math.min(length, transport.maxChunk, bytes.length - position))
				bytes.copy(buffer, offset, position, position + entry.returned)
				if (readIndex === 1 && transport.growAfterFirstRead) bytes = transport.growAfterFirstRead
				return { bytesRead: entry.returned, buffer }
			},
			readWholeFile: async () => {
				// Whole-file reads have no caller-supplied bound and may observe concurrent growth.
				if (transport.growAfterFirstRead) bytes = transport.growAfterFirstRead
				const buffer = Buffer.alloc(bytes.length)
				const entry = {
					offset: 0,
					position: 0,
					requested: bytes.length,
					allocation: buffer.length,
					backingAllocation: buffer.buffer.byteLength,
					returned: 0,
				}
				transport.reads.push(entry)
				transport.allocations.push(buffer.buffer.byteLength)
				await transport.onRead?.(1)
				if (transport.readError) throw transport.readError
				entry.returned = bytes.copy(buffer)
				return buffer
			},
		}
	}
	return {
		stat: vi.fn(async () => ({ size: transport.statSize, isFile: () => true })),
		open: vi.fn(async (_path: string, _flags: string) => openHandle("open")),
		readFile: vi.fn(async (_path: string, options?: { signal?: AbortSignal }) => {
			transport.readFileCalls += 1
			options?.signal?.throwIfAborted()
			const handle = openHandle("readFile")
			let readResult: { bytes: Buffer } | { error: unknown }
			try {
				const bytes = await handle.readWholeFile()
				options?.signal?.throwIfAborted()
				readResult = { bytes }
			} catch (error) {
				readResult = { error }
			}
			try {
				await handle.close()
			} catch (error) {
				if ("bytes" in readResult) throw error
			}
			if ("error" in readResult) {
				throw readResult.error
			}
			return readResult.bytes
		}),
	}
})

vi.mock("../../../../i18n", () => ({ t: (key: string) => key }))

// These tests isolate byte admission and cleanup, not codec validity. The existing builtin worker
// transport accepts any admitted bytes; no new decoder-module mock or real worker is needed for RED.
vi.mock("node:worker_threads", async () => {
	const { EventEmitter } = await import("node:events")
	class ByteAdmissionWorker extends EventEmitter {
		constructor(_filename: string | URL, _options?: unknown) {
			super()
		}

		postMessage(request: { bytes: Uint8Array; extension: string }) {
			transport.decoderBytes.push(request.bytes.length)
			transport.decoderAfterClose.push(transport.handles.every((handle) => handle.closed))
			queueMicrotask(() => this.emit("message", { kind: "original", sourceExtension: request.extension }))
		}

		async terminate() {
			this.emit("exit", 0)
			return 0
		}
	}
	return { Worker: ByteAdmissionWorker }
})

import {
	DEFAULT_MAX_IMAGE_FILE_SIZE_MB,
	readImageAsDataUrlWithBuffer,
	validateImageForProcessing,
} from "../imageHelpers"

// The baseline public export exists but ignores the two optional arguments. Widening only the
// call signature keeps test-only RED independent of a new export or a missing decoder module.
const readImage = readImageAsDataUrlWithBuffer as (
	filePath: string,
	signal?: AbortSignal,
	maxBytes?: number,
) => ReturnType<typeof readImageAsDataUrlWithBuffer>

const imagePath = "/controlled/image.png"
const sizeErrorKey = "tools:readFile.imageChangedAfterValidation"

function barrier() {
	let release!: () => void
	const promise = new Promise<void>((resolve) => {
		release = resolve
	})
	return { promise, release }
}

function observe(signal?: AbortSignal, maxBytes?: number) {
	return readImage(imagePath, signal, maxBytes).then(
		(value) => ({ kind: "value" as const, value }),
		(error: unknown) => ({ kind: "error" as const, error }),
	)
}

function expectReadCeiling(maxBytes: number) {
	const ceiling = Math.floor(maxBytes) + 1
	expect(transport.reads.length).toBeGreaterThan(0)
	expect(
		Math.max(0, ...transport.allocations),
		"observed scratch or whole-file backing allocation",
	).toBeLessThanOrEqual(ceiling)
	expect(transport.reads.reduce((total, read) => total + read.returned, 0)).toBeLessThanOrEqual(ceiling)
	for (const read of transport.reads) {
		expect(read.requested).toBeGreaterThan(0)
		expect(read.offset + read.requested).toBeLessThanOrEqual(ceiling)
		expect(read.position + read.requested).toBeLessThanOrEqual(ceiling)
		expect(read.allocation).toBeLessThanOrEqual(ceiling)
		expect(read.backingAllocation).toBeLessThanOrEqual(ceiling)
		expect(read.returned).toBeLessThanOrEqual(read.requested)
	}
}

function expectClosedOnce() {
	expect(transport.handles).toHaveLength(1)
	expect(transport.handles[0]).toMatchObject({ closeCalls: 1, closeSettled: true })
	expect(transport.handles[0].closed).toBe(transport.closeError === undefined)
	expect(transport.decoderAfterClose.every(Boolean)).toBe(true)
}

function expectOriginalReason(result: Awaited<ReturnType<typeof observe>>, reason: unknown) {
	expect(result.kind).toBe("error")
	if (result.kind === "error") expect(result.error).toBe(reason)
}

describe("image helper bounded native reads (codec acceptance stubbed)", () => {
	beforeEach(() => {
		transport.pathBytes = Buffer.alloc(24, 0x61)
		transport.statSize = transport.pathBytes.length
		transport.maxChunk = Number.POSITIVE_INFINITY
		transport.growAfterFirstRead = undefined
		transport.onOpen = undefined
		transport.onRead = undefined
		transport.onClose = undefined
		transport.readError = undefined
		transport.closeError = undefined
		transport.openError = undefined
		transport.handles.length = 0
		transport.reads.length = 0
		transport.allocations.length = 0
		transport.readFileCalls = 0
		transport.decoderBytes.length = 0
		transport.decoderAfterClose.length = 0
	})

	it("caps allocation and actual bytes after a stat-underreported image was approved", async () => {
		const cap = 32
		transport.statSize = 4
		transport.pathBytes = Buffer.alloc(4096, 0x61)
		const validation = await validateImageForProcessing(imagePath, true, cap / 1024 ** 2, 1, 0)
		expect(validation.isValid).toBe(true)

		const result = await observe(undefined, cap)

		expectReadCeiling(cap)
		expect(result).toMatchObject({ kind: "error", error: { message: sizeErrorKey } })
		expect(transport.decoderBytes).toEqual([])
		expectClosedOnce()
	})

	it("stops at the sentinel byte when an approved opened file grows during short reads", async () => {
		const cap = 32
		transport.pathBytes = Buffer.alloc(16, 0x61)
		transport.statSize = 16
		transport.maxChunk = 8
		transport.growAfterFirstRead = Buffer.alloc(4096, 0x61)
		expect((await validateImageForProcessing(imagePath, true, cap / 1024 ** 2, 1, 0)).isValid).toBe(true)

		const result = await observe(undefined, cap)

		expectReadCeiling(cap)
		expect(result).toMatchObject({ kind: "error", error: { message: sizeErrorKey } })
		expect(transport.decoderBytes).toEqual([])
		expectClosedOnce()
	})

	it("bounds a larger replacement that appears after stat validation and before opening", async () => {
		const cap = 32
		transport.statSize = 8
		expect((await validateImageForProcessing(imagePath, true, cap / 1024 ** 2, 1, 0)).isValid).toBe(true)
		transport.pathBytes = Buffer.alloc(8192, 0x62)

		const result = await observe(undefined, cap)

		expectReadCeiling(cap)
		expect(result).toMatchObject({ kind: "error", error: { message: sizeErrorKey } })
		expect(transport.decoderBytes).toEqual([])
		expectClosedOnce()
	})

	it("uses a finite default byte ceiling when a direct caller supplies no cap", async () => {
		const cap = DEFAULT_MAX_IMAGE_FILE_SIZE_MB * 1024 * 1024
		transport.pathBytes = Buffer.alloc(cap + 17, 0x61)

		const result = await observe()

		expectReadCeiling(cap)
		expect(result).toMatchObject({ kind: "error", error: { message: sizeErrorKey } })
		expect(transport.decoderBytes).toEqual([])
		expectClosedOnce()
	})

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER])(
		"rejects an invalid or unsafe cap %s before opening or allocating",
		async (cap) => {
			const result = await observe(undefined, cap)

			expect(result).toMatchObject({ kind: "error", error: { message: sizeErrorKey } })
			expect(transport.handles).toEqual([])
			expect(transport.allocations).toEqual([])
			expect(transport.decoderBytes).toEqual([])
		},
	)

	it("treats a fractional cap conservatively and reads only one overflow byte", async () => {
		transport.pathBytes = Buffer.alloc(33, 0x61)

		const result = await observe(undefined, 32.9)

		expectReadCeiling(32.9)
		expect(result).toMatchObject({ kind: "error", error: { message: sizeErrorKey } })
		expect(transport.decoderBytes).toEqual([])
		expectClosedOnce()
	})

	it("rejects one byte at a zero cap without reading the remaining source", async () => {
		const result = await observe(undefined, 0)

		expectReadCeiling(0)
		expect(result).toMatchObject({ kind: "error", error: { message: sizeErrorKey } })
		expect(transport.decoderBytes).toEqual([])
		expectClosedOnce()
	})

	it("accepts exact-cap bytes through repeated short reads without padding or rewriting the receipt", async () => {
		const cap = 32
		const original = Buffer.from(Array.from({ length: cap }, (_, index) => index))
		transport.pathBytes = original
		transport.maxChunk = 3

		const result = await readImage(imagePath, undefined, cap)

		expectReadCeiling(cap)
		expect(result.buffer).toEqual(original)
		expect(result.buffer.buffer.byteLength).toBe(original.length)
		expect(result.dataUrl).toBe(`data:image/png;base64,${original.toString("base64")}`)
		expectClosedOnce()
	})

	it("keeps the opened file identity when the pathname is replaced during the read", async () => {
		const original = Buffer.from(transport.pathBytes)
		transport.onOpen = () => {
			transport.pathBytes = Buffer.alloc(4096, 0x62)
		}

		const result = await readImage(imagePath, undefined, 32)

		expectReadCeiling(32)
		expect(result.buffer).toEqual(original)
		expectClosedOnce()
	})

	it("publishes only the exact-sized backing buffer for a tiny image under the default allowance", async () => {
		const original = Buffer.from(transport.pathBytes)

		const result = await readImage(imagePath)

		expectReadCeiling(DEFAULT_MAX_IMAGE_FILE_SIZE_MB * 1024 * 1024)
		expect(result.buffer).toEqual(original)
		expect(result.buffer.buffer.byteLength).toBe(original.length)
		expectClosedOnce()
	})

	it("awaits close before decoding or publishing an admitted byte receipt", async () => {
		const entered = barrier()
		const close = barrier()
		transport.onClose = () => {
			entered.release()
			return close.promise
		}
		let settled = false
		const pending = observe(undefined, 32).then((outcome) => {
			settled = true
			return outcome
		})
		await entered.promise
		try {
			expect(settled).toBe(false)
			expect(transport.decoderBytes).toEqual([])
		} finally {
			close.release()
		}

		expect(await pending).toMatchObject({ kind: "value", value: { buffer: transport.pathBytes } })
		expectClosedOnce()
	})

	it("preserves an already-aborted caller's reason without any open, allocation, or publication", async () => {
		const controller = new AbortController()
		const reason = new Error("cancel before image open")
		controller.abort(reason)

		const result = await observe(controller.signal, 32)

		expectOriginalReason(result, reason)
		expect(transport.handles).toEqual([])
		expect(transport.allocations).toEqual([])
		expect(transport.decoderBytes).toEqual([])
	})

	it("closes exactly once if cancellation arrives while opening", async () => {
		const controller = new AbortController()
		const reason = new Error("cancel while opening image")
		transport.onOpen = () => controller.abort(reason)

		const result = await observe(controller.signal, 32)

		expectOriginalReason(result, reason)
		expect(transport.reads).toEqual([])
		expect(transport.decoderBytes).toEqual([])
		expectClosedOnce()
	})

	it("awaits an in-flight read after cancellation, then closes once without another read or decode", async () => {
		const entered = barrier()
		const read = barrier()
		const controller = new AbortController()
		const reason = new Error("cancel held image read")
		transport.onRead = () => {
			entered.release()
			return read.promise
		}
		let settled = false
		const pending = observe(controller.signal, 32).then((outcome) => {
			settled = true
			return outcome
		})
		await entered.promise
		controller.abort(reason)
		try {
			expect(settled).toBe(false)
			expect(transport.handles[0].closeCalls).toBe(0)
		} finally {
			read.release()
		}

		expectOriginalReason(await pending, reason)
		expect(transport.reads).toHaveLength(1)
		expect(transport.decoderBytes).toEqual([])
		expectClosedOnce()
	})

	it("preserves cancellation during close and does not admit bytes to the codec", async () => {
		const controller = new AbortController()
		const reason = new Error("cancel while closing image")
		transport.onClose = () => controller.abort(reason)

		const result = await observe(controller.signal, 32)

		expectOriginalReason(result, reason)
		expect(transport.decoderBytes).toEqual([])
		expectClosedOnce()
	})

	it("closes once and preserves the read error even if close also fails", async () => {
		const reason = new Error("controlled read failure")
		transport.readError = reason
		transport.closeError = new Error("controlled close failure")

		const result = await observe(undefined, 32)

		expectOriginalReason(result, reason)
		expect(transport.decoderBytes).toEqual([])
		expectClosedOnce()
	})

	it("does not publish bytes when closing an otherwise successful read fails", async () => {
		const reason = new Error("controlled close failure")
		transport.closeError = reason

		const result = await observe(undefined, 32)

		expectOriginalReason(result, reason)
		expect(transport.decoderBytes).toEqual([])
		expectClosedOnce()
	})

	it("keeps the overflow outcome when closing the bounded read also fails", async () => {
		transport.pathBytes = Buffer.alloc(4096, 0x61)
		transport.closeError = new Error("controlled close failure after overflow")

		const result = await observe(undefined, 32)

		expectReadCeiling(32)
		expect(result).toMatchObject({ kind: "error", error: { message: sizeErrorKey } })
		expect(transport.decoderBytes).toEqual([])
		expectClosedOnce()
	})

	it("does not close a handle when opening failed", async () => {
		const reason = new Error("controlled open failure")
		transport.openError = reason

		expectOriginalReason(await observe(undefined, 32), reason)
		expect(transport.handles).toEqual([])
		expect(transport.allocations).toEqual([])
		expect(transport.decoderBytes).toEqual([])
	})
})
