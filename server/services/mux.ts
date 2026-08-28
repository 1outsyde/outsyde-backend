import Mux from "@mux/mux-node";

export const mux = new Mux({
  tokenId: process.env.MUX_TOKEN_ID!,
  tokenSecret: process.env.MUX_TOKEN_SECRET!,
});

export async function createMuxUploadUrl(): Promise<{
  uploadUrl: string;
  uploadId: string;
}> {
  const upload = await mux.video.uploads.create({
    cors_origin: "*",
    new_asset_settings: {
      playback_policies: ["public"],
      video_quality: "basic",
    },
  }).catch((error: unknown) => {
    throw new Error(
      `[Mux] uploads.create failed: ${JSON.stringify((error as any)?.error ?? error)}`
    );
  });

  if (!upload.url) {
    throw new Error("[Mux] Upload URL missing from Mux response");
  }

  return {
    uploadUrl: upload.url,
    uploadId: upload.id,
  };
}

export async function getMuxAsset(uploadId: string): Promise<{
  assetId: string;
  playbackId: string;
  status: string;
} | null> {
  try {
    const upload = await mux.video.uploads.retrieve(uploadId);
    if (!upload.asset_id) return null;

    const asset = await mux.video.assets.retrieve(upload.asset_id);
    const playbackId = asset.playback_ids?.[0]?.id;

    return {
      assetId: asset.id,
      playbackId: playbackId || "",
      status: asset.status,
    };
  } catch {
    return null;
  }
}

export async function deleteMuxAsset(
  assetId: string
): Promise<void> {
  try {
    await mux.video.assets.delete(assetId);
  } catch (err) {
    console.error("[Mux] Delete failed:", err);
  }
}

export async function getMuxAssetIdByPlaybackId(
  playbackId: string
): Promise<string | null> {
  try {
    const info = await mux.video.playbackIds.retrieve(playbackId);
    return info.object?.id ?? null;
  } catch {
    return null;
  }
}
