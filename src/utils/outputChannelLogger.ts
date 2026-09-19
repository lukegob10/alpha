import * as vscode from "vscode"

export type LogFunction = (...args: unknown[]) => void

/** VS Code may close diagnostic channels before invoking extension deactivation. */
export function createLifecycleSafeOutputChannel(channel: vscode.OutputChannel): vscode.OutputChannel {
	let closed = false
	const write = (operation: () => void) => {
		if (closed) return
		try {
			operation()
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "Channel has been closed") throw error
			closed = true
		}
	}
	return {
		get name() {
			return channel.name
		},
		append: (value) => write(() => channel.append(value)),
		appendLine: (value) => write(() => channel.appendLine(value)),
		replace: (value) => write(() => channel.replace(value)),
		clear: () => write(() => channel.clear()),
		show: ((columnOrFocus?: vscode.ViewColumn | boolean, preserveFocus?: boolean) => {
			if (typeof columnOrFocus === "number") channel.show(columnOrFocus, preserveFocus)
			else channel.show(columnOrFocus)
		}) as vscode.OutputChannel["show"],
		hide: () => channel.hide(),
		dispose: () => {
			closed = true
			channel.dispose()
		},
	}
}

/**
 * Creates a logging function that writes to a VSCode output channel
 * Based on the outputChannelLog implementation from src/extension/api.ts
 */
export function createOutputChannelLogger(outputChannel: vscode.OutputChannel): LogFunction {
	return (...args: unknown[]) => {
		for (const arg of args) {
			if (arg === null) {
				outputChannel.appendLine("null")
			} else if (arg === undefined) {
				outputChannel.appendLine("undefined")
			} else if (typeof arg === "string") {
				outputChannel.appendLine(arg)
			} else if (arg instanceof Error) {
				outputChannel.appendLine(`Error: ${arg.message}\n${arg.stack || ""}`)
			} else {
				try {
					outputChannel.appendLine(
						JSON.stringify(
							arg,
							(key, value) => {
								if (typeof value === "bigint") return `BigInt(${value})`
								if (typeof value === "function") return `Function: ${value.name || "anonymous"}`
								if (typeof value === "symbol") return value.toString()
								return value
							},
							2,
						),
					)
				} catch (error) {
					outputChannel.appendLine(`[Non-serializable object: ${Object.prototype.toString.call(arg)}]`)
				}
			}
		}
	}
}

/**
 * Creates a logging function that logs to both the output channel and console
 * Following the pattern from src/extension/api.ts
 */
export function createDualLogger(outputChannelLog: LogFunction): LogFunction {
	return (...args: unknown[]) => {
		outputChannelLog(...args)
		console.log(...args)
	}
}
