/** Cover media helpers for search cards (pure, no DB). */

/**
 * A cover usable as a card background. Image covers pass through. A Mux video cover
 * (https://stream.mux.com/<playbackId>.m3u8) becomes Mux's still thumbnail, the same URL
 * shape the app already uses for story highlights. Any other video URL has no still → null.
 */
export function coverStillImage(url: string | null | undefined, mediaType: string | null | undefined): string | null {
  const u = (url ?? '').trim();
  if (!u) return null;
  const mux = u.match(/^https:\/\/stream\.mux\.com\/([A-Za-z0-9]+)(?:\.m3u8)?(?:\?.*)?$/);
  if (mux) return `https://image.mux.com/${mux[1]}/thumbnail.jpg`;
  if (mediaType === 'video' || /\.(m3u8|mp4|mov|webm)(\?|$)/i.test(u)) return null;
  return u;
}

export const nonEmpty = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t ? t : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Video cover saving (every profile type: users, businesses, staff_members,
// photographers).
//
// Video covers go through Mux. The client uploads straight to Mux and saves
// the Mux *upload id* as the cover value with coverMediaType = "video". When
// Mux finishes processing, /api/webhooks/mux swaps the upload id for the
// playable https://stream.mux.com/<playbackId>.m3u8 URL. If processing has
// already finished by the time the profile is saved, the webhook has nothing
// to update, so the save routes call resolveCoverVideoValue() to store the
// playable URL straight away.
// ─────────────────────────────────────────────────────────────────────────────

export const MUX_STREAM_PREFIX = "https://stream.mux.com/";

// Mux upload ids are opaque alphanumeric strings (no scheme, no slashes).
const MUX_UPLOAD_ID_RE = /^[A-Za-z0-9]{8,128}$/;
const MUX_PLAYBACK_URL_RE = /^https:\/\/stream\.mux\.com\/([A-Za-z0-9]+)\.m3u8(?:\?.*)?$/;

export function isMuxUploadId(value: unknown): value is string {
  return typeof value === "string" && MUX_UPLOAD_ID_RE.test(value);
}

export function muxPlaybackIdFromUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = url.match(MUX_PLAYBACK_URL_RE);
  return match ? match[1] : null;
}

export function muxThumbnailUrl(playbackId: string): string {
  return `https://image.mux.com/${playbackId}/thumbnail.jpg`;
}

/**
 * coverPosterUrl (additive DTO field): a still picture for any cover, for
 * screens that can only show images. Same picture as coverStillImage() (used by
 * search), restricted to http(s) so a phone path (file://…) or a Mux upload id
 * still processing never reaches an <img>.
 * - video + playable Mux URL → Mux thumbnail
 * - video still processing (upload id) → null
 * - image (or legacy rows with no type) → the URL itself when it is http(s)
 */
export function coverPosterUrl(
  url: string | null | undefined,
  mediaType: string | null | undefined,
): string | null {
  const still = coverStillImage(url, mediaType);
  return still && /^https?:\/\//i.test(still) ? still : null;
}

type MuxAssetLookup = (uploadId: string) => Promise<{ playbackId: string; status: string } | null>;

async function defaultMuxLookup(uploadId: string) {
  const { getMuxAsset } = await import("./services/mux");
  return getMuxAsset(uploadId);
}

/**
 * When a video cover is saved with a Mux upload id and Mux has already
 * finished processing, return the playable URL; otherwise return the value
 * unchanged (the webhook fills it in later). Never throws.
 */
export async function resolveCoverVideoValue(
  value: string | null | undefined,
  mediaType: string | null | undefined,
  lookup: MuxAssetLookup = defaultMuxLookup,
): Promise<string | null | undefined> {
  if (mediaType !== "video" || !isMuxUploadId(value)) return value;
  try {
    const asset = await lookup(value);
    if (asset && asset.status === "ready" && asset.playbackId) {
      return `${MUX_STREAM_PREFIX}${asset.playbackId}.m3u8`;
    }
  } catch (err) {
    console.warn("[coverMedia] Mux lookup failed; webhook will update later", { uploadId: value, err });
  }
  return value;
}
