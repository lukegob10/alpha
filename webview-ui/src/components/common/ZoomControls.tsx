import { IconButton } from "./IconButton"
import { useRef, useEffect } from "react"

interface ZoomControlsProps {
	zoomLevel: number
	zoomInTitle: string
	zoomOutTitle: string
	useContinuousZoom?: boolean
	adjustZoom?: (amount: number) => void
	zoomInStep?: number
	zoomOutStep?: number
	onZoomIn?: () => void
	onZoomOut?: () => void
}

export function ZoomControls({
	zoomLevel,
	zoomInTitle,
	zoomOutTitle,
	useContinuousZoom = false,
	adjustZoom,
	zoomInStep = 0.1,
	zoomOutStep = -0.1,
	onZoomIn,
	onZoomOut,
}: ZoomControlsProps) {
	const zoomIntervalRef = useRef<NodeJS.Timeout | null>(null)

	/**
	 * Start continuous zoom on mouse down
	 */
	const startContinuousZoom = (amount: number) => {
		if (!useContinuousZoom || !adjustZoom) return

		// Clear any existing interval first
		if (zoomIntervalRef.current) {
			clearInterval(zoomIntervalRef.current)
		}

		// Immediately apply first zoom adjustment
		adjustZoom(amount)

		// Set up interval for continuous zooming
		zoomIntervalRef.current = setInterval(() => {
			adjustZoom(amount)
		}, 150) // Adjust every 150ms while button is held down
	}

	/**
	 * Stop continuous zoom on mouse up or mouse leave
	 */
	const stopContinuousZoom = () => {
		if (zoomIntervalRef.current) {
			clearInterval(zoomIntervalRef.current)
			zoomIntervalRef.current = null
		}
	}

	const handleContinuousZoomKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, amount: number) => {
		if (!useContinuousZoom || !adjustZoom || event.repeat) return

		if (event.key === "Enter" || event.key === " ") {
			// Prevent the button's native follow-on click from applying a second step.
			event.preventDefault()
			adjustZoom(amount)
		}
	}

	// Clean up interval on unmount
	useEffect(() => {
		return () => {
			if (zoomIntervalRef.current) {
				clearInterval(zoomIntervalRef.current)
			}
		}
	}, [])

	return (
		<div className="flex items-center gap-2">
			<IconButton
				icon="zoom-out"
				title={zoomOutTitle}
				onClick={!useContinuousZoom ? onZoomOut || (() => adjustZoom?.(zoomOutStep)) : undefined}
				onKeyDown={
					useContinuousZoom && adjustZoom
						? (event) => handleContinuousZoomKeyDown(event, zoomOutStep)
						: undefined
				}
				onMouseDown={useContinuousZoom && adjustZoom ? () => startContinuousZoom(zoomOutStep) : undefined}
				onMouseUp={useContinuousZoom && adjustZoom ? stopContinuousZoom : undefined}
				onMouseLeave={useContinuousZoom && adjustZoom ? stopContinuousZoom : undefined}
			/>
			<div className="text-sm text-vscode-editor-foreground min-w-[50px] text-center">
				{Math.round(zoomLevel * 100)}%
			</div>
			<IconButton
				icon="zoom-in"
				title={zoomInTitle}
				onClick={!useContinuousZoom ? onZoomIn || (() => adjustZoom?.(zoomInStep)) : undefined}
				onKeyDown={
					useContinuousZoom && adjustZoom
						? (event) => handleContinuousZoomKeyDown(event, zoomInStep)
						: undefined
				}
				onMouseDown={useContinuousZoom && adjustZoom ? () => startContinuousZoom(zoomInStep) : undefined}
				onMouseUp={useContinuousZoom && adjustZoom ? stopContinuousZoom : undefined}
				onMouseLeave={useContinuousZoom && adjustZoom ? stopContinuousZoom : undefined}
			/>
		</div>
	)
}
