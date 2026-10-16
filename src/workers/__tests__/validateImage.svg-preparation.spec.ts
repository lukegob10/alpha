import { beforeEach, describe, expect, it, vi } from "vitest"

const ipc = vi.hoisted(() => ({
	onMessage: undefined as ((request: unknown) => void | Promise<void>) | undefined,
	replies: [] as unknown[],
}))
const codec = vi.hoisted(() => ({
	initialize: vi.fn(async (_bytes: unknown, _configuration: unknown) => {}),
	ping: vi.fn(),
	read: vi.fn(),
	write: vi.fn(),
	dispose: vi.fn(),
	strip: vi.fn(),
	onWarning: undefined as ((event: { error: Error }) => void) | undefined,
	writeBytes: new Uint8Array([
		137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21,
		196, 137, 0, 0, 0, 11, 73, 68, 65, 84, 120, 156, 99, 96, 0, 2, 0, 0, 5, 0, 1, 122, 94, 171, 63, 0, 0, 0, 0, 73,
		69, 78, 68, 174, 66, 96, 130,
	]),
}))

vi.mock("node:fs/promises", () => ({ readFile: vi.fn(async () => Uint8Array.of(1, 2, 3)) }))
vi.mock("node:worker_threads", () => ({
	parentPort: {
		once: vi.fn((_event: string, onMessage: (request: unknown) => void | Promise<void>) => {
			ipc.onMessage = onMessage
		}),
		postMessage: vi.fn((result: unknown) => ipc.replies.push(result)),
	},
}))

// This control accepts admitted data. It isolates the existing worker IPC guard and publication
// contract; it is not evidence of real XML parsing, rasterization, pixels or codec security.
vi.mock("@imagemagick/magick-wasm", async (importOriginal) => {
	const original = await importOriginal<typeof import("@imagemagick/magick-wasm")>()
	return {
		...original,
		initializeImageMagick: codec.initialize,
		ResourceLimits: {},
		MagickColors: { Transparent: { red: 0, green: 0, blue: 0, alpha: 0 } },
		MagickReadSettings: class {
			constructor(settings: object) {
				Object.assign(this, settings)
			}
		},
		MagickImage: {
			create: () => ({
				set onWarning(handler: (event: { error: Error }) => void) {
					codec.onWarning = handler
				},
				width: 1,
				height: 1,
				signature: "accepted-by-control-codec",
				ping: codec.ping,
				read: codec.read,
				strip: codec.strip,
				attributeNames: [],
				artifactNames: [],
				removeAttribute: vi.fn(),
				removeArtifact: vi.fn(),
				settings: { setDefine: vi.fn(), removeDefine: vi.fn() },
				write: (format: unknown, callback: (bytes: Uint8Array) => unknown) => {
					codec.write(format)
					return callback(codec.writeBytes)
				},
				dispose: codec.dispose,
			}),
		},
	}
})

const literalSvg =
	'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>'
const oldL08 =
	'<!DOCTYPE svg [<!ENTITY alpha SYSTEM "file:///xml/alpha-svg-canary.svg">]>' +
	'<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2">' +
	'<rect width="2" height="2" fill="red"/>&alpha;</svg>'
const sharedSvg = new Uint8Array(new SharedArrayBuffer(Buffer.byteLength(literalSvg)))
sharedSvg.set(Buffer.from(literalSvg))
const rejectedSources = [
	{ name: "shared mutable SVG input backing", bytes: sharedSvg },
	{ name: "the unchanged L08 external entity fixture", bytes: Buffer.from(oldL08) },
	{ name: "a plain DOCTYPE", bytes: Buffer.from(`<!DOCTYPE svg>${literalSvg}`) },
	{ name: "an internal entity declaration", bytes: Buffer.from(`<!ENTITY alpha "red">${literalSvg}`) },
	{ name: "a declaration token hidden inside a comment", bytes: Buffer.from(`<!-- <!DOCTYPE svg> -->${literalSvg}`) },
	{ name: "invalid UTF-8", bytes: Buffer.concat([Buffer.from([0xc0, 0xaf]), Buffer.from(literalSvg)]) },
	{
		name: "a truncated multibyte UTF-8 suffix",
		bytes: Buffer.concat([Buffer.from(literalSvg), Buffer.from([0xe2, 0x82])]),
	},
	{ name: "a literal NUL", bytes: Buffer.from(`${literalSvg}\u0000`) },
	{ name: "UTF-16LE input", bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(literalSvg, "utf16le")]) },
	{ name: "UTF-16BE BOM", bytes: Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(literalSvg)]) },
	{ name: "UTF-32 BOM", bytes: Buffer.concat([Buffer.from([0, 0, 0xfe, 0xff]), Buffer.from(literalSvg)]) },
	{ name: "legacy XML encoding", bytes: Buffer.from(`<?xml version="1.0" encoding="ISO-8859-1"?>${literalSvg}`) },
	{
		name: "a UTF-16 declaration in UTF-8 bytes",
		bytes: Buffer.from(`<?xml version="1.0" encoding="UTF-16"?>${literalSvg}`),
	},
	{ name: "XML 1.1", bytes: Buffer.from(`<?xml version="1.1" encoding="UTF-8"?>${literalSvg}`) },
	{
		name: "an unknown XML declaration attribute",
		bytes: Buffer.from(`<?xml version="1.0" surprise="yes"?>${literalSvg}`),
	},
	{ name: "an unterminated XML declaration", bytes: Buffer.from(`<?xml version="1.0" ${literalSvg}`) },
	{ name: "a misplaced XML declaration", bytes: Buffer.from(`<!-- header --><?xml version="1.0"?>${literalSvg}`) },
	{ name: "a second XML declaration", bytes: Buffer.from(`<?xml version="1.0"?><?xml version="1.0"?>${literalSvg}`) },
	{
		name: "an overlong XML declaration",
		bytes: Buffer.from(`<?xml version="1.0" ${" ".repeat(1024)}?>${literalSvg}`),
	},
	{ name: "an ambiguous legacy prefix", bytes: Buffer.from(`legacy${literalSvg}`) },
]
const controlPng = Uint8Array.from(codec.writeBytes)

async function send(bytes: Uint8Array, extension = ".svg", maxOutputBytes = 5 * 1024 * 1024) {
	await import("../validateImage")
	if (!ipc.onMessage) throw new Error("Existing worker message handler was not registered")
	await ipc.onMessage({ bytes, extension, maxOutputBytes })
	expect(ipc.replies).toHaveLength(1)
	return ipc.replies[0]
}

describe("existing image-worker IPC SVG preparation boundary (codec controlled)", () => {
	beforeEach(() => {
		vi.resetModules()
		vi.clearAllMocks()
		codec.read.mockReset()
		codec.write.mockReset()
		ipc.onMessage = undefined
		ipc.replies.length = 0
		codec.onWarning = undefined
		codec.writeBytes = Uint8Array.from(controlPng)
	})

	it.each(rejectedSources)("rejects $name before native initialization", async ({ bytes }) => {
		const reply = await send(bytes)

		expect(codec.initialize).not.toHaveBeenCalled()
		expect(codec.ping).not.toHaveBeenCalled()
		expect(codec.read).not.toHaveBeenCalled()
		expect(codec.write).not.toHaveBeenCalled()
		expect(reply).toMatchObject({ kind: "invalid", sourceExtension: ".svg" })
		expect(reply).not.toHaveProperty("bytes")
	})

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])(
		"rejects an inadmissible byte allowance %s before native initialization",
		async (maxOutputBytes) => {
			const reply = await send(Buffer.from(literalSvg), ".svg", maxOutputBytes)

			expect(codec.initialize).not.toHaveBeenCalled()
			expect(codec.read).not.toHaveBeenCalled()
			expect(reply).toMatchObject({ kind: "failure", sourceExtension: ".svg", failure: "resource_limit" })
		},
	)

	it.each([
		{ name: "literal UTF-8", bytes: Buffer.from(literalSvg) },
		{ name: "UTF-8 BOM", bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(literalSvg)]) },
		{ name: "explicit UTF-8 XML 1.0", bytes: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${literalSvg}`) },
		{ name: "XML 1.0 with standalone", bytes: Buffer.from(`<?xml version='1.0' standalone='yes'?>${literalSvg}`) },
	])("initializes the control codec for accepted $name and emits only owned PNG", async ({ bytes }) => {
		const reply = await send(bytes)

		expect(codec.initialize).toHaveBeenCalledOnce()
		expect(codec.ping).toHaveBeenCalledOnce()
		expect(codec.read).toHaveBeenCalledOnce()
		expect(codec.write).toHaveBeenCalledOnce()
		expect(codec.dispose).toHaveBeenCalledOnce()
		expect(reply).toMatchObject({
			kind: "prepared",
			sourceExtension: ".svg",
			outputExtension: ".png",
			mimeType: "image/png",
			bytes: codec.writeBytes,
		})
		if (
			typeof reply !== "object" ||
			reply === null ||
			!("bytes" in reply) ||
			!(reply.bytes instanceof Uint8Array)
		) {
			throw new Error("Expected owned prepared image bytes")
		}
		expect(reply.bytes).not.toBe(codec.writeBytes)
		const prepared = Uint8Array.from(reply.bytes)
		const first = codec.writeBytes[0]
		try {
			codec.writeBytes[0] = 0
			expect(reply.bytes).toEqual(prepared)
		} finally {
			codec.writeBytes[0] = first
		}
	})

	it("rejects a prepared output over budget instead of returning the raw SVG", async () => {
		const bytes = Buffer.from('<svg width="1" height="1"/>')
		const reply = await send(bytes, ".svg", codec.writeBytes.length - 1)

		expect(codec.read).toHaveBeenCalledOnce()
		expect(codec.write).toHaveBeenCalledOnce()
		expect(codec.dispose).toHaveBeenCalledOnce()
		expect(reply).toMatchObject({ kind: "failure", sourceExtension: ".svg", failure: "resource_limit" })
		expect(reply).not.toHaveProperty("bytes")
	})

	it("keeps raster controls read-only and returns original-kind approval", async () => {
		const reply = await send(codec.writeBytes, ".png")

		expect(codec.initialize).toHaveBeenCalledOnce()
		expect(codec.read).toHaveBeenCalledOnce()
		expect(codec.write).not.toHaveBeenCalled()
		expect(reply).toEqual({ kind: "original", sourceExtension: ".png" })
	})

	it("does not prepare or publish source XML after a native read warning", async () => {
		codec.read.mockImplementationOnce(() => codec.onWarning?.({ error: new Error("controlled native warning") }))

		const reply = await send(Buffer.from(literalSvg))

		expect(reply).toEqual({ kind: "invalid", sourceExtension: ".svg" })
		expect(codec.write).not.toHaveBeenCalled()
		expect(codec.dispose).toHaveBeenCalledOnce()
	})

	it("rejects a native encoder warning without raw source fallback", async () => {
		codec.write.mockImplementationOnce(() => codec.onWarning?.({ error: new Error("controlled encoder warning") }))

		const reply = await send(Buffer.from(literalSvg))

		expect(reply).toEqual({ kind: "failure", sourceExtension: ".svg", failure: "preparation" })
		expect(reply).not.toHaveProperty("bytes")
		expect(codec.dispose).toHaveBeenCalledOnce()
	})

	it("rejects encoder metadata chunks even when the PNG pixel framing is otherwise present", async () => {
		// A controlled encoder returns a zero-length text chunk after IHDR. No codec-validity claim.
		const textChunk = Buffer.from([0, 0, 0, 0, 116, 69, 88, 116, 0, 0, 0, 0])
		codec.writeBytes = Buffer.concat([
			Buffer.from(controlPng.subarray(0, 33)),
			textChunk,
			Buffer.from(controlPng.subarray(33)),
		])

		const reply = await send(Buffer.from(literalSvg))

		expect(reply).toEqual({ kind: "failure", sourceExtension: ".svg", failure: "preparation" })
		expect(reply).not.toHaveProperty("bytes")
		expect(codec.dispose).toHaveBeenCalledOnce()
	})
})
