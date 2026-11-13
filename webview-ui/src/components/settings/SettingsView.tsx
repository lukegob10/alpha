import {
	type KeyboardEvent,
	forwardRef,
	memo,
	useCallback,
	useEffect,
	useImperativeHandle,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react"
import { AlertTriangle, Info, Glasses, Plug, Settings2, ArrowLeft, Bot } from "lucide-react"

import {
	type GlobalSettings,
	type ProviderSettings,
	type ExperimentId,
	type ProviderProfileRenameRequest,
	type ProviderProfileRenameResult,
	providerProfileRenameResultSchema,
	providerProfileSaveResultSchema,
	settingsSaveResultSchema,
	memorySettingsSchema,
} from "@alpha-code/types"
import deepEqual from "fast-deep-equal"
import { EXPERIMENT_IDS } from "@alpha/experiments"

import { vscode } from "@src/utils/vscode"
import { cn } from "@src/lib/utils"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogTitle,
	AlertDialogDescription,
	AlertDialogCancel,
	AlertDialogAction,
	AlertDialogHeader,
	AlertDialogFooter,
	Button,
	StandardTooltip,
} from "@src/components/ui"

import { Tab, TabContent, TabHeader, TabTrigger } from "../common/Tab"
import { SetExperimentEnabled } from "./types"
import ApiConfigManager from "./ApiConfigManager"
import ApiOptions from "./ApiOptions"
import { getManagedAgentSettingsError } from "./agents-settings-validation"
import { Section } from "./Section"
import { ToolsAgentsSettings } from "./ToolsAgentsSettings"
import { PreferencesSettings } from "./PreferencesSettings"
import { AdvancedSettings } from "./AdvancedSettings"
import { SettingsSearch } from "./SettingsSearch"
import { SettingsHelp } from "./SettingsHelp"
import { SectionHeader } from "./SectionHeader"
import { useSearchIndexRegistry, SearchIndexProvider } from "./useSettingsSearch"
import { type SettingsCachedState } from "./managed-agent-settings"
import {
	settingsSectionNames,
	getSettingsSectionTarget,
	revealSettingDetails,
	lazyToolsSearchSettings,
	type SectionName,
} from "./settingsNavigation"
import {
	acknowledgeSettingsSave,
	applyAcknowledgedSettings,
	createSettingsPatch,
	createSettingsSaveProgress,
	getEditableSettingsState,
	getSettingsSavePayload,
	getSettingsSaveStatus,
	type SettingsSaveProgress,
} from "./settingsSave"

export interface SettingsViewRef {
	checkUnsaveChanges: (then: () => void) => void
}

export const sectionNames = settingsSectionNames
export type { SectionName } from "./settingsNavigation"

type SettingsViewProps = {
	onDone: () => void
	targetSection?: string
}

type ConfirmedProfileRename = Pick<
	Extract<ProviderProfileRenameResult, { status: "success" }>,
	"id" | "oldName" | "newName"
> & { requestedName?: string }

const profileSaveTimeoutMs = 30_000
const profileRenameTimeoutMs = 30_000

type ProfileSelectionState = Pick<
	SettingsCachedState,
	"currentApiConfigName" | "listApiConfigMeta" | "settingsProviderProfile"
>

function getPairedSettingsProfile(state: ProfileSelectionState) {
	const snapshot = state.settingsProviderProfile
	// Task-only projections can change selection before the next full saved-profile snapshot arrives.
	return snapshot && snapshot.name !== state.currentApiConfigName ? null : snapshot
}

function getCurrentProfileId(state: ProfileSelectionState, rename?: ConfirmedProfileRename): string | undefined {
	const snapshot = getPairedSettingsProfile(state)
	if (snapshot) return snapshot.id
	const profile = state.listApiConfigMeta?.find(({ name }) => name === state.currentApiConfigName)
	if (profile) return profile.id

	// A name projection and its metadata can arrive on either side of the rename acknowledgement.
	if (
		rename &&
		(state.currentApiConfigName === rename.oldName ||
			state.currentApiConfigName === rename.newName ||
			(rename.requestedName !== undefined && state.currentApiConfigName === rename.requestedName)) &&
		state.listApiConfigMeta?.some(({ id }) => id === rename.id)
	) {
		return rename.id
	}
	return undefined
}

function captureProfileIdentity(state: ProfileSelectionState, requiresId = false) {
	const id = getCurrentProfileId(state)
	const snapshot = getPairedSettingsProfile(state)
	const version =
		snapshot?.version ??
		(snapshot === undefined ? state.listApiConfigMeta?.find((profile) => profile.id === id)?.version : undefined)
	return {
		id,
		name: state.currentApiConfigName,
		version,
		requiresId: requiresId || id !== undefined,
		snapshotUnavailable: snapshot === null && (id !== undefined || state.settingsProviderProfile !== null),
	}
}

function getSettingsEditState(state: Parameters<typeof getEditableSettingsState>[0]) {
	return getEditableSettingsState({
		...state,
		apiConfiguration: getPairedSettingsProfile(state)?.configuration ?? state.apiConfiguration,
	})
}

const SettingsView = forwardRef<SettingsViewRef, SettingsViewProps>(({ onDone, targetSection }, ref) => {
	const { t } = useAppTranslation()
	const settingsId = useId()

	const extensionState = useExtensionState()
	const { currentApiConfigName, listApiConfigMeta, uriScheme, settingsImportedAt, didHydrateState } = extensionState

	const [isDiscardDialogShow, setDiscardDialogShow] = useState(false)
	const [isChangeDetected, setChangeDetected] = useState(false)
	const [isProfileRenaming, setProfileRenaming] = useState(false)
	const [confirmedProfileRename, setConfirmedProfileRename] = useState<ConfirmedProfileRename>()
	// Save follows the profile that supplied the edit buffer, even if another view renames it.
	const [cachedApiConfigIdentity, setCachedApiConfigIdentity] = useState(() => captureProfileIdentity(extensionState))
	const [isProfileSaving, setProfileSaving] = useState(false)
	const [profileSaveError, setProfileSaveError] = useState<string>()
	const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined)
	const contentRef = useRef<HTMLDivElement | null>(null)
	const [activeSection, setActiveSection] = useState<SectionName>(
		getSettingsSectionTarget(targetSection)?.section ?? "providers",
	)
	const activeSectionRef = useRef(activeSection)
	const scrollPositions = useRef<Partial<Record<SectionName, number>>>({})
	const tabRefs = useRef<Partial<Record<SectionName, HTMLButtonElement | null>>>({})

	const prevApiConfigName = useRef(currentApiConfigName)
	const pendingProfileRename = useRef<
		ProviderProfileRenameRequest & {
			oldName: string
			resolve: (error?: string) => void
			timeout: ReturnType<typeof setTimeout>
		}
	>()
	const pendingProfileSave = useRef<{
		requestId: string
		id?: string
		generation: SettingsCachedState
		patch: ReturnType<typeof createSettingsPatch>
		debugChanged: boolean
		progress: SettingsSaveProgress
		timeout: ReturnType<typeof setTimeout>
	}>()
	const prevSettingsImportedAt = useRef(settingsImportedAt)
	const initializedFromHydration = useRef(didHydrateState)
	const latestExtensionState = useRef(extensionState)
	latestExtensionState.current = extensionState
	const requestedSettingsState = useRef(false)
	const pendingSettingsRefresh = useRef<{ snapshot: typeof extensionState.settingsProviderProfile }>()
	const requestSettingsRefresh = useCallback(() => {
		pendingSettingsRefresh.current = { snapshot: latestExtensionState.current.settingsProviderProfile }
		vscode.postMessage({ type: "requestState" })
	}, [])
	useEffect(() => {
		if (requestedSettingsState.current) return
		requestedSettingsState.current = true
		requestSettingsRefresh()
	}, [requestSettingsRefresh])
	const confirmDialogHandler = useRef<() => void>()
	const discardDialogOpenerRef = useRef<HTMLElement | null>(null)
	const [cachedState, setCachedState] = useState<SettingsCachedState>(() => getSettingsEditState(extensionState))
	const savedState = useRef(cachedState)
	const savedProjection = useRef(extensionState)
	const latestCommittedApiConfigId = useRef(cachedApiConfigIdentity.id)
	useLayoutEffect(() => {
		latestCommittedApiConfigId.current = cachedApiConfigIdentity.id
	}, [cachedApiConfigIdentity.id])

	const { memorySettings } = cachedState

	const apiConfiguration = useMemo(() => cachedState.apiConfiguration ?? {}, [cachedState.apiConfiguration])
	const [mountedGroups, setMountedGroups] = useState(() => ({
		providers: activeSection === "providers",
		tools: activeSection === "tools",
	}))
	const currentApiConfigId = getCurrentProfileId(
		extensionState,
		pendingProfileRename.current ?? confirmedProfileRename,
	)
	const effectiveApiConfigName =
		confirmedProfileRename &&
		confirmedProfileRename.id === currentApiConfigId &&
		(currentApiConfigName === confirmedProfileRename.oldName ||
			currentApiConfigName === confirmedProfileRename.newName ||
			(confirmedProfileRename.requestedName !== undefined &&
				currentApiConfigName === confirmedProfileRename.requestedName))
			? confirmedProfileRename.newName
			: currentApiConfigName
	const effectiveApiConfigMeta = useMemo(
		() =>
			listApiConfigMeta?.map((profile) =>
				profile.id === currentApiConfigId && effectiveApiConfigName
					? { ...profile, name: effectiveApiConfigName }
					: profile,
			),
		[listApiConfigMeta, currentApiConfigId, effectiveApiConfigName],
	)
	const isProfileNameAwaitingRefresh = Boolean(
		confirmedProfileRename &&
			confirmedProfileRename.id === currentApiConfigId &&
			(currentApiConfigName !== effectiveApiConfigName ||
				listApiConfigMeta?.find(({ id }) => id === currentApiConfigId)?.name !== effectiveApiConfigName),
	)
	const areProfileActionsDisabled = isProfileRenaming || isProfileSaving || isProfileNameAwaitingRefresh
	const isProfileIdentityPending =
		(cachedApiConfigIdentity.requiresId && cachedApiConfigIdentity.id === undefined) ||
		cachedApiConfigIdentity.snapshotUnavailable
	const profileIdentityPendingMessage = t(
		cachedApiConfigIdentity.snapshotUnavailable
			? "settings:providers.profileSnapshotUnavailable"
			: "settings:providers.profileIdentityPending",
	)

	const cancelPendingProfileRename = useCallback((error: string) => {
		const pending = pendingProfileRename.current
		clearTimeout(pending?.timeout)
		pendingProfileRename.current = undefined
		setProfileRenaming(false)
		pending?.resolve(error)
	}, [])
	const cancelPendingProfileSave = useCallback(() => {
		clearTimeout(pendingProfileSave.current?.timeout)
		pendingProfileSave.current = undefined
		setProfileSaving(false)
		setProfileSaveError(undefined)
	}, [])

	useEffect(() => {
		const receive = (event: MessageEvent) => {
			const pending = pendingProfileSave.current
			if (!pending) return
			let progress = pending.progress
			if (event.data?.type === "settingsSaved") {
				const response = settingsSaveResultSchema.safeParse(event.data.settingsSaveResult)
				if (!response.success) return
				progress = acknowledgeSettingsSave(progress, { part: "settings", result: response.data })
				if (progress !== pending.progress) {
					const appliedKeys =
						response.data.status === "success"
							? (Object.keys(pending.patch.updatedSettings) as Array<keyof GlobalSettings>)
							: (response.data.appliedKeys ?? [])
					const savedKeys = appliedKeys.filter((key) => Object.hasOwn(pending.patch.updatedSettings, key))
					const debugApplied =
						pending.debugChanged && (response.data.status === "success" || response.data.debugApplied)
					const acknowledged = Object.fromEntries(
						savedKeys.map((key) => [key, Reflect.get(pending.generation, key)]),
					)
					savedState.current = applyAcknowledgedSettings(savedState.current, acknowledged, savedKeys)
					savedProjection.current = applyAcknowledgedSettings(
						savedProjection.current,
						pending.patch.updatedSettings,
						savedKeys,
					)
					if (debugApplied) {
						savedState.current = { ...savedState.current, debug: pending.generation.debug }
						savedProjection.current = { ...savedProjection.current, debug: pending.generation.debug }
					}
				}
			} else if (event.data?.type === "apiConfigurationSaved") {
				const response = providerProfileSaveResultSchema.safeParse(event.data.apiConfigurationSaveResult)
				if (
					!response.success ||
					(pending.id !== undefined && latestCommittedApiConfigId.current !== pending.id)
				)
					return
				const receipt =
					response.data.status === "success"
						? response.data
						: response.data.error === "applyFailed"
							? response.data.saved
							: undefined
				if (receipt && pending.id !== undefined && receipt.id !== pending.id) return
				progress = acknowledgeSettingsSave(progress, { part: "profile", result: response.data })
				if (progress !== pending.progress && response.data.status === "success") {
					savedState.current = {
						...savedState.current,
						apiConfiguration: pending.generation.apiConfiguration,
					}
				}
				// An apply failure still committed this base; keep the draft dirty and retry by that identity.
				if (progress !== pending.progress && receipt?.version !== undefined) {
					setCachedApiConfigIdentity((identity) =>
						identity.id === receipt.id || pending.id === undefined
							? {
									...identity,
									id: receipt.id,
									version: receipt.version,
									requiresId: true,
									snapshotUnavailable: false,
								}
							: identity,
					)
				}
			} else return
			if (progress === pending.progress) return
			pending.progress = progress
			if (progress.failure) {
				const failure = progress.failure
				setProfileSaveError(
					t(
						failure.part === "settings"
							? `settings:common.saveErrors.${failure.result.error}`
							: `settings:providers.saveErrors.${failure.result.error}`,
					),
				)
			}
			if (progress.settingsPending || progress.profilePending) return
			clearTimeout(pending.timeout)
			pendingProfileSave.current = undefined
			setProfileSaving(false)
			if (getSettingsSaveStatus(progress) !== "success") return
			setProfileSaveError(undefined)
			// Compare in the state queue so edits queued before this response also retain dirty state.
			setCachedState((state) => {
				if (state === pending.generation) setChangeDetected(false)
				return state
			})
		}
		window.addEventListener("message", receive)
		return () => window.removeEventListener("message", receive)
	}, [t])

	useEffect(() => {
		const receive = (event: MessageEvent) => {
			if (event.data?.type !== "apiConfigurationRenamed") return
			const response = providerProfileRenameResultSchema.safeParse(event.data.apiConfigurationRenameResult)
			const pending = pendingProfileRename.current
			if (!response.success || !pending || response.data.requestId !== pending.requestId) return

			clearTimeout(pending.timeout)
			pendingProfileRename.current = undefined
			setProfileRenaming(false)
			if (response.data.status === "error") {
				if (response.data.profile?.id === pending.id) {
					const confirmed = {
						id: pending.id,
						oldName: pending.oldName,
						newName: response.data.profile.name,
						requestedName: pending.newName,
					}
					if (getCurrentProfileId(latestExtensionState.current, confirmed) === pending.id) {
						setConfirmedProfileRename(confirmed)
					}
				}
				pending.resolve(t(`settings:providers.renameErrors.${response.data.error}`))
				return
			}
			if (response.data.id !== pending.id) {
				pending.resolve(t("settings:providers.renameErrors.invalid"))
				return
			}
			if (
				getCurrentProfileId(latestExtensionState.current, {
					id: pending.id,
					oldName: pending.oldName,
					newName: response.data.newName,
					requestedName: pending.newName,
				}) !== pending.id
			) {
				pending.resolve(t("settings:providers.renameErrors.cancelled"))
				return
			}
			setConfirmedProfileRename({
				id: pending.id,
				oldName: pending.oldName,
				newName: response.data.newName,
				requestedName: pending.newName,
			})
			pending.resolve()
		}
		window.addEventListener("message", receive)
		return () => window.removeEventListener("message", receive)
	}, [t])

	useEffect(
		() => () => {
			clearTimeout(pendingProfileRename.current?.timeout)
			pendingProfileRename.current?.resolve()
			pendingProfileRename.current = undefined
			clearTimeout(pendingProfileSave.current?.timeout)
			pendingProfileSave.current = undefined
		},
		[],
	)

	const renameApiConfiguration = (oldName: string, newName: string): Promise<string | undefined> => {
		const id = getCurrentProfileId(latestExtensionState.current, confirmedProfileRename)
		if (!id) return Promise.resolve(t("settings:providers.renameErrors.notFound"))
		if (pendingProfileSave.current) return Promise.resolve(t("settings:providers.profileSavePending"))
		if (isProfileNameAwaitingRefresh) return Promise.resolve(t("settings:providers.profileRefreshPending"))
		if (pendingProfileRename.current) return Promise.resolve(t("settings:providers.renameErrors.pending"))

		const request: ProviderProfileRenameRequest = { requestId: crypto.randomUUID(), id, newName }
		setProfileRenaming(true)
		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				if (pendingProfileRename.current?.requestId !== request.requestId) return
				cancelPendingProfileRename(t("settings:providers.renameErrors.timeout"))
			}, profileRenameTimeoutMs)
			pendingProfileRename.current = {
				...request,
				oldName: latestExtensionState.current.currentApiConfigName ?? oldName,
				resolve,
				timeout,
			}
			try {
				vscode.postMessage({ type: "renameApiConfiguration", apiConfigurationRename: request })
			} catch {
				cancelPendingProfileRename(t("settings:providers.renameErrors.saveFailed"))
			}
		})
	}

	// Hydrate the edit buffer exactly once. Subsequent live state pushes must not
	// overwrite unsaved fields in cachedState.
	useEffect(() => {
		if (!didHydrateState || initializedFromHydration.current) {
			return
		}

		const nextState = getSettingsEditState(latestExtensionState.current)
		savedState.current = nextState
		savedProjection.current = latestExtensionState.current
		setCachedState(nextState)
		prevApiConfigName.current = latestExtensionState.current.currentApiConfigName
		setCachedApiConfigIdentity(
			captureProfileIdentity(latestExtensionState.current, cachedApiConfigIdentity.requiresId),
		)
		cancelPendingProfileSave()
		prevSettingsImportedAt.current = latestExtensionState.current.settingsImportedAt
		initializedFromHydration.current = true
		setChangeDetected(false)
	}, [didHydrateState, cachedApiConfigIdentity.requiresId, cancelPendingProfileSave])

	useEffect(() => {
		// Names are editable metadata; only a profile selection replaces the edit buffer.
		const sameName = prevApiConfigName.current === currentApiConfigName
		const sameProfile =
			cachedApiConfigIdentity.id !== undefined
				? currentApiConfigId === undefined || cachedApiConfigIdentity.id === currentApiConfigId
				: sameName
		prevApiConfigName.current = currentApiConfigName
		if (sameProfile) {
			const refresh = pendingSettingsRefresh.current
			const refreshed = refresh !== undefined && extensionState.settingsProviderProfile !== refresh.snapshot
			if (
				(cachedApiConfigIdentity.snapshotUnavailable || refreshed) &&
				(!refresh || refreshed) &&
				!isChangeDetected &&
				getPairedSettingsProfile(latestExtensionState.current)
			) {
				pendingSettingsRefresh.current = undefined
				const nextState = getSettingsEditState(latestExtensionState.current)
				savedState.current = nextState
				savedProjection.current = latestExtensionState.current
				setCachedState(nextState)
				setCachedApiConfigIdentity(
					captureProfileIdentity(latestExtensionState.current, cachedApiConfigIdentity.requiresId),
				)
				return
			}
			// A partial metadata push cannot replace a known target with name-based creation.
			if (
				currentApiConfigId !== undefined &&
				(!cachedApiConfigIdentity.requiresId ||
					cachedApiConfigIdentity.id !== currentApiConfigId ||
					cachedApiConfigIdentity.name !== currentApiConfigName)
			) {
				setCachedApiConfigIdentity({
					id: currentApiConfigId,
					name: currentApiConfigName,
					version:
						cachedApiConfigIdentity.id === undefined
							? cachedState.settingsProviderProfile === undefined
								? listApiConfigMeta?.find(({ id }) => id === currentApiConfigId)?.version
								: undefined
							: cachedApiConfigIdentity.version,
					requiresId: true,
					snapshotUnavailable:
						cachedApiConfigIdentity.snapshotUnavailable || cachedState.settingsProviderProfile === null,
				})
			}
			return
		}

		setCachedApiConfigIdentity({
			...captureProfileIdentity(latestExtensionState.current, cachedApiConfigIdentity.requiresId),
		})
		cancelPendingProfileRename(t("settings:providers.renameErrors.cancelled"))
		cancelPendingProfileSave()
		setConfirmedProfileRename(undefined)
		const nextState = getSettingsEditState(latestExtensionState.current)
		savedState.current = nextState
		savedProjection.current = latestExtensionState.current
		setCachedState(nextState)
		setChangeDetected(false)
	}, [
		currentApiConfigName,
		currentApiConfigId,
		listApiConfigMeta,
		extensionState.settingsProviderProfile,
		isChangeDetected,
		cachedApiConfigIdentity,
		cachedState.settingsProviderProfile,
		cancelPendingProfileRename,
		cancelPendingProfileSave,
		t,
	])

	// Bust the cache when settings are imported.
	useEffect(() => {
		if (!settingsImportedAt || prevSettingsImportedAt.current === settingsImportedAt) {
			return
		}

		prevSettingsImportedAt.current = settingsImportedAt
		setCachedApiConfigIdentity(
			captureProfileIdentity(latestExtensionState.current, cachedApiConfigIdentity.requiresId),
		)
		cancelPendingProfileRename(t("settings:providers.renameErrors.cancelled"))
		cancelPendingProfileSave()
		setConfirmedProfileRename(undefined)
		const nextState = getSettingsEditState(latestExtensionState.current)
		savedState.current = nextState
		savedProjection.current = latestExtensionState.current
		setCachedState(nextState)
		setChangeDetected(false)
	}, [
		settingsImportedAt,
		cachedApiConfigIdentity.requiresId,
		cancelPendingProfileRename,
		cancelPendingProfileSave,
		t,
	])

	const setCachedStateField = useCallback(
		<K extends keyof SettingsCachedState>(field: K, value: SettingsCachedState[K]) => {
			setCachedState((prevState) => {
				if (prevState[field] === value) {
					return prevState
				}

				setChangeDetected(true)
				return { ...prevState, [field]: value }
			})
		},
		[],
	)

	const setApiConfigurationField = useCallback(
		<K extends keyof ProviderSettings>(field: K, value: ProviderSettings[K], isUserAction: boolean = true) => {
			setCachedState((prevState) => {
				if (prevState.apiConfiguration?.[field] === value) {
					return prevState
				}

				const previousValue = prevState.apiConfiguration?.[field]

				// Helper to check if two values are semantically equal
				const areValuesEqual = (a: any, b: any): boolean => {
					if (a === b) return true
					if (a == null && b == null) return true
					if (typeof a !== typeof b) return false
					if (typeof a === "object" && typeof b === "object") {
						return JSON.stringify(a) === JSON.stringify(b)
					}
					return false
				}

				// Only skip change detection for automatic initialization (not user actions)
				// This prevents the dirty state when the component initializes and auto-syncs values
				const isInitialSync =
					!isUserAction &&
					(previousValue === undefined || previousValue === "" || previousValue === null) &&
					value !== undefined &&
					value !== "" &&
					value !== null

				// Also skip if it's an automatic sync with semantically equal values
				const isAutomaticNoOpSync = !isUserAction && areValuesEqual(previousValue, value)

				if (!isInitialSync && !isAutomaticNoOpSync) {
					setChangeDetected(true)
				}
				return { ...prevState, apiConfiguration: { ...prevState.apiConfiguration, [field]: value } }
			})
		},
		[],
	)

	const setExperimentEnabled: SetExperimentEnabled = useCallback((id: ExperimentId, enabled: boolean) => {
		setCachedState((prevState) => {
			if (prevState.experiments?.[id] === enabled) {
				return prevState
			}

			setChangeDetected(true)
			return { ...prevState, experiments: { ...prevState.experiments, [id]: enabled } }
		})
	}, [])

	const setDebug = useCallback((debug: boolean) => {
		setCachedState((prevState) => {
			if (prevState.debug === debug) {
				return prevState
			}

			setChangeDetected(true)
			return { ...prevState, debug }
		})
	}, [])

	const setCustomSupportPromptsField = useCallback((prompts: Record<string, string | undefined>) => {
		setCachedState((prevState) => {
			const previousStr = JSON.stringify(prevState.customSupportPrompts)
			const newStr = JSON.stringify(prompts)

			if (previousStr === newStr) {
				return prevState
			}

			setChangeDetected(true)
			return { ...prevState, customSupportPrompts: prompts }
		})
	}, [])

	const managedAgentSettingsError = getManagedAgentSettingsError(cachedState)
	const memorySettingsValid = memorySettings === undefined || memorySettingsSchema.safeParse(memorySettings).success
	const settingsErrorMessage =
		errorMessage ??
		(managedAgentSettingsError ? t(managedAgentSettingsError) : undefined) ??
		(!memorySettingsValid ? t("settings:memory.invalid") : undefined)
	const isSettingValid = !settingsErrorMessage

	const handleSubmit = () => {
		if (!isSettingValid || pendingProfileRename.current || pendingProfileSave.current || isProfileIdentityPending)
			return
		const patch = createSettingsPatch(
			getSettingsSavePayload(savedState.current),
			getSettingsSavePayload(cachedState),
			{
				...savedProjection.current,
				allowedCommands: savedState.current.allowedCommands,
				deniedCommands: savedState.current.deniedCommands,
			},
		)
		const debugChanged = (cachedState.debug ?? false) !== (savedState.current.debug ?? false)
		const settingsChanged = Object.keys(patch.updatedSettings).length > 0 || debugChanged
		const profileChanged = !deepEqual(apiConfiguration, savedState.current.apiConfiguration ?? {})
		if (!settingsChanged && !profileChanged) {
			setChangeDetected(false)
			return
		}
		const requestId = crypto.randomUUID()
		const timeout = setTimeout(() => {
			if (pendingProfileSave.current?.requestId !== requestId) return
			pendingProfileSave.current = undefined
			setProfileSaving(false)
			setProfileSaveError(t("settings:providers.saveErrors.timeout"))
		}, profileSaveTimeoutMs)
		pendingProfileSave.current = {
			requestId,
			id: cachedApiConfigIdentity.id,
			generation: cachedState,
			patch,
			debugChanged,
			progress: createSettingsSaveProgress(requestId, {
				settings: settingsChanged,
				profile: profileChanged,
				...(profileChanged && cachedApiConfigIdentity.id !== undefined
					? { profileId: cachedApiConfigIdentity.id }
					: {}),
			}),
			timeout,
		}
		setProfileSaving(true)
		setProfileSaveError(undefined)
		try {
			if (settingsChanged) {
				vscode.postMessage({
					type: "updateSettings",
					updatedSettings: patch.updatedSettings,
					settingsSave: {
						requestId,
						expectedSettings: patch.expectedSettings,
						...(debugChanged
							? {
									debug: {
										expected: savedProjection.current.debug ?? false,
										value: cachedState.debug ?? false,
									},
								}
							: {}),
					},
				})
			}
			if (profileChanged && cachedApiConfigIdentity.id !== undefined) {
				vscode.postMessage({
					type: "upsertApiConfiguration",
					requestId,
					apiConfigurationId: cachedApiConfigIdentity.id,
					...(cachedApiConfigIdentity.version !== undefined
						? { apiConfigurationExpectedVersion: cachedApiConfigIdentity.version }
						: {}),
					text: effectiveApiConfigName,
					apiConfiguration,
				})
			} else if (profileChanged) {
				vscode.postMessage({
					type: "upsertApiConfiguration",
					requestId,
					apiConfigurationReturnVersion: true,
					text: effectiveApiConfigName ?? "default",
					apiConfiguration,
				})
			}
		} catch {
			clearTimeout(timeout)
			pendingProfileSave.current = undefined
			setProfileSaving(false)
			setProfileSaveError(t("settings:common.saveErrors.saveFailed"))
		}
	}

	const checkUnsaveChanges = useCallback(
		(then: () => void) => {
			if (isChangeDetected) {
				confirmDialogHandler.current = then
				setDiscardDialogShow(true)
			} else {
				then()
			}
		},
		[isChangeDetected],
	)

	useImperativeHandle(ref, () => ({ checkUnsaveChanges }), [checkUnsaveChanges])

	const onConfirmDialogResult = useCallback(
		(confirm: boolean) => {
			if (confirm) {
				// Discard changes: Reset state and flag
				const knownSameProfileName =
					currentApiConfigName === cachedApiConfigIdentity.name ||
					(confirmedProfileRename &&
						confirmedProfileRename.id === cachedApiConfigIdentity.id &&
						(currentApiConfigName === confirmedProfileRename.oldName ||
							currentApiConfigName === confirmedProfileRename.newName ||
							currentApiConfigName === confirmedProfileRename.requestedName))
				const id =
					getCurrentProfileId(extensionState, confirmedProfileRename) ??
					(knownSameProfileName ? cachedApiConfigIdentity.id : undefined)
				setCachedApiConfigIdentity({
					id,
					name: currentApiConfigName,
					version:
						captureProfileIdentity(extensionState).version ??
						(extensionState.settingsProviderProfile === undefined && id === cachedApiConfigIdentity.id
							? cachedApiConfigIdentity.version
							: undefined),
					requiresId: cachedApiConfigIdentity.requiresId || id !== undefined,
					snapshotUnavailable:
						captureProfileIdentity(extensionState).snapshotUnavailable ||
						(extensionState.settingsProviderProfile === null && id !== undefined),
				})
				if (captureProfileIdentity(extensionState).snapshotUnavailable) requestSettingsRefresh()
				cancelPendingProfileSave()
				const nextState = getSettingsEditState(extensionState)
				savedState.current = nextState
				savedProjection.current = extensionState
				setCachedState(nextState)
				setChangeDetected(false) // Reset change flag
				confirmDialogHandler.current?.() // Execute the pending navigation
			}
			// If confirm is false (Cancel), do nothing, dialog closes automatically
		},
		[
			extensionState,
			currentApiConfigName,
			confirmedProfileRename,
			cachedApiConfigIdentity,
			cancelPendingProfileSave,
			requestSettingsRefresh,
		],
	)

	const sections = useMemo(
		() => [
			{ id: "providers" as const, icon: Plug },
			{ id: "tools" as const, icon: Bot },
			{ id: "preferences" as const, icon: Glasses },
			{ id: "advanced" as const, icon: Settings2 },
		],
		[],
	)
	const [navigationTarget, setNavigationTarget] = useState(getSettingsSectionTarget(targetSection))
	const [searchRequest, setSearchRequest] = useState(0)
	const [isCompactMode, setCompactMode] = useState(false)
	const [isStackedLayout, setStackedLayout] = useState(false)
	const containerRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!containerRef.current) return
		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				setCompactMode(entry.contentRect.width < 500)
				setStackedLayout(entry.contentRect.width < 300)
			}
		})
		observer.observe(containerRef.current)
		return () => observer.disconnect()
	}, [])

	const activateSection = useCallback((section: SectionName) => {
		if (contentRef.current && activeSectionRef.current !== section) {
			scrollPositions.current[activeSectionRef.current] = contentRef.current.scrollTop
		}
		activeSectionRef.current = section
		setActiveSection(section)
		// Load resource managers on first visit, then retain drafts and validation between pages.
		if (section === "providers" || section === "tools") {
			setMountedGroups((previous) => (previous[section] ? previous : { ...previous, [section]: true }))
		}
	}, [])

	useLayoutEffect(() => {
		if (contentRef.current) contentRef.current.scrollTop = scrollPositions.current[activeSection] ?? 0
		tabRefs.current[activeSection]?.scrollIntoView({ block: "nearest" })
	}, [activeSection])

	useEffect(() => {
		const target = getSettingsSectionTarget(targetSection)
		if (!target) return
		activateSection(target.section)
		setNavigationTarget(target)
		setSearchRequest((request) => request + 1)
	}, [targetSection, activateSection])

	const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (!(event.target instanceof Element) || !event.target.closest('[role="tab"]')) return
		const current = sectionNames.indexOf(activeSection)
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? sectionNames.length - 1
					: event.key === "ArrowDown" || event.key === "ArrowRight"
						? (current + 1) % sectionNames.length
						: event.key === "ArrowUp" || event.key === "ArrowLeft"
							? (current - 1 + sectionNames.length) % sectionNames.length
							: undefined
		if (next === undefined) return
		event.preventDefault()
		const section = sectionNames[next]
		activateSection(section)
		setNavigationTarget(undefined)
		tabRefs.current[section]?.focus()
	}

	const getSectionLabel = useCallback((section: SectionName) => t(`settings:sections.${section}`), [t])
	const { contextValue: searchContextValue, index: searchIndex } = useSearchIndexRegistry(getSectionLabel)

	useEffect(() => {
		for (const { id } of sections) {
			searchContextValue.registerSetting({
				settingId: `section-${id}`,
				section: id,
				label: getSectionLabel(id),
			})
		}
		for (const { settingId, labelKey } of lazyToolsSearchSettings) {
			searchContextValue.registerSetting({ settingId, section: "tools", label: t(labelKey) })
		}
	}, [searchContextValue, sections, getSectionLabel, t])

	const handleSearchNavigate = useCallback(
		(section: SectionName, settingId: string) => {
			activateSection(section)
			setNavigationTarget({ section, settingId })
			setSearchRequest((request) => request + 1)
		},
		[activateSection],
	)

	useLayoutEffect(() => {
		if (!navigationTarget) return
		const settingId = navigationTarget.settingId ?? `section-${navigationTarget.section}`
		const elements = Array.from(contentRef.current?.querySelectorAll<HTMLElement>("[data-setting-id]") ?? [])
		const element =
			elements.find((candidate) => candidate.dataset.settingId === settingId) ??
			elements.find((candidate) => candidate.dataset.settingId === `section-${navigationTarget.section}`)
		if (!element) return
		revealSettingDetails(element)
		element.scrollIntoView({ behavior: "auto", block: "center" })
		element.classList.add("settings-highlight")
		const timer = setTimeout(() => element.classList.remove("settings-highlight"), 1500)
		return () => {
			clearTimeout(timer)
			element.classList.remove("settings-highlight")
		}
	}, [activeSection, navigationTarget, searchRequest, mountedGroups])

	const renderSettingsSection = (section: SectionName) => (
		<>
			{section === "providers" && (
				<div>
					<Section>
						<ApiConfigManager
							currentApiConfigName={effectiveApiConfigName}
							listApiConfigMeta={effectiveApiConfigMeta}
							profileActionsDisabled={areProfileActionsDisabled}
							onSelectConfig={(configName: string) => {
								if (
									pendingProfileRename.current ||
									pendingProfileSave.current ||
									isProfileNameAwaitingRefresh
								)
									return
								checkUnsaveChanges(() =>
									vscode.postMessage({ type: "loadApiConfiguration", text: configName }),
								)
							}}
							onDeleteConfig={(configName: string) => {
								if (
									pendingProfileRename.current ||
									pendingProfileSave.current ||
									isProfileNameAwaitingRefresh
								)
									return
								checkUnsaveChanges(() =>
									vscode.postMessage({
										type: "deleteApiConfiguration",
										text: configName,
									}),
								)
							}}
							onRenameConfig={renameApiConfiguration}
							onUpsertConfig={(configName: string) => {
								if (
									pendingProfileRename.current ||
									pendingProfileSave.current ||
									isProfileNameAwaitingRefresh
								)
									return
								const hadUnsavedChanges = isChangeDetected
								checkUnsaveChanges(() =>
									vscode.postMessage({
										type: "upsertApiConfiguration",
										text: configName,
										// Discard restores the saved profile before running this callback.
										apiConfiguration: hadUnsavedChanges
											? (savedState.current.apiConfiguration ?? {})
											: apiConfiguration,
									}),
								)
							}}
						/>
						{isProfileNameAwaitingRefresh && (
							<p role="status" className="text-vscode-descriptionForeground text-sm">
								{t("settings:providers.profileRefreshPending")}
							</p>
						)}
						{isProfileIdentityPending && (
							<p role="status" className="text-vscode-descriptionForeground text-sm">
								{profileIdentityPendingMessage}
							</p>
						)}
						<ApiOptions
							uriScheme={uriScheme}
							profileIdentity={cachedApiConfigIdentity.id ?? cachedApiConfigIdentity.name}
							apiConfiguration={apiConfiguration}
							setApiConfigurationField={setApiConfigurationField}
							errorMessage={errorMessage}
							setErrorMessage={setErrorMessage}
						/>
					</Section>
				</div>
			)}
			{section === "tools" && (
				<ToolsAgentsSettings
					embedded
					values={cachedState}
					setCachedStateField={setCachedStateField}
					setExperimentEnabled={setExperimentEnabled}
					isActive={activeSection === "tools"}
					committedCustomToolsEnabled={extensionState.experiments?.[EXPERIMENT_IDS.CUSTOM_TOOLS] === true}
				/>
			)}
			{section === "preferences" && (
				<PreferencesSettings
					embedded
					values={cachedState}
					setCachedStateField={setCachedStateField}
					inheritedCommandRules={cachedState.commandRuleSettings?.inherited}
				/>
			)}
			{section === "advanced" && (
				<AdvancedSettings
					embedded
					values={cachedState}
					setCachedStateField={setCachedStateField}
					setCustomSupportPrompts={setCustomSupportPromptsField}
					setDebug={setDebug}
				/>
			)}
		</>
	)

	return (
		<Tab className="settings-shell" data-settings-compact={isCompactMode} data-settings-stacked={isStackedLayout}>
			<TabHeader className="settings-header z-20 flex min-w-0 flex-wrap justify-between items-center gap-2">
				<div className="flex min-w-0 flex-1 basis-32 items-center gap-2">
					<StandardTooltip content={t("settings:header.doneButtonTooltip")}>
						<Button variant="ghost" className="px-1.5 -ml-2" onClick={() => checkUnsaveChanges(onDone)}>
							<ArrowLeft />
							<span className="sr-only">{t("settings:common.done")}</span>
						</Button>
					</StandardTooltip>
					<h3 className="text-vscode-foreground m-0 flex-shrink-0">{t("settings:header.title")}</h3>
				</div>
				<div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
					<SettingsSearch index={searchIndex} onNavigate={handleSearchNavigate} sections={sections} />
					<StandardTooltip
						content={
							isProfileRenaming
								? t("settings:providers.renameErrors.pending")
								: isProfileSaving
									? t("settings:providers.profileSavePending")
									: isProfileIdentityPending
										? profileIdentityPendingMessage
										: !isSettingValid
											? settingsErrorMessage
											: isChangeDetected
												? t("settings:header.saveButtonTooltip")
												: t("settings:header.nothingChangedTooltip")
						}>
						<Button
							variant={isSettingValid ? "primary" : "secondary"}
							className={!isSettingValid ? "!border-vscode-errorForeground" : ""}
							onClick={handleSubmit}
							disabled={
								!isChangeDetected ||
								!isSettingValid ||
								isProfileRenaming ||
								isProfileSaving ||
								isProfileIdentityPending
							}
							data-testid="save-button"
							aria-describedby={settingsErrorMessage ? settingsId + "-validation" : undefined}
							aria-busy={isProfileSaving}>
							{t("settings:common.save")}
						</Button>
					</StandardTooltip>
				</div>
			</TabHeader>
			{settingsErrorMessage && (
				<p
					id={settingsId + "-validation"}
					role="alert"
					className="m-0 border-b border-vscode-inputValidation-errorBorder bg-vscode-inputValidation-errorBackground px-5 py-3 text-sm text-vscode-errorForeground">
					{settingsErrorMessage}
				</p>
			)}
			{profileSaveError && (
				<div
					role="alert"
					className="flex flex-wrap items-center justify-between gap-3 border-b border-vscode-inputValidation-errorBorder bg-vscode-inputValidation-errorBackground px-5 py-3 text-sm text-vscode-errorForeground">
					<span>{profileSaveError}</span>
					<Button
						variant="secondary"
						className="h-auto max-w-full whitespace-normal"
						onClick={() =>
							checkUnsaveChanges(() => {
								const next = getSettingsEditState(latestExtensionState.current)
								savedState.current = next
								savedProjection.current = latestExtensionState.current
								setCachedState(next)
								setCachedApiConfigIdentity({
									...captureProfileIdentity(
										latestExtensionState.current,
										cachedApiConfigIdentity.requiresId,
									),
									snapshotUnavailable:
										getCurrentProfileId(latestExtensionState.current) !== undefined,
								})
								requestSettingsRefresh()
								setChangeDetected(false)
								setProfileSaveError(undefined)
							})
						}>
						{t("settings:common.reloadSettings")}
					</Button>
				</div>
			)}

			<div
				ref={containerRef}
				className={cn("flex min-h-0 min-w-0 flex-1 overflow-hidden", isStackedLayout && "flex-col")}>
				<div
					role="tablist"
					aria-label={t("settings:header.title")}
					aria-orientation={isStackedLayout ? "horizontal" : "vertical"}
					onKeyDown={handleTabKeyDown}
					data-testid="settings-tab-list"
					data-compact={isCompactMode}
					className={cn(
						"flex shrink-0 gap-1 border-[var(--border-subtle)] bg-vscode-editor-background p-2",
						isStackedLayout
							? "w-full flex-row overflow-x-auto border-b p-1"
							: "flex-col overflow-y-auto overflow-x-hidden border-r",
						!isStackedLayout && (isCompactMode ? "w-14" : "w-48"),
					)}>
					{sections.map(({ id, icon: Icon }) => (
						<StandardTooltip
							key={id}
							content={getSectionLabel(id)}
							side={isStackedLayout ? "bottom" : "right"}>
							<TabTrigger
								ref={(element) => {
									tabRefs.current[id] = element
								}}
								value={id}
								id={settingsId + "-tab-" + id}
								aria-label={getSectionLabel(id)}
								aria-controls={settingsId + "-panel-" + id}
								isSelected={activeSection === id}
								onClick={() => {
									activateSection(id)
									setNavigationTarget(undefined)
								}}
								data-testid={`tab-${id}`}
								className={cn(
									"box-border flex h-9 min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-3 text-vscode-foreground opacity-70 hover:bg-vscode-list-hoverBackground hover:opacity-100",
									activeSection === id && "bg-vscode-list-hoverBackground opacity-100",
									isCompactMode && "w-10 justify-center px-0",
									isStackedLayout && "h-8 w-7 shrink-0",
								)}>
								<Icon className="size-4 shrink-0" aria-hidden="true" />
								<span className={isCompactMode ? "sr-only" : "truncate"}>{getSectionLabel(id)}</span>
							</TabTrigger>
						</StandardTooltip>
					))}
				</div>
				<SearchIndexProvider value={searchContextValue}>
					<TabContent
						ref={contentRef}
						className="p-0 min-h-0 min-w-0 flex-1 overflow-auto"
						data-testid="settings-content">
						{sections.map(({ id }) => (
							<div
								key={id}
								role="tabpanel"
								id={settingsId + "-panel-" + id}
								aria-labelledby={settingsId + "-tab-" + id}
								data-settings-section={id}
								data-setting-id={`section-${id}`}
								hidden={activeSection !== id}
								tabIndex={0}>
								<SectionHeader>
									<span className="flex min-w-0 items-center gap-2">
										{getSectionLabel(id)}
										{id === "tools" && (
											<SettingsHelp label={getSectionLabel(id)}>
												<p className="m-0">{t("settings:tools.managementDescription")}</p>
											</SettingsHelp>
										)}
									</span>
								</SectionHeader>
								{((id !== "providers" && id !== "tools") || mountedGroups[id]) &&
									renderSettingsSection(id)}
							</div>
						))}
					</TabContent>
				</SearchIndexProvider>
			</div>

			<div className="flex shrink-0 justify-end border-t border-[var(--border-subtle)] px-5 py-2">
				<Button
					variant="ghost"
					data-testid="settings-about-button"
					onClick={() => checkUnsaveChanges(() => vscode.postMessage({ type: "switchTab", tab: "about" }))}>
					<Info className="mr-2 h-4 w-4" aria-hidden="true" />
					{t("settings:sections.about")}
				</Button>
			</div>
			<AlertDialog open={isDiscardDialogShow} onOpenChange={setDiscardDialogShow}>
				<AlertDialogContent
					className="settings-discard-dialog max-h-[calc(100%-1rem)] min-w-0 overflow-y-auto"
					onOpenAutoFocus={() => {
						const activeElement = contentRef.current?.ownerDocument.activeElement
						discardDialogOpenerRef.current = activeElement instanceof HTMLElement ? activeElement : null
					}}
					onCloseAutoFocus={(event) => {
						// The unsaved-changes dialog is also opened by imperative navigation, without a Radix Trigger.
						event.preventDefault()
						if (discardDialogOpenerRef.current?.isConnected) discardDialogOpenerRef.current.focus()
						discardDialogOpenerRef.current = null
					}}>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<AlertTriangle className="w-5 h-5 shrink-0 text-vscode-editorWarning-foreground" />
							<span className="min-w-0 break-words">{t("settings:unsavedChangesDialog.title")}</span>
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t("settings:unsavedChangesDialog.description")}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter className="flex-wrap">
						<AlertDialogCancel onClick={() => onConfirmDialogResult(false)}>
							{t("settings:unsavedChangesDialog.cancelButton")}
						</AlertDialogCancel>
						<AlertDialogAction onClick={() => onConfirmDialogResult(true)}>
							{t("settings:unsavedChangesDialog.discardButton")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</Tab>
	)
})

export default memo(SettingsView)
