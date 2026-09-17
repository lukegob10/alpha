import React from "react"

import { cn } from "@/lib/utils"

export interface ToggleSwitchProps {
	checked: boolean
	onChange: () => void
	disabled?: boolean
	size?: "small" | "medium"
	"aria-label"?: string
	"data-testid"?: string
}

export const ToggleSwitch: React.FC<ToggleSwitchProps> = ({
	checked,
	onChange,
	disabled = false,
	size = "small",
	"aria-label": ariaLabel,
	"data-testid": dataTestId,
}) => {
	const dimensions =
		size === "small" ? { width: 28, height: 16, dotSize: 12 } : { width: 34, height: 18, dotSize: 14 }

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault()
			if (!disabled) {
				onChange()
			}
		}
	}

	return (
		<div
			role="switch"
			aria-checked={checked}
			aria-disabled={disabled}
			aria-label={ariaLabel}
			tabIndex={disabled ? -1 : 0}
			data-testid={dataTestId}
			className={cn(
				"relative shrink-0 rounded-full border border-vscode-foreground/20 shadow-inner transition-[background-color,border-color,box-shadow,opacity] duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-offset-1",
				disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:border-vscode-foreground/35",
			)}
			style={{
				width: `${dimensions.width}px`,
				height: `${dimensions.height}px`,
				backgroundColor: checked
					? "var(--vscode-button-background)"
					: "var(--vscode-button-secondaryBackground)",
			}}
			onClick={disabled ? undefined : onChange}
			onKeyDown={handleKeyDown}>
			<div
				style={{
					width: `${dimensions.dotSize}px`,
					height: `${dimensions.dotSize}px`,
					backgroundColor: checked ? "var(--vscode-button-foreground)" : "var(--vscode-foreground)",
					borderRadius: "50%",
					position: "absolute",
					top: `${(dimensions.height - dimensions.dotSize) / 2}px`,
					left: checked
						? `${dimensions.width - dimensions.dotSize - (dimensions.height - dimensions.dotSize) / 2}px`
						: `${(dimensions.height - dimensions.dotSize) / 2}px`,
					boxShadow: "0 1px 2px color-mix(in srgb, var(--vscode-widget-shadow, #000) 35%, transparent)",
					transition: "left 150ms ease-out, background-color 150ms ease-out",
				}}
			/>
		</div>
	)
}
