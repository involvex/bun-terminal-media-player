import {
	CFunction,
	FFIType,
	dlopen,
	read,
	toArrayBuffer,
	type Pointer,
} from 'bun:ffi'
import Mfplat, {MFMediaType_Video, MFVideoFormat_RGB32} from '@bun-win32/mfplat'
import type {DecodedFrame, VideoSource} from '../types'
import '@bun-win32/core'

const invokers = new Map<string, ReturnType<typeof CFunction>>()
const IUNKNOWN_RELEASE = 2

function vcall(
	thisPtr: bigint,
	slot: number,
	argTypes: readonly FFIType[],
	args: readonly unknown[],
	returns: FFIType = FFIType.i32,
): number {
	const vtable = read.u64(Number(thisPtr) as Pointer, 0)
	const method = read.u64(Number(vtable) as Pointer, slot * 8)
	const key = `${method}|${returns}|${argTypes.join(',')}`
	let invoke = invokers.get(key)
	if (invoke === undefined) {
		invoke = CFunction({
			ptr: Number(method) as Pointer,
			args: [FFIType.u64, ...argTypes],
			returns,
		})
		invokers.set(key, invoke)
	}
	return invoke(thisPtr, ...args) as number
}

function comRelease(thisPtr: bigint): void {
	if (thisPtr !== 0n) vcall(thisPtr, IUNKNOWN_RELEASE, [], [], FFIType.u32)
}

const S_OK = 0
const MF_VERSION = 0x0002_0070
const MFSTARTUP_LITE = 0x1
const MF_SOURCE_READER_FIRST_VIDEO_STREAM = 0xffff_fffc
const MF_SOURCE_READERF_ENDOFSTREAM = 0x2
const VT_I8 = 20

const MF_MT_MAJOR_TYPE = '48eba18e-f8c9-4687-bf11-0a74c9f96a8f'
const MF_MT_SUBTYPE = 'f7e34c9a-42e8-4714-b74b-cb29d72c35e5'
const MF_MT_FRAME_SIZE = '1652c33d-d6b2-4012-b834-72030849a37d'
const MF_MT_FRAME_RATE = 'c459a2e8-3d2c-4e44-b132-fee5156c7bb0'
const MF_MT_DEFAULT_STRIDE = '644b4e48-1e02-4516-b0eb-c01ca9d49ac6'
const MF_PD_DURATION = '6c990d33-bb8e-477a-8598-0d5d96fcd88a'
const MF_SOURCE_READER_MEDIASOURCE = 0xffff_ffff
const MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING =
	'fb394f3d-ccf1-42ee-bbb3-f9b845d5681d'

const READER_GET_NATIVE_MEDIA_TYPE = 5
const READER_GET_CURRENT_MEDIA_TYPE = 6
const READER_SET_CURRENT_MEDIA_TYPE = 7
const READER_SET_CURRENT_POSITION = 8
const READER_READ_SAMPLE = 9
const READER_GET_PRESENTATION_ATTRIBUTE = 12
const ATTR_GET_UINT32 = 7
const ATTR_GET_UINT64 = 8
const ATTR_SET_UINT32 = 21
const ATTR_SET_GUID = 24
const SAMPLE_CONVERT_TO_CONTIGUOUS_BUFFER = 41
const BUFFER_LOCK = 3
const BUFFER_UNLOCK = 4

const hex = (hr: number): string =>
	`0x${(hr >>> 0).toString(16).padStart(8, '0')}`

function wide(s: string): Buffer {
	return Buffer.from(`${s}\0`, 'utf16le')
}

function guidBytes(value: string): Buffer {
	const match =
		/^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(
			value,
		)
	if (match === null) throw new Error(`Invalid GUID: ${value}`)
	const [, d1, d2, d3, d4High, d4Low] = match
	const buffer = Buffer.alloc(16)
	buffer.writeUInt32LE(parseInt(d1!, 16), 0)
	buffer.writeUInt16LE(parseInt(d2!, 16), 4)
	buffer.writeUInt16LE(parseInt(d3!, 16), 6)
	const data4 = `${d4High}${d4Low}`
	for (let i = 0; i < 8; i += 1)
		buffer[8 + i] = parseInt(data4.slice(i * 2, i * 2 + 2), 16)
	return buffer
}

const mfrw = dlopen('mfreadwrite.dll', {
	MFCreateSourceReaderFromURL: {
		args: [FFIType.ptr, FFIType.u64, FFIType.ptr],
		returns: FFIType.i32,
	},
})

const ppAttrs = Buffer.alloc(8)
const ppReader = Buffer.alloc(8)
const ppNativeType = Buffer.alloc(8)
const ppMediaType = Buffer.alloc(8)
const ppOutputType = Buffer.alloc(8)
const frameSizeOut = Buffer.alloc(8)
const frameRateOut = Buffer.alloc(8)
const strideOut = Buffer.alloc(4)
const durationOut = Buffer.alloc(16)
const pActualIndex = Buffer.alloc(4)
const pStreamFlags = Buffer.alloc(4)
const pTimestamp = Buffer.alloc(8)
const ppSample = Buffer.alloc(8)
const ppBuffer = Buffer.alloc(8)
const ppData = Buffer.alloc(8)
const pMaxLen = Buffer.alloc(4)
const pCurLen = Buffer.alloc(4)
const seekProp = Buffer.alloc(16)
const guidNull = Buffer.alloc(16)

export function createVideoSource(path: string): VideoSource {
	const fail = (error: string): VideoSource => ({
		ok: false,
		error,
		w: 0,
		h: 0,
		durationSec: 0,
		fps: 0,
		decodeNextFrame: () => null,
		releaseFrame: () => {},
		seekTo: () => {},
		shutdown: () => {},
	})

	if (Mfplat.MFCreateAttributes(ppAttrs.ptr!, 1) !== S_OK)
		return fail('MFCreateAttributes failed')
	const attrs = ppAttrs.readBigUInt64LE(0)
	const keyVP = guidBytes(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING)
	vcall(attrs, ATTR_SET_UINT32, [FFIType.ptr, FFIType.u32], [keyVP.ptr!, 1])

	const wpath = wide(path)
	const createHr = mfrw.symbols.MFCreateSourceReaderFromURL(
		wpath.ptr!,
		attrs,
		ppReader.ptr!,
	)
	comRelease(attrs)
	if (createHr !== S_OK)
		return fail(`MFCreateSourceReaderFromURL ${hex(createHr)}`)
	const reader = ppReader.readBigUInt64LE(0)

	let w = 0,
		h = 0,
		fps = 0
	if (
		vcall(
			reader,
			READER_GET_NATIVE_MEDIA_TYPE,
			[FFIType.u32, FFIType.u32, FFIType.ptr],
			[MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, ppNativeType.ptr!],
		) === S_OK
	) {
		const nativeType = ppNativeType.readBigUInt64LE(0)
		const keySize = guidBytes(MF_MT_FRAME_SIZE)
		if (
			vcall(
				nativeType,
				ATTR_GET_UINT64,
				[FFIType.ptr, FFIType.ptr],
				[keySize.ptr!, frameSizeOut.ptr!],
			) === S_OK
		) {
			w = frameSizeOut.readUInt32LE(4)
			h = frameSizeOut.readUInt32LE(0)
		}
		const keyRate = guidBytes(MF_MT_FRAME_RATE)
		if (
			vcall(
				nativeType,
				ATTR_GET_UINT64,
				[FFIType.ptr, FFIType.ptr],
				[keyRate.ptr!, frameRateOut.ptr!],
			) === S_OK
		) {
			const num = frameRateOut.readUInt32LE(4)
			const den = frameRateOut.readUInt32LE(0)
			if (den > 0) fps = num / den
		}
		comRelease(nativeType)
	}
	if (w <= 0 || h <= 0) {
		comRelease(reader)
		return fail('no video stream / zero frame size')
	}

	if (Mfplat.MFCreateMediaType(ppMediaType.ptr!) !== S_OK) {
		comRelease(reader)
		return fail('MFCreateMediaType failed')
	}
	const mt = ppMediaType.readBigUInt64LE(0)
	vcall(
		mt,
		ATTR_SET_GUID,
		[FFIType.ptr, FFIType.ptr],
		[guidBytes(MF_MT_MAJOR_TYPE).ptr!, guidBytes(MFMediaType_Video).ptr!],
	)
	vcall(
		mt,
		ATTR_SET_GUID,
		[FFIType.ptr, FFIType.ptr],
		[guidBytes(MF_MT_SUBTYPE).ptr!, guidBytes(MFVideoFormat_RGB32).ptr!],
	)
	const setHr = vcall(
		reader,
		READER_SET_CURRENT_MEDIA_TYPE,
		[FFIType.u32, FFIType.ptr, FFIType.u64],
		[MF_SOURCE_READER_FIRST_VIDEO_STREAM, null, mt],
	)
	comRelease(mt)
	if (setHr !== S_OK) {
		comRelease(reader)
		return fail(`SetCurrentMediaType(RGB32) ${hex(setHr)}`)
	}
	vcall(
		reader,
		4,
		[FFIType.u32, FFIType.i32],
		[MF_SOURCE_READER_FIRST_VIDEO_STREAM, 1],
	)

	let stride = w * 4,
		flip = false,
		strideKnown = false
	if (
		vcall(
			reader,
			READER_GET_CURRENT_MEDIA_TYPE,
			[FFIType.u32, FFIType.ptr],
			[MF_SOURCE_READER_FIRST_VIDEO_STREAM, ppOutputType.ptr!],
		) === S_OK
	) {
		const outType = ppOutputType.readBigUInt64LE(0)
		const keyStride = guidBytes(MF_MT_DEFAULT_STRIDE)
		if (
			vcall(
				outType,
				ATTR_GET_UINT32,
				[FFIType.ptr, FFIType.ptr],
				[keyStride.ptr!, strideOut.ptr!],
			) === S_OK
		) {
			const signed = strideOut.readInt32LE(0)
			if (signed !== 0) {
				flip = signed < 0
				stride = Math.abs(signed)
				strideKnown = true
			}
		}
		comRelease(outType)
	}

	let durationSec = 0
	const keyDur = guidBytes(MF_PD_DURATION)
	durationOut.fill(0)
	if (
		vcall(
			reader,
			READER_GET_PRESENTATION_ATTRIBUTE,
			[FFIType.u32, FFIType.ptr, FFIType.ptr],
			[MF_SOURCE_READER_MEDIASOURCE, keyDur.ptr!, durationOut.ptr!],
		) === S_OK
	) {
		const ticks = durationOut.readBigUInt64LE(8)
		if (ticks > 0n) durationSec = Number(ticks) / 1e7
	}

	let alive = true
	let frameHeld = false
	let heldBuffer = 0n,
		heldSample = 0n

	const releaseHeld = (): void => {
		if (!frameHeld) return
		frameHeld = false
		vcall(heldBuffer, BUFFER_UNLOCK, [], [], FFIType.i32)
		comRelease(heldBuffer)
		comRelease(heldSample)
		heldBuffer = 0n
		heldSample = 0n
	}

	return {
		ok: true,
		error: '',
		w,
		h,
		durationSec,
		fps,
		seekTo(seconds: number): void {
			if (!alive) return
			releaseHeld()
			const ticks = BigInt(Math.floor(seconds * 1e7))
			seekProp.fill(0)
			seekProp.writeUInt16LE(VT_I8, 0)
			seekProp.writeBigInt64LE(ticks, 8)
			vcall(
				reader,
				READER_SET_CURRENT_POSITION,
				[FFIType.ptr, FFIType.ptr],
				[guidNull.ptr!, seekProp.ptr!],
			)
		},
		decodeNextFrame(): DecodedFrame | null {
			if (!alive) return null
			const hr = vcall(
				reader,
				READER_READ_SAMPLE,
				[
					FFIType.u32,
					FFIType.u32,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.ptr,
					FFIType.ptr,
				],
				[
					MF_SOURCE_READER_FIRST_VIDEO_STREAM,
					0,
					pActualIndex.ptr!,
					pStreamFlags.ptr!,
					pTimestamp.ptr!,
					ppSample.ptr!,
				],
			)
			if (hr !== S_OK) return null

			if (
				(pStreamFlags.readUInt32LE(0) & MF_SOURCE_READERF_ENDOFSTREAM) !==
				0
			) {
				seekProp.fill(0)
				seekProp.writeUInt16LE(VT_I8, 0)
				seekProp.writeBigInt64LE(0n, 8)
				vcall(
					reader,
					READER_SET_CURRENT_POSITION,
					[FFIType.ptr, FFIType.ptr],
					[guidNull.ptr!, seekProp.ptr!],
				)
				return null
			}

			const sample = ppSample.readBigUInt64LE(0)
			if (sample === 0n) return null

			const tsSec = Number(pTimestamp.readBigInt64LE(0)) / 1e7
			if (
				vcall(
					sample,
					SAMPLE_CONVERT_TO_CONTIGUOUS_BUFFER,
					[FFIType.ptr],
					[ppBuffer.ptr!],
				) !== S_OK
			) {
				comRelease(sample)
				return null
			}
			const buffer = ppBuffer.readBigUInt64LE(0)
			if (
				vcall(
					buffer,
					BUFFER_LOCK,
					[FFIType.ptr, FFIType.ptr, FFIType.ptr],
					[ppData.ptr!, pMaxLen.ptr!, pCurLen.ptr!],
				) !== S_OK
			) {
				comRelease(buffer)
				comRelease(sample)
				return null
			}
			const dataPtr = ppData.readBigUInt64LE(0)
			const curLen = pCurLen.readUInt32LE(0)
			if (dataPtr === 0n || curLen === 0) {
				vcall(buffer, BUFFER_UNLOCK, [], [], FFIType.i32)
				comRelease(buffer)
				comRelease(sample)
				return null
			}

			let rowStride = stride
			if (!strideKnown) {
				const fromLen = Math.floor(curLen / h)
				rowStride = fromLen >= w * 4 ? fromLen : w * 4
			}

			releaseHeld()
			heldBuffer = buffer
			heldSample = sample
			frameHeld = true
			const bytes = new Uint8Array(
				toArrayBuffer(Number(dataPtr) as Pointer, 0, curLen),
			)
			return {bytes, stride: rowStride, flip, tsSec}
		},
		releaseFrame(): void {
			releaseHeld()
		},
		shutdown(): void {
			if (!alive) return
			this.releaseFrame()
			alive = false
			comRelease(reader)
		},
	}
}

export function closeMfreadwrite(): void {
	mfrw.close()
}
