import type { PersistentCommandPrefixAmendment } from "@alpha-code/types"

import { analyzeShellCommands, containsDynamicExecutable } from "./shellCommand"
import { isUnsafePersistentCommandPrefix } from "./indirectCommandExecution"
import { parseCommand } from "../../shared/parse-command"

const STATIC_COMMAND_PATTERN = /^[A-Za-z0-9_./\\:=,+-]+(?:[ \t]+[A-Za-z0-9_./\\:=,+-]+)*$/

/** Return a persistent prefix only when the reviewed command has a static, single-command form. */
export function createPersistentCommandPrefixAmendment(
	command: string | undefined,
): PersistentCommandPrefixAmendment | undefined {
	if (!command || command.length > 4096 || command.trim() !== command || !STATIC_COMMAND_PATTERN.test(command)) {
		return undefined
	}

	const firstToken = command.split(/[ \t]+/, 1)[0]
	if (!firstToken || /^[A-Za-z_][A-Za-z0-9_]*=/.test(firstToken)) return undefined

	const shellAnalysis = analyzeShellCommands(command)
	if (shellAnalysis.malformedSubstitution || shellAnalysis.commands.length || containsDynamicExecutable(command)) {
		return undefined
	}
	if (parseCommand(command).length !== 1) return undefined
	if (isUnsafePersistentCommandPrefix(command)) return undefined

	return { kind: "command_prefix", prefix: command }
}
