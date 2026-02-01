import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Heart, MessageCircle, Share2, Bookmark, Volume2, VolumeX, Play, User } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface PulsePost {
  id: string;
  authorId: string;
  authorType: string;
  postType: string;
  postIntent: string;
  displayLayout: string | null;
  content: string;
  imageUrl: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
  mediaWidth: number | null;
  mediaHeight: number | null;
  aspectRatio: number | null;
  likesCount: number;
  commentsCount: number;
  createdAt: string;
  pulseScore: number;
  author: {
    userId: string;
    username: string | null;
    displayName: string;
    profilePhotoUrl: string | null;
    role: 'consumer' | 'vendor' | 'photographer';
  };
  media: {
    mediaUrl: string | null;
    mediaType: string | null;
    width: number | null;
    height: number | null;
    aspectRatio: number | null;
  } | null;
}

interface PulseFeedViewerProps {
  isAuthenticated?: boolean;
  onLoginRequired?: () => void;
}

export default function PulseFeedViewer({ isAuthenticated = false, onLoginRequired }: PulseFeedViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);
  const [seenPostIds, setSeenPostIds] = useState<string[]>([]);
  const [allPosts, setAllPosts] = useState<PulsePost[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const watchStartRef = useRef<number>(0);
  const loopCountRef = useRef<Map<string, number>>(new Map());
  const { toast } = useToast();

  const { data: feedData, isLoading, refetch } = useQuery({
    queryKey: ['/api/pulse/feed', offset],
    queryFn: async () => {
      const excludeIds = seenPostIds.join(',');
      const response = await fetch(`/api/pulse/feed?limit=10&offset=${offset}&excludeIds=${excludeIds}`);
      if (!response.ok) throw new Error('Failed to fetch pulse feed');
      return response.json();
    },
    staleTime: 30000,
  });

  useEffect(() => {
    if (feedData?.posts) {
      setAllPosts(prev => {
        const existingIds = prev.map(p => p.id);
        const newPosts = feedData.posts.filter((p: PulsePost) => !existingIds.includes(p.id));
        return [...prev, ...newPosts];
      });
      setHasMore(feedData.hasMore);
      setIsFetchingMore(false);
    }
  }, [feedData]);

  const engagementMutation = useMutation({
    mutationFn: async (data: {
      postId: string;
      watchTimeMs: number;
      videoDurationMs: number;
      isRewatch?: boolean;
      shared?: boolean;
      saved?: boolean;
    }) => {
      return apiRequest('POST', '/api/pulse/engagement', data);
    },
  });

  const sendEngagement = useCallback((postId: string, videoDuration: number, isRewatch: boolean = false) => {
    if (!isAuthenticated) return;
    
    const watchTime = Date.now() - watchStartRef.current;
    if (watchTime < 500) return;

    engagementMutation.mutate({
      postId,
      watchTimeMs: watchTime,
      videoDurationMs: videoDuration,
      isRewatch,
    });
  }, [isAuthenticated, engagementMutation]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const container = e.currentTarget;
    const scrollTop = container.scrollTop;
    const itemHeight = container.clientHeight;
    const newIndex = Math.round(scrollTop / itemHeight);
    
    if (newIndex !== currentIndex && newIndex >= 0 && newIndex < allPosts.length) {
      const currentPost = allPosts[currentIndex];
      if (currentPost) {
        const videoEl = videoRefs.current.get(currentPost.id);
        const duration = videoEl?.duration ? videoEl.duration * 1000 : 10000;
        sendEngagement(currentPost.id, duration, false);
      }

      setCurrentIndex(newIndex);
      setSeenPostIds(prev => [...prev, allPosts[newIndex].id]);
      watchStartRef.current = Date.now();

      if (newIndex >= allPosts.length - 3 && hasMore && !isFetchingMore) {
        setIsFetchingMore(true);
        setOffset(prev => prev + 10);
      }
    }
  }, [currentIndex, allPosts, sendEngagement, hasMore, isFetchingMore]);

  useEffect(() => {
    allPosts.forEach((post, index) => {
      const videoEl = videoRefs.current.get(post.id);
      if (videoEl) {
        if (index === currentIndex) {
          videoEl.play().catch(() => {});
          videoEl.muted = isMuted;
        } else {
          videoEl.pause();
          videoEl.currentTime = 0;
        }
      }
    });
  }, [currentIndex, allPosts, isMuted]);

  useEffect(() => {
    watchStartRef.current = Date.now();
    if (allPosts[currentIndex]) {
      setSeenPostIds(prev => [...prev, allPosts[currentIndex].id]);
    }
  }, []);

  const handleVideoEnded = useCallback((postId: string, videoEl: HTMLVideoElement) => {
    const loopCount = loopCountRef.current.get(postId) || 0;
    loopCountRef.current.set(postId, loopCount + 1);

    if (loopCount > 0 && isAuthenticated) {
      const duration = videoEl.duration ? videoEl.duration * 1000 : 10000;
      sendEngagement(postId, duration, true);
    }

    videoEl.currentTime = 0;
    videoEl.play().catch(() => {});
  }, [isAuthenticated, sendEngagement]);

  const handleTapToPause = useCallback((postId: string) => {
    const videoEl = videoRefs.current.get(postId);
    if (videoEl) {
      if (videoEl.paused) {
        videoEl.play().catch(() => {});
        setIsPlaying(true);
      } else {
        videoEl.pause();
        setIsPlaying(false);
      }
    }
  }, []);

  const handleLike = useCallback(async (postId: string) => {
    if (!isAuthenticated) {
      onLoginRequired?.();
      return;
    }
    try {
      await apiRequest('POST', `/api/feed/${postId}/like`);
      toast({ title: "Liked!" });
    } catch {
      toast({ title: "Failed to like", variant: "destructive" });
    }
  }, [isAuthenticated, onLoginRequired, toast]);

  const handleShare = useCallback(async (postId: string) => {
    if (!isAuthenticated) {
      onLoginRequired?.();
      return;
    }

    engagementMutation.mutate({
      postId,
      watchTimeMs: 0,
      videoDurationMs: 0,
      shared: true,
    });

    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Check out this post on Outsyde',
          url: `${window.location.origin}/post/${postId}`,
        });
      } catch {
      }
    } else {
      await navigator.clipboard.writeText(`${window.location.origin}/post/${postId}`);
      toast({ title: "Link copied!" });
    }
  }, [isAuthenticated, onLoginRequired, engagementMutation, toast]);

  const handleSave = useCallback(async (postId: string) => {
    if (!isAuthenticated) {
      onLoginRequired?.();
      return;
    }
    engagementMutation.mutate({
      postId,
      watchTimeMs: 0,
      videoDurationMs: 0,
      saved: true,
    });
    toast({ title: "Saved!" });
  }, [isAuthenticated, onLoginRequired, engagementMutation, toast]);

  if (isLoading && allPosts.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-black">
        <div className="text-white text-lg">Loading Pulse...</div>
      </div>
    );
  }

  if (allPosts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-black text-white p-6">
        <div className="text-xl font-semibold mb-2">No Pulse content yet</div>
        <div className="text-gray-400 text-center">
          Be the first to share a video! Pulse is all about discovery and culture.
        </div>
      </div>
    );
  }

  return (
    <div 
      ref={containerRef}
      className="h-full w-full overflow-y-scroll snap-y snap-mandatory bg-black"
      onScroll={handleScroll}
      style={{ scrollSnapType: 'y mandatory' }}
      data-testid="pulse-feed-container"
    >
      {allPosts.map((post, index) => (
        <div 
          key={post.id}
          className="h-full w-full snap-start snap-always relative flex items-center justify-center"
          style={{ scrollSnapAlign: 'start' }}
          data-testid={`pulse-post-${post.id}`}
        >
          <div 
            className="absolute inset-0 flex items-center justify-center cursor-pointer"
            onClick={() => handleTapToPause(post.id)}
          >
            {post.media?.mediaType === 'video' || post.mediaType === 'video' ? (
              <video
                ref={(el) => {
                  if (el) videoRefs.current.set(post.id, el);
                }}
                src={post.media?.mediaUrl || post.mediaUrl || ''}
                className="h-full w-full object-cover"
                loop={false}
                playsInline
                muted={isMuted}
                onEnded={(e) => handleVideoEnded(post.id, e.currentTarget)}
                data-testid={`pulse-video-${post.id}`}
              />
            ) : (
              <img
                src={post.media?.mediaUrl || post.mediaUrl || post.imageUrl || ''}
                alt=""
                className="h-full w-full object-cover"
              />
            )}

            {!isPlaying && index === currentIndex && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                <Play className="w-20 h-20 text-white/80" />
              </div>
            )}
          </div>

          <div className="absolute bottom-0 left-0 right-16 p-4 bg-gradient-to-t from-black/80 to-transparent">
            <div className="flex items-center gap-3 mb-3">
              <Avatar className="h-10 w-10 border-2 border-white">
                <AvatarImage src={post.author.profilePhotoUrl || undefined} />
                <AvatarFallback className="bg-primary text-primary-foreground">
                  <User className="h-5 w-5" />
                </AvatarFallback>
              </Avatar>
              <div>
                <div className="text-white font-semibold text-sm">
                  @{post.author.username || post.author.displayName}
                </div>
                <div className="text-white/70 text-xs capitalize">
                  {post.author.role}
                </div>
              </div>
            </div>

            {post.content && (
              <p className="text-white text-sm line-clamp-3 mb-2">
                {post.content}
              </p>
            )}
          </div>

          <div className="absolute right-3 bottom-24 flex flex-col items-center gap-5">
            <button
              onClick={() => handleLike(post.id)}
              className="flex flex-col items-center"
              data-testid={`pulse-like-${post.id}`}
            >
              <div className="w-12 h-12 rounded-full bg-black/40 flex items-center justify-center">
                <Heart className="w-6 h-6 text-white" />
              </div>
              <span className="text-white text-xs mt-1">{post.likesCount}</span>
            </button>

            <button
              onClick={() => {}}
              className="flex flex-col items-center"
              data-testid={`pulse-comment-${post.id}`}
            >
              <div className="w-12 h-12 rounded-full bg-black/40 flex items-center justify-center">
                <MessageCircle className="w-6 h-6 text-white" />
              </div>
              <span className="text-white text-xs mt-1">{post.commentsCount}</span>
            </button>

            <button
              onClick={() => handleSave(post.id)}
              className="flex flex-col items-center"
              data-testid={`pulse-save-${post.id}`}
            >
              <div className="w-12 h-12 rounded-full bg-black/40 flex items-center justify-center">
                <Bookmark className="w-6 h-6 text-white" />
              </div>
              <span className="text-white text-xs mt-1">Save</span>
            </button>

            <button
              onClick={() => handleShare(post.id)}
              className="flex flex-col items-center"
              data-testid={`pulse-share-${post.id}`}
            >
              <div className="w-12 h-12 rounded-full bg-black/40 flex items-center justify-center">
                <Share2 className="w-6 h-6 text-white" />
              </div>
              <span className="text-white text-xs mt-1">Share</span>
            </button>

            <button
              onClick={() => setIsMuted(!isMuted)}
              className="flex flex-col items-center"
              data-testid="pulse-mute-toggle"
            >
              <div className="w-10 h-10 rounded-full bg-black/40 flex items-center justify-center">
                {isMuted ? (
                  <VolumeX className="w-5 h-5 text-white" />
                ) : (
                  <Volume2 className="w-5 h-5 text-white" />
                )}
              </div>
            </button>
          </div>
        </div>
      ))}

      {isFetchingMore && (
        <div className="h-full w-full snap-start flex items-center justify-center bg-black">
          <div className="text-white">Loading more...</div>
        </div>
      )}
    </div>
  );
}
