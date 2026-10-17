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
