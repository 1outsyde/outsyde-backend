/**
 * Feed video card serializer.
 *
 * Maps raw PulseFeedPost objects to a guaranteed VideoCard contract.
 * Every field is present and never undefined — null or safe defaults are used.
 */

import type { PulseFeedPost } from "./pulseService";

export interface VideoCard {
  id: string;
  videoUrl: string;
  thumbnailUrl: string;
  userId: string;
  username: string;
  avatarUrl: string;
  caption: string;
  likeCount: number;
  commentCount: number;
  saveCount: number;
  createdAt: string; // ISO 8601

  // Extended fields for rich clients
  author: {
    userId: string;
    username: string;
    displayName: string;
    profilePhotoUrl: string;
    role: 'consumer' | 'vendor' | 'photographer';
  };
  media: {
    mediaUrl: string;
    mediaType: string;
    width: number | null;
    height: number | null;
    aspectRatio: number | null;
  };
  businessId: string | null;
  photographerId: string | null;
  pulseScore: number;
  feedSurface: string;
  postIntent: string;
}

/**
 * Format a raw PulseFeedPost into a guaranteed VideoCard shape.
 * Returns null if the post is missing critical data (videoUrl).
 */
export function formatVideoCard(post: PulseFeedPost): VideoCard | null {
  const videoUrl = post.mediaUrl || post.imageUrl;
  if (!videoUrl) return null;

  return {
    id: post.id,
    videoUrl,
    thumbnailUrl: post.thumbnailUrl || '',
    userId: post.author?.userId || post.authorId,
    username: post.author?.username || '',
    avatarUrl: post.author?.profilePhotoUrl || '',
    caption: post.content || '',
    likeCount: post.likesCount || 0,
    commentCount: post.commentsCount || 0,
    saveCount: 0,
    createdAt: post.createdAt instanceof Date
      ? post.createdAt.toISOString()
      : String(post.createdAt),

    author: {
      userId: post.author?.userId || post.authorId,
      username: post.author?.username || '',
      displayName: post.author?.displayName || 'Anonymous',
      profilePhotoUrl: post.author?.profilePhotoUrl || '',
      role: post.author?.role || 'consumer',
    },
    media: {
      mediaUrl: videoUrl,
      mediaType: post.mediaType || 'video',
      width: post.mediaWidth || null,
      height: post.mediaHeight || null,
      aspectRatio: post.aspectRatio || null,
    },
    businessId: post.taggedBusinessId || null,
    photographerId: post.taggedPhotographerId || null,
    pulseScore: post.pulseScore || 0,
    feedSurface: post.feedSurface || 'pulse',
    postIntent: post.postIntent || 'social',
  };
}

/**
 * Batch-format posts and filter out any with missing video data.
 */
export function formatVideoCards(posts: PulseFeedPost[]): VideoCard[] {
  const cards: VideoCard[] = [];
  for (const post of posts) {
    const card = formatVideoCard(post);
    if (card) cards.push(card);
  }
  return cards;
}
