import {
  CFunction,
  FFIType,
  dlopen,
  read,
  toArrayBuffer,
  type Pointer,
} from "bun:ffi";
import "@bun-win32/core";
import Mfplat from "@bun-win32/mfplat";
import { CharTerm, runText, type RGB } from "@bun-win32/terminal";
import type {
  DecodedFrame,
  VideoSource,
  AudioSource,
  PlaybackMode,
} from "./types";
import {
  createVideoSource,
  closeMfreadwrite as closeVideoMfreadwrite,
} from "./player/VideoPlayer";
import {
  createAudioSource,
  initAudioGlobals,
  shutdownAudioGlobals,
  closeWinmm,
  closeMfreadwrite as closeAudioMfreadwrite,
} from "./player/AudioPlayer";
import {
  renderHalfBlock,
  renderAscii,
  ensureLut,
  buildLut,
} from "./player/Renderer";
import {
  isYouTubeUrl,
  searchYouTube,
  downloadVideo,
} from "./services/YouTubeService";

const RAMP = " .:-=+*#%@";
const RAMP_CODE = new Int32Array(RAMP.length);
for (let i = 0; i < RAMP.length; i++) RAMP_CODE[i] = RAMP.charCodeAt(i);
const RAMP_LAST = RAMP.length - 1;
const UPPER_HALF = "\u2584".codePointAt(0)!;
const BLACK: RGB = [0, 0, 0];
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

const invokers = new Map<string, ReturnType<typeof CFunction>>();
function vcall(
  thisPtr: bigint,
  slot: number,
  argTypes: readonly FFIType[],
  args: readonly unknown[],
  returns: FFIType = FFIType.i32,
): number {
  const vtable = read.u64(Number(thisPtr) as Pointer, 0);
  const method = read.u64(Number(vtable) as Pointer, slot * 8);
  const key = `${method}|${returns}|${argTypes.join(",")}`;
  let invoke = invokers.get(key);
  if (invoke === undefined) {
    invoke = CFunction({
      ptr: Number(method) as Pointer,
      args: [FFIType.u64, ...argTypes],
      returns,
    });
    invokers.set(key, invoke);
  }
  return invoke(thisPtr, ...args) as number;
}

let lut: {
  cols: number;
  rows: number;
  srcW: number;
  srcH: number;
  stride: number;
  flip: boolean;
  topOff: Int32Array;
  botOff: Int32Array;
  midOff: Int32Array;
} | null = null;

function srcOffset(
  sx: number,
  sy: number,
  srcH: number,
  stride: number,
  flip: boolean,
): number {
  const row = flip ? srcH - 1 - sy : sy;
  return row * stride + sx * 4;
}

function ensureLutForFrame(
  cols: number,
  rows: number,
  srcW: number,
  srcH: number,
  stride: number,
  flip: boolean,
) {
  if (
    lut === null ||
    lut.cols !== cols ||
    lut.rows !== rows ||
    lut.stride !== stride ||
    lut.flip !== flip ||
    lut.srcW !== srcW ||
    lut.srcH !== srcH
  ) {
    const topOff = new Int32Array(cols * rows).fill(-1);
    const botOff = new Int32Array(cols * rows).fill(-1);
    const midOff = new Int32Array(cols * rows).fill(-1);

    const gridPxW = cols;
    const gridPxH = rows * 2;
    const scale = Math.min(gridPxW / srcW, gridPxH / srcH);
    const dstPxW = Math.max(1, Math.round(srcW * scale));
    const dstPxH = Math.max(1, Math.round(srcH * scale));
    const offPxX = Math.floor((gridPxW - dstPxW) / 2);
    const offPxY = Math.floor((gridPxH - dstPxH) / 2);
    const invScaleX = srcW / dstPxW;
    const invScaleY = srcH / dstPxH;

    for (let r = 0; r < rows; r++) {
      const pyTop = r * 2;
      const pyBot = r * 2 + 1;
      const base = r * cols;
      for (let c = 0; c < cols; c++) {
        const lx = c - offPxX;
        const sxF = (lx + 0.5) * invScaleX;
        const inX = lx >= 0 && lx < dstPxW;
        let sx = sxF | 0;
        if (sx < 0) sx = 0;
        else if (sx >= srcW) sx = srcW - 1;

        const lyTop = pyTop - offPxY;
        const lyBot = pyBot - offPxY;
        const inYTop = lyTop >= 0 && lyTop < dstPxH;
        const inYBot = lyBot >= 0 && lyBot < dstPxH;
        const idx = base + c;

        if (inX && inYTop) {
          let sy = ((lyTop + 0.5) * invScaleY) | 0;
          if (sy < 0) sy = 0;
          else if (sy >= srcH) sy = srcH - 1;
          topOff[idx] = srcOffset(sx, sy, srcH, stride, flip);
        }
        if (inX && inYBot) {
          let sy = ((lyBot + 0.5) * invScaleY) | 0;
          if (sy < 0) sy = 0;
          else if (sy >= srcH) sy = srcH - 1;
          botOff[idx] = srcOffset(sx, sy, srcH, stride, flip);
        }
        const lyMid = r * 2 + 1 - offPxY;
        if (inX && (inYTop || inYBot)) {
          let sy = ((lyMid + 0.5) * invScaleY) | 0;
          if (sy < 0) sy = 0;
          else if (sy >= srcH) sy = srcH - 1;
          midOff[idx] = srcOffset(sx, sy, srcH, stride, flip);
        }
      }
    }
    lut = { cols, rows, srcW, srcH, stride, flip, topOff, botOff, midOff };
  }
  return lut;
}

function renderFrameOnTerm(
  t: CharTerm,
  frame: DecodedFrame,
  mode: PlaybackMode,
  srcW: number,
  srcH: number,
): void {
  const L = ensureLutForFrame(
    t.columns,
    t.rows,
    srcW,
    srcH,
    frame.stride,
    frame.flip,
  );
  if (mode === "half") {
    const { cols, rows, topOff, botOff } = L;
    const fgRGB: [number, number, number] = [0, 0, 0];
    const bgRGB: [number, number, number] = [0, 0, 0];
    const src = frame.bytes;
    for (let r = 0; r < rows; r++) {
      const base = r * cols;
      for (let c = 0; c < cols; c++) {
        const idx = base + c;
        const to = topOff[idx]!;
        const bo = botOff[idx]!;
        if (to < 0 && bo < 0) {
          t.put(c, r, " ", BLACK, BLACK);
          continue;
        }
        if (to >= 0) {
          fgRGB[0] = src[to + 2]!;
          fgRGB[1] = src[to + 1]!;
          fgRGB[2] = src[to]!;
        } else {
          fgRGB[0] = 0;
          fgRGB[1] = 0;
          fgRGB[2] = 0;
        }
        if (bo >= 0) {
          bgRGB[0] = src[bo + 2]!;
          bgRGB[1] = src[bo + 1]!;
          bgRGB[2] = src[bo]!;
        } else {
          bgRGB[0] = 0;
          bgRGB[1] = 0;
          bgRGB[2] = 0;
        }
        t.put(c, r, UPPER_HALF, fgRGB, bgRGB);
      }
    }
  } else {
    const { cols, rows, midOff } = L;
    const src = frame.bytes;
    for (let r = 0; r < rows; r++) {
      const base = r * cols;
      for (let c = 0; c < cols; c++) {
        const idx = base + c;
        const mo = midOff[idx]!;
        if (mo < 0) {
          t.put(c, r, " ", BLACK, BLACK);
          continue;
        }
        const b = src[mo]!;
        const g = src[mo + 1]!;
        const rr = src[mo + 2]!;
        const lum = (77 * rr + 150 * g + 29 * b) >> 8;
        const gi = (lum * RAMP_LAST) >> 8;
        const glyph = RAMP_CODE[gi <= RAMP_LAST ? gi : RAMP_LAST]!;
        t.put(c, r, glyph, [rr, g, b], BLACK);
      }
    }
  }
}

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
    ? {
        ok: false,
        rate: 0,
        channels: 0,
        bits: 0,
        underruns: 0,
        feed: () => {},
        masterSec: () => 0,
        pause: () => {},
        resume: () => {},
        shutdown: () => {},
      }
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
  const fgRGB: [number, number, number] = [0, 0, 0];
  const bgRGB: [number, number, number] = [0, 0, 0];

  function pullFrame(): DecodedFrame | null {
    let frame: DecodedFrame | null = null;
    for (let tries = 0; tries < 8 && frame === null; tries++)
      frame = video.decodeNextFrame();
    return frame;
  }

  function decodeAndRender(t: CharTerm): boolean {
    const frame = pullFrame();
    if (frame === null) return false;
    framesDecoded++;
    displayedTs = frame.tsSec;
    renderFrameOnTerm(t, frame, mode, SRC_W, SRC_H);
    video.releaseFrame();
    everDrew = true;
    return true;
  }

  function drawOverlay(t: CharTerm, fps: number): void {
    const y = t.rows - 1;
    const m = mode === "half" ? "HALF-BLOCK" : "ASCII";
    const dur =
      video.durationSec > 0 ? `/${video.durationSec.toFixed(1)}s` : "s";
    const snd = audioActive
      ? ` · ♪ ${(audio.rate / 1000).toFixed(0)}k/${audio.channels}ch`
      : " · (silent)";
    const flags = `${paused ? " [PAUSED]" : ""}${turbo ? " [TURBO]" : ""}`;
    const left = ` ${fileName} ${SRC_W}x${SRC_H} · ${m} · ${displayedTs.toFixed(1)}${dur}${snd}${flags}`;
    const right = "SPACE pause · m mode · t turbo · ESC quit ";
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

  function frameStep(t: CharTerm, time: number): void {
    if (paused) return;

    if (headless || turbo) {
      if (!decodeAndRender(t) && !everDrew)
        t.fillRect(0, 0, t.columns, t.rows, BLACK);
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
      if (!decodeAndRender(t)) t.fillRect(0, 0, t.columns, t.rows, BLACK);
      return;
    }

    if (displayedTs >= clock) return;
    let guard = 0;
    let lastFrame: DecodedFrame | null = null;
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
      renderFrameOnTerm(t, lastFrame, mode, SRC_W, SRC_H);
      video.releaseFrame();
    }
  }

  await runText({
    title: `${fileName}`,
    hud: "",
    targetFps: Infinity,
    drawFps: false,
    mouse: true,
    frame: (t, time, dt) => {
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
    onKey: (key) => {
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
  M       Toggle Half-block/ASCII mode
  T       Toggle TURBO mode (unlimited fps)
  ESC/Q   Quit

Environment Variables:
  VIDEO_MODE=ascii    Start in ASCII mode (default: half-block)
  BENCH=1             Headless benchmark mode
  CAPTURE_PNG=1       Capture first frame to PNG
  FPS_REPORT=1        Print frame statistics
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
