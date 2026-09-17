import { useCallback, useState } from "react"
import { Trans } from "react-i18next"

import type { ProviderSettings } from "@alpha-code/types"

import { useExtensionState } from "@src/context/ExtensionStateContext"
import { validateApiConfiguration } from "@src/utils/validate"
import { vscode } from "@src/utils/vscode"
import { Button } from "@src/components/ui"

import ApiOptions from "../settings/ApiOptions"
import { Tab, TabContent } from "../common/Tab"

import AlphaHero from "./AlphaHero"
import { ArrowLeft, Brain } from "lucide-react"

const WelcomeViewProvider = () => {
	const { apiConfiguration, currentApiConfigName, setApiConfiguration, uriScheme } = useExtensionState()
	const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)
	const [showProviderSetup, setShowProviderSetup] = useState(false)

	const setApiConfigurationFieldForApiOptions = useCallback(
		<K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K]) => {
			setApiConfiguration({ [field]: value })
		},
		[setApiConfiguration],
	)

	const handleFinish = useCallback(() => {
		const error = apiConfiguration ? validateApiConfiguration(apiConfiguration) : undefined

		if (error) {
			setErrorMessage(error)
			return
		}

		setErrorMessage(undefined)
		vscode.postMessage({ type: "upsertApiConfiguration", text: currentApiConfigName, apiConfiguration })
	}, [apiConfiguration, currentApiConfigName])

	if (!showProviderSetup) {
		return (
			<Tab>
				<TabContent className="relative flex items-center justify-center overflow-y-auto p-6">
					<div className="hero-panel mx-auto flex w-full max-w-[760px] flex-col items-start gap-6 rounded-3xl p-6 min-[440px]:p-8">
						<AlphaHero variant="welcome" />
						<h2 className="brand-title m-0 max-w-full text-[42px] font-black leading-none">
							Welcome to Alpha.
						</h2>

						<div className="max-w-[620px] space-y-4 leading-normal">
							<p className="m-0 text-base text-vscode-foreground/90">
								<Trans i18nKey="welcome:landing.introduction" />
							</p>
						</div>

						<div className="mt-1 flex flex-wrap items-center gap-3">
							<Button onClick={() => setShowProviderSetup(true)} variant="primary" size="lg">
								Set up provider
							</Button>
							<button
								onClick={() => vscode.postMessage({ type: "importSettings" })}
								className="accent-chip h-9 cursor-pointer rounded-lg px-3 text-sm transition-colors hover:bg-[var(--alpha-accent-soft)]">
								Import Settings
							</button>
						</div>
					</div>
				</TabContent>
			</Tab>
		)
	}

	return (
		<Tab>
			<TabContent className="flex items-center justify-center p-6">
				<div className="hero-panel mx-auto flex w-full max-w-[760px] flex-col gap-4 rounded-3xl p-6">
					<div className="flex size-11 items-center justify-center rounded-xl bg-[var(--alpha-accent-soft)] text-[var(--alpha-accent)]">
						<Brain className="size-6" strokeWidth={1.5} />
					</div>
					<h2 className="brand-title my-0 text-2xl">Set up provider</h2>

					<p className="my-0 text-base text-vscode-foreground/90">
						Choose an LLM provider to use with Alpha. You can add more providers later.
					</p>

					<div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-4">
						<div className="max-h-[calc(100vh_-_300px)] overflow-y-auto pr-2">
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

					<div className="flex gap-2">
						<Button onClick={() => setShowProviderSetup(false)} variant="secondary">
							<ArrowLeft className="size-4" />
							Back
						</Button>
						<Button onClick={handleFinish} variant="primary">
							Finish
						</Button>
					</div>
				</div>
			</TabContent>
		</Tab>
	)
}

export default WelcomeViewProvider
