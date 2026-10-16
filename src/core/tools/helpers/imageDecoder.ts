import { constants as bufferConstants } from "node:buffer"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { t } from "../../../i18n"

export const IMAGE_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".tiff": "image/tiff",
	".tif": "image/tiff",
	".avif": "image/avif",
}

export interface ImageDecodeRequest {
	bytes: Uint8Array
	extension: string
	maxOutputBytes: number
}

export type ImageDecodeResult =
	| { kind: "invalid"; sourceExtension: string }
	| { kind: "original"; sourceExtension: string }
	| {
			kind: "prepared"
			sourceExtension: ".svg"
			outputExtension: ".png"
			mimeType: "image/png"
			bytes: Uint8Array
	  }
	| { kind: "failure"; sourceExtension: string; failure: "resource_limit" | "initialization" | "preparation" }

export type PreparedImageContent =
	| {
			kind: "original"
			sourceExtension: string
			outputExtension: string
			mimeType: string
			bytes: Uint8Array
	  }
	| Extract<ImageDecodeResult, { kind: "prepared" }>

const MAX_ACTIVE_IMAGE_DECODES = 2
const MAX_PENDING_IMAGE_DECODES = 8
const IMAGE_DECODE_TIMEOUT_MS = 5_000
const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const PNG_END = [0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]

let activeDecodes = 0
const pendingDecodes: Array<() => void> = []

/** Prepares new image output without retaining source XML in the SVG publication path. */
export function prepareImageContent(
	bytes: Uint8Array,
	extension: string,
	signal?: AbortSignal,
	maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
): Promise<PreparedImageContent | undefined> {
	signal?.throwIfAborted()
	if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)) return Promise.resolve(undefined)
	const byteLimit = Math.floor(maxOutputBytes)
	if (
		!Number.isFinite(maxOutputBytes) ||
		byteLimit < 0 ||
		!Number.isSafeInteger(byteLimit + 1) ||
		byteLimit >= bufferConstants.MAX_LENGTH ||
		bytes.length > byteLimit
	) {
		return Promise.reject(new Error(t("tools:readFile.imageDecodeLimit")))
	}
	const sourceExtension = extension.toLowerCase()
	if (bytes.length === 0 || !Object.hasOwn(IMAGE_MIME_TYPES, sourceExtension)) return Promise.resolve(undefined)
	if (activeDecodes >= MAX_ACTIVE_IMAGE_DECODES && pendingDecodes.length >= MAX_PENDING_IMAGE_DECODES) {
		return Promise.reject(new Error(t("tools:readFile.imageDecodeBusy")))
	}

	return new Promise((resolve, reject) => {
		const onAbort = () => {
			const index = pendingDecodes.indexOf(start)
			if (index < 0) return
			pendingDecodes.splice(index, 1)
			signal?.removeEventListener("abort", onAbort)
			reject(signal?.reason ?? new Error(t("tools:readFile.imageDecodeCancelled")))
		}
		const start = () => {
			signal?.removeEventListener("abort", onAbort)
			activeDecodes += 1
			void decodeInWorker(bytes, sourceExtension, byteLimit, signal)
				.then(resolve, reject)
				.finally(() => {
					activeDecodes -= 1
					pendingDecodes.shift()?.()
				})
		}
		if (activeDecodes < MAX_ACTIVE_IMAGE_DECODES) {
			start()
		} else {
			pendingDecodes.push(start)
			signal?.addEventListener("abort", onAbort, { once: true })
		}
	})
}

/** Legacy raster validity callers cannot accidentally publish source SVG after preparation. */
export function isImageContentDecodable(bytes: Uint8Array, extension: string, signal?: AbortSignal): Promise<boolean> {
	signal?.throwIfAborted()
	if (extension.toLowerCase() === ".svg") return Promise.resolve(false)
	return prepareImageContent(bytes, extension, signal, bytes.length).then((result) => result?.kind === "original")
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
	const keys = Object.keys(value)
	return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

function isPreparedPng(bytes: unknown, maxBytes: number): bytes is Uint8Array {
	if (
		!(bytes instanceof Uint8Array) ||
		!(bytes.buffer instanceof ArrayBuffer) ||
		bytes.byteOffset !== 0 ||
		bytes.buffer.byteLength !== bytes.byteLength ||
		bytes.length <= 57 ||
		bytes.length > maxBytes ||
		!PNG_SIGNATURE.every((value, index) => bytes[index] === value) ||
		!PNG_END.every((value, index) => bytes[bytes.length - PNG_END.length + index] === value)
	) {
		return false
	}
	const header = new DataView(bytes.buffer)
	const width = header.getUint32(16)
	const height = header.getUint32(20)
	return (
		header.getUint32(8) === 13 &&
		header.getUint32(12) === 0x49484452 &&
		width > 0 &&
		height > 0 &&
		width <= 32_768 &&
		height <= 32_768 &&
		width * height <= 16_777_216
	)
}

function decodeInWorker(
	bytes: Uint8Array,
	extension: string,
	maxOutputBytes: number,
	signal?: AbortSignal,
): Promise<PreparedImageContent | undefined> {
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted()
		let worker: Worker
		try {
			worker = new Worker(path.join(__dirname, "workers", "validateImage.js"), {
				resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
			})
		} catch {
			reject(new Error(t("tools:readFile.imageDecodeUnavailable")))
			return
		}
		let settled = false
		const finish = async (prepared?: PreparedImageContent, error?: unknown) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal?.removeEventListener("abort", onAbort)
			// Reclaim the WASM heap before releasing this job's concurrency slot or publishing output.
			try {
				await worker.terminate()
			} catch {
				error ??= new Error(t("tools:readFile.imageDecodeUnavailable"))
			}
			// Node drains worker errors before exit; keep the persistent guard until termination settles.
			worker.removeListener("message", onMessage)
			worker.removeListener("error", onError)
			worker.removeListener("exit", onExit)
			if (signal?.aborted) reject(signal.reason ?? new Error(t("tools:readFile.imageDecodeCancelled")))
			else if (error !== undefined) reject(error)
			else resolve(prepared)
		}
		const onAbort = () =>
			void finish(undefined, signal?.reason ?? new Error(t("tools:readFile.imageDecodeCancelled")))
		const invalidResponse = () => void finish(undefined, new Error(t("tools:readFile.imageDecodeInvalidResponse")))
		const onMessage = (result: unknown) => {
			if (settled) return
			try {
				if (
					typeof result !== "object" ||
					result === null ||
					!("sourceExtension" in result) ||
					result.sourceExtension !== extension ||
					!("kind" in result)
				) {
					invalidResponse()
					return
				}
				if (result.kind === "invalid" && hasExactKeys(result, ["kind", "sourceExtension"])) {
					void finish()
				} else if (
					result.kind === "original" &&
					extension !== ".svg" &&
					hasExactKeys(result, ["kind", "sourceExtension"])
				) {
					void finish({
						kind: "original",
						bytes,
						sourceExtension: extension,
						outputExtension: extension,
						mimeType: IMAGE_MIME_TYPES[extension],
					})
				} else if (
					result.kind === "prepared" &&
					extension === ".svg" &&
					hasExactKeys(result, ["kind", "sourceExtension", "outputExtension", "mimeType", "bytes"]) &&
					"outputExtension" in result &&
					result.outputExtension === ".png" &&
					"mimeType" in result &&
					result.mimeType === "image/png" &&
					"bytes" in result &&
					isPreparedPng(result.bytes, maxOutputBytes)
				) {
					// Snapshot the admitted extent before awaiting termination; retain no mutable reply backing.
					const preparedBytes = new Uint8Array(result.bytes)
					void finish({
						kind: "prepared",
						sourceExtension: ".svg",
						outputExtension: ".png",
						mimeType: "image/png",
						bytes: preparedBytes,
					})
				} else if (
					result.kind === "failure" &&
					"failure" in result &&
					hasExactKeys(result, ["kind", "sourceExtension", "failure"]) &&
					(result.failure === "resource_limit" ||
						result.failure === "initialization" ||
						result.failure === "preparation")
				) {
					void finish(
						undefined,
						new Error(
							result.failure === "resource_limit"
								? t("tools:readFile.imageDecodeLimit")
								: t("tools:readFile.imageDecodeUnavailable"),
						),
					)
				} else invalidResponse()
			} catch {
				void finish(undefined, new Error(t("tools:readFile.imageDecodeUnavailable")))
			}
		}
		const onError = () => void finish(undefined, new Error(t("tools:readFile.imageDecodeUnavailable")))
		const onExit = () => void finish(undefined, new Error(t("tools:readFile.imageDecodeUnavailable")))
		const timer = setTimeout(
			() => void finish(undefined, new Error(t("tools:readFile.imageDecodeTimeout"))),
			IMAGE_DECODE_TIMEOUT_MS,
		)
		worker.once("message", onMessage)
		worker.on("error", onError)
		worker.once("exit", onExit)
		signal?.addEventListener("abort", onAbort, { once: true })
		if (signal?.aborted) {
			onAbort()
		} else {
			// Clone source bytes; original raster results retain the approved caller buffer.
			try {
				worker.postMessage({ bytes, extension, maxOutputBytes } satisfies ImageDecodeRequest)
			} catch {
				void finish(undefined, new Error(t("tools:readFile.imageDecodeUnavailable")))
			}
		}
	})
}
