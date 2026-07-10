import { type YouTubeResult } from "../types";

export async function searchYouTube(query: string): Promise<YouTubeResult[]> {
  const results: YouTubeResult[] = [];

  try {
    const proc = Bun.spawn({
      cmd: [
        "yt-dlp",
        "--dump-json",
        `--search-url=https://www.youtube.com/results?search_query=`,
        `ytsearch10:${query}`,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    const lines = output
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("{"));
    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        results.push({
          title: data.title || "Unknown",
          url: `https://youtube.com/watch?v=${data.id}`,
          duration: data.duration ? formatDuration(data.duration) : "N/A",
          viewCount: data.view_count ? formatViewCount(data.view_count) : "N/A",
        });
      } catch {
        // Skip malformed JSON lines
      }
    }
  } catch (error) {
    console.error("Search failed:", error);
  }

  return results;
}

export async function downloadVideo(url: string): Promise<string | null> {
  const tempDir = import.meta.dir || ".";
  const outputPath = `${tempDir}/temp_video.%(ext)s`;

  try {
    const proc = Bun.spawn({
      cmd: [
        "yt-dlp",
        "-f",
        "best[height<=720]/best",
        "--no-playlist",
        "-o",
        outputPath,
        url,
      ],
      stdout: "inherit",
      stderr: "inherit",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error("Download failed with exit code:", exitCode);
      return null;
    }

    // Find the actual file (yt-dlp replaces %(ext)s with actual extension)
    const glob = new Bun.Glob("temp_video.*");
    const files = [...glob.scanSync(tempDir)];
    const videoFile = files.find((f) => !f.endsWith(".part"));

    return videoFile || null;
  } catch (error) {
    console.error("Download failed:", error);
    return null;
  }
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0)
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatViewCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M views`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K views`;
  return `${count} views`;
}

export function isYouTubeUrl(url: string): boolean {
  return url.includes("youtube.com") || url.includes("youtu.be");
}
