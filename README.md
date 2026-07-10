# Bun Terminal Media Player

A smooth video player that renders videos as ASCII art in the Windows terminal using [bun-win32](https://github.com/ObscuritySRL/bun-win32).

## Features

- **Smooth playback** - Uses Media Foundation for hardware-accelerated video decoding
- **Synchronized audio** - Audio plays in sync with video using winmm as master clock
- **High performance** - Renders at 60 FPS with proper frame pacing
- **YouTube support** - Search and play videos from YouTube
- **Half-block rendering** - Uses Unicode `▀` character for high-fidelity display
- **ASCII mode** - Alternative ASCII rendering with density ramp

## Requirements

- Windows 10/11
- [Bun](https://bun.sh) runtime (>=1.1.0)
- yt-dlp (for YouTube support)

## Quick Start

```bash
# Install dependencies
bun install

# Play a local video
bun run src/index.ts video.mp4

# Play from YouTube
bun run src/index.ts "https://youtube.com/watch?v=..."

# Search YouTube
bun run src/index.ts search "cat videos"
```

## Controls

| Key   | Action                            |
| ----- | --------------------------------- |
| SPACE | Pause/Resume                      |
| ← →   | Seek backward/forward 10s         |
| ↑ ↓   | Volume up/down                    |
| M     | Toggle Half-block/ASCII mode      |
| T     | Toggle TURBO mode (unlimited fps) |
| ESC/Q | Quit                              |

## Environment Variables

| Variable           | Description                               |
| ------------------ | ----------------------------------------- |
| `VIDEO_MODE=ascii` | Start in ASCII mode (default: half-block) |
| `BENCH=1`          | Headless benchmark mode                   |
| `CAPTURE_PNG=1`    | Capture first frame to PNG                |
| `FPS_REPORT=1`     | Print frame statistics                    |

## Architecture

```
src/
├── index.ts              # CLI entry point
├── player/
│   ├── VideoPlayer.ts   # Media Foundation video decoder
│   ├── AudioPlayer.ts   # winmm audio with master clock sync
│   └── Renderer.ts      # Half-block + ASCII rendering
├── services/
│   └── YouTubeService.ts # yt-dlp wrapper
└── types/
    └── index.ts          # Type definitions
```

## Tech Stack

This project is built on the excellent [bun-win32](https://github.com/ObscuritySRL/bun-win32) library:

- `@bun-win32/terminal` - Terminal rendering engine with pixel framebuffer
- `@bun-win32/mfplat` - Media Foundation platform bindings
- `@bun-win32/mfreadwrite` - Media Foundation source reader
- `@bun-win32/ole32` - COM initialization
- `@bun-win32/winmm` - Windows multimedia audio output

## License

MIT
