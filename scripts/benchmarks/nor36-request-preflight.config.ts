import path from "node:path"

const root = path.resolve(__dirname, "../..")

export default {
	root,
	test: {
		globals: true,
		setupFiles: [path.join(root, "src/vitest.setup.ts")],
		include: ["scripts/benchmarks/nor36-request-preflight.spec.ts"],
		testTimeout: 30_000,
		fileParallelism: false,
	},
	resolve: { alias: { vscode: path.join(root, "src/__mocks__/vscode.js") } },
}
