import path from "path"
import { mapPatchPaths } from "./parser"

export interface ApplyPatchCommandInvocation {
	kind: "patch"
	patch: string
	workdir?: string
}

export interface ApplyPatchCommandError {
	kind: "error"
	message: string
}

// Match only a complete, standalone Codex-style heredoc invocation. The body is
// never evaluated by a shell; the patch tool parses it after policy validation.
const HEREDOC_COMMAND =
	/^[ \t]*(?:cd\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([A-Za-z0-9_./\\:-]+))\s*&&\s*)?(?:apply_patch|applypatch)\s+<<(?:(['"])([A-Za-z_][A-Za-z0-9_]*)\4|([A-Za-z_][A-Za-z0-9_]*))[ \t]*$/

export function extractApplyPatchCommand(
	command: string,
): ApplyPatchCommandInvocation | ApplyPatchCommandError | undefined {
	// Codex CLI 970111f6cb62 reports implicit patch bodies as repairable input
	// errors; they must never reach a shell or become an implicit write grant.
	if (/^\s*\*\*\* Begin Patch(?:\s|$)/.test(command)) {
		return {
			kind: "error",
			message:
				"Send patch text to apply_patch using its patch argument. Use the exact control lines '*** Begin Patch' and '*** End Patch'.",
		}
	}
	const lines = command.replace(/\r\n/g, "\n").split("\n")
	if (lines.at(-1) === "") lines.pop()

	const match = HEREDOC_COMMAND.exec(lines[0])
	if (!match) return undefined
	const delimiter = match[5] ?? match[6]
	if (lines.slice(1, -1).includes(delimiter)) return undefined
	if (lines.length < 3 || lines.at(-1) !== delimiter) {
		return { kind: "error", message: `apply_patch heredoc must end with ${delimiter}.` }
	}

	return {
		kind: "patch",
		patch: lines.slice(1, -1).join("\n"),
		...(match[1] || match[2] || match[3] ? { workdir: match[1] ?? match[2] ?? match[3] } : {}),
	}
}

/** The patch handler uses the task root, while exec_command can select a subdirectory. */
export function rebaseApplyPatchPaths(patchText: string, taskRoot: string, commandCwd: string): string {
	if (path.resolve(taskRoot) === path.resolve(commandCwd)) return patchText

	return mapPatchPaths(patchText, (filePath) =>
		path.relative(taskRoot, path.resolve(commandCwd, filePath)).split(path.sep).join("/"),
	)
}
