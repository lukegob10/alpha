import fs from "fs/promises"
// @ts-ignore-next-line
import pdf from "pdf-parse/lib/pdf-parse"
import { extractTextFromFileRaw, extractTextFromFileWithMetadata } from "../extract-text"

vi.mock("fs/promises", () => ({ default: { access: vi.fn(), readFile: vi.fn() } }))
vi.mock("pdf-parse/lib/pdf-parse", () => ({ default: vi.fn() }))

describe("PDF parser byte transport", () => {
	const expectedBytes = [0x25, 0x50, 0x44, 0x46, 0x00, 0x80, 0xff]
	let source: Buffer

	beforeEach(() => {
		vi.resetAllMocks()
		const backing = new ArrayBuffer(32)
		new Uint8Array(backing).fill(0xa5)
		source = Buffer.from(backing, 11, expectedBytes.length)
		source.set(expectedBytes)
		vi.mocked(fs.access).mockResolvedValue(undefined)
		vi.mocked(fs.readFile).mockResolvedValue(source)
		vi.mocked(pdf).mockResolvedValue({ text: "decoded PDF text" })
	})

	it("passes an owned plain Uint8Array containing only the nonzero-offset Buffer view", async () => {
		expect(source.byteOffset).toBe(11)
		expect(Array.from(new Uint8Array(source.buffer).slice(0, 11))).toEqual(Array(11).fill(0xa5))
		expect(Array.from(new Uint8Array(source.buffer).slice(18))).toEqual(Array(14).fill(0xa5))
		await expect(extractTextFromFileRaw("spec.pdf")).resolves.toBe("decoded PDF text")
		expect(pdf).toHaveBeenCalledTimes(1)
		const input: unknown = vi.mocked(pdf).mock.calls[0]![0]
		expect(input).toBeInstanceOf(Uint8Array)
		expect(Buffer.isBuffer(input)).toBe(false)
		if (!(input instanceof Uint8Array)) throw new Error("Expected native PDF byte array")
		expect(input.constructor).toBe(Uint8Array)
		expect(input.byteLength).toBe(expectedBytes.length)
		expect(input.byteOffset).toBe(0)
		expect(input.buffer.byteLength).toBe(expectedBytes.length)
		expect(input.buffer).not.toBe(source.buffer)
		expect(Array.from(input)).toEqual(expectedBytes)
		input[0] = 0
		expect(Array.from(source)).toEqual(expectedBytes)
	})

	it("preserves the original parser rejection when cancellation is absent", async () => {
		const failure = new Error("PDF parser failure")
		vi.mocked(pdf).mockRejectedValueOnce(failure)
		await expect(extractTextFromFileRaw("spec.pdf")).rejects.toBe(failure)
		expect(pdf).toHaveBeenCalledTimes(1)
	})

	it("rejects pre-aborted extraction before filesystem or parser work", async () => {
		const controller = new AbortController()
		const reason = new Error("PDF cancelled before read")
		controller.abort(reason)
		await expect(extractTextFromFileRaw("spec.pdf", controller.signal)).rejects.toBe(reason)
		expect(fs.access).not.toHaveBeenCalled()
		expect(fs.readFile).not.toHaveBeenCalled()
		expect(pdf).not.toHaveBeenCalled()
	})

	it("checks cancellation after the signalled read before invoking the parser", async () => {
		const controller = new AbortController()
		const reason = new Error("PDF cancelled during read")
		vi.mocked(fs.readFile).mockImplementationOnce(async () => {
			controller.abort(reason)
			return source
		})
		await expect(extractTextFromFileRaw("spec.pdf", controller.signal)).rejects.toBe(reason)
		expect(fs.readFile).toHaveBeenCalledWith("spec.pdf", { signal: controller.signal })
		expect(pdf).not.toHaveBeenCalled()
	})

	it("does not publish metadata when cancellation precedes deferred parser fulfillment", async () => {
		const controller = new AbortController()
		const reason = new Error("PDF cancelled during parser fulfillment")
		let markStarted!: () => void
		let fulfill!: (value: { text: string }) => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		const parsed = new Promise<{ text: string }>((resolve) => {
			fulfill = resolve
		})
		vi.mocked(pdf).mockImplementationOnce(() => {
			markStarted()
			return parsed
		})
		const extraction = extractTextFromFileWithMetadata("spec.pdf", 2, controller.signal)
		await started
		controller.abort(reason)
		fulfill({ text: "discarded PDF text" })
		await expect(extraction).rejects.toBe(reason)
		expect(pdf).toHaveBeenCalledTimes(1)
	})

	it("preserves cancellation when the deferred parser subsequently rejects", async () => {
		const controller = new AbortController()
		const reason = new Error("PDF cancelled during parser rejection")
		const failure = new Error("Late PDF parser failure")
		let markStarted!: () => void
		let reject!: (reason: Error) => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		const parsed = new Promise<{ text: string }>((_resolve, rejectPromise) => {
			reject = rejectPromise
		})
		vi.mocked(pdf).mockImplementationOnce(() => {
			markStarted()
			return parsed
		})
		const extraction = extractTextFromFileRaw("spec.pdf", controller.signal)
		await started
		controller.abort(reason)
		reject(failure)
		await expect(extraction).rejects.toBe(reason)
		expect(pdf).toHaveBeenCalledTimes(1)
	})
})
