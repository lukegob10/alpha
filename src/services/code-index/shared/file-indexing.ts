import type { CodeBlock, IEmbedder, IVectorStore, PointStruct, EmbeddingPriority } from "../interfaces"
import { createIndexPoint, getEmbeddingText, relativeIndexPath, validateEmbeddingBatch } from "./embedding-input"
import { EmbeddingRateLimiter } from "./embedding-rate-limiter"
import { t } from "../../../i18n"

/** Observe late settlement while releasing cancelled reads/provider calls promptly. Never race a storage mutation. */
export function withIndexingCancellation<T>(operation: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return Promise.resolve(operation)
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason)
		signal.addEventListener("abort", abort, { once: true })
		Promise.resolve(operation)
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort))
		if (signal.aborted) abort()
	})
}

/** Reuse only the exact embedding input, independent of line/offset movement and whole-file hashes. */
export async function prepareIndexPoints(
	blocks: CodeBlock[],
	workspacePath: string,
	options: {
		embedder: IEmbedder
		vectorStore: IVectorStore
		rateLimiter: EmbeddingRateLimiter
		batchSize: number
		signal?: AbortSignal
		onProgress?: (message: string) => void
		reusableFilePaths?: ReadonlySet<string>
		priority?: EmbeddingPriority
	},
): Promise<PointStruct[]> {
	const { embedder, vectorStore, rateLimiter, batchSize, signal, onProgress, reusableFilePaths, priority } = options
	signal?.throwIfAborted()
	const reusable = new Map<string, number[]>()
	for (const filePath of new Set(blocks.map((block) => block.file_path))) {
		if (reusableFilePaths && !reusableFilePaths.has(filePath)) continue
		// Older/custom store adapters can omit the optimization and still generate fresh vectors.
		if (!vectorStore.getPointsByFilePath) continue
		const previous = await withIndexingCancellation(vectorStore.getPointsByFilePath(filePath), signal)
		for (const point of previous) {
			if (!point.vector.length || point.vector.some((value) => !Number.isFinite(value))) continue
			const input = [
				`File: ${relativeIndexPath(String(point.payload.filePath), workspacePath)}`,
				point.payload.context || point.payload.identifier || "",
				point.payload.codeChunk,
			]
				.filter(Boolean)
				.join("\n")
			reusable.set(input, point.vector)
		}
	}
	const texts = blocks.map((block) => getEmbeddingText(block, workspacePath))
	const vectors: Array<number[] | undefined> = texts.map((text) => reusable.get(text))
	const missing = vectors.flatMap((vector, index) => (vector ? [] : [index]))
	onProgress?.(t("embeddings:incremental.embedding", { count: missing.length }))
	for (let offset = 0; offset < missing.length; offset += batchSize) {
		const indices = missing.slice(offset, offset + batchSize)
		await rateLimiter.wait(signal, 1, (waitMs) =>
			onProgress?.(t("embeddings:incremental.waiting", { seconds: Math.ceil(waitMs / 1000) })),
		)
		const response = await withIndexingCancellation(
			embedder.createEmbeddings(
				indices.map((index) => texts[index]),
				undefined,
				"document",
				signal,
				onProgress
					? (progress) =>
							onProgress(
								t(
									`embeddings:incremental.${progress.stage === "queued" && progress.waitMs ? "waiting" : progress.stage}`,
									{ seconds: Math.ceil((progress.waitMs ?? 0) / 1000) },
								),
							)
					: undefined,
				priority,
			),
			signal,
		)
		signal?.throwIfAborted()
		validateEmbeddingBatch(response.embeddings, indices.length)
		for (const [index, sourceIndex] of indices.entries()) vectors[sourceIndex] = response.embeddings[index]
	}
	const complete = vectors.map((vector) => {
		if (!vector) throw new Error(t("embeddings:validation.invalidResponse"))
		return vector
	})
	if (complete.length) validateEmbeddingBatch(complete, blocks.length)
	return blocks.map((block, index) => createIndexPoint(block, workspacePath, complete[index]))
}
