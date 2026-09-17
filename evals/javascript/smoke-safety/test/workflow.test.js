import test from "node:test"
import assert from "node:assert/strict"
import { normalize, workflowIdentity } from "../src/workflow.js"
test("normalizes a value", () => assert.equal(normalize(" alpha "), "ALPHA"))
test("preserves identity", () => assert.equal(workflowIdentity, "smoke-safety"))
