import { Worker } from "node:worker_threads"
import type { SanitizedDocument } from "./sanitize"
import { HTML_DOCUMENT_LIMITS } from "@alpha-code/types"

/** Untrusted HTML parsing never runs on the extension event loop. One job per panel. */
export class DocumentParser {
	private cancel?: () => void
	private worker?: Worker
	constructor(private readonly workerPath: string) {}

	parse(source: string): Promise<SanitizedDocument> {
		this.cancelPending()
		if (Buffer.byteLength(source, "utf8") > HTML_DOCUMENT_LIMITS.bytes) return Promise.reject(new Error("size"))
		return new Promise((resolve, reject) => {
			const worker =
				this.worker ??
				new Worker(this.workerPath, {
					resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
				})
			this.worker = worker
			let settled = false
			const finish = (document?: SanitizedDocument, error?: string) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				this.cancel = undefined
				worker.removeListener("message", onMessage)
				worker.removeListener("error", onError)
				worker.removeListener("exit", onExit)
				if (!document) {
					this.worker = undefined
					void worker.terminate()
				}
				if (document) resolve(document)
				else reject(new Error(error ?? "format"))
			}
			const timer = setTimeout(() => finish(undefined, "size"), 1500)
			this.cancel = () => finish(undefined, "cancelled")
			const onMessage = (result: { document?: SanitizedDocument; error?: string }) =>
				finish(result.document, result.error)
			const onError = () => finish(undefined, "size")
			const onExit = () => finish(undefined, "format")
			worker.once("message", onMessage)
			worker.once("error", onError)
			worker.once("exit", onExit)
			worker.postMessage(source)
		})
	}

	cancelPending(): void {
		this.cancel?.()
	}

	dispose(): void {
		this.cancelPending()
		if (this.worker) {
			void this.worker.terminate()
			this.worker = undefined
		}
	}
}
