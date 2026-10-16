import type { Mock } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

interface FakeWorker {
	emit(event: string, ...args: unknown[]): boolean
	listenerCount(event: string): number
	postMessage: Mock<(value: unknown) => void>
	terminate: Mock<() => Promise<number>>
}

const workers = vi.hoisted(() => ({
	instances: [] as FakeWorker[],
	onSpawn: undefined as ((worker: FakeWorker) => void) | undefined,
}))

vi.mock("node:worker_threads", async () => {
	const { EventEmitter } = await import("node:events")
	return {
		Worker: class extends EventEmitter {
			postMessage = vi.fn<(value: unknown) => void>()
			terminate = vi.fn(async () => 0)
			constructor() {
				super()
				workers.instances.push(this)
				workers.onSpawn?.(this)
			}
		},
	}
})
vi.mock("../../../../i18n", () => ({ t: (key: string) => key }))

const source =
	'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>'
const png = new Uint8Array([
	137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196,
	137, 0, 0, 0, 11, 73, 68, 65, 84, 120, 156, 99, 96, 0, 2, 0, 0, 5, 0, 1, 122, 94, 171, 63, 0, 0, 0, 0, 73, 69, 78,
	68, 174, 66, 96, 130,
])

function prepared(bytes: unknown = Uint8Array.from(png)) {
	return { kind: "prepared", sourceExtension: ".svg", outputExtension: ".png", mimeType: "image/png", bytes }
}

function framedOversizePng() {
	const bytes = new Uint8Array(1025)
	bytes.set(png)
	bytes.set(png.subarray(png.length - 12), bytes.length - 12)
	return bytes
}

function oversizedBackingView() {
	const bytes = new Uint8Array(4096).subarray(0, png.length)
	bytes.set(png)
	return bytes
}

function sharedPng() {
	const bytes = new Uint8Array(new SharedArrayBuffer(png.length))
	bytes.set(png)
	return bytes
}

function barrier<T>() {
	let release!: (value: T) => void
	const promise = new Promise<T>((resolve) => {
		release = resolve
	})
	return { promise, release }
}

async function workerStarted() {
	if (workers.instances[0]) return workers.instances[0]
	return new Promise<FakeWorker>((resolve) => {
		workers.onSpawn = (worker) => {
			workers.onSpawn = undefined
			resolve(worker)
		}
	})
}

// The transport supports BOTH the existing boolean request/reply and the proposed prepared wire.
// Baseline controls receive their valid legacy response and can publish source SVG; an unknown
// replacement wire is never used to manufacture a baseline transport/setup failure.
function replyForRequest(worker: FakeWorker, replacement: unknown) {
	const request = worker.postMessage.mock.calls[0]?.[0]
	const preparedWire = typeof request === "object" && request !== null && "maxOutputBytes" in request
	worker.emit("message", preparedWire ? replacement : { isValid: true })
}

function expectReleased(worker: FakeWorker) {
	expect(worker.terminate).toHaveBeenCalledOnce()
	for (const event of ["message", "error", "exit"]) expect(worker.listenerCount(event)).toBe(0)
	expect(vi.getTimerCount()).toBe(0)
}

describe("existing public helper prepared-output admission (worker transport controlled)", () => {
	let workspace: string
	let imagePath: string

	beforeEach(async () => {
		vi.resetModules()
		vi.useFakeTimers()
		workers.instances.length = 0
		workers.onSpawn = undefined
		workspace = await mkdtemp(path.join(os.tmpdir(), "alpha-prepared-protocol-"))
		imagePath = path.join(workspace, "square.svg")
		await writeFile(imagePath, source)
	})

	afterEach(async () => {
		vi.useRealTimers()
		await rm(workspace, { recursive: true, force: true })
	})

	async function observe(signal?: AbortSignal, cap = 1024) {
		const { readImageAsDataUrlWithBuffer } = await import("../imageHelpers")
		return readImageAsDataUrlWithBuffer(imagePath, signal, cap).then(
			(value) => ({ kind: "value" as const, value }),
			(error: unknown) => ({ kind: "error" as const, error }),
		)
	}

	it("publishes owned PNG bytes only after termination and snapshots the admitted response", async () => {
		const pending = observe()
		const worker = await workerStarted()
		const termination = barrier<number>()
		const entered = barrier<void>()
		worker.terminate.mockImplementation(() => {
			entered.release()
			return termination.promise
		})
		const bytes = Uint8Array.from(png)
		let settled = false
		void pending.then(() => {
			settled = true
		})
		replyForRequest(worker, prepared(bytes))
		await entered.promise
		try {
			expect(settled).toBe(false)
			bytes.fill(0)
		} finally {
			termination.release(0)
		}

		const result = await pending
		expect(result.kind).toBe("value")
		if (result.kind !== "value") throw result.error
		expect(result.value).toMatchObject({ sourceExtension: ".svg", outputExtension: ".png", mimeType: "image/png" })
		expect(result.value.buffer).toEqual(Buffer.from(png))
		expect(result.value.buffer.buffer.byteLength).toBe(png.length)
		expect(result.value.dataUrl).toBe(`data:image/png;base64,${Buffer.from(png).toString("base64")}`)
		expectReleased(worker)
	})

	it.each([
		{ name: "legacy untagged boolean success", reply: () => ({ isValid: true }) },
		{ name: "source binding mismatch", reply: () => ({ ...prepared(), sourceExtension: ".png" }) },
		{ name: "raw SVG original-kind approval", reply: () => ({ kind: "original", sourceExtension: ".svg" }) },
		{ name: "non-PNG output extension", reply: () => ({ ...prepared(), outputExtension: ".svg" }) },
		{ name: "non-PNG output MIME", reply: () => ({ ...prepared(), mimeType: "image/svg+xml" }) },
		{ name: "string bytes", reply: () => prepared("not bytes") },
		{ name: "empty bytes", reply: () => prepared(new Uint8Array()) },
		{ name: "signature-only bytes", reply: () => prepared(png.slice(0, 8)) },
		{ name: "oversized prepared output", reply: () => prepared(framedOversizePng()) },
		{ name: "small view retaining oversized backing", reply: () => prepared(oversizedBackingView()) },
		{ name: "shared backing", reply: () => prepared(sharedPng()) },
		{
			name: "unexpected payload on original-kind",
			reply: () => ({ kind: "original", sourceExtension: ".svg", bytes: png }),
		},
		{
			name: "unexpected payload on invalid-kind",
			reply: () => ({ kind: "invalid", sourceExtension: ".svg", bytes: png }),
		},
		{ name: "unknown failure", reply: () => ({ kind: "failure", sourceExtension: ".svg", failure: "unknown" }) },
	])("rejects $name without raw SVG fallback", async ({ reply }) => {
		const pending = observe()
		const worker = await workerStarted()
		replyForRequest(worker, reply())

		const result = await pending
		expect(result).toMatchObject({ kind: "error", error: { message: "tools:readFile.imageDecodeInvalidResponse" } })
		expectReleased(worker)
	})

	it.each(["resource_limit", "initialization", "preparation"])(
		"keeps %s operational failure distinct",
		async (failure) => {
			const pending = observe()
			const worker = await workerStarted()
			replyForRequest(worker, { kind: "failure", sourceExtension: ".svg", failure })

			const result = await pending
			expect(result).toMatchObject({
				kind: "error",
				error: {
					message:
						failure === "resource_limit"
							? "tools:readFile.imageDecodeLimit"
							: "tools:readFile.imageDecodeUnavailable",
				},
			})
			expectReleased(worker)
		},
	)

	it("rejects a prepared-kind replacement for an approved raster source", async () => {
		imagePath = path.join(workspace, "pixel.png")
		await writeFile(imagePath, png)
		const pending = observe()
		const worker = await workerStarted()
		replyForRequest(worker, { ...prepared(), sourceExtension: ".png" })

		expect(await pending).toMatchObject({
			kind: "error",
			error: { message: "tools:readFile.imageDecodeInvalidResponse" },
		})
		expectReleased(worker)
	})

	it("preserves the approved raster Buffer identity and exact bytes", async () => {
		imagePath = path.join(workspace, "pixel.png")
		await writeFile(imagePath, png)
		const pending = observe()
		const worker = await workerStarted()
		const request = worker.postMessage.mock.calls[0]?.[0]
		if (typeof request !== "object" || request === null || !("bytes" in request)) {
			throw new Error("Expected existing image worker byte request")
		}
		const approved = request.bytes
		replyForRequest(worker, { kind: "original", sourceExtension: ".png" })

		const result = await pending
		expect(result.kind).toBe("value")
		if (result.kind !== "value") throw result.error
		expect(result.value.buffer).toBe(approved)
		expect(result.value.buffer).toEqual(Buffer.from(png))
		expect(result.value.dataUrl).toBe(`data:image/png;base64,${Buffer.from(png).toString("base64")}`)
		expectReleased(worker)
	})

	it("maps an invalid SVG reply to invalid image without publishing any source representation", async () => {
		const pending = observe()
		const worker = await workerStarted()
		replyForRequest(worker, { kind: "invalid", sourceExtension: ".svg" })

		expect(await pending).toMatchObject({ kind: "error", error: { message: "tools:readFile.invalidImage" } })
		expectReleased(worker)
	})

	it("keeps the existing raster-only boolean API fail-closed for SVG without starting a worker", async () => {
		const { isImageContentDecodable } = await import("../imageDecoder")
		const pending = isImageContentDecodable(Buffer.from(source), ".svg")
		// The baseline has a functioning legacy transport, so a true result is an assertion failure.
		if (workers.instances[0]) replyForRequest(workers.instances[0], prepared())

		await expect(pending).resolves.toBe(false)
		expect(workers.instances).toHaveLength(0)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("retains the exact late abort reason while prepared-output termination is held", async () => {
		const controller = new AbortController()
		const reason = new Error("cancel after prepared image reply")
		const receipts = vi.fn()
		const pending = observe(controller.signal).then((outcome) => {
			receipts(outcome)
			return outcome
		})
		const worker = await workerStarted()
		const termination = barrier<number>()
		const entered = barrier<void>()
		worker.terminate.mockImplementation(() => {
			entered.release()
			return termination.promise
		})
		replyForRequest(worker, prepared())
		await entered.promise
		try {
			controller.abort(reason)
			expect(receipts).not.toHaveBeenCalled()
			expect(() => worker.emit("error", new Error("late termination error"))).not.toThrow()
		} finally {
			termination.release(0)
		}

		const result = await pending
		expect(result).toEqual({ kind: "error", error: reason })
		expect(receipts).toHaveBeenCalledOnce()
		expectReleased(worker)
	})

	it("does not publish prepared bytes if worker termination fails", async () => {
		const pending = observe()
		const worker = await workerStarted()
		worker.terminate.mockRejectedValue(new Error("private termination failure"))
		replyForRequest(worker, prepared())

		expect(await pending).toMatchObject({
			kind: "error",
			error: { message: "tools:readFile.imageDecodeUnavailable" },
		})
		expectReleased(worker)
	})

	it("times out once and ignores a prepared response arriving during termination", async () => {
		const receipts = vi.fn()
		const pending = observe().then((outcome) => {
			receipts(outcome)
			return outcome
		})
		const worker = await workerStarted()
		const termination = barrier<number>()
		worker.terminate.mockReturnValue(termination.promise)
		await vi.advanceTimersByTimeAsync(5_000)
		try {
			expect(receipts).not.toHaveBeenCalled()
			replyForRequest(worker, prepared())
		} finally {
			termination.release(0)
		}

		expect(await pending).toMatchObject({ kind: "error", error: { message: "tools:readFile.imageDecodeTimeout" } })
		expect(receipts).toHaveBeenCalledOnce()
		expectReleased(worker)
	})
})
