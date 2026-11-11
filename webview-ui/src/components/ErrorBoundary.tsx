import React, { Component } from "react"
import { reportWebviewError } from "@src/utils/webviewErrors"
import { withTranslation, WithTranslation } from "react-i18next"

type ErrorProps = {
	children: React.ReactNode
} & WithTranslation

type ErrorState = {
	hasError: boolean
	error?: string
	componentStack?: string | null
}

class ErrorBoundary extends Component<ErrorProps, ErrorState> {
	constructor(props: ErrorProps) {
		super(props)
		this.state = { hasError: false }
	}

	static getDerivedStateFromError(error: unknown) {
		let errorMessage = ""

		if (error instanceof Error) {
			errorMessage = error.stack || error.message || error.name
		} else {
			errorMessage = `${error}`
		}

		return {
			hasError: true,
			error: errorMessage,
		}
	}

	componentDidCatch(error: unknown, errorInfo: React.ErrorInfo) {
		reportWebviewError("render", error)
		const componentStack = errorInfo.componentStack || ""
		this.setState({ componentStack })
		void this.enhanceErrorDiagnostics(error, componentStack)
	}

	private async enhanceErrorDiagnostics(error: unknown, componentStack: string) {
		try {
			const errorToEnhance = error instanceof Error ? error : new Error(String(error))
			if (!(error instanceof Error)) errorToEnhance.stack = undefined
			const { enhanceErrorWithSourceMaps } = await import("@src/utils/sourceMapUtils")
			const enhancedError = await enhanceErrorWithSourceMaps(errorToEnhance, componentStack)

			// Diagnostics may be incomplete; they must never clear the captured failure or retry its children.
			this.setState((state) => ({
				error: enhancedError.sourceMappedStack || enhancedError.stack || state.error,
				componentStack: enhancedError.sourceMappedComponentStack || componentStack,
			}))
		} catch {
			console.error("[ErrorBoundary] Failed to enhance render error diagnostics")
		}
	}

	render() {
		const { t } = this.props

		if (!this.state.hasError) {
			return this.props.children
		}

		const errorDisplay = this.state.error
		const componentStackDisplay = this.state.componentStack

		const version = process.env.PKG_VERSION || "unknown"

		return (
			<div>
				<h2 className="text-lg font-bold mt-0 mb-2">
					{t("errorBoundary.title")} (v{version})
				</h2>
				<p className="mb-4">
					{t("errorBoundary.reportText")}{" "}
					<a href="https://github.com/AlphaInc/Alpha/issues" target="_blank" rel="noreferrer">
						{t("errorBoundary.githubText")}
					</a>
				</p>
				<p className="mb-2">{t("errorBoundary.copyInstructions")}</p>

				<div className="mb-4">
					<h3 className="text-md font-bold mb-1">{t("errorBoundary.errorStack")}</h3>
					<pre className="p-2 border rounded text-sm overflow-auto">{errorDisplay}</pre>
				</div>

				{componentStackDisplay && (
					<div>
						<h3 className="text-md font-bold mb-1">{t("errorBoundary.componentStack")}</h3>
						<pre className="p-2 border rounded text-sm overflow-auto">{componentStackDisplay}</pre>
					</div>
				)}
			</div>
		)
	}
}

export default withTranslation("common")(ErrorBoundary)
