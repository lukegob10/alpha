import { defineConfig } from "vitest/config"

import extensionConfig from "./vitest.config"

// Explicitly selected diagnostic probes assert desired contracts and currently
// expose unfixed failures. They are excluded from ordinary *.spec discovery.
export default defineConfig({
	...extensionConfig,
	test: { ...extensionConfig.test, include: ["core/**/__tests__/*.investigation.ts"] },
})
