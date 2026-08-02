import { db } from "../db";
import { stories, storyViews } from "../../shared/schema";
import { deleteFromR2 } from "./r2";
import { deleteMuxAsset } from "./mux";
import { eq, and, lt, asc, inArray, sql } from "drizzle-orm";

export interface CreateStoryInput {
  authorId: string;
  mediaUrl: string;
  mediaType: "image" | "video";
  thumbnailUrl?: string;
  muxAssetId?: string;
  caption?: string;
}

export async function createStory(input: CreateStoryInput) {
  const [story] = await db
    .insert(stories)
    .values({
      authorId: input.authorId,
      mediaUrl: input.mediaUrl,
      mediaType: input.mediaType,
      thumbnailUrl: input.thumbnailUrl ?? null,
      muxAssetId: input.muxAssetId ?? null,
      caption: input.caption ?? null,
      expiresAt: sql`now() + interval '24 hours'`,
    })
    .returning();
  return story;
}

export async function getStoriesByUser(authorId: string, viewerId?: string) {
  const activeStories = await db
    .select()
    .from(stories)
    .where(
      and(
        eq(stories.authorId, authorId),
        eq(stories.isActive, true),
        sql`${stories.expiresAt} > now()`
      )
    )
    .orderBy(asc(stories.createdAt));

  if (!viewerId || activeStories.length === 0) {
    return activeStories.map((s) => ({ ...s, viewedByCurrentUser: false }));
  }

  const storyIds = activeStories.map((s) => s.id);
  const viewRows = await db
    .select({ storyId: storyViews.storyId })
    .from(storyViews)
    .where(
      and(
        inArray(storyViews.storyId, storyIds),
        eq(storyViews.viewerId, viewerId)
      )
    );

  const viewedSet = new Set(viewRows.map((v) => v.storyId));
  return activeStories.map((s) => ({
    ...s,
    viewedByCurrentUser: viewedSet.has(s.id),
  }));
}

export async function getStory(storyId: string) {
  const [story] = await db
    .select()
    .from(stories)
    .where(eq(stories.id, storyId));
  return story ?? null;
}

export async function deleteStory(storyId: string, requesterId: string) {
  const story = await getStory(storyId);
  if (!story) {
    const err: any = new Error("Story not found");
    err.statusCode = 404;
    throw err;
  }
  if (story.authorId !== requesterId) {
    const err: any = new Error("Forbidden");
    err.statusCode = 403;
    throw err;
  }

  await db.update(stories).set({ isActive: false }).where(eq(stories.id, storyId));

  // Best-effort media cleanup
  try {
    if (story.mediaType === "video" && story.muxAssetId) {
      await deleteMuxAsset(story.muxAssetId);
    } else if (story.mediaType === "image" && story.mediaUrl) {
      await deleteFromR2(story.mediaUrl);
    }
  } catch (cleanupErr) {
    console.error(`[Stories] Media cleanup failed for story ${storyId}:`, cleanupErr);
  }
}

export async function recordView(storyId: string, viewerId: string) {
  await db
    .insert(storyViews)
    .values({ storyId, viewerId })
    .onConflictDoNothing();
}

export async function cleanupExpiredStories() {
  const expired = await db
    .select({ id: stories.id, mediaType: stories.mediaType, mediaUrl: stories.mediaUrl, muxAssetId: stories.muxAssetId })
    .from(stories)
    .where(
      and(
        eq(stories.isActive, true),
        lt(stories.expiresAt, sql`now()`)
      )
    );

  if (expired.length === 0) return;

  const ids = expired.map((s) => s.id);
  await db
    .update(stories)
    .set({ isActive: false })
    .where(inArray(stories.id, ids));

  for (const story of expired) {
    try {
      if (story.mediaType === "video" && story.muxAssetId) {
        await deleteMuxAsset(story.muxAssetId);
      } else if (story.mediaType === "image" && story.mediaUrl) {
        await deleteFromR2(story.mediaUrl);
      }
    } catch (err) {
      console.error(`[Stories] Cleanup: media deletion failed for story ${story.id}:`, err);
    }
  }

  console.log(`[Stories] Cleanup: expired ${ids.length} story/stories`);
}
