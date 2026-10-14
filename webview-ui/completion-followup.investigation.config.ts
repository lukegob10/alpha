import { defineConfig } from "vitest/config"

import webviewConfig from "./vitest.config"

export default defineConfig({
	...webviewConfig,
	test: { ...webviewConfig.test, include: ["src/**/__tests__/*.investigation.ts"] },
})
