import { useRef, useState } from "react"
import { DEFAULT_MEMORY_SETTINGS, type MemorySettings as MemorySettingsConfig } from "@alpha-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	Button,
	Checkbox,
} from "@/components/ui"

import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"
import { SearchableSetting } from "./SearchableSetting"
import { SettingsHelp } from "./SettingsHelp"
import type { SectionName } from "./SettingsView"

type MemorySettingsProps = {
	embedded?: boolean
	unframed?: boolean
	section?: SectionName
	memorySettings?: MemorySettingsConfig
	onChange: (settings: MemorySettingsConfig) => void
}

const booleanSettings = ["enabled", "useMemories", "generateMemories"] as const

export function MemorySettings({
	embedded = false,
	unframed = false,
	section = "preferences",
	memorySettings,
	onChange,
}: MemorySettingsProps) {
	const { t } = useAppTranslation()
	const settings = memorySettings ?? DEFAULT_MEMORY_SETTINGS
	const [confirmReset, setConfirmReset] = useState(false)
	const resetButtonRef = useRef<HTMLButtonElement>(null)
	const Frame = unframed ? "div" : Section

	return (
		<div className="flex flex-col gap-2">
			{!embedded && <SectionHeader>{t("settings:memory.title")}</SectionHeader>}
			<Frame className={unframed ? "flex flex-col gap-4" : undefined}>
				{embedded && !unframed && (
					<h4 className="m-0 font-semibold text-vscode-foreground">{t("settings:memory.title")}</h4>
				)}
				<p id="memory-cost-notice" className="m-0 text-sm text-vscode-descriptionForeground">
					{t("settings:memory.costNotice")}
				</p>
				{booleanSettings.map((key) => (
					<SearchableSetting
						key={key}
						settingId={`memory-${key}`}
						section={section}
						label={t(`settings:memory.${key}.label`)}>
						<div className="flex items-center gap-2">
							<Checkbox
								id={`memory-${key}`}
								checked={settings[key]}
								disabled={key !== "enabled" && !settings.enabled}
								aria-describedby={key === "enabled" ? "memory-cost-notice" : undefined}
								onCheckedChange={(checked) => onChange({ ...settings, [key]: checked === true })}
							/>
							<label htmlFor={`memory-${key}`} className="font-medium">
								{t(`settings:memory.${key}.label`)}
							</label>
							<SettingsHelp label={t(`settings:memory.${key}.label`)}>
								<p>{t(`settings:memory.${key}.description`)}</p>
								{key === "enabled" && <p>{t("settings:memory.description")}</p>}
							</SettingsHelp>
						</div>
					</SearchableSetting>
				))}

				<div className="flex flex-wrap gap-2">
					<Button variant="secondary" onClick={() => vscode.postMessage({ type: "memoryOpenFolder" })}>
						{t("settings:memory.openFolder")}
					</Button>
					<Button ref={resetButtonRef} variant="secondary" onClick={() => setConfirmReset(true)}>
						{t("settings:memory.reset")}
					</Button>
				</div>
			</Frame>

			<AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
				<AlertDialogContent
					className="settings-confirmation-dialog"
					onCloseAutoFocus={(event) => {
						event.preventDefault()
						resetButtonRef.current?.focus()
					}}>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("settings:memory.resetTitle")}</AlertDialogTitle>
						<AlertDialogDescription>{t("settings:memory.resetDescription")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("settings:memory.cancel")}</AlertDialogCancel>
						<AlertDialogAction onClick={() => vscode.postMessage({ type: "memoryReset" })}>
							{t("settings:memory.confirmReset")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
