import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

const dynamicRuntimeRequire = "require(`./pdf.js/${options.version}/build/pdf.js`)"

/** @returns {import("esbuild").Plugin} */
export function defaultPdfRuntimePlugin(
	parserPath = createRequire(import.meta.url).resolve("pdf-parse/lib/pdf-parse"),
) {
	return {
		name: "pdf-parse-default-runtime",
		setup(build) {
			build.onLoad({ filter: /[/\\]pdf-parse[/\\]lib[/\\]pdf-parse\.js$/ }, async (args) => {
				if (args.path !== parserPath) return
				const manifestPath = path.resolve(path.dirname(args.path), "../package.json")
				const [source, manifest] = await Promise.all([
					readFile(args.path, "utf8"),
					readFile(manifestPath, "utf8"),
				])
				if (
					JSON.parse(manifest).version !== "1.1.1" ||
					!source.match(/const DEFAULT_OPTIONS\s*=\s*\{[^}]*\bversion:\s*(['"])v1\.10\.100\1\s*\}/su) ||
					source.split(dynamicRuntimeRequire).length !== 2
				) {
					throw new Error(
						"Unexpected pdf-parse default-runtime contract; review its bundling before packaging",
					)
				}
				// Alpha's extractor uses the 1.1.1 default only. Its dynamic require would otherwise
				// pull three unused PDF.js versions and workers into the same extension bundle.
				return {
					contents: source.replace(dynamicRuntimeRequire, 'require("./pdf.js/v1.10.100/build/pdf.js")'),
					loader: "js",
					resolveDir: path.dirname(args.path),
					watchFiles: [manifestPath],
				}
			})
		},
	}
}
