import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import { Package } from "../../shared/package"
import { getTaskDirectoryPath } from "../../utils/storage"
import type { settlementDiagnostics } from "../agent/SettlementDiagnostics"
import { collectDiagnosticsEvidence, projectErrorDetails, projectRuntimeDiagnostics } from "./diagnosticsEvidence"

const MAX_REPORT_BYTES = 8 * 1_024 * 1_024

export interface ErrorDiagnosticsValues {
	timestamp?: string
	version?: string
	provider?: string
	model?: string
	details?: string
}

export interface GenerateDiagnosticsParams {
	taskId: string
	globalStoragePath: string
	values?: ErrorDiagnosticsValues
	log: (message: string) => void
	/** Evaluated only for the user-requested report; failures do not discard the original error. */
	getRuntimeDiagnostics?: () => ReturnType<typeof settlementDiagnostics>
	extension?: vscode.Extension<unknown>
}

export interface GenerateDiagnosticsResult {
	success: boolean
	filePath?: string
	error?: string
}

/**
 * Generates an error diagnostics file containing error metadata and bounded,
 * privacy-aware evidence projections. Provider conversation contents are never
 * included; the `history` field remains a shape-only compatibility view.
 * The file is created in the system temp directory and opened in VS Code for the user to review
 * before sharing it with support.
 */
export async function generateErrorDiagnostics(params: GenerateDiagnosticsParams): Promise<GenerateDiagnosticsResult> {
	const { taskId, globalStoragePath, values, log } = params

	try {
		const taskDirPath = await getTaskDirectoryPath(globalStoragePath, taskId)
		const collected = await collectDiagnosticsEvidence(taskDirPath, taskId)
		if (collected.historyParseFailed) {
			vscode.window.showErrorMessage("Failed to parse api_conversation_history.json")
		}

		let runtime: unknown
		try {
			runtime = projectRuntimeDiagnostics(params.getRuntimeDiagnostics?.())
		} catch {
			runtime = { unavailable: true }
		}

		const diagnostics = {
			schemaVersion: 2,
			runtime,
			installation: {
				vscodeVersion: vscode.version,
				runtimeVersion: Package.version,
				runtimeCommit: Package.sha,
				extensionId: params.extension?.id,
				manifestVersion: params.extension?.packageJSON?.version,
				extensionDirectory: params.extension ? path.basename(params.extension.extensionPath) : undefined,
				extensionActive: params.extension?.isActive,
			},
			error: {
				timestamp: values?.timestamp ?? new Date().toISOString(),
				version: values?.version ?? "",
				provider: values?.provider ?? "",
				model: values?.model ?? "",
				details: projectErrorDetails(values?.details),
			},
			history: collected.history,
			evidence: collected.evidence,
		}

		// Prepend human-readable guidance comments before the JSON payload. The
		// compatibility `history` field contains role/tool shape only; prompts,
		// arguments, outputs, and provider payloads are intentionally omitted.
		const headerComment =
			"// Please review this bounded report before sharing it with Alpha Support (support@alpha.invalid).\n" +
			"// Provider prompts, tool arguments, outputs, and raw conversation history are omitted by default.\n\n"
		const fullContent = headerComment + JSON.stringify(diagnostics, null, 2)
		if (Buffer.byteLength(fullContent, "utf8") > MAX_REPORT_BYTES) {
			throw new Error("Diagnostics report exceeds the bounded report limit")
		}

		const tempFileName = `alpha-diagnostics-${taskId.slice(0, 8)}-${Date.now()}.json`
		const tempFilePath = path.join(os.tmpdir(), tempFileName)
		await fs.writeFile(tempFilePath, fullContent, { encoding: "utf8", mode: 0o600, flag: "wx" })

		const doc = await vscode.workspace.openTextDocument(tempFilePath)
		await vscode.window.showTextDocument(doc, { preview: true })

		return { success: true, filePath: tempFilePath }
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		log(`Error generating diagnostics: ${errorMessage}`)
		vscode.window.showErrorMessage(`Failed to generate diagnostics: ${errorMessage}`)
		return { success: false, error: errorMessage }
	}
}
