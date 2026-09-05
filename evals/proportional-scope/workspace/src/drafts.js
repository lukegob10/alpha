export function saveDraft(current, requestedText, expectedVersion) {
	return { text: requestedText, version: current.version + 1 }
}
