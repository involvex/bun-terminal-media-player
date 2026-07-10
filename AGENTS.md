# AGENTS.md

Instructions for AI agents working on this codebase.

## Project Overview

This is a Bun/TypeScript terminal video player for Windows that renders videos as ASCII art using the bun-win32 FFI bindings.

## Tech Stack

- **Runtime**: Bun (>=1.1.0) on Windows 10/11
- **Video Decoding**: Media Foundation via `@bun-win32/mfreadwrite`
- **Audio**: winmm via `@bun-win32/winmm` with synchronized playback
- **Terminal**: `@bun-win32/terminal` (CharTerm for character grid rendering)

## Key Dependencies

```json
{
	"@bun-win32/terminal": "latest",
	"@bun-win32/mfplat": "latest",
	"@bun-win32/mfreadwrite": "latest",
	"@bun-win32/ole32": "latest",
	"@bun-win32/winmm": "latest",
	"@bun-win32/kernel32": "latest"
}
```

## Running the Project

```bash
# Install dependencies
bun install

# Play a video file
bun run src/index.ts video.mp4

# Play from YouTube
bun run src/index.ts "https://youtube.com/watch?v=..."

# Search YouTube
bun run src/index.ts search "query"

# Benchmark mode
BENCH=1 bun run src/index.ts video.mp4
```

## Code Architecture

### Core Components

1. **VideoPlayer.ts** - Wraps Media Foundation's `IMFSourceReader` to decode video frames
   - Uses `@bun-win32/mfplat` for MFStartup/MFShutdown
   - Uses `@bun-win32/mfreadwrite` for `MFCreateSourceReaderFromURL`
   - Handles RGB32 format negotiation, stride detection, EOF looping
   - `seekTo(seconds)` via `SetCurrentPosition` with VT_I8

2. **AudioPlayer.ts** - Second `IMFSourceReader` for audio + winmm waveOut
   - Decodes audio to PCM format
   - Ring buffer of 8 x 16KB headers for smooth playback
   - `waveOutGetPosition(TIME_BYTES)` provides master clock for A/V sync
   - `seekTo(seconds)` resets waveOut and repositions reader
   - `setVolume(l, r)` via `waveOutSetVolume`

3. **Renderer.ts** - Letterboxed downscale LUT + rendering
   - Precomputes source pixel offsets for each terminal cell
   - `renderHalfBlock()` uses `▀` with fg/bg colors
   - `renderAscii()` uses density ramp characters
   - `renderFrame(t, frame, mode, srcW, srcH)` dispatches to appropriate renderer

4. **index.ts** - Main playback loop
   - Initializes COM + Media Foundation
   - Creates video + audio sources
   - Uses `runText` from `@bun-win32/terminal` for the render loop
   - Frame stepping with audio-master clock sync
   - Seeking (LEFT/RIGHT), volume (UP/DOWN), mode toggle (M), turbo (T)

### Controls

| Key   | Action                            |
| ----- | --------------------------------- |
| SPACE | Pause/Resume                      |
| LEFT  | Seek backward 10s                 |
| RIGHT | Seek forward 10s                  |
| UP    | Volume up                         |
| DOWN  | Volume down                       |
| M     | Toggle Half-block/ASCII mode      |
| T     | Toggle TURBO mode (unlimited fps) |
| ESC/Q | Quit                              |

### Overlay

- Bottom bar: filename, resolution, mode, flags, progress bar, timestamp
- Top-right: FPS indicator (green ≥60, yellow ≥30, red <30)
- Auto-hides after 2s of mouse inactivity

### COM/FFI Pattern

The codebase uses inline COM vtable invocations:

```typescript
function vcall(
	thisPtr: bigint,
	slot: number,
	argTypes: FFIType[],
	args: unknown[],
	returns: FFIType,
): number {
	const vtable = read.u64(Number(thisPtr) as Pointer, 0)
	const method = read.u64(Number(vtable) as Pointer, slot * 8)
	// ... create CFunction and call
}
```

Slot numbers are verified against Microsoft SDK headers (mfreadwrite.h, mfobjects.h).

## Critical Patterns

### 1. Frame Buffer Lifecycle

Every `decodeNextFrame()` returns a frame with a locked buffer. You **must** call `releaseFrame()` when done:

```typescript
const frame = video.decodeNextFrame()
// use frame
video.releaseFrame() // releases the MF buffer
```

### 2. Audio Master Clock

Audio position is the authoritative clock. Video decoding drops frames to catch up:

```typescript
audio.feed()
const clock = audio.masterSec() // bytes / bytesPerSec = seconds
while (displayedTs < clock) {
	// decode and drop frames
}
```

### 3. EOF Handling

Both video and audio readers loop back to position 0 on EOF. The audio device must be reset (`waveOutReset`) when all buffers are drained to zero the byte clock.

## Win32 FFI Type Reference

| Win32 type              | FFI           | TypeScript |
| ----------------------- | ------------- | ---------- |
| `HANDLE`, `HWND`        | `FFIType.u64` | `bigint`   |
| `DWORD`, `UINT`, `BOOL` | `FFIType.u32` | `number`   |
| `LPVOID`, `LPCWSTR`     | `FFIType.ptr` | `Pointer`  |

For handles use `0n` for NULL. For pointers use `null`.

## Testing

```bash
# Run tests
bun test

# Type check
bun --typecheck src/index.ts

# Benchmark
BENCH=1 FPS_REPORT=1 bun run src/index.ts video.mp4
```

## Troubleshooting

### "MFStartup failed"

- Media Foundation requires `CoInitializeEx` first
- Call `ole32.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED)` before `MFStartup`

### No audio

- Check that the video has an audio track
- Verify winmm is available (`winmm.dll`)
- Audio is disabled in headless mode (`BENCH=1` or `CAPTURE_PNG=1`)

### Poor playback performance

- Try ASCII mode: `VIDEO_MODE=ascii bun run src/index.ts video.mp4`
- Use TURBO mode to skip frame pacing: press `T` during playback

## See Also

- [bun-win32 repository](https://github.com/ObscuritySRL/bun-win32)
- [video.ts example](https://github.com/ObscuritySRL/bun-win32/blob/main/packages/terminal/example/video.ts) - Original reference implementation
- [Media Foundation documentation](https://docs.microsoft.com/en-us/windows/win32/medfound/)
