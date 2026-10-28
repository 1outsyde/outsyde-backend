/**
 * Video size from a Mux asset (webhook `video.asset.ready` data).
 *
 * Mux puts the size on the video track (`data.tracks[].max_width` / `max_height`) and the shape on the
 * asset (`data.aspect_ratio`, a string like "9:16"). Phone videos can carry rotation, so when the track
 * size and the aspect string disagree on orientation (tall vs wide), the aspect string wins and the
 * width and height are swapped.
 *
 * Returns null when Mux sent no usable video track, so callers leave the post's size empty.
 */
export interface MuxVideoSize {
  width: number;
  height: number;
  aspectRatio: number;
}

function parseAspect(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(value);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!(a > 0) || !(b > 0)) return null;
  return a / b;
}

export function videoSizeFromMuxAsset(data: unknown): MuxVideoSize | null {
  const asset = (data ?? {}) as { tracks?: unknown; aspect_ratio?: unknown };
  const tracks = Array.isArray(asset.tracks) ? asset.tracks : [];
  const video = tracks.find((t: any) => t && t.type === "video") as
    | { max_width?: unknown; max_height?: unknown }
    | undefined;
  if (!video) return null;

  let width = Number(video.max_width);
  let height = Number(video.max_height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;

  const shape = parseAspect(asset.aspect_ratio);
  if (shape !== null && (shape < 1) !== (width / height < 1) && shape !== 1 && width !== height) {
    [width, height] = [height, width];
  }

  return { width, height, aspectRatio: width / height };
}
