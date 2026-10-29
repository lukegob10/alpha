import React, { useRef, useLayoutEffect, memo } from "react"
import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"

interface ThumbnailsProps {
	images: string[]
	style?: React.CSSProperties
	setImages?: React.Dispatch<React.SetStateAction<string[]>>
	onHeightChange?: (height: number) => void
}

const Thumbnails = ({ images, style, setImages, onHeightChange }: ThumbnailsProps) => {
	const { t } = useAppTranslation()
	const containerRef = useRef<HTMLDivElement>(null)

	useLayoutEffect(() => {
		const container = containerRef.current
		if (!onHeightChange || !container) return

		const measureHeight = () => {
			let height = container.clientHeight
			// some browsers return 0 for clientHeight
			if (!height) {
				height = container.getBoundingClientRect().height
			}
			onHeightChange(height)
		}
		let width = window.innerWidth
		let resizeFrame: number | undefined
		const handleResize = () => {
			if (window.innerWidth === width) return
			width = window.innerWidth
			if (resizeFrame !== undefined) return
			resizeFrame = window.requestAnimationFrame(() => {
				resizeFrame = undefined
				measureHeight()
			})
		}

		measureHeight()
		window.addEventListener("resize", handleResize)
		return () => {
			window.removeEventListener("resize", handleResize)
			if (resizeFrame !== undefined) window.cancelAnimationFrame(resizeFrame)
		}
	}, [images, onHeightChange])

	const handleDelete = (index: number) => {
		setImages?.((prevImages) => prevImages.filter((_, i) => i !== index))
	}

	const isDeletable = setImages !== undefined

	const handleImageClick = (image: string) => {
		vscode.postMessage({ type: "openImage", text: image })
	}

	return (
		<div
			ref={containerRef}
			className="py-1"
			style={{
				display: "flex",
				flexWrap: "wrap",
				gap: 5,
				rowGap: 3,
				...style,
			}}>
			{images.map((image, index) => (
				<div key={index} className="group/thumbnail relative">
					<button
						type="button"
						aria-label={t("common:image.openAttachment", { number: index + 1 })}
						className="block cursor-pointer rounded border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder focus-visible:outline-offset-1"
						onClick={(event) => {
							event.stopPropagation()
							handleImageClick(image)
						}}>
						<img
							src={image}
							alt={t("common:image.attachment", { number: index + 1 })}
							style={{ width: 34, height: 34, objectFit: "cover", borderRadius: 4 }}
						/>
					</button>
					{isDeletable && (
						<button
							type="button"
							aria-label={t("common:image.removeAttachment", { number: index + 1 })}
							className="pointer-events-none border-0 p-0 opacity-0 group-hover/thumbnail:pointer-events-auto group-hover/thumbnail:opacity-100 group-focus-within/thumbnail:pointer-events-auto group-focus-within/thumbnail:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder focus-visible:outline-offset-1"
							onClick={(event) => {
								event.stopPropagation()
								handleDelete(index)
							}}
							style={{
								position: "absolute",
								top: -4,
								right: -4,
								width: 13,
								height: 13,
								borderRadius: "50%",
								backgroundColor: "var(--vscode-badge-background)",
								display: "flex",
								justifyContent: "center",
								alignItems: "center",
								cursor: "pointer",
							}}>
							<span
								className="codicon codicon-close"
								aria-hidden="true"
								style={{
									color: "var(--vscode-foreground)",
									fontSize: 10,
									fontWeight: "bold",
								}}></span>
						</button>
					)}
				</div>
			))}
		</div>
	)
}

export default memo(Thumbnails)
