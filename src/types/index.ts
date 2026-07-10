export interface DecodedFrame {
	bytes: Uint8Array
	stride: number
	flip: boolean
	tsSec: number
}

export interface VideoSource {
	ok: boolean
	error: string
	w: number
	h: number
	durationSec: number
	fps: number
	decodeNextFrame(): DecodedFrame | null
	releaseFrame(): void
	seekTo(seconds: number): void
	shutdown(): void
}

export interface AudioSource {
	ok: boolean
	rate: number
	channels: number
	bits: number
	underruns: number
	feed(): void
	masterSec(): number
	pause(): void
	resume(): void
	seekTo(seconds: number): void
	setVolume(left: number, right: number): void
	shutdown(): void
}

export interface DownscaleLut {
	cols: number
	rows: number
	srcW: number
	srcH: number
	stride: number
	flip: boolean
	topOff: Int32Array
	botOff: Int32Array
	midOff: Int32Array
}

export type PlaybackMode = 'half' | 'ascii'

export interface YouTubeResult {
	title: string
	url: string
	duration: string
	viewCount: string
}

export interface PlayerOptions {
	path: string
	mode?: PlaybackMode
	turbo?: boolean
}
