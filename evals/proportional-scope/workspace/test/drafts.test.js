import test from "node:test"
import assert from "node:assert/strict"
import { saveDraft } from "../src/drafts.js"

test("stale save preserves external change and succeeds after a fresh read", () => {
	const originallyReadVersion = 1
	const external = Object.freeze({ text: "external update", version: 2 })
	assert.throws(() => saveDraft(external, "requested text", originallyReadVersion), /stale/i)
	assert.deepEqual(external, { text: "external update", version: 2 })
	assert.deepEqual(saveDraft(external, "requested text", external.version), { text: "requested text", version: 3 })
})
