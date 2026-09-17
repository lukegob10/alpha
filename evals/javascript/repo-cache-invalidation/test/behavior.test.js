import test from "node:test"
import assert from "node:assert/strict"
import { ConfigCache } from "../src/cache.js"
test("invalidates transitive values only", () => {
	const c = new ConfigCache()
	c.set("port", 3000)
	assert.equal(c.getOrigin(), "http://localhost:3000")
	c.set("port", 4000)
	assert.equal(c.getOrigin(), "http://localhost:4000")
})
