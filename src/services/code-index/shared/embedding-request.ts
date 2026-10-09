import { EMBEDDING_REQUEST_TIMEOUT_MS } from "../constants"
import { t } from "../../../i18n"
import { withIndexingCancellation } from "./file-indexing"

/** Bound auth/network work, excluding quota waits. Own the timer: GenAI 1.47.0 leaves httpOptions.timeout timers alive after settlement. */
export async function withEmbeddingTimeout<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted()
	const deadline = new AbortController()
	const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
	const timer = setTimeout(
		() => deadline.abort(new Error(t("embeddings:incremental.requestTimeout"))),
		EMBEDDING_REQUEST_TIMEOUT_MS,
	)
	try {
		return await withIndexingCancellation(operation(requestSignal), requestSignal)
	} finally {
		clearTimeout(timer)
	}
}
