// pnpm exec vitest run src/__tests__/index.test.ts

import { GLOBAL_STATE_KEYS } from "../index.js"

describe("GLOBAL_STATE_KEYS", () => {
	it("should contain provider settings keys", () => {
		expect(GLOBAL_STATE_KEYS).toContain("autoApprovalEnabled")
	})

	it("should contain retained provider settings keys", () => {
		expect(GLOBAL_STATE_KEYS).toContain("openAiBaseUrl")
	})

	it("should not contain secret state keys", () => {
		expect(GLOBAL_STATE_KEYS).not.toContain("openRouterApiKey")
	})

	it("should contain Vertex code index settings", () => {
		expect(GLOBAL_STATE_KEYS).toContain("codebaseIndexConfig")
	})

	it("should not contain Vertex credentials (secret)", () => {
		expect(GLOBAL_STATE_KEYS).not.toContain("codebaseIndexVertexJsonCredentials")
	})
})
