import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as os from "os"
import * as path from "path"

import { safeWriteJson } from "../safeWriteJson"

vi.mock("fs", async () => {
	const actual = await vi.importActual<typeof import("fs")>("fs")
	return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) }
})

const deferred = () => {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}

const bufferingOptions = (serializationBufferSize: number) => ({ prettyPrint: true, serializationBufferSize })

const fixture = () => ({
	version: 2,
	records: Array.from({ length: 600 }, (_, index) => ({
		id: `record-${index}`,
		metadata: {
			text: '😀\\"\n\t'.repeat(80),
			empty: {},
			optional: undefined,
		},
	})),
	special: {
		unicode: "\u2028\u2029\ud800",
		bigint: BigInt(123),
		date: new Date("2026-09-05T00:00:00Z"),
		sparse: Object.assign(new Array<unknown>(3), { 0: undefined, 2: null }),
		nested: { omitted: undefined },
	},
})

describe("safeWriteJson serialization buffering", () => {
	let directory: string

	beforeEach(async () => {
		const actual = await vi.importActual<typeof import("fs")>("fs")
		vi.mocked(fsSync.createWriteStream).mockReset().mockImplementation(actual.createWriteStream)
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "safeWriteJson-buffering-"))
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it.each([16_384, 65_536])("preserves exact output bytes with fewer writes at %i characters", async (bufferSize) => {
		const actual = await vi.importActual<typeof import("fs")>("fs")
		const chunkCounts: Array<() => number> = []
		vi.mocked(fsSync.createWriteStream).mockImplementation((filePath, options) => {
			const stream = actual.createWriteStream(filePath, options)
			const write = vi.spyOn(stream, "write")
			chunkCounts.push(() => write.mock.calls.length)
			return stream
		})
		const baselinePath = path.join(directory, "baseline.json")
		const bufferedPath = path.join(directory, "buffered.json")
		const data = fixture()

		await safeWriteJson(baselinePath, data, { prettyPrint: true })
		await safeWriteJson(bufferedPath, data, bufferingOptions(bufferSize))

		expect(await fs.readFile(bufferedPath)).toEqual(await fs.readFile(baselinePath))
		expect(chunkCounts).toHaveLength(2)
		expect(chunkCounts[1]()).toBeGreaterThan(1)
		expect(chunkCounts[1]()).toBeLessThan(chunkCounts[0]())
	})

	it("preserves the default chunking when the minimum buffer is explicitly selected", async () => {
		const actual = await vi.importActual<typeof import("fs")>("fs")
		const chunkCounts: Array<() => number> = []
		vi.mocked(fsSync.createWriteStream).mockImplementation((filePath, options) => {
			const stream = actual.createWriteStream(filePath, options)
			const write = vi.spyOn(stream, "write")
			chunkCounts.push(() => write.mock.calls.length)
			return stream
		})
		const baselinePath = path.join(directory, "baseline.json")
		const explicitPath = path.join(directory, "explicit.json")
		await safeWriteJson(baselinePath, fixture(), { prettyPrint: true })
		await safeWriteJson(explicitPath, fixture(), bufferingOptions(512))
		expect(await fs.readFile(explicitPath)).toEqual(await fs.readFile(baselinePath))
		expect(chunkCounts[1]()).toBe(chunkCounts[0]())
	})

	it.each([16_384, 65_536])(
		"respects write backpressure and waits for stream finish at %i characters",
		async (bufferSize) => {
			const actual = await vi.importActual<typeof import("fs")>("fs")
			const firstWrite = deferred()
			const releaseWrite = deferred()
			let output!: fsSync.WriteStream
			vi.mocked(fsSync.createWriteStream).mockImplementationOnce((filePath, options) => {
				output = actual.createWriteStream(filePath, options)
				const write = output._write.bind(output)
				vi.spyOn(output, "_write").mockImplementationOnce((chunk, encoding, callback) => {
					firstWrite.resolve()
					void releaseWrite.promise.then(() => write(chunk, encoding, callback))
				})
				return output
			})
			let visitedRecords = 0
			const data = {
				records: Array.from({ length: 2_000 }, () => ({
					get body() {
						visitedRecords++
						return "x".repeat(1_024)
					},
				})),
			}
			const destination = path.join(directory, "state.json")
			await fs.writeFile(destination, "original")
			const commit = vi.fn((source: string, target: string) => {
				expect(output.writableFinished).toBe(true)
				actual.renameSync(source, target)
			})
			const writing = safeWriteJson(destination, data, {
				...bufferingOptions(bufferSize),
				atomicReplace: true,
				commitTempFile: commit,
			})
			try {
				await firstWrite.promise
				// Let ready stream callbacks run while the first disk write remains held.
				await new Promise<void>((resolve) => setImmediate(resolve))
				expect(output.writableFinished).toBe(false)
				expect(commit).not.toHaveBeenCalled()
				expect(await fs.readFile(destination, "utf8")).toBe("original")
				expect(visitedRecords).toBeGreaterThan(0)
				expect(visitedRecords).toBeLessThan(data.records.length)
				// The ASCII fixture can overshoot the chunk threshold by one primitive.
				expect(output.writableLength).toBeLessThanOrEqual(output.writableHighWaterMark + bufferSize + 2_048)
			} finally {
				releaseWrite.resolve()
				await writing
			}
			expect(commit).toHaveBeenCalledTimes(1)
			expect(visitedRecords).toBe(data.records.length)
			expect(JSON.parse(await fs.readFile(destination, "utf8")).records).toHaveLength(data.records.length)
		},
	)

	it("retains the original bytes on a rejected buffered commit fence and permits the next write", async () => {
		const destination = path.join(directory, "state.json")
		const original = Buffer.from('{"original":"retained"}\n')
		await fs.writeFile(destination, original)
		vi.spyOn(console, "error").mockImplementation(() => undefined)
		const commit = vi.fn(() => {
			throw new Error("transaction ownership was lost")
		})

		await expect(
			safeWriteJson(destination, fixture(), {
				...bufferingOptions(65_536),
				atomicReplace: true,
				commitTempFile: commit,
			}),
		).rejects.toThrow("transaction ownership was lost")

		expect(commit).toHaveBeenCalledTimes(1)
		expect(await fs.readFile(destination)).toEqual(original)
		expect(await fs.readdir(directory)).toEqual(["state.json"])
		await expect(
			safeWriteJson(
				destination,
				{ next: true },
				{
					...bufferingOptions(65_536),
					atomicReplace: true,
					commitTempFile: (source, target) => fsSync.renameSync(source, target),
				},
			),
		).resolves.toBeUndefined()
		expect(JSON.parse(await fs.readFile(destination, "utf8"))).toEqual({ next: true })
		expect(await fs.readdir(directory)).toEqual(["state.json"])
	})

	it.each([0, 511, 512.5, 65_537, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects an invalid buffer size %s without replacing existing content",
		async (bufferSize) => {
			const destination = path.join(directory, "state.json")
			await fs.writeFile(destination, "original")
			await expect(safeWriteJson(destination, { next: true }, bufferingOptions(bufferSize))).rejects.toThrow()
			expect(await fs.readFile(destination, "utf8")).toBe("original")
		},
	)
})
