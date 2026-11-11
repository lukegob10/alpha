import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { CdpConnection } from "./cdp"
import { createRenderedAcceptanceControls } from "./renderedAcceptance"
import { javascriptLiteral } from "./javascriptLiteral"
import { waitUntil } from "../evidence/sharedStorageProtocol"

const sections = [
	["providers", "Providers"],
	["tools", "Tools & agents"],
	["preferences", "Preferences"],
	["advanced", "Advanced"],
] as const

/** Real webview input; the owned extension host independently verifies persistence and unchanged authority. */
export async function exerciseRenderedSettings(
	cdp: CdpConnection,
	sessionId: string,
	workbenchSession: string,
	directory: string,
	nonce: string,
	signal?: AbortSignal,
) {
	const controls = createRenderedAcceptanceControls(cdp, sessionId, signal)
	const { evaluate } = controls
	const check = async (expression: string) => {
		try {
			await controls.check(expression)
		} catch (cause) {
			throw new Error(`settings_render_check_failed: ${expression}`, { cause })
		}
	}
	const click = async (expression: string) => {
		try {
			await controls.click(expression)
		} catch (cause) {
			throw new Error(`settings_render_click_failed: ${expression}`, { cause })
		}
	}
	const button = (label: string) =>
		`[...d.querySelectorAll('button')].find(e=>e.textContent.trim()===${javascriptLiteral(label)})`
	const replaceInput = async (element: string, text: string) => {
		await click(element)
		await check(`d.activeElement===(${element})`)
		for (const type of ["keyDown", "keyUp"]) {
			await cdp.request(
				"Input.dispatchKeyEvent",
				{
					type,
					key: "a",
					code: "KeyA",
					windowsVirtualKeyCode: 65,
					modifiers: process.platform === "darwin" ? 4 : 2,
				},
				sessionId,
			)
		}
		for (const type of ["keyDown", "keyUp"]) {
			await cdp.request(
				"Input.dispatchKeyEvent",
				{ type, key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
				sessionId,
			)
		}
		if (text) await cdp.request("Input.insertText", { text }, sessionId)
		await check(`(${element}).value===${javascriptLiteral(text)}`)
	}
	const tab = (section: string) => `d.querySelector('[data-testid="tab-${section}"]')`
	const preferenceGroup = (name: string) =>
		`d.querySelector('[data-settings-section=preferences] [data-settings-group="${name}"]')`
	const settlePaint = () =>
		evaluate(
			"new Promise(resolve=>d.defaultView.requestAnimationFrame(()=>d.defaultView.requestAnimationFrame(()=>resolve(true))))",
		)
	const revealControl = async (element: string) => {
		await check(`!!(${element})`)
		const closed = `[...d.querySelectorAll('details:not([open])')].find(e=>e.contains(${element}))`
		for (let depth = 0; depth < 8 && (await evaluate<boolean>(`!!(${closed})`)); depth++) {
			await click(`(${closed}).querySelector(':scope > summary')`)
			await settlePaint()
		}
		await check(`!(${closed})&&(${element}).checkVisibility()===true`)
	}
	const resizeSidebar = async (width: number) => {
		const read = async () => {
			const result = await cdp.request<{
				result: { value: { width: number; x: number; y: number } }
				exceptionDetails?: unknown
			}>(
				"Runtime.evaluate",
				{
					expression: `(()=>{const p=document.querySelector('.part.sidebar');if(!p)throw new Error('sidebar_missing');
						const r=p.getBoundingClientRect();
						const s=[...document.querySelectorAll('.monaco-sash.vertical')].find(e=>{
							const b=e.getBoundingClientRect();return b.height>100&&Math.abs(b.x+b.width/2-r.right)<=8;
						});if(!s)throw new Error('sidebar_sash_missing');const b=s.getBoundingClientRect();
						return {width:r.width,x:b.x+b.width/2,y:b.y+b.height/2}})()`,
					returnByValue: true,
				},
				workbenchSession,
			)
			assert.equal(result.exceptionDetails, undefined)
			return result.result.value
		}
		const before = await read()
		await cdp.request(
			"Input.dispatchMouseEvent",
			{ type: "mouseMoved", x: before.x, y: before.y },
			workbenchSession,
		)
		await cdp.request(
			"Input.dispatchMouseEvent",
			{ type: "mousePressed", x: before.x, y: before.y, button: "left", buttons: 1, clickCount: 1 },
			workbenchSession,
		)
		try {
			await cdp.request(
				"Input.dispatchMouseEvent",
				{ type: "mouseMoved", x: before.x + width - before.width, y: before.y, button: "left", buttons: 1 },
				workbenchSession,
			)
		} finally {
			await cdp.request(
				"Input.dispatchMouseEvent",
				{
					type: "mouseReleased",
					x: before.x + width - before.width,
					y: before.y,
					button: "left",
					buttons: 0,
					clickCount: 1,
				},
				workbenchSession,
			)
		}
		await waitUntil(
			async () => Math.abs((await read()).width - width) <= 2,
			Date.now() + 15_000,
			"settings_sidebar_resize_timeout",
		)
	}
	const go = async (section: string) => {
		await click(tab(section))
		await check(`${tab(section)}?.getAttribute('aria-selected')==='true'`)
		await check(
			`(()=>{const visible=[...d.querySelectorAll('[data-testid=settings-content] [data-settings-section]')].filter(e=>e.getClientRects().length>0);
				return visible.length===1&&visible[0].getAttribute('data-settings-section')===${javascriptLiteral(section)}&&!!visible[0].closest('[role=tabpanel]')})()`,
		)
		if (section === "tools") {
			await check("!!d.querySelector('[data-setting-id=agents-enabled]')")
		} else if (section === "providers") {
			await check("!!d.querySelector('[data-testid=select-component]')")
		}
		if (section !== "providers") {
			await check(
				`(()=>{const page=d.querySelector('[data-settings-section="${section}"]'),card=page.querySelector('[data-settings-page-card="${section}"]');
					return !!card&&card.classList.contains('surface-raised')&&page.querySelectorAll('.surface-raised').length===1})()`,
			)
		}
		if (section === "advanced") {
			await check(
				"(()=>{const panel=d.querySelector('[data-testid=settings-content]');return panel.scrollWidth<=panel.clientWidth+1})()",
			)
			await check(`(()=>{const groups=[...d.querySelectorAll('[data-settings-page-card=advanced] > [data-settings-group]')];
				return groups.map(e=>e.getAttribute('data-settings-group')).join('|')==='context|recovery|diagnostics'&&
					groups.every(e=>!e.closest('details')&&e.querySelector(':scope > h4')?.checkVisibility())})()`)
			for (const id of ["context-open-tabs", "checkpoints-enable", "about-debug-mode"]) {
				await check(
					`d.querySelector('[data-settings-page-card=advanced] [data-setting-id="${id}"]')?.checkVisibility()===true`,
				)
			}
		}
		await settlePaint()
		await evaluate("(d.querySelector('[data-testid=settings-content]').scrollTop=0,true)")
		await settlePaint()
	}
	const capture = async (stage: string) => {
		// Native toggle queues React work; allow that commit before testing whether its animation has started.
		await settlePaint()
		await check("!d.getAnimations().some(a=>a.playState==='running'&&a.effect?.getTiming().iterations!==Infinity)")
		await settlePaint()
		const snapshot = await evaluate<{
			text: string
			groups: Array<{
				id: string
				open: boolean
				bodyHeight: number
				arrowTransform: string
				arrowRotate: string
			}>
		}>(`({text:d.body.innerText,groups:[...d.querySelectorAll('[data-testid=settings-content] details')].filter(e=>e.getClientRects().length>0).map((e,index)=>{
			const body=[...e.children].find(child=>child.tagName!=='SUMMARY'),arrow=e.querySelector(':scope > summary > svg');
			const style=arrow?d.defaultView.getComputedStyle(arrow):null;
			return {id:e.getAttribute('data-settings-advanced')??e.getAttribute('data-agents-advanced')??String(index),open:e.open,bodyHeight:body?.getBoundingClientRect().height??0,
				arrowTransform:style?.transform??'',arrowRotate:style?.rotate??''};})})`)
		const screenshot = await cdp.request<{ data: string }>(
			"Page.captureScreenshot",
			{ format: "png" },
			workbenchSession,
		)
		await fs.writeFile(path.join(directory, `ui-${stage}.png`), Buffer.from(screenshot.data, "base64"))
		await fs.writeFile(path.join(directory, `ui-${stage}.txt`), snapshot.text)
		await fs.writeFile(
			path.join(directory, `ui-${stage}-disclosures.json`),
			JSON.stringify(snapshot.groups, null, 2),
		)
		if (stage === "settings-dark-home" || stage === "settings-light-home") {
			const bounds = await cdp.request<{
				result: { value: { x: number; y: number; width: number; height: number } }
				exceptionDetails?: unknown
			}>(
				"Runtime.evaluate",
				{
					expression:
						"(()=>{const r=document.querySelector('.part.sidebar').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()",
					returnByValue: true,
				},
				workbenchSession,
			)
			assert.equal(bounds.exceptionDetails, undefined)
			assert.ok(bounds.result.value.width > 0 && bounds.result.value.height > 0)
			const clipped = await cdp.request<{ data: string }>(
				"Page.captureScreenshot",
				{ format: "png", clip: { ...bounds.result.value, scale: 1 } },
				workbenchSession,
			)
			await fs.writeFile(path.join(directory, `ui-${stage}-sidebar.png`), Buffer.from(clipped.data, "base64"))
		}
	}
	const assertNavigation = async () => {
		await check("!!d.querySelector('[data-testid=settings-content]')")
		await check("d.querySelectorAll('[data-testid=settings-tab-list] [role=tab]').length===4")
		const actual = await evaluate<Array<[string | null, string]>>(
			"[...d.querySelectorAll('[data-testid=settings-tab-list] [role=tab]')].map(e=>[e.getAttribute('data-testid'),e.textContent.trim()])",
		)
		assert.deepEqual(
			actual,
			sections.map(([id, label]) => [`tab-${id}`, label]),
		)
		assert.equal(await evaluate("!!d.querySelector('[data-testid=tab-permissions]')"), false)
	}
	const layout = async (theme: string) => {
		await assertNavigation()
		await go("providers")
		await capture(`settings-${theme}-home`)
		for (const [section] of sections) {
			await go(section)
			await capture(`settings-${theme}-${section}`)
			if (section === "advanced") {
				for (const group of ["recovery", "diagnostics"]) {
					await evaluate(
						`(d.querySelector('[data-settings-page-card=advanced] [data-settings-group="${group}"] > h4').scrollIntoView({block:'start',behavior:'instant'}),true)`,
					)
					await capture(`settings-${theme}-advanced-${group}`)
				}
			}
		}
	}
	const compactHome = async (name: string) => {
		await go("providers")
		await capture(`settings-${name}-home`)
	}
	const verifyTerminalSettingsRetired = async () => {
		await go("advanced")
		await check(
			"!d.querySelector('[data-settings-group=terminal]')&&!d.querySelector('[data-setting-id^=terminal-]')",
		)
		await check("!d.querySelector('[data-testid=terminal-output-preview-size-dropdown]')")
		await capture("settings-terminal-controls-retired")
		await go("providers")
		const search = "d.querySelector('[data-testid=settings-search-input]')"
		for (const query of ["Command output preview size", "Terminal"]) {
			await replaceInput(search, query)
			await check("!!d.querySelector('[role=listbox]')")
			await check("!d.querySelector('[role=option][id^=settings-search-result-terminal-]')")
		}
		await replaceInput(search, "")
		await check("d.querySelector('[data-testid=save-button]').disabled")
	}
	const verifyPromptDisclosure = async (name: string) => {
		await go("advanced")
		const details =
			"d.querySelector('[data-settings-section=advanced] details[data-settings-advanced=condense-prompt]')"
		const summary = `(${details}).querySelector(':scope > summary')`
		const editor = "d.querySelector('[data-testid=condense-prompt-textarea]')"
		const reset = `(${details}).querySelector('.codicon-discard').closest('button')`
		await check(
			`!!(${details})&&!(${details}).open&&(${editor}).checkVisibility()===false&&(${reset}).checkVisibility()===false`,
		)
		await check("d.querySelector('[data-setting-id=context-auto-condense]')?.checkVisibility()===true")
		const value = await evaluate<string>(`(${editor}).value`)
		const label = await evaluate<string>(`(${summary}).textContent.trim()`)
		await evaluate(`((${summary}).scrollIntoView({block:'center',behavior:'instant'}),true)`)
		await capture(`settings-${name}-condense-prompt-folded`)
		await click(summary)
		await check(`(${details}).open&&(${editor}).checkVisibility()&&(${reset}).checkVisibility()`)
		await capture(`settings-${name}-condense-prompt-editor`)
		await click(summary)
		await check(`!(${details}).open&&(${editor}).checkVisibility()===false`)
		assert.equal(await evaluate(`(${editor}).value`), value)
		await go("providers")
		const search = "d.querySelector('[data-testid=settings-search-input]')"
		await replaceInput(search, label)
		await check("!!d.querySelector('#settings-search-result-context-condense-prompt')")
		await click("d.querySelector('#settings-search-result-context-condense-prompt')")
		await check(
			`${tab("advanced")}?.getAttribute('aria-selected')==='true'&&(${details}).open&&(${editor}).checkVisibility()`,
		)
		assert.equal(await evaluate(`(${editor}).value`), value)
		await check("d.querySelector('[data-testid=save-button]').disabled")
		await capture(`settings-${name}-condense-prompt-search`)
		await click(summary)
		await check(`!(${details}).open&&(${editor}).checkVisibility()===false`)
		await replaceInput(search, "")
	}
	const verifyHelp = async (name: string) => {
		await go("preferences")
		const help = "d.querySelector('[data-setting-id=auto-approve-mode] button[aria-label]')"
		const label = "Help for Default permission mode"
		const description =
			"Choose the default for new chats. Change permissions for an individual chat from its composer."
		await check(`(${help})?.getAttribute('aria-label')===${javascriptLiteral(label)}`)
		assert.equal(
			await evaluate<boolean>(
				`d.querySelector('[data-testid=settings-content]').innerText.includes(${javascriptLiteral(description)})`,
			),
			false,
			"Routine explanations should stay outside the main settings form",
		)
		await controls.hover(help)
		await check(
			`!![...d.querySelectorAll('[role=tooltip]')].find(e=>e.textContent.includes(${javascriptLiteral(label)}))`,
		)
		await check(
			`(()=>{const e=[...d.querySelectorAll('[role=tooltip]')].find(e=>e.textContent.includes(${javascriptLiteral(label)}));
				const r=e?.getBoundingClientRect();return !!r&&r.width>0&&r.left>=0&&r.right<=d.documentElement.clientWidth})()`,
		)
		await capture(`settings-${name}-help-tooltip`)
		await click(help)
		const dialog = `d.querySelector('[role=dialog][aria-label=${javascriptLiteral(label)}]')`
		await check(`!!(${dialog})&&(${dialog}).textContent.includes(${javascriptLiteral(description)})`)
		await check(`(${dialog}).querySelectorAll('dt').length===3`)
		await check(
			`(()=>{const r=(${dialog}).getBoundingClientRect();return r.left>=0&&r.right<=d.documentElement.clientWidth})()`,
		)
		await capture(`settings-${name}-help-dialog`)
		for (const type of ["keyDown", "keyUp"]) {
			await cdp.request(
				"Input.dispatchKeyEvent",
				{ type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
				sessionId,
			)
		}
		await check(`!(${dialog})&&d.activeElement===(${help})`)
	}
	const verifyTinyControls = async (section: string) => {
		if (section === "providers") {
			await check(
				"(()=>{const panel=d.querySelector('[data-settings-section=providers]'),picker=panel?.querySelector('[data-testid=select-component]');if(!picker)return false;const r=picker.getBoundingClientRect();return r.width>=80&&r.right<=panel.getBoundingClientRect().right})()",
			)
			await check(
				`(()=>{const e=d.querySelector('[data-settings-section=providers] h2,[data-settings-section=providers] h3');if(!e)return false;
					const text=d.createTreeWalker(e,d.defaultView.NodeFilter.SHOW_TEXT),rects=[];
					while(text.nextNode()){if(!text.currentNode.textContent.trim())continue;const r=d.createRange();r.selectNodeContents(text.currentNode);
						rects.push(...[...r.getClientRects()].filter(b=>b.width>0&&b.height>0));}
					return rects.length>0&&rects.every(r=>Math.abs(r.top-rects[0].top)<1)})()`,
			)
		} else if (section === "tools") {
			await check("d.querySelectorAll('.settings-skill-row').length>0")
			const rows = await evaluate<
				Array<{
					name: string
					width: number
					rowWidth: number
					nameBottom: number
					actionsTop: number
					textOverflow: string
				}>
			>(
				"[...d.querySelectorAll('.settings-skill-row')].map(row=>{const name=row.querySelector('.settings-skill-name'),actions=row.querySelector('.settings-skill-actions');const n=name.getBoundingClientRect(),a=actions.getBoundingClientRect();return {name:name.textContent,width:n.width,rowWidth:row.getBoundingClientRect().width,nameBottom:n.bottom,actionsTop:a.top,textOverflow:d.defaultView.getComputedStyle(name).textOverflow}})",
			)
			await fs.writeFile(
				path.join(directory, "ui-settings-tiny-skill-geometry.json"),
				JSON.stringify(rows, null, 2),
			)
			for (const row of rows) {
				assert.ok(
					row.width >= Math.min(60, row.rowWidth),
					`${row.name}: the skill name must retain readable width`,
				)
				assert.ok(
					row.actionsTop >= row.nameBottom + 2,
					`${row.name}: actions belong below the name in a tiny sidebar`,
				)
				assert.notEqual(row.textOverflow, "ellipsis", `${row.name}: stacked skill names should wrap`)
			}
		} else if (section === "preferences") {
			const checkboxes = await evaluate<Array<{ label: string; controlWidth: number | null }>>(
				"[...d.querySelectorAll('vscode-checkbox')].filter(e=>e.checkVisibility()).map(e=>({label:e.textContent.trim(),controlWidth:e.shadowRoot?.querySelector('[part~=control]')?.getBoundingClientRect().width??null}))",
			)
			await fs.writeFile(
				path.join(directory, "ui-settings-tiny-checkbox-geometry.json"),
				JSON.stringify(checkboxes, null, 2),
			)
			assert.ok(checkboxes.length > 0, "The tiny preference fixture must contain rendered toolkit checkboxes")
			for (const checkbox of checkboxes) {
				assert.ok(
					checkbox.controlWidth !== null && checkbox.controlWidth >= 16,
					`${checkbox.label}: the checkbox control must not shrink below16px`,
				)
			}
		}
	}
	const verifyCoarsePointer = async () => {
		const enabled: string[] = []
		const unavailable: string[] = []
		try {
			// Touch emulation changes the actual browser pointer media query; no product styles are overwritten.
			for (const target of [workbenchSession, sessionId]) {
				try {
					await cdp.request(
						"Emulation.setTouchEmulationEnabled",
						{ enabled: true, maxTouchPoints: 1 },
						target,
					)
					enabled.push(target)
				} catch (error) {
					if (
						!(error instanceof Error) ||
						!/not supported|not found|wasn't found|unknown method/i.test(error.message)
					)
						throw error
					unavailable.push(target === sessionId ? "webview-touch-emulation" : "workbench-touch-emulation")
				}
			}
			await settlePaint()
			const coarse = await evaluate<boolean>("d.defaultView.matchMedia('(pointer: coarse)').matches")
			const buttons = coarse
				? await evaluate<Array<{ label: string; width: number; height: number }>>(
						"[...d.querySelectorAll('button[data-settings-help-trigger]')].filter(e=>e.checkVisibility()).map(e=>{const r=e.getBoundingClientRect();return {label:e.getAttribute('aria-label'),width:r.width,height:r.height}})",
					)
				: []
			await fs.writeFile(
				path.join(directory, "ui-settings-tiny-coarse-pointer.json"),
				JSON.stringify({ supported: coarse, unavailable, buttons }, null, 2),
			)
			if (coarse) {
				assert.ok(buttons.length > 0, "The coarse-pointer fixture must expose a help control")
				for (const button of buttons) {
					assert.ok(
						button.width >= 44 && button.height >= 44,
						`${button.label}: coarse-pointer help targets must measure at least44px`,
					)
				}
				await capture("settings-tiny-coarse-pointer")
			}
		} finally {
			for (const target of enabled) {
				await cdp.request("Emulation.setTouchEmulationEnabled", { enabled: false }, target)
			}
			await settlePaint()
		}
	}
	const assertHeaderFits = () =>
		check(
			"(()=>{const w=d.documentElement.clientWidth;const save=d.querySelector('[data-testid=save-button]').getBoundingClientRect();const done=[...d.querySelectorAll('button')].find(e=>e.textContent.trim()==='Done').getBoundingClientRect();return d.documentElement.scrollWidth<=w+1&&save.width>0&&save.left>=0&&save.right<=w&&done.width>0&&done.left>=0&&done.right<=w})()",
		)
	const verifyProviderFieldLayout = async () => {
		await resizeSidebar(800)
		await go("providers")
		const geometry = await evaluate<{
			label: { top: number; bottom: number; width: number }
			help: { top: number; bottom: number; width: number }
			selector: { top: number; bottom: number; width: number }
		}>(`(()=>{const panel=d.querySelector('[data-settings-section=providers]');
			const label=[...panel.querySelectorAll('span')].find(e=>e.textContent.trim()==='API Provider');
			const help=panel.querySelector('button[aria-label="Help for API Provider"]');
			const selector=panel.querySelector('[data-testid=provider-select]');
			const rect=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width}};
			return {label:rect(label),help:rect(help),selector:rect(selector)}})()`)
		await fs.writeFile(
			path.join(directory, "ui-settings-provider-label-geometry.json"),
			JSON.stringify(geometry, null, 2),
		)
		assert.ok(geometry.label.width > 0 && geometry.help.width > 0 && geometry.selector.width > 0)
		assert.ok(
			geometry.label.bottom <= geometry.selector.top,
			"API Provider label must sit above the selector at wide widths",
		)
		assert.ok(
			geometry.help.bottom <= geometry.selector.top,
			"API Provider help must sit above the selector at wide widths",
		)
		await capture("settings-extra-wide-providers")
		await resizeSidebar(520)
	}
	const verifyPermissionsAdvanced = async () => {
		await go("preferences")
		const details = `(${preferenceGroup("permissions")}).querySelector('details[data-settings-advanced]')`
		await check(`!!(${details})`)
		if (await evaluate<boolean>(`!(${details}).open`)) await click(`(${details}).querySelector('summary')`)
		await check(`(${details}).open`)
		await settlePaint()
		for (const label of ["Requests between confirmations", "Reported API cost between confirmations"]) {
			assert.equal(
				await evaluate<boolean>(
					`(${preferenceGroup("permissions")}).textContent.includes(${javascriptLiteral(label)})`,
				),
				false,
				`${label} should not remain in the Permissions UI`,
			)
		}
		await check("d.querySelector('[data-testid=denied-command-input]')?.checkVisibility()===true")
		await check("d.querySelector('[data-testid=always-allow-mcp-checkbox]')?.checkVisibility()===true")
		await evaluate(`((${details}).scrollIntoView({block:'start',behavior:'instant'}),true)`)
		await capture("settings-permissions-advanced")
	}
	const verifyPreferenceGroups = async () => {
		await go("preferences")
		const groups = await evaluate<string[]>(
			"[...d.querySelectorAll('[data-settings-section=preferences] [data-settings-group]')].map(e=>e.getAttribute('data-settings-group'))",
		)
		assert.deepEqual(groups, ["permissions", "chat-and-sound", "memories"])
		for (const [id, label] of [
			["permissions", "Permissions"],
			["chat-and-sound", "Chat & sound"],
			["memories", "Memories"],
		] as const) {
			await check(
				`[...(${preferenceGroup(id)}).querySelectorAll('h2,h3,h4,summary')].some(e=>e.textContent.trim()===${javascriptLiteral(label)}&&e.checkVisibility())`,
			)
		}
		await check(
			`(${preferenceGroup("permissions")}).contains(d.querySelector('[data-setting-id=auto-approve-mode]'))`,
		)
		const thinking = "d.querySelector('[data-testid=collapse-thinking-checkbox]')"
		const sound = "d.querySelector('[data-testid=sound-enabled-checkbox]')"
		const memory = "d.getElementById('memory-enabled')"
		await check("!d.querySelector('details[data-settings-preferences]')")
		await check(`(${thinking}).checkVisibility()&&(${sound}).checkVisibility()&&(${memory}).checkVisibility()`)
		assert.equal(
			await evaluate(
				`[${thinking},${sound},${memory}].every(e=>e.closest('.surface-raised')===d.querySelector('[data-settings-page-card=preferences]'))`,
			),
			true,
			"Permissions, chat, sound and memories must share one preferences card",
		)
		const saved = await evaluate<{ thinking: boolean; sound: boolean }>(
			`({thinking:(${thinking}).checked,sound:(${sound}).checked})`,
		)
		await capture("settings-preferences-visible-groups")
		await go("providers")
		await replaceInput("d.querySelector('[data-testid=settings-search-input]')", "Enable sound effects")
		await check("!!d.querySelector('#settings-search-result-notifications-sound')")
		await click("d.querySelector('#settings-search-result-notifications-sound')")
		await check(`${tab("preferences")}?.getAttribute('aria-selected')==='true'`)
		await check(`(${thinking}).checkVisibility()&&(${sound}).checkVisibility()&&(${memory}).checkVisibility()`)
		assert.deepEqual(await evaluate(`({thinking:(${thinking}).checked,sound:(${sound}).checked})`), saved)
		await check("d.querySelector('[data-testid=save-button]').disabled")
		await capture("settings-preferences-chat-search")
	}
	const verifyTinyConfirmationFocus = async () => {
		await go("preferences")
		const readSettings = () =>
			evaluate(`({ask:d.querySelector('[data-testid=approval-mode-ask]').getAttribute('aria-pressed'),
			bypass:d.querySelector('[data-testid=approval-mode-bypass]').getAttribute('aria-pressed'),
			memory:['memory-enabled','memory-useMemories','memory-generateMemories'].map(id=>d.getElementById(id)?.getAttribute('aria-checked')),
			saveDisabled:d.querySelector('[data-testid=save-button]').disabled})`)
		const before = await readSettings()
		await check(
			"d.querySelector('[data-testid=approval-mode-ask]').getAttribute('aria-pressed')==='true'&&d.querySelector('[data-testid=save-button]').disabled",
		)
		const key = async (value: "Enter" | "Escape") => {
			for (const type of ["keyDown", "keyUp"]) {
				await cdp.request(
					"Input.dispatchKeyEvent",
					{
						type,
						key: value,
						code: value,
						windowsVirtualKeyCode: value === "Enter" ? 13 : 27,
						...(value === "Enter" && type === "keyDown" ? { text: "\r" } : {}),
					},
					sessionId,
				)
			}
		}
		for (const [name, title, opener] of [
			["full-access", "Enable Full Access?", "d.querySelector('[data-testid=approval-mode-bypass]')"],
			[
				"memory-reset",
				"Reset all memories?",
				"[...d.querySelectorAll('[data-settings-section=preferences] button')].find(e=>e.textContent.trim()==='Reset all memories')",
			],
		] as const) {
			await revealControl(opener)
			for (const dismissal of ["cancel", "escape"] as const) {
				await evaluate(
					`((${opener}).scrollIntoView({block:'center',behavior:'instant'}),(${opener}).focus(),true)`,
				)
				await check(`d.activeElement===(${opener})`)
				await key("Enter")
				const dialog = "d.querySelector('[role=alertdialog]')"
				await check(
					`!!(${dialog})&&(${dialog}).textContent.includes(${javascriptLiteral(title)})&&(${dialog}).contains(d.activeElement)`,
				)
				await check(
					`(()=>{const e=${dialog},r=e.getBoundingClientRect(),w=d.documentElement.clientWidth,h=d.documentElement.clientHeight;
						return e.classList.contains('settings-confirmation-dialog')&&r.left>=0&&r.right<=w&&r.top>=0&&r.bottom<=h&&
						[...e.querySelectorAll('button')].every(button=>{const b=button.getBoundingClientRect();return b.width>0&&b.left>=0&&b.right<=w&&b.top>=0&&b.bottom<=h})})()`,
				)
				await capture(`settings-tiny-${name}-${dismissal}-dialog`)
				if (dismissal === "cancel") {
					const cancel = `([...(${dialog}).querySelectorAll('button')].find(e=>e.textContent.trim()==='Cancel'))`
					await evaluate(`((${cancel}).focus(),true)`)
					await check(`d.activeElement===(${cancel})`)
					await key("Enter")
				} else {
					await key("Escape")
				}
				await check(`!(${dialog})&&d.activeElement===(${opener})`)
				assert.deepEqual(
					await readSettings(),
					before,
					`${name} ${dismissal}: cancellation must not change permission or memory settings`,
				)
			}
		}
	}
	const dismissHomeAnnouncement = async () => {
		// Returning to visible chat can mount its queued release dialog after the navigation commit.
		await settlePaint()
		const announcement = `([...d.querySelectorAll('[role=dialog]')].find(e=>
			/^Welcome to Alpha v[0-9]/.test(e.querySelector('[data-slot=dialog-title]')?.textContent.trim()??'')))`
		if (!(await evaluate<boolean>(`!!(${announcement})`))) return
		await capture("settings-home-release-announcement")
		const close = `([...(${announcement}).querySelectorAll('button')].find(e=>e.textContent.trim()==='Close'))`
		await click(close)
		await check(`!(${announcement})&&!d.querySelector('[role=dialog]')`)
		await capture("settings-home-release-dismissed")
	}
	const verifyCustomAgents = async () => {
		await go("tools")
		const advanced = "d.querySelector('[data-settings-section=tools] details[data-agents-advanced]')"
		const name = "d.getElementById('agents-new-type-name')"
		const description = "d.getElementById('agents-new-type-description')"
		const assertFormVisibility = async (phase: string, visible: boolean) => {
			await settlePaint()
			const state = await evaluate<{
				advancedOpen: boolean
				fields: Array<{
					id: string
					mounted: boolean
					supported: boolean
					visible: boolean | null
					closedDetails: boolean
					rectCount: number
				}>
			}>(`(()=>{const fields=[${name},${description}];return {advancedOpen:(${advanced})?.open,
				fields:fields.map(e=>({id:e?.id??'missing',mounted:!!e?.isConnected,supported:typeof e?.checkVisibility==='function',
					visible:typeof e?.checkVisibility==='function'?e.checkVisibility():null,closedDetails:!!e?.closest('details:not([open])'),
					rectCount:e?.getClientRects().length??0}))}})()`)
			await fs.writeFile(
				path.join(directory, `ui-settings-agents-${phase}-visibility.json`),
				JSON.stringify(state, null, 2),
			)
			assert.equal(state.advancedOpen, visible, `${phase}: the agent disclosure must match its expected state`)
			for (const field of state.fields) {
				assert.ok(field.mounted, `${phase}: ${field.id} must remain mounted`)
				assert.ok(field.supported, `${phase}: the actual browser must expose checkVisibility`)
				assert.equal(field.visible, visible, `${phase}: ${field.id} must be ${visible ? "visible" : "hidden"}`)
				assert.equal(field.closedDetails, !visible, `${phase}: ${field.id} must follow its native disclosure`)
			}
		}
		await check(`!!(${advanced})`)
		await evaluate(`((${advanced}).scrollIntoView({block:'center',behavior:'instant'}),true)`)
		await capture("settings-agents-collapsed")
		await assertFormVisibility("collapsed", false)
		await click(`(${advanced}).querySelector(':scope > summary')`)
		await assertFormVisibility("opened", true)
		const draftName = "settings_fixture_agent"
		const draftDescription = "Review changes for this renderer fixture."
		await replaceInput(name, draftName)
		await replaceInput(description, draftDescription)
		await capture("settings-agents-expanded-draft")
		await click(`(${advanced}).querySelector(':scope > summary')`)
		await assertFormVisibility("folded", false)
		await click(`(${advanced}).querySelector(':scope > summary')`)
		await assertFormVisibility("reopened", true)
		await check(
			`(${advanced}).open&&(${name}).value===${javascriptLiteral(draftName)}&&(${description}).value===${javascriptLiteral(draftDescription)}`,
		)
		await replaceInput(name, "")
		await replaceInput(description, "")
		await check("d.querySelector('[data-testid=save-button]').disabled")
		await click(`(${advanced}).querySelector(':scope > summary')`)
		await check(`!(${advanced}).open`)
		await go("providers")
		await click("d.querySelector('[data-testid=settings-search-input]')")
		await cdp.request("Input.insertText", { text: "Custom agents" }, sessionId)
		await check("!!d.querySelector('#settings-search-result-agents-types')")
		await click("d.querySelector('#settings-search-result-agents-types')")
		await check(`${tab("tools")}?.getAttribute('aria-selected')==='true'&&(${advanced}).open`)
		await assertFormVisibility("search-expanded", true)
		await check("d.querySelector('[data-setting-id=agents-types]')?.checkVisibility()===true")
		await check(`(${name}).value===''&&(${description}).value===''`)
		await capture("settings-agents-search-expanded")
		await click(`(${advanced}).querySelector(':scope > summary')`)
		await check(`!(${advanced}).open&&d.querySelector('[data-testid=save-button]').disabled`)
		await go("tools")
	}
	const verifyBackgroundSettingAbsent = async () => {
		await go("preferences")
		assert.equal(
			await evaluate("!!d.querySelector('[data-setting-id=experimental-prevent_focus_disruption]')"),
			false,
		)
		assert.equal(
			await evaluate(
				"[...d.querySelectorAll('[data-settings-section=preferences] vscode-checkbox,[data-settings-section=preferences] [role=checkbox],[data-settings-section=preferences] input[type=checkbox],[data-settings-section=preferences] button[aria-label]')].some(e=>/background editing/i.test(e.getAttribute('aria-label')??e.textContent))",
			),
			false,
			"Background editing should not remain a preference or help control",
		)
		const search = "d.querySelector('[data-testid=settings-search-input]')"
		await replaceInput(search, "Background editing")
		await check("!!d.querySelector('[role=listbox]')")
		assert.equal(
			await evaluate(
				"!!d.querySelector('#settings-search-result-experimental-prevent_focus_disruption')||[...d.querySelectorAll('[role=listbox] [role=option]')].some(e=>e.textContent.trim().toLowerCase()==='background editing')",
			),
			false,
			"The removed preference should not remain in settings search metadata",
		)
		await capture("settings-background-preference-absent")
		await replaceInput(search, "")
		await check(
			"d.querySelector('[data-testid=settings-search-input]').getAttribute('aria-expanded')==='false'&&d.querySelector('[data-testid=save-button]').disabled",
		)
		assert.equal(
			await evaluate("!!d.querySelector('[data-setting-id=about-telemetry],#preferences-telemetry')"),
			false,
		)
		assert.equal(
			await evaluate(
				"/Allow anonymous error and usage reporting|Help improve Alpha|anonymous usage reporting/i.test(d.body.innerText)",
			),
			false,
			"Anonymous reporting controls and banners must not remain in the UI",
		)
		await replaceInput(search, "Allow anonymous error and usage reporting")
		await check("!!d.querySelector('[role=listbox]')")
		assert.equal(
			await evaluate(
				"!!d.querySelector('#settings-search-result-about-telemetry')||[...d.querySelectorAll('[role=listbox] [role=option]')].some(e=>/anonymous.*reporting/i.test(e.textContent))",
			),
			false,
			"Anonymous reporting must not remain in settings search",
		)
		await capture("settings-reporting-preference-absent")
		await replaceInput(search, "")
		await check("d.querySelector('[data-testid=save-button]').disabled")
	}
	const searchRecovery = async (name: string) => {
		await go("providers")
		await click("d.querySelector('[data-testid=settings-search-input]')")
		await cdp.request("Input.insertText", { text: "Checkpoint timeout" }, sessionId)
		const result = "d.querySelector('#settings-search-result-checkpoints-timeout')"
		await check(`!!(${result})`)
		await capture(`settings-${name}-search-results`)
		await fs.writeFile(
			path.join(directory, `ui-settings-${name}-search-hit.json`),
			JSON.stringify(
				await evaluate(`(()=>{const e=${result},r=e.getBoundingClientRect();const list=e.closest('[role=listbox]').getBoundingClientRect();
					const hit=d.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
					return {viewport:d.documentElement.clientWidth,result:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},
						list:{left:list.left,right:list.right},hit:hit?.outerHTML.slice(0,2000),hitIsResult:!!hit&&e.contains(hit)}})()`),
				null,
				2,
			),
		)
		await check(
			`(()=>{const e=${result},r=e.closest('[role=listbox]').getBoundingClientRect();return r.left>=0&&r.right<=d.documentElement.clientWidth})()`,
		)
		await click(result)
		await check(`${tab("advanced")}?.getAttribute('aria-selected')==='true'`)
		await check(
			"(()=>{const e=d.querySelector('[data-testid=settings-content] [data-setting-id=checkpoints-timeout]');return !!e&&e.getClientRects().length>0&&!Array.from(d.querySelectorAll('details:not([open])')).some(p=>p.contains(e))})()",
		)
		const bounds = await evaluate(`(()=>{
			const card=d.querySelector('[data-settings-page-card=advanced]');
			const recovery=card.querySelector('[data-settings-group=recovery]');
			const heading=recovery.querySelector(':scope > h4').getBoundingClientRect();
			const controls=recovery.querySelector('[data-setting-id=checkpoints-enable]').getBoundingClientRect();
			return {cardCount:d.querySelectorAll('[data-settings-section=advanced] .surface-raised').length,
				heading:{left:heading.left,right:heading.right},controls:{left:controls.left,right:controls.right}}})()`)
		await fs.writeFile(
			path.join(directory, `ui-settings-${name}-recovery-bounds.json`),
			JSON.stringify(bounds, null, 2),
		)
		await check(`(()=>{const card=d.querySelector('[data-settings-page-card=advanced]'),recovery=card.querySelector('[data-settings-group=recovery]');
			const heading=recovery.querySelector(':scope > h4').getBoundingClientRect(),controls=recovery.querySelector('[data-setting-id=checkpoints-enable]').getBoundingClientRect();
			return card.querySelectorAll('.surface-raised').length===0&&heading.width>0&&controls.width>0&&
				Math.abs(heading.left-controls.left)<=1&&Math.abs(heading.right-controls.right)<=1})()`)
		await capture(`settings-${name}-search-recovery`)
	}
	const stages = [
		"settings-layout",
		"settings-buffered-discard",
		"settings-save",
		"settings-resources",
		"settings-light",
		"settings-narrow",
		"settings-tiny",
	]
	await cdp.request("Page.bringToFront", {}, workbenchSession)
	const completed: string[] = []
	for (const stage of stages) {
		await waitUntil(
			async () => {
				signal?.throwIfAborted()
				try {
					const detail = JSON.parse(await fs.readFile(path.join(directory, `ui-stage-${stage}.json`), "utf8"))
					assert.equal(detail.nonce, nonce)
					assert.equal(detail.stage, stage)
					return true
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
					throw error
				}
			},
			Date.now() + 60_000,
			`ui_${stage}_missing`,
		)
		if (stage === "settings-layout") {
			await resizeSidebar(520)
			await assertNavigation()
			await check("!d.querySelector('[data-setting-id=agents-enabled]')")
			assert.equal(
				await evaluate<boolean>(
					"d.querySelector('[data-testid=settings-content]').innerText.includes('Choose how chat behaves, manage local memory, and review privacy preferences.')",
				),
				false,
				"The settings pages should not repeat introduction paragraphs",
			)
			await verifyProviderFieldLayout()
			await layout("dark")
			await verifyTerminalSettingsRetired()
			await verifyPromptDisclosure("wide")
			await verifyPreferenceGroups()
			await verifyPermissionsAdvanced()
			await verifyHelp("wide")
		} else if (stage === "settings-buffered-discard" || stage === "settings-save") {
			await go("preferences")
			if (stage === "settings-buffered-discard") await verifyBackgroundSettingAbsent()
			const reasoning = "d.querySelector('[data-testid=collapse-thinking-checkbox]')"
			await revealControl(reasoning)
			await check(`${reasoning}?.checked===true`)
			await click(reasoning)
			await check(`${reasoning}?.checked===false&&!d.querySelector('[data-testid=save-button]').disabled`)
			if (stage === "settings-buffered-discard") {
				await click(button("Done"))
				await check("!!d.querySelector('[role=alertdialog]')")
				await capture("settings-discard-dialog")
				await click(button("Discard changes"))
				await check("!d.querySelector('[data-testid=settings-content]')")
			} else {
				await click("d.querySelector('[data-testid=save-button]')")
				await check("d.querySelector('[data-testid=save-button]').disabled")
				await capture("settings-saved-preference")
			}
		} else if (stage === "settings-resources") {
			await go("tools")
			for (const settingId of ["skills-management", "agents-enabled", "mcp-management"]) {
				await check(`!!d.querySelector('[data-setting-id="${settingId}"]')`)
			}
			await verifyCustomAgents()
			await capture("settings-tools-managers")
			await searchRecovery("wide")
			await click("d.querySelector('[data-testid=settings-about-button]')")
			await check(
				"!!d.querySelector('[data-testid=about-view]')&&!d.querySelector('[data-testid=settings-content]')",
			)
			await capture("settings-about-manager")
			await click("[...d.querySelectorAll('button')].find(e=>e.textContent.trim().startsWith('Back to tasks'))")
			await check("!!d.querySelector('[data-testid=worktree-selector-trigger]')")
			await dismissHomeAnnouncement()
			await click("d.querySelector('[data-testid=worktree-selector-trigger]')")
			await click("d.querySelector('[data-testid=manage-worktrees-button]')")
			await check(
				"!!d.querySelector('[data-testid=worktrees-manager-view]')&&!d.querySelector('[data-testid=settings-content]')",
			)
			await capture("settings-worktrees-manager")
			await click("[...d.querySelectorAll('button')].find(e=>e.textContent.trim().startsWith('Back to tasks'))")
		} else if (stage === "settings-light") {
			await check("d.body.classList.contains('vscode-light')")
			await layout("light")
		} else if (stage === "settings-narrow") {
			await resizeSidebar(320)
			await assertNavigation()
			await compactHome("narrow")
			for (const [section] of sections) {
				await go(section)
				await assertHeaderFits()
				await capture(`settings-narrow-${section}`)
			}
		} else if (stage === "settings-tiny") {
			await resizeSidebar(169)
			await assertNavigation()
			await compactHome("tiny")
			for (const [section] of sections) {
				await go(section)
				await assertHeaderFits()
				await verifyTinyControls(section)
				await capture(`settings-tiny-${section}`)
			}
			await verifyPromptDisclosure("tiny")
			await searchRecovery("tiny")
			await verifyHelp("tiny")
			await verifyCoarsePointer()
			await verifyTinyConfirmationFocus()
			await go("preferences")
			const reasoning = "d.querySelector('[data-testid=collapse-thinking-checkbox]')"
			await revealControl(reasoning)
			await check(`${reasoning}?.checked===false`)
			await click(reasoning)
			await click(button("Done"))
			await check(
				"(()=>{const dialog=d.querySelector('[role=alertdialog]');if(!dialog)return false;const w=d.documentElement.clientWidth,r=dialog.getBoundingClientRect();return r.left>=0&&r.right<=w&&[...dialog.querySelectorAll('button')].every(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.left>=0&&b.right<=w})})()",
			)
			await capture("settings-tiny-discard-dialog")
			await click(button("Discard changes"))
			await check("!d.querySelector('[data-testid=settings-content]')")
		}
		await fs.writeFile(
			path.join(directory, `ui-done-${stage}.json`),
			JSON.stringify({ nonce, stage, status: "passed" }),
			{ flag: "wx" },
		)
		completed.push(stage)
	}
	return completed
}
