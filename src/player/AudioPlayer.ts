import {
	CFunction,
	FFIType,
	dlopen,
	read,
	toArrayBuffer,
	type Pointer,
} from 'bun:ffi'
import Mfplat, {MFMediaType_Audio, MFAudioFormat_PCM} from '@bun-win32/mfplat'
import type {AudioSource} from '../types'
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
const MF_SOURCE_READER_FIRST_AUDIO_STREAM = 0xffff_fffd
const MF_SOURCE_READERF_ENDOFSTREAM = 0x2
const VT_I8 = 20

const MF_MT_MAJOR_TYPE = '48eba18e-f8c9-4687-bf11-0a74c9f96a8f'
const MF_MT_SUBTYPE = 'f7e34c9a-42e8-4714-b74b-cb29d72c35e5'
const MF_MT_AUDIO_NUM_CHANNELS = '37e48bf5-645e-4c5b-89de-ada9e29b696a'
const MF_MT_AUDIO_SAMPLES_PER_SECOND = '5faeeae7-0290-4c31-9e8a-c534f68d9dba'
const MF_MT_AUDIO_BITS_PER_SAMPLE = 'f2deb57f-40fa-4764-aa33-ed4f2d1ff669'

const WAVE_MAPPER = 0xffffffff
const WHDR_DONE = 0x1
const WHDR_PREPARED = 0x2
const TIME_BYTES = 4

const READER_SET_STREAM_SELECTION = 4
const READER_GET_CURRENT_MEDIA_TYPE = 6
const READER_SET_CURRENT_MEDIA_TYPE = 7
const READER_SET_CURRENT_POSITION = 8
const READER_READ_SAMPLE = 9
const ATTR_SET_GUID = 24
const ATTR_GET_UINT32 = 7
const SAMPLE_CONVERT_TO_CONTIGUOUS_BUFFER = 41
const BUFFER_LOCK = 3
const BUFFER_UNLOCK = 4

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

const winmm = dlopen('winmm.dll', {
	waveOutOpen: {
		args: [
			FFIType.ptr,
			FFIType.u32,
			FFIType.ptr,
			FFIType.u64,
			FFIType.u64,
			FFIType.u32,
		],
		returns: FFIType.u32,
	},
	waveOutPrepareHeader: {
		args: [FFIType.u64, FFIType.ptr, FFIType.u32],
		returns: FFIType.u32,
	},
	waveOutWrite: {
		args: [FFIType.u64, FFIType.ptr, FFIType.u32],
		returns: FFIType.u32,
	},
	waveOutUnprepareHeader: {
		args: [FFIType.u64, FFIType.ptr, FFIType.u32],
		returns: FFIType.u32,
	},
	waveOutGetPosition: {
		args: [FFIType.u64, FFIType.ptr, FFIType.u32],
		returns: FFIType.u32,
	},
	waveOutPause: {args: [FFIType.u64], returns: FFIType.u32},
	waveOutRestart: {args: [FFIType.u64], returns: FFIType.u32},
	waveOutReset: {args: [FFIType.u64], returns: FFIType.u32},
	waveOutClose: {args: [FFIType.u64], returns: FFIType.u32},
	waveOutSetVolume: {args: [FFIType.u64, FFIType.u32], returns: FFIType.u32},
	waveOutGetVolume: {args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32},
})

const AUDIO_RING = 8
const AUDIO_CHUNK = 16384
const WAVEHDR_SIZE = 48
const WAVEFORMATEX_SIZE = 18

export const audioWfx = Buffer.alloc(WAVEFORMATEX_SIZE)
const audioData: Buffer[] = []
const audioHdr: Buffer[] = []
for (let i = 0; i < AUDIO_RING; i++) {
	audioData.push(Buffer.alloc(AUDIO_CHUNK))
	audioHdr.push(Buffer.alloc(WAVEHDR_SIZE))
}
const audioMmtime = Buffer.alloc(16)

const aPpReader = Buffer.alloc(8)
const aPpMediaType = Buffer.alloc(8)
const aPpCurType = Buffer.alloc(8)
const aU32Out = Buffer.alloc(4)
const aPpHwo = Buffer.alloc(8)
const aActualIndex = Buffer.alloc(4)
const aStreamFlags = Buffer.alloc(4)
const aTimestamp = Buffer.alloc(8)
const aPpSample = Buffer.alloc(8)
const aPpBuffer = Buffer.alloc(8)
const aPpData = Buffer.alloc(8)
const aMaxLen = Buffer.alloc(4)
const aCurLen = Buffer.alloc(4)
const aSeekProp = Buffer.alloc(16)
const aGuidNull = Buffer.alloc(16)

export function createAudioSource(path: string): AudioSource {
	const disabled: AudioSource = {
		ok: false,
		rate: 0,
		channels: 0,
		bits: 0,
		underruns: 0,
		feed: () => {},
		masterSec: () => 0,
		pause: () => {},
		resume: () => {},
		seekTo: () => {},
		setVolume: () => {},
		shutdown: () => {},
	}

	const wpath = wide(path)
	if (
		mfrw.symbols.MFCreateSourceReaderFromURL(wpath.ptr!, 0n, aPpReader.ptr!) !==
		S_OK
	)
		return disabled
	const reader = aPpReader.readBigUInt64LE(0)

	if (Mfplat.MFCreateMediaType(aPpMediaType.ptr!) !== S_OK) {
		comRelease(reader)
		return disabled
	}
	const mt = aPpMediaType.readBigUInt64LE(0)
	vcall(
		mt,
		ATTR_SET_GUID,
		[FFIType.ptr, FFIType.ptr],
		[guidBytes(MF_MT_MAJOR_TYPE).ptr!, guidBytes(MFMediaType_Audio).ptr!],
	)
	vcall(
		mt,
		ATTR_SET_GUID,
		[FFIType.ptr, FFIType.ptr],
		[guidBytes(MF_MT_SUBTYPE).ptr!, guidBytes(MFAudioFormat_PCM).ptr!],
	)
	const setHr = vcall(
		reader,
		READER_SET_CURRENT_MEDIA_TYPE,
		[FFIType.u32, FFIType.ptr, FFIType.u64],
		[MF_SOURCE_READER_FIRST_AUDIO_STREAM, null, mt],
	)
	comRelease(mt)
	if (setHr !== S_OK) {
		comRelease(reader)
		return disabled
	}
	vcall(
		reader,
		READER_SET_STREAM_SELECTION,
		[FFIType.u32, FFIType.i32],
		[MF_SOURCE_READER_FIRST_AUDIO_STREAM, 1],
	)

	let rate = 48000,
		channels = 2,
		bits = 16
	if (
		vcall(
			reader,
			READER_GET_CURRENT_MEDIA_TYPE,
			[FFIType.u32, FFIType.ptr],
			[MF_SOURCE_READER_FIRST_AUDIO_STREAM, aPpCurType.ptr!],
		) === S_OK
	) {
		const cur = aPpCurType.readBigUInt64LE(0)
		const getU32 = (guid: string, def: number): number =>
			vcall(
				cur,
				ATTR_GET_UINT32,
				[FFIType.ptr, FFIType.ptr],
				[guidBytes(guid).ptr!, aU32Out.ptr!],
			) === S_OK
				? aU32Out.readUInt32LE(0)
				: def
		rate = getU32(MF_MT_AUDIO_SAMPLES_PER_SECOND, 48000)
		channels = getU32(MF_MT_AUDIO_NUM_CHANNELS, 2)
		bits = getU32(MF_MT_AUDIO_BITS_PER_SAMPLE, 16)
		comRelease(cur)
	}
	const blockAlign = channels * (bits / 8)
	const bytesPerSec = rate * blockAlign
	if (blockAlign <= 0 || bytesPerSec <= 0) {
		comRelease(reader)
		return disabled
	}

	audioWfx.fill(0)
	audioWfx.writeUInt16LE(1, 0)
	audioWfx.writeUInt16LE(channels, 2)
	audioWfx.writeUInt32LE(rate, 4)
	audioWfx.writeUInt32LE(bytesPerSec, 8)
	audioWfx.writeUInt16LE(blockAlign, 12)
	audioWfx.writeUInt16LE(bits, 14)

	if (
		winmm.symbols.waveOutOpen(
			aPpHwo.ptr!,
			WAVE_MAPPER,
			audioWfx.ptr!,
			0n,
			0n,
			0,
		) !== 0
	) {
		comRelease(reader)
		return disabled
	}
	const hwo = aPpHwo.readBigUInt64LE(0)

	for (let i = 0; i < AUDIO_RING; i++) {
		const hdr = audioHdr[i]!
		hdr.fill(0)
		hdr.writeBigUInt64LE(BigInt(audioData[i]!.ptr!), 0)
		hdr.writeUInt32LE(AUDIO_CHUNK, 8)
		winmm.symbols.waveOutPrepareHeader(hwo, hdr.ptr!, WAVEHDR_SIZE)
		hdr.writeUInt32LE(WHDR_DONE | WHDR_PREPARED, 24)
	}

	let alive = true
	let atEof = false
	let underruns = 0

	const decodeInto = (dest: Buffer): number => {
		let written = 0
		for (let tries = 0; tries < 8 && written === 0; tries++) {
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
					MF_SOURCE_READER_FIRST_AUDIO_STREAM,
					0,
					aActualIndex.ptr!,
					aStreamFlags.ptr!,
					aTimestamp.ptr!,
					aPpSample.ptr!,
				],
			)
			if (hr !== S_OK) return 0
			if (
				(aStreamFlags.readUInt32LE(0) & MF_SOURCE_READERF_ENDOFSTREAM) !==
				0
			) {
				atEof = true
				aSeekProp.fill(0)
				aSeekProp.writeUInt16LE(VT_I8, 0)
				aSeekProp.writeBigInt64LE(0n, 8)
				vcall(
					reader,
					READER_SET_CURRENT_POSITION,
					[FFIType.ptr, FFIType.ptr],
					[aGuidNull.ptr!, aSeekProp.ptr!],
				)
				return 0
			}
			const sample = aPpSample.readBigUInt64LE(0)
			if (sample === 0n) continue
			if (
				vcall(
					sample,
					SAMPLE_CONVERT_TO_CONTIGUOUS_BUFFER,
					[FFIType.ptr],
					[aPpBuffer.ptr!],
				) === S_OK
			) {
				const buffer = aPpBuffer.readBigUInt64LE(0)
				if (
					vcall(
						buffer,
						BUFFER_LOCK,
						[FFIType.ptr, FFIType.ptr, FFIType.ptr],
						[aPpData.ptr!, aMaxLen.ptr!, aCurLen.ptr!],
					) === S_OK
				) {
					const dataPtr = aPpData.readBigUInt64LE(0)
					const curLen = aCurLen.readUInt32LE(0)
					if (dataPtr !== 0n && curLen > 0) {
						const n = Math.min(curLen, dest.length)
						const view = new Uint8Array(
							toArrayBuffer(Number(dataPtr) as Pointer, 0, n),
						)
						dest.set(view, 0)
						written = n
					}
					vcall(buffer, BUFFER_UNLOCK, [], [], FFIType.i32)
				}
				comRelease(buffer)
			}
			comRelease(sample)
		}
		return written
	}

	return {
		ok: true,
		rate,
		channels,
		bits,
		get underruns(): number {
			return underruns
		},
		feed(): void {
			if (!alive) return
			let anyFree = false
			let wrote = false
			for (let i = 0; i < AUDIO_RING; i++) {
				const hdr = audioHdr[i]!
				if ((hdr.readUInt32LE(24) & WHDR_DONE) === 0) continue
				anyFree = true
				if (atEof) break
				const n = decodeInto(audioData[i]!)
				if (n === 0) break
				hdr.writeUInt32LE(n, 8)
				hdr.writeUInt32LE(hdr.readUInt32LE(24) & ~WHDR_DONE, 24)
				winmm.symbols.waveOutWrite(hwo, hdr.ptr!, WAVEHDR_SIZE)
				wrote = true
			}
			if (atEof) {
				let allDone = true
				for (let i = 0; i < AUDIO_RING; i++)
					if ((audioHdr[i]!.readUInt32LE(24) & WHDR_DONE) === 0) {
						allDone = false
						break
					}
				if (allDone) {
					winmm.symbols.waveOutReset(hwo)
					for (let i = 0; i < AUDIO_RING; i++)
						audioHdr[i]!.writeUInt32LE(WHDR_DONE | WHDR_PREPARED, 24)
					atEof = false
				}
				return
			}
			if (anyFree && !wrote && !atEof) underruns++
		},
		masterSec(): number {
			if (!alive) return 0
			audioMmtime.fill(0)
			audioMmtime.writeUInt32LE(TIME_BYTES, 0)
			if (winmm.symbols.waveOutGetPosition(hwo, audioMmtime.ptr!, 16) !== 0)
				return 0
			if (audioMmtime.readUInt32LE(0) !== TIME_BYTES) return 0
			return audioMmtime.readUInt32LE(4) / bytesPerSec
		},
		pause(): void {
			if (alive) winmm.symbols.waveOutPause(hwo)
		},
		resume(): void {
			if (alive) winmm.symbols.waveOutRestart(hwo)
		},
		seekTo(seconds: number): void {
			if (!alive) return
			winmm.symbols.waveOutReset(hwo)
			for (let i = 0; i < AUDIO_RING; i++)
				audioHdr[i]!.writeUInt32LE(WHDR_DONE | WHDR_PREPARED, 24)
			atEof = false
			const ticks = BigInt(Math.floor(seconds * 1e7))
			aSeekProp.fill(0)
			aSeekProp.writeUInt16LE(VT_I8, 0)
			aSeekProp.writeBigInt64LE(ticks, 8)
			vcall(
				reader,
				READER_SET_CURRENT_POSITION,
				[FFIType.ptr, FFIType.ptr],
				[aGuidNull.ptr!, aSeekProp.ptr!],
			)
		},
		setVolume(left: number, right: number): void {
			if (!alive) return
			const l = Math.max(0, Math.min(1, left))
			const r = Math.max(0, Math.min(1, right))
			const packed = (Math.round(r * 0xffff) << 16) | Math.round(l * 0xffff)
			winmm.symbols.waveOutSetVolume(hwo, packed)
		},
		shutdown(): void {
			if (!alive) return
			alive = false
			winmm.symbols.waveOutReset(hwo)
			for (let i = 0; i < AUDIO_RING; i++)
				winmm.symbols.waveOutUnprepareHeader(
					hwo,
					audioHdr[i]!.ptr!,
					WAVEHDR_SIZE,
				)
			winmm.symbols.waveOutClose(hwo)
			comRelease(reader)
		},
	}
}

export function closeWinmm(): void {
	winmm.close()
}

export function closeMfreadwrite(): void {
	mfrw.close()
}
