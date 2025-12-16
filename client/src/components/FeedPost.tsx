import { useState } from "react";
import { Heart, MessageCircle, Share2, Bookmark, MoreHorizontal, Store, Camera } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

interface FeedPostProps {
  id: string;
  authorName: string;
  authorAvatar?: string;
  authorType: "customer" | "vendor" | "photographer";
  taggedBusinessName?: string;
  taggedPhotographerName?: string;
  postImage?: string;
  content: string;
  likes: number;
  comments: number;
  timestamp: string;
  isLiked?: boolean;
  isSaved?: boolean;
  onLike?: (id: string) => void;
  onComment?: (id: string) => void;
  onShare?: (id: string) => void;
  onSave?: (id: string) => void;
  onAuthorClick?: (id: string) => void;
}

export default function FeedPost({
  id,
  authorName,
  authorAvatar,
  authorType,
  taggedBusinessName,
  taggedPhotographerName,
  postImage,
  content,
  likes,
  comments,
  timestamp,
  isLiked = false,
  isSaved = false,
  onLike,
  onComment,
  onShare,
  onSave,
  onAuthorClick,
}: FeedPostProps) {
  const [showFullCaption, setShowFullCaption] = useState(false);

  const getAuthorTypeLabel = () => {
    switch (authorType) {
      case "vendor":
        return "Business";
      case "photographer":
        return "Photographer";
      default:
        return "Customer";
    }
  };

  const getAuthorTypeBadgeVariant = () => {
    switch (authorType) {
      case "vendor":
        return "default";
      case "photographer":
        return "secondary";
      default:
        return "outline";
    }
  };

  return (
    <Card className="overflow-visible" data-testid={`post-${id}`}>
      <div className="p-4">
        <div className="flex items-center justify-between gap-4">
          <div
            className="flex items-center gap-3 cursor-pointer"
            onClick={() => onAuthorClick?.(id)}
            data-testid={`button-author-profile-${id}`}
          >
            <Avatar className="h-10 w-10 border">
              <AvatarImage src={authorAvatar} alt={authorName || "User"} />
              <AvatarFallback>{(authorName || "U").charAt(0)}</AvatarFallback>
            </Avatar>
            <div>
              <h4 className="font-semibold text-sm">{authorName}</h4>
              <Badge variant={getAuthorTypeBadgeVariant()} className="text-xs">
                {getAuthorTypeLabel()}
              </Badge>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{timestamp}</span>
            <Button size="icon" variant="ghost" data-testid={`button-more-${id}`}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {(taggedBusinessName || taggedPhotographerName) && (
          <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
            {taggedBusinessName && (
              <div className="flex items-center gap-1">
                <Store className="h-3 w-3" />
                <span>@{taggedBusinessName}</span>
              </div>
            )}
            {taggedPhotographerName && (
              <div className="flex items-center gap-1">
                <Camera className="h-3 w-3" />
                <span>@{taggedPhotographerName}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {postImage && (
        <div className="aspect-[4/3] overflow-hidden">
          <img
            src={postImage}
            alt="Post"
            className="w-full h-full object-cover"
          />
        </div>
      )}

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
          <span className="font-semibold">{authorName}</span>{" "}
          <span className={showFullCaption ? "" : "line-clamp-2"}>
            {content}
          </span>
          {content.length > 100 && !showFullCaption && (
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
