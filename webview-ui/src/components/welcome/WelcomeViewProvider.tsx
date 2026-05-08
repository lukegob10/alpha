import { useCallback, useEffect, useRef, useState } from "react"
import {
	VSCodeProgressRing,
	VSCodeRadio,
	VSCodeRadioGroup,
	VSCodeTextField,
} from "@vscode/webview-ui-toolkit/react"

import type { ProviderSettings } from "@roo-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { validateApiConfiguration } from "@src/utils/validate"
import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button } from "@src/components/ui"

import ApiOptions from "../settings/ApiOptions"
import { Tab, TabContent } from "../common/Tab"

import RooHero from "./RooHero"
import { Trans } from "react-i18next"
import { ArrowLeft, ArrowRight, BadgeInfo, Brain, TriangleAlert } from "lucide-react"
import { buildDocLink } from "@/utils/docLinks"

type ProviderOption = "roo" | "custom"
type AuthOrigin = "landing" | "providerSelection"

const WelcomeViewProvider = () => {
	const {
		apiConfiguration,
		currentApiConfigName,
		setApiConfiguration,
		uriScheme,
		cloudIsAuthenticated,
		cloudAuthSkipModel,
	} = useExtensionState()
	const { t } = useAppTranslation()
	const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)
	const [selectedProvider, setSelectedProvider] = useState<ProviderOption | null>(null)
	const [authInProgress, setAuthInProgress] = useState(false)
	const [authOrigin, setAuthOrigin] = useState<AuthOrigin | null>(null)
	const [showManualEntry, setShowManualEntry] = useState(false)
	const [manualUrl, setManualUrl] = useState("")
	const [manualErrorMessage, setManualErrorMessage] = useState<boolean | undefined>(undefined)
	const manualUrlInputRef = useRef<HTMLInputElement | null>(null)

	// When auth completes during the provider signup flow, either:
	// 1. If user skipped model selection (cloudAuthSkipModel=true), navigate to provider selection with "custom" selected
	// 2. Otherwise, save the Alpha config and navigate to chat
	useEffect(() => {
		if (cloudIsAuthenticated && authInProgress) {
			if (cloudAuthSkipModel) {
				// User skipped model selection during signup - navigate to provider selection with 3rd-party selected
				setSelectedProvider("custom")
				setAuthInProgress(false)
				setShowManualEntry(false)
				// Clear the flag so it doesn't affect future flows
				vscode.postMessage({ type: "clearCloudAuthSkipModel" })
			} else {
				// Auth completed from provider signup flow - save the config now
				const rooConfig: ProviderSettings = {
					apiProvider: "roo",
				}
				vscode.postMessage({
					type: "upsertApiConfiguration",
					text: currentApiConfigName,
					apiConfiguration: rooConfig,
				})
				setAuthInProgress(false)
				setShowManualEntry(false)
			}
		}
	}, [cloudIsAuthenticated, authInProgress, currentApiConfigName, cloudAuthSkipModel])

	// Focus the manual URL input when it becomes visible
	useEffect(() => {
		if (showManualEntry && manualUrlInputRef.current) {
			setTimeout(() => {
				manualUrlInputRef.current?.focus()
			}, 50)
		}
	}, [showManualEntry])

	// Memoize the setApiConfigurationField function to pass to ApiOptions
	const setApiConfigurationFieldForApiOptions = useCallback(
		<K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K]) => {
			setApiConfiguration({ [field]: value })
		},
		[setApiConfiguration], // setApiConfiguration from context is stable
	)

	const handleGetStarted = useCallback(() => {
		// Landing screen - always trigger auth with Alpha
		if (selectedProvider === null) {
			setAuthOrigin("landing")
			vscode.postMessage({ type: "rooCloudSignIn", useProviderSignup: true })
			setAuthInProgress(true)
		}
		// Provider Selection screen
		else if (selectedProvider === "roo") {
			if (cloudIsAuthenticated) {
				// Already authenticated - save config and finish
				const rooConfig: ProviderSettings = {
					apiProvider: "roo",
				}
				vscode.postMessage({
					type: "upsertApiConfiguration",
					text: currentApiConfigName,
					apiConfiguration: rooConfig,
				})
			} else {
				// Need to authenticate
				setAuthOrigin("providerSelection")
				vscode.postMessage({ type: "rooCloudSignIn", useProviderSignup: true })
				setAuthInProgress(true)
			}
		} else {
			// Custom provider - validate first
			const error = apiConfiguration ? validateApiConfiguration(apiConfiguration) : undefined

			if (error) {
				setErrorMessage(error)
				return
			}

			setErrorMessage(undefined)
			vscode.postMessage({ type: "upsertApiConfiguration", text: currentApiConfigName, apiConfiguration })
		}
	}, [selectedProvider, cloudIsAuthenticated, apiConfiguration, currentApiConfigName])

	const handleChooseProvider = useCallback(() => {
		setSelectedProvider("custom")
	}, [])

	const handleBackToLanding = useCallback(() => {
		// Return to the landing screen
		setSelectedProvider(null)
		setErrorMessage(undefined)
	}, [])

	const handleGoBack = useCallback(() => {
		setAuthInProgress(false)
		setShowManualEntry(false)
		setManualUrl("")
		setManualErrorMessage(false)

		// Return to the appropriate screen based on origin
		if (authOrigin === "providerSelection") {
			// Keep selectedProvider as-is, user returns to Provider Selection
		} else {
			// Return to Landing
			setSelectedProvider(null)
		}
		setAuthOrigin(null)
	}, [authOrigin])

	const handleManualUrlChange = (e: any) => {
		const url = e.target.value
		setManualUrl(url)

		// Auto-trigger authentication when a complete URL is pasted
		setTimeout(() => {
			if (url.trim() && url.includes("://") && url.includes("/auth/clerk/callback")) {
				setManualErrorMessage(false)
				vscode.postMessage({ type: "rooCloudManualUrl", text: url.trim() })
			}
		}, 100)
	}

	const handleSubmit = useCallback(() => {
		const url = manualUrl.trim()
		if (url && url.includes("://") && url.includes("/auth/clerk/callback")) {
			setManualErrorMessage(false)
			vscode.postMessage({ type: "rooCloudManualUrl", text: url })
		} else {
			setManualErrorMessage(true)
		}
	}, [manualUrl])

	const handleOpenSignupUrl = () => {
		vscode.postMessage({ type: "rooCloudSignIn", useProviderSignup: false })
	}

	// Render the waiting for cloud state
	if (authInProgress) {
		return (
			<Tab>
				<TabContent className="flex flex-col gap-4 p-6 justify-center">
					<div className="flex flex-col items-start gap-4 pt-8">
						<VSCodeProgressRing className="size-6" />
						<h2 className="my-0 text-xl font-semibold">{t("welcome:waitingForCloud.heading")}</h2>
						<p className="text-vscode-descriptionForeground mt-0">
							{t("welcome:waitingForCloud.description")}
						</p>

						<div className="flex gap-2 items-start pr-4 text-vscode-descriptionForeground">
							<BadgeInfo className="size-4 inline shrink-0" />
							<p className="m-0">
								<Trans
									i18nKey="welcome:waitingForCloud.noPrompt"
									components={{
										clickHere: (
											<button
												onClick={handleOpenSignupUrl}
												className="text-vscode-textLink-foreground hover:text-vscode-textLink-activeForeground underline cursor-pointer bg-transparent border-none p-0"
											/>
										),
									}}
								/>
							</p>
						</div>

						<div className="flex gap-2 items-start pr-4 text-vscode-descriptionForeground">
							<TriangleAlert className="size-4 inline shrink-0" />
							<div>
								{!showManualEntry ? (
									<p className="m-0">
										<Trans
											i18nKey="welcome:waitingForCloud.havingTrouble"
											components={{
												clickHere: (
													<button
														onClick={() => setShowManualEntry(true)}
														className="text-vscode-textLink-foreground hover:text-vscode-textLink-activeForeground underline cursor-pointer bg-transparent border-none p-0	"
													/>
												),
											}}
										/>
									</p>
								) : (
									<div className="w-full max-w-sm">
										<p className="text-vscode-descriptionForeground mt-0">
											{t("welcome:waitingForCloud.pasteUrl")}
										</p>
										<div className="flex gap-2 items-center">
											<VSCodeTextField
												ref={manualUrlInputRef as any}
												value={manualUrl}
												onKeyUp={handleManualUrlChange}
												placeholder="vscode://Alpha.alpha/auth/clerk/callback?state=..."
												className="flex-1"
											/>
											<Button
												onClick={handleSubmit}
												disabled={manualUrl.length < 40}
												variant="secondary">
												<ArrowRight className="size-4" />
											</Button>
										</div>
										<p className="mt-2">
											<Trans
												i18nKey="welcome:waitingForCloud.docsLink"
												components={{
													DocsLink: (
														<a
															href={buildDocLink("roo-code-cloud/login", "setup")}
															target="_blank"
															rel="noopener noreferrer"
															className="text-vscode-textLink-foreground hover:underline">
															{t("common:docsLink.label")}
														</a>
													),
												}}
											/>
										</p>
										{manualUrl && manualErrorMessage && (
											<p className="text-vscode-errorForeground mt-2">
												{t("welcome:waitingForCloud.invalidURL")}
											</p>
										)}
									</div>
								)}
							</div>
						</div>
					</div>

					<div className="mt-4">
						<Button onClick={handleGoBack} variant="secondary">
							<ArrowLeft className="size-4" />
							{t("welcome:waitingForCloud.goBack")}
						</Button>
					</div>
				</TabContent>
			</Tab>
		)
	}

		// Landing screen - shown when selectedProvider === null
		if (selectedProvider === null) {
			return (
				<Tab>
					<TabContent className="relative flex flex-col gap-4 p-6 justify-center overflow-hidden bg-vscode-sideBar-background">
						<div className="mb-6 flex w-full max-w-[720px] flex-col items-start gap-8">
							<RooHero variant="welcome" />
							<h2 className="m-0 w-fit max-w-full bg-[#4b00ff] px-5 py-3 text-[42px] font-black leading-none tracking-normal text-white shadow-[0_0_36px_rgba(75,0,255,0.34)]">
								Welcome to Alpha.
							</h2>
						</div>

						<div className="space-y-4 leading-normal">
							<p className="text-base text-vscode-foreground">
								<Trans i18nKey="welcome:landing.introduction" />
							</p>
						</div>

						<div className="mt-2 flex gap-2 items-center">
							<Button onClick={handleChooseProvider} variant="primary">
								Set up local provider
							</Button>
						</div>

					<div className="absolute bottom-6 left-6">
						<button
								onClick={() => vscode.postMessage({ type: "importSettings" })}
								className="cursor-pointer bg-transparent border-none p-0 text-vscode-foreground hover:underline">
								Import Settings
							</button>
						</div>
				</TabContent>
			</Tab>
		)
	}

	// Provider Selection screen - shown when selectedProvider is "roo" or "custom"
	return (
		<Tab>
				<TabContent className="flex flex-col gap-4 p-6 justify-center">
					<Brain className="size-8" strokeWidth={1.5} />
					<h2 className="mt-0 mb-0 text-xl">Set up local provider</h2>

					<p className="text-base text-vscode-foreground">
						Choose an LLM provider to use with Alpha. You can add more providers later.
					</p>

				<div>
					<VSCodeRadioGroup
						value={selectedProvider}
						onChange={(e: Event | React.FormEvent<HTMLElement>) => {
							const target = ((e as CustomEvent)?.detail?.target ||
								(e.target as HTMLInputElement)) as HTMLInputElement
							setSelectedProvider(target.value as ProviderOption)
						}}>
							<VSCodeRadio value="custom" className="flex items-start gap-2">
								<div className="flex-1 space-y-1 cursor-pointer">
									<p className="text-lg font-semibold block -mt-1">
										3rd-party Provider
									</p>
									<p className="text-base text-vscode-descriptionForeground mt-0">
										Enter an API key and get going.
									</p>
								</div>
						</VSCodeRadio>
					</VSCodeRadioGroup>

					{/* Expand API options only when custom provider is selected, max height is used to force a transition */}
					<div className="mb-8 border-l-2 border-vscode-panel-border pl-6 ml-[7px]">
						<div
							className={`transition-[max-height] ease-in-out duration-300 ${selectedProvider === "custom" ? "max-h-[calc(100vh_-_260px)] overflow-y-auto pr-2" : "max-h-0 overflow-clip"}`}>
							<ApiOptions
								fromWelcomeView
								apiConfiguration={apiConfiguration || {}}
								uriScheme={uriScheme}
								setApiConfigurationField={setApiConfigurationFieldForApiOptions}
								errorMessage={errorMessage}
								setErrorMessage={setErrorMessage}
							/>
						</div>
					</div>
				</div>

				<div className="-mt-4 flex gap-2">
						<Button onClick={handleBackToLanding} variant="secondary">
							<ArrowLeft className="size-4" />
							Back
						</Button>
						<Button onClick={handleGetStarted} variant="primary">
							Finish →
						</Button>
				</div>
			</TabContent>
		</Tab>
	)
}

export default WelcomeViewProvider
