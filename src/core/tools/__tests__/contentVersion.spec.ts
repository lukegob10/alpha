import { checkObservedContentVersion, contentVersionMetadata, fingerprintContent } from "../contentVersion"

describe("content version checks", () => {
	it("accepts the observed version", () => {
		const content = "alpha\nbeta\n"
		expect(checkObservedContentVersion(content, "", fingerprintContent(content)).status).toBe("current")
	})

	it("recovers stale line drift when every search anchor is unique", () => {
		const current = "inserted\nalpha\nbeta\n"
		const diff = "<<<<<<< SEARCH\n:start_line:1\n-------\nalpha\nbeta\n=======\nalpha\ngamma\n>>>>>>> REPLACE"
		expect(checkObservedContentVersion(current, diff, fingerprintContent("alpha\nbeta\n"))).toMatchObject({
			status: "recovered",
			metadata: { recovery: "unique_search_anchors", anchorCount: 1 },
		})
	})

	it("emits stable first and last non-empty line anchors", () => {
		expect(contentVersionMetadata("\nalpha\nbeta\n")).toMatchObject({
			fingerprint: expect.any(String),
			anchors: [
				{ line: 2, digest: expect.any(String) },
				{ line: 3, digest: expect.any(String) },
			],
		})
	})

	it("fails closed when a stale anchor is ambiguous", () => {
		const current = "alpha\nalpha\n"
		const diff = "<<<<<<< SEARCH\nalpha\n=======\nbeta\n>>>>>>> REPLACE"
		expect(checkObservedContentVersion(current, diff, fingerprintContent("alpha\n"))).toMatchObject({
			status: "stale_context",
			error: expect.stringContaining("re-read"),
		})
	})
})
