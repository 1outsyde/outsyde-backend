import { useState } from "react";
import { Heart, MessageCircle, Share2, Bookmark, MoreHorizontal } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

interface FeedPostProps {
  id: string;
  businessName: string;
  businessAvatar?: string;
  businessCategory: string;
  postImage: string;
  caption: string;
  likes: number;
  comments: number;
  timestamp: string;
  isLiked?: boolean;
  isSaved?: boolean;
  onLike?: (id: string) => void;
  onComment?: (id: string) => void;
  onShare?: (id: string) => void;
  onSave?: (id: string) => void;
  onBusinessClick?: (id: string) => void;
}

export default function FeedPost({
  id,
  businessName,
  businessAvatar,
  businessCategory,
  postImage,
  caption,
  likes,
  comments,
  timestamp,
  isLiked = false,
  isSaved = false,
  onLike,
  onComment,
  onShare,
  onSave,
  onBusinessClick,
}: FeedPostProps) {
  const [showFullCaption, setShowFullCaption] = useState(false);

  return (
    <Card className="overflow-visible" data-testid={`post-${id}`}>
      <div className="p-4">
        <div className="flex items-center justify-between gap-4">
          <div
            className="flex items-center gap-3 cursor-pointer"
            onClick={() => onBusinessClick?.(id)}
            data-testid={`button-business-profile-${id}`}
          >
            <Avatar className="h-10 w-10 border">
              <AvatarImage src={businessAvatar} alt={businessName} />
              <AvatarFallback>{businessName.charAt(0)}</AvatarFallback>
            </Avatar>
            <div>
              <h4 className="font-semibold text-sm">{businessName}</h4>
              <Badge variant="secondary">{businessCategory}</Badge>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{timestamp}</span>
            <Button size="icon" variant="ghost" data-testid={`button-more-${id}`}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="aspect-[4/3] overflow-hidden">
        <img
          src={postImage}
          alt="Post"
          className="w-full h-full object-cover"
        />
      </div>

      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onLike?.(id)}
              data-testid={`button-like-post-${id}`}
            >
              <Heart
                className={`h-5 w-5 ${isLiked ? "fill-red-500 text-red-500" : ""}`}
              />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onComment?.(id)}
              data-testid={`button-comment-${id}`}
            >
              <MessageCircle className="h-5 w-5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => onShare?.(id)}
              data-testid={`button-share-${id}`}
            >
              <Share2 className="h-5 w-5" />
            </Button>
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onSave?.(id)}
            data-testid={`button-save-${id}`}
          >
            <Bookmark
              className={`h-5 w-5 ${isSaved ? "fill-primary text-primary" : ""}`}
            />
          </Button>
        </div>

        <div className="flex gap-4 text-sm">
          <span className="font-semibold" data-testid={`text-likes-${id}`}>{likes} likes</span>
          <span className="text-muted-foreground" data-testid={`text-comments-${id}`}>{comments} comments</span>
        </div>

        <div className="text-sm">
          <span className="font-semibold">{businessName}</span>{" "}
          <span className={showFullCaption ? "" : "line-clamp-2"}>
            {caption}
          </span>
          {caption.length > 100 && !showFullCaption && (
            <button
              className="text-muted-foreground ml-1"
              onClick={() => setShowFullCaption(true)}
              data-testid={`button-read-more-${id}`}
            >
              more
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}
