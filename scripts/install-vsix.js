const { execFileSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const readline = require("node:readline")

const ALLOWED_EDITORS = Object.freeze(["code", "code-insiders", "cursor"])
const SAFE_PACKAGE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const SAFE_VERSION_TOKEN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const NIGHTLY_REMOVAL_MESSAGE =
	"Nightly VSIX installation is no longer supported. Build and install the regular extension instead."

function normalizeEditor(value, { platform = process.platform } = {}) {
	if (typeof value !== "string") {
		throw new Error(`Editor must be one of: ${ALLOWED_EDITORS.join(", ")}`)
	}

	const candidate = value.trim().toLowerCase()
	const hasCmdExtension = candidate.endsWith(".cmd")
	const editor = hasCmdExtension ? candidate.slice(0, -4) : candidate

	if (hasCmdExtension && platform !== "win32") {
		throw new Error(`Editor must be one of: ${ALLOWED_EDITORS.join(", ")}`)
	}
	if (!ALLOWED_EDITORS.includes(editor)) {
		throw new Error(`Editor must be one of: ${ALLOWED_EDITORS.join(", ")}`)
	}

	return editor
}

function parseArguments(argv) {
	let autoYes = false
	let editor

	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index]
		if (argument === "-y") {
			autoYes = true
			continue
		}
		if (argument === "--nightly") {
			throw new Error(NIGHTLY_REMOVAL_MESSAGE)
		}
		if (argument === "--editor") {
			if (editor !== undefined || index + 1 >= argv.length) {
				throw new Error("The --editor option requires one editor name.")
			}
			editor = argv[++index]
			continue
		}
		if (argument.startsWith("--editor=")) {
			if (editor !== undefined) {
				throw new Error("The --editor option may only be provided once.")
			}
			editor = argument.slice("--editor=".length)
			continue
		}
		throw new Error(`Unknown option: ${argument}`)
	}

	return { autoYes, editor }
}

function validatePackageMetadata({ name, version, publisher }) {
	if (
		typeof name !== "string" ||
		typeof version !== "string" ||
		typeof publisher !== "string" ||
		!SAFE_PACKAGE_TOKEN.test(name) ||
		!SAFE_VERSION_TOKEN.test(version) ||
		!SAFE_PACKAGE_TOKEN.test(publisher)
	) {
		throw new Error("Extension manifest name, version, and publisher must use safe package identifier syntax.")
	}

	return { name, version, publisher }
}

/**
 * Quote a safe argument for the Windows command interpreter. The installer
 * passes only fixed flags and validated manifest-derived paths through cmd.exe;
 * shell metacharacters are rejected instead of being escaped through .cmd's
 * additional %* expansion layer.
 */
function quoteWindowsArgument(value) {
	if (typeof value !== "string" || /[\0\r\n"&|<>()^%!]/u.test(value)) {
		throw new Error("Editor arguments cannot contain shell metacharacters or control characters.")
	}

	return `"${value}"`
}

function createEditorInvocation(
	editor,
	args,
	{ platform = process.platform, comSpec = process.env.ComSpec || "cmd.exe" } = {},
) {
	const normalizedEditor = normalizeEditor(editor, { platform })
	if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
		throw new Error("Editor arguments must be strings.")
	}

	if (platform === "win32") {
		const command = [`${normalizedEditor}.cmd`, ...args.map(quoteWindowsArgument)].join(" ")
		return {
			file: comSpec,
			args: ["/d", "/v:off", "/c", command],
			options: { stdio: "inherit", windowsVerbatimArguments: true },
		}
	}

	return {
		file: normalizedEditor,
		args: [...args],
		options: { stdio: "inherit" },
	}
}

function runEditor(editor, args, options = {}) {
	const { execFileSyncImpl = execFileSync, ...invocationOptions } = options
	const invocation = createEditorInvocation(editor, args, invocationOptions)
	return execFileSyncImpl(invocation.file, invocation.args, invocation.options)
}

function askQuestion(rl, question) {
	return new Promise((resolve) => {
		rl.question(question, resolve)
	})
}

async function main(argv = process.argv.slice(2)) {
	let rl

	try {
		const { autoYes, editor: editorArgument } = parseArguments(argv)
		const validatedEditorArgument = editorArgument === undefined ? undefined : normalizeEditor(editorArgument)
		const packageJson = JSON.parse(fs.readFileSync(path.join("src", "package.json"), "utf8"))
		const { name, version, publisher } = validatePackageMetadata(packageJson)
		const vsixFileName = path.join("bin", `${name}-${version}.vsix`)
		const extensionId = `${publisher}.${name}`

		console.log("\n🚀 Alpha VSIX Installer")
		console.log("========================")
		console.log("\nThis script will:")
		console.log("1. Install the newly built VSIX package")
		console.log("2. Replace any installed copy of the same version")
		console.log(`\nExtension: ${extensionId}`)
		console.log(`VSIX file: ${vsixFileName}`)

		if (!fs.existsSync(vsixFileName)) {
			throw new Error(`VSIX file not found: ${vsixFileName}. Make sure the build completed successfully.`)
		}

		rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		})

		let editor = validatedEditorArgument
		if (editor === undefined && !autoYes) {
			editor =
				(
					await askQuestion(
						rl,
						"\nWhich editor command to use? (code/cursor/code-insiders) [default: code]: ",
					)
				).trim() || "code"
		}
		editor = normalizeEditor(editor === undefined ? "code" : editor)

		const answer = autoYes ? "y" : await askQuestion(rl, "\nDo you wish to continue? (y/n): ")
		if (answer.trim().toLowerCase() !== "y") {
			console.log("Installation cancelled.")
			return
		}

		console.log(`\nProceeding with installation using '${editor}' command...`)
		runEditor(editor, ["--install-extension", vsixFileName, "--force"])

		console.log(`\n✅ Successfully installed extension from ${vsixFileName}`)
		console.log("\n⚠️  IMPORTANT: You need to restart VS Code for the changes to take effect.")
		console.log("   Please close and reopen VS Code to use the updated extension.\n")
	} catch (error) {
		console.error("\n❌ Failed to install extension:", error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	} finally {
		rl?.close()
	}
}

module.exports = {
	ALLOWED_EDITORS,
	NIGHTLY_REMOVAL_MESSAGE,
	createEditorInvocation,
	normalizeEditor,
	parseArguments,
	quoteWindowsArgument,
	runEditor,
	validatePackageMetadata,
}

if (require.main === module) {
	void main()
}
