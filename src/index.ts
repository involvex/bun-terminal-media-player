import { FFIType, dlopen } from "bun:ffi";
import "@bun-win32/core";
import Mfplat from "@bun-win32/mfplat";
import { runText, type RGB } from "@bun-win32/terminal";
import type { PlaybackMode } from "./types";
import {
  createVideoSource,
  closeMfreadwrite as closeVideoMfreadwrite,
} from "./player/VideoPlayer";
import {
  createAudioSource,
  closeWinmm,
  closeMfreadwrite as closeAudioMfreadwrite,
} from "./player/AudioPlayer";
import { renderFrame } from "./player/Renderer";
import {
  isYouTubeUrl,
  searchYouTube,
  downloadVideo,
} from "./services/YouTubeService";

const COINIT_APARTMENTTHREADED = 0x2;
const MF_VERSION = 0x0002_0070;
const MFSTARTUP_LITE = 0x1;
const S_OK = 0;
const hex = (hr: number): string =>
  `0x${(hr >>> 0).toString(16).padStart(8, "0")}`;

const ole32 = dlopen("ole32.dll", {
  CoInitializeEx: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  CoUninitialize: { args: [], returns: FFIType.void },
});

async function playVideo(path: string): Promise<void> {
  const coHr = ole32.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED);
  if (coHr < 0 && coHr >>> 0 !== 0x80010106) {
    console.error(`CoInitializeEx: ${coHr}`);
  }

  const mfStartHr = Mfplat.MFStartup(MF_VERSION, MFSTARTUP_LITE);
  if (mfStartHr !== S_OK) {
    console.error(`MFStartup failed: ${hex(mfStartHr)}`);
    return;
  }

  const video = createVideoSource(path);
  if (!video.ok) {
    console.error(`Cannot play video: ${video.error}`);
    Mfplat.MFShutdown();
    return;
  }

  const SRC_W = video.w;
  const SRC_H = video.h;
  const fileName = path.replace(/^.*[\\/]/, "");

  const headless =
    (process.env.CAPTURE_PNG !== undefined && process.env.CAPTURE_PNG !== "") ||
    process.env.BENCH === "1";
  const audio = headless
    ? ({
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
      } as any)
    : createAudioSource(path);
  const audioActive = audio.ok;

  let mode: PlaybackMode =
    process.env.VIDEO_MODE === "ascii" ? "ascii" : "half";
  let paused = false;
  let turbo = false;
  let displayedTs = 0;
  let everDrew = false;
  let framesDecoded = 0;
  let framesDropped = 0;
  const syncSamples: Array<{ master: number; disp: number }> = [];
  let syncNextAt = 0.5;
  const HIDE_AFTER_S = 2;
  let lastMoveT = -1000;
  let lastMouseSeq = -1;
  let fpsEma = 60;
  let volume = 0.8;

  function pullFrame() {
    let frame = null;
    for (let tries = 0; tries < 8 && frame === null; tries++)
      frame = video.decodeNextFrame();
    return frame;
  }

  function decodeAndRender(t: any): boolean {
    const frame = pullFrame();
    if (frame === null) return false;
    framesDecoded++;
    displayedTs = frame.tsSec;
    renderFrame(t, frame, mode, SRC_W, SRC_H);
    video.releaseFrame();
    everDrew = true;
    return true;
  }

  function drawOverlay(t: any, fps: number): void {
    const y = t.rows - 1;
    const m = mode === "half" ? "HALF" : "ASCII";
    const dur =
      video.durationSec > 0 ? `/${video.durationSec.toFixed(1)}s` : "s";
    const snd = audioActive
      ? ` ♪${(audio.rate / 1000).toFixed(0)}k/${audio.channels}ch`
      : " (silent)";
    const flags = `${paused ? " [PAUSE]" : ""}${turbo ? " [TURBO]" : ""}`;

    // Progress bar
    let progressBar = "";
    if (video.durationSec > 0) {
      const barLen = Math.max(10, Math.floor(t.columns * 0.3));
      const progress = Math.min(1, displayedTs / video.durationSec);
      const filled = Math.round(progress * barLen);
      progressBar = " [";
      for (let i = 0; i < barLen; i++) progressBar += i < filled ? "█" : "░";
      progressBar += "]";
    }

    const left = ` ${fileName} ${SRC_W}x${SRC_H} ${m}${flags}${snd}${progressBar} ${displayedTs.toFixed(1)}${dur}`;
    const right = "SPC pause · ←→ seek · ↑↓ vol · M mode · T turbo · Q quit ";
    t.fillRect(0, y, t.columns, 1, [18, 18, 24] as RGB);
    t.text(
      0,
      y,
      left.slice(0, Math.max(0, t.columns - right.length - 1)),
      [180, 200, 255] as RGB,
      [18, 18, 24] as RGB,
      true,
    );
    const rx = Math.max(0, t.columns - right.length);
    if (rx > left.length)
      t.text(rx, y, right, [130, 130, 150] as RGB, [18, 18, 24] as RGB);

    // FPS indicator
    const fc: RGB =
      fps >= 60
        ? ([120, 255, 140] as RGB)
        : fps >= 30
          ? ([255, 200, 90] as RGB)
          : ([255, 110, 110] as RGB);
    const fl = ` ${fps.toFixed(0).padStart(3)} FPS `;
    const fx = Math.max(0, t.columns - fl.length);
    t.fillRect(fx, 0, fl.length, 1, [22, 22, 30] as RGB);
    t.text(fx, 0, fl, fc, [22, 22, 30] as RGB, true);
  }

  function frameStep(t: any, time: number): void {
    if (paused) return;

    if (headless || turbo) {
      if (!decodeAndRender(t) && !everDrew)
        t.fillRect(0, 0, t.columns, t.rows, [0, 0, 0] as RGB);
      return;
    }

    let clock = time;
    if (audioActive) {
      audio.feed();
      clock = audio.masterSec();
      if (clock + 1 < displayedTs) displayedTs = 0;
      if (clock >= syncNextAt && syncSamples.length < 16) {
        syncSamples.push({ master: clock, disp: displayedTs });
        syncNextAt = clock + 1;
      }
    }

    if (!everDrew) {
      if (!decodeAndRender(t))
        t.fillRect(0, 0, t.columns, t.rows, [0, 0, 0] as RGB);
      return;
    }

    if (displayedTs >= clock) return;
    let guard = 0;
    let lastFrame = null;
    while (displayedTs < clock && guard < 240) {
      guard++;
      const frame = pullFrame();
      if (frame === null) break;
      framesDecoded++;
      if (lastFrame !== null) framesDropped++;
      displayedTs = frame.tsSec;
      lastFrame = frame;
      if (frame.tsSec >= clock) break;
    }
    if (lastFrame !== null) {
      renderFrame(t, lastFrame, mode, SRC_W, SRC_H);
      video.releaseFrame();
    }
  }

  await runText({
    title: `${fileName}`,
    hud: "",
    targetFps: Infinity,
    drawFps: false,
    mouse: true,
    frame: (t: any, time: number, dt: number) => {
      const inst = dt > 0 ? 1 / dt : 60;
      fpsEma = fpsEma * 0.9 + inst * 0.1;
      if (t.mouse.active && t.mouse.sequence !== lastMouseSeq) {
        lastMouseSeq = t.mouse.sequence;
        lastMoveT = time;
      }
      frameStep(t, time);
      if (
        process.env.BENCH !== "1" &&
        (process.env.VIDEO_OVERLAY === "1" || time - lastMoveT < HIDE_AFTER_S)
      ) {
        drawOverlay(t, fpsEma);
      }
    },
    onKey: (key: string) => {
      if (key === "space") {
        paused = !paused;
        if (audioActive) {
          if (paused) audio.pause();
          else audio.resume();
        }
      } else if (key === "m" || key === "M") {
        mode = mode === "half" ? "ascii" : "half";
      } else if (key === "t" || key === "T") {
        turbo = !turbo;
        if (audioActive && !paused) {
          if (turbo) audio.pause();
          else audio.resume();
        }
      } else if (key === "escape" || key === "q" || key === "Q") {
        process.exit(0);
      } else if (key === "right") {
        // Seek forward 10s
        const target = Math.min(
          displayedTs + 10,
          video.durationSec || displayedTs + 10,
        );
        video.seekTo(target);
        if (audioActive) audio.seekTo(target);
        displayedTs = target;
      } else if (key === "left") {
        // Seek backward 10s
        const target = Math.max(displayedTs - 10, 0);
        video.seekTo(target);
        if (audioActive) audio.seekTo(target);
        displayedTs = target;
      } else if (key === "up") {
        // Volume up
        volume = Math.min(1, volume + 0.1);
        if (audioActive) audio.setVolume(volume, volume);
      } else if (key === "down") {
        // Volume down
        volume = Math.max(0, volume - 0.1);
        if (audioActive) audio.setVolume(volume, volume);
      }
    },
  });

  audio.shutdown();
  video.shutdown();
  Mfplat.MFShutdown();
  ole32.symbols.CoUninitialize();
  ole32.close();
  closeVideoMfreadwrite();
  closeAudioMfreadwrite();
  closeWinmm();

  if (process.env.FPS_REPORT === "1") {
    const sync = syncSamples
      .map((s) => `${s.master.toFixed(2)}:${s.disp.toFixed(2)}`)
      .join(" ");
    console.error(
      `video_stats decoded=${framesDecoded} dropped=${framesDropped} audio=${audioActive ? `${audio.rate}/${audio.channels}/${audio.bits}` : "off"} sync[master:disp]=${sync}`,
    );
  }
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
Bun Terminal Media Player

Usage:
  btm <video_file>              Play a video file
  btm search "<query>"          Search YouTube
  btm --help                    Show this help

Controls:
  SPACE   Pause/Resume
  LEFT    Seek backward 10s
  RIGHT   Seek forward 10s
  UP      Volume up
  DOWN    Volume down
  M       Toggle Half-block/ASCII mode
  T       Toggle TURBO mode (unlimited fps)
  ESC/Q   Quit

Environment Variables:
  VIDEO_MODE=ascii      Start in ASCII mode (default: half-block)
  VIDEO_OVERLAY=1       Always show overlay (default: auto-hide)
  BENCH=1               Headless benchmark mode
  CAPTURE_PNG=1         Capture first frame to PNG
  FPS_REPORT=1          Print frame statistics
`);
    return;
  }

  if (args[0] === "search" || args[0] === "-s") {
    const query = args.slice(1).join(" ");
    if (!query) {
      console.error('Usage: btm search "<query>"');
      return;
    }
    console.log(`Searching YouTube for: "${query}"...`);
    const results = await searchYouTube(query);
    if (results.length === 0) {
      console.log("No results found.");
      return;
    }
    console.log("\nResults:");
    for (let i = 0; i < results.length; i++) {
      console.log(`${i + 1}. ${results[i].title}`);
      console.log(`   ${results[i].url} (${results[i].duration})`);
    }
    console.log("\nTo play: btm <url>");
    return;
  }

  let videoPath = args[0];

  if (isYouTubeUrl(videoPath)) {
    console.log("Downloading from YouTube...");
    const path = await downloadVideo(videoPath);
    if (!path) {
      console.error("Failed to download video");
      process.exit(1);
    }
    videoPath = path;
    console.log(`Downloaded to: ${videoPath}`);
  }

  await playVideo(videoPath);
}

main().catch(console.error);
