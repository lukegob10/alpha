import { defineConfig } from "vitest/config"

import extensionConfig from "./vitest.config"

// These review probes include desired contracts that expose unfixed defects.
// Keep them explicitly selected and separate from ordinary suite discovery.
export default defineConfig({
	...extensionConfig,
	test: { ...extensionConfig.test, include: ["**/__tests__/*early-ending.investigation.ts"] },
})
