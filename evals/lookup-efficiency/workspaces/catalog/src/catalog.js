import { maxBatchSize } from "./settings.js"

export function computeReorderPoint(onHand, inbound) {
	return Math.max(0, maxBatchSize - onHand - inbound)
}
