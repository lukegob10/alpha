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
				<TabContent className="relative flex flex-col gap-4 p-6 justify-center overflow-hidden bg-vscode-sideBar-background">
					<div className="mb-6 flex w-full max-w-[720px] flex-col items-start gap-8">
						<AlphaHero variant="welcome" />
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
						<Button onClick={() => setShowProviderSetup(true)} variant="primary">
							Set up provider
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

	return (
		<Tab>
			<TabContent className="flex flex-col gap-4 p-6 justify-center">
				<Brain className="size-8" strokeWidth={1.5} />
				<h2 className="mt-0 mb-0 text-xl">Set up provider</h2>

				<p className="text-base text-vscode-foreground">
					Choose an LLM provider to use with Alpha. You can add more providers later.
				</p>

				<div className="mb-8 border-l-2 border-vscode-panel-border pl-6 ml-[7px]">
					<div className="max-h-[calc(100vh_-_260px)] overflow-y-auto pr-2">
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

				<div className="-mt-4 flex gap-2">
					<Button onClick={() => setShowProviderSetup(false)} variant="secondary">
						<ArrowLeft className="size-4" />
						Back
					</Button>
					<Button onClick={handleFinish} variant="primary">
						Finish
					</Button>
				</div>
			</TabContent>
		</Tab>
	)
}

export default WelcomeViewProvider
