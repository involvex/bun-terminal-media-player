import { CharTerm, type RGB } from "@bun-win32/terminal";
import type { DecodedFrame, DownscaleLut, PlaybackMode } from "../types";

const RAMP = " .:-=+*#%@";
const RAMP_CODE = new Int32Array(RAMP.length);
for (let i = 0; i < RAMP.length; i++) RAMP_CODE[i] = RAMP.charCodeAt(i);
const RAMP_LAST = RAMP.length - 1;
const UPPER_HALF = "\u2584".codePointAt(0)!;
const BLACK: RGB = [0, 0, 0];

const fgRGB: [number, number, number] = [0, 0, 0];
const bgRGB: [number, number, number] = [0, 0, 0];

let lut: DownscaleLut | null = null;

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

function buildLut(
  cols: number,
  rows: number,
  srcW: number,
  srcH: number,
  stride: number,
  flip: boolean,
): DownscaleLut {
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
  return { cols, rows, srcW, srcH, stride, flip, topOff, botOff, midOff };
}

function ensureLut(
  cols: number,
  rows: number,
  srcW: number,
  srcH: number,
  stride: number,
  flip: boolean,
): DownscaleLut {
  if (
    lut === null ||
    lut.cols !== cols ||
    lut.rows !== rows ||
    lut.stride !== stride ||
    lut.flip !== flip ||
    lut.srcW !== srcW ||
    lut.srcH !== srcH
  ) {
    lut = buildLut(cols, rows, srcW, srcH, stride, flip);
  }
  return lut;
}

export function renderHalfBlock(
  t: CharTerm,
  src: Uint8Array,
  L: DownscaleLut,
): void {
  const { cols, rows, topOff, botOff } = L;
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
}

export function renderAscii(
  t: CharTerm,
  src: Uint8Array,
  L: DownscaleLut,
): void {
  const { cols, rows, midOff } = L;
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
      fgRGB[0] = rr;
      fgRGB[1] = g;
      fgRGB[2] = b;
      t.put(c, r, glyph, fgRGB, BLACK);
    }
  }
}

export function renderFrame(
  t: CharTerm,
  frame: DecodedFrame,
  mode: PlaybackMode,
  srcW: number,
  srcH: number,
): void {
  const L = ensureLut(t.columns, t.rows, srcW, srcH, frame.stride, frame.flip);
  if (mode === "half") renderHalfBlock(t, frame.bytes, L);
  else renderAscii(t, frame.bytes, L);
}

export { ensureLut, buildLut, UPPER_HALF, RAMP };
