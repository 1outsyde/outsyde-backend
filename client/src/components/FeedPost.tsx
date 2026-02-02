import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Heart, MessageCircle, Share2, Bookmark, MoreHorizontal, Store, Camera, ShoppingCart, Calendar, Clock, Send, Loader2, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";

interface ProductData {
  id: string;
  name: string;
  description?: string | null;
  price: number;
  imageUrl?: string | null;
  businessId: string;
}

interface ServiceData {
  id: string;
  name: string;
  description?: string | null;
  price: number;
  durationMinutes?: number | null;
  businessId: string;
}

interface PostComment {
  id: string;
  postId: string;
  userId: string;
  content: string;
  createdAt: string;
  user?: {
    id: string;
    name?: string;
    username?: string;
    firstName?: string;
    lastName?: string;
    profileImageUrl?: string;
  };
}

interface FeedPostProps {
  id: string;
  authorName: string;
  authorAvatar?: string;
  authorType: "customer" | "vendor" | "photographer";
  authorBusinessId?: string | null;
  authorPhotographerId?: string | null;
  postType?: "text" | "product" | "service";
  taggedBusinessName?: string;
  taggedPhotographerName?: string;
  postImage?: string;
  mediaUrl?: string;
  mediaType?: "image" | "video";
  thumbnailUrl?: string;
  content: string;
  likes: number;
  comments: number;
  timestamp: string;
  isLiked?: boolean;
  isSaved?: boolean;
  product?: ProductData | null;
  service?: ServiceData | null;
  isAuthenticated?: boolean;
  isAdmin?: boolean;
  onLike?: (id: string) => void;
  onComment?: (id: string) => void;
  onShare?: (id: string) => void;
  onSave?: (id: string) => void;
  onViewBusiness?: (id: string) => void;
  onViewPhotographer?: (id: string) => void;
  onAddToCart?: (productId: string) => void;
  onBookService?: (serviceId: string) => void;
  onLoginRequired?: () => void;
}

export default function FeedPost({
  id,
  authorName,
  authorAvatar,
  authorType,
  authorBusinessId,
  authorPhotographerId,
  postType = "text",
  taggedBusinessName,
  taggedPhotographerName,
  postImage,
  mediaUrl,
  mediaType,
  thumbnailUrl,
  content,
  likes,
  comments,
  timestamp,
  isLiked = false,
  isSaved = false,
  product,
  service,
  isAuthenticated = false,
  isAdmin = false,
  onLike,
  onComment,
  onShare,
  onSave,
  onViewBusiness,
  onViewPhotographer,
  onAddToCart,
  onBookService,
  onLoginRequired,
}: FeedPostProps) {
  const [showFullCaption, setShowFullCaption] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [newComment, setNewComment] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const deletePostMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/admin/posts/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/feed"] });
      toast({ title: "Post deleted", description: "The post has been removed." });
    },
    onError: () => {
      toast({ title: "Failed to delete post", variant: "destructive" });
    },
  });

  const { data: commentsData, isLoading: commentsLoading } = useQuery<{ comments: PostComment[] }>({
    queryKey: ["/api/feed", id, "comments"],
    enabled: showComments,
  });

  const postCommentMutation = useMutation({
    mutationFn: async (commentContent: string) => {
      const res = await apiRequest("POST", `/api/feed/${id}/comments`, { content: commentContent });
      return res.json();
    },
    onSuccess: () => {
      setNewComment("");
      queryClient.invalidateQueries({ queryKey: ["/api/feed", id, "comments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/feed"] });
    },
  });

  const handleSubmitComment = () => {
    if (!isAuthenticated) {
      onLoginRequired?.();
      return;
    }
    if (newComment.trim()) {
      postCommentMutation.mutate(newComment.trim());
    }
  };

  const handleCommentClick = () => {
    setShowComments(!showComments);
    onComment?.(id);
  };

  const formatCommentTime = (dateStr: string) => {
    try {
      return formatDistanceToNow(new Date(dateStr), { addSuffix: true });
    } catch {
      return "recently";
    }
  };

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
            onClick={() => {
              if (authorType === 'vendor' && authorBusinessId) {
                onViewBusiness?.(authorBusinessId);
              } else if (authorType === 'photographer' && authorPhotographerId) {
                onViewPhotographer?.(authorPhotographerId);
              }
            }}
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" data-testid={`button-more-${id}`}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {isAdmin && (
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => setDeleteDialogOpen(true)}
                    data-testid={`button-admin-delete-${id}`}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete Post
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
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

      {/* Regular post media (image or video) */}
      {postType === "text" && (mediaUrl || postImage) && (
        <div className="aspect-[4/3] overflow-hidden">
          {mediaType === "video" ? (
            <video
              src={mediaUrl}
              poster={thumbnailUrl || undefined}
              controls
              playsInline
              preload="metadata"
              className="w-full h-full object-cover"
              data-testid={`video-post-${id}`}
            />
          ) : (
            <img
              src={mediaUrl || postImage}
              alt="Post"
              className="w-full h-full object-cover"
              data-testid={`img-post-${id}`}
            />
          )}
        </div>
      )}

      {/* Product showcase */}
      {postType === "product" && product && (
        <div className="border-t border-b">
          <div className="flex gap-4 p-4">
            {product.imageUrl && (
              <div className="w-32 h-32 flex-shrink-0 overflow-hidden rounded-lg">
                <img
                  src={product.imageUrl}
                  alt={product.name}
                  className="w-full h-full object-cover"
                />
              </div>
            )}
            <div className="flex-1 min-w-0 flex flex-col justify-between">
              <div>
                <Badge variant="secondary" className="mb-2">Product</Badge>
                <h3 className="font-semibold text-lg" data-testid={`text-product-name-${id}`}>
                  {product.name}
                </h3>
                {product.description && (
                  <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                    {product.description}
                  </p>
                )}
              </div>
              <div className="flex items-center justify-between gap-2 mt-2">
                <span className="font-bold text-lg text-primary" data-testid={`text-product-price-${id}`}>
                  ${(product.price / 100).toFixed(2)}
                </span>
                <Button
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAddToCart?.(product.id);
                  }}
                  data-testid={`button-add-to-cart-${id}`}
                >
                  <ShoppingCart className="h-4 w-4 mr-2" />
                  Add to Cart
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Service showcase */}
      {postType === "service" && service && (
        <div className="border-t border-b">
          <div className="p-4">
            <Badge variant="secondary" className="mb-2">Service</Badge>
            <h3 className="font-semibold text-lg" data-testid={`text-service-name-${id}`}>
              {service.name}
            </h3>
            {service.description && (
              <p className="text-sm text-muted-foreground mt-1">
                {service.description}
              </p>
            )}
            <div className="flex items-center gap-4 mt-3">
              {service.durationMinutes && (
                <div className="flex items-center gap-1 text-sm text-muted-foreground">
                  <Clock className="h-4 w-4" />
                  <span>{service.durationMinutes} min</span>
                </div>
              )}
              <span className="font-bold text-lg text-primary" data-testid={`text-service-price-${id}`}>
                ${(service.price / 100).toFixed(2)}
              </span>
            </div>
            <Button
              className="w-full mt-3"
              onClick={(e) => {
                e.stopPropagation();
                onBookService?.(service.id);
              }}
              data-testid={`button-book-service-${id}`}
            >
              <Calendar className="h-4 w-4 mr-2" />
              Book Now
            </Button>
          </div>
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
              onClick={handleCommentClick}
              data-testid={`button-comment-${id}`}
            >
              <MessageCircle className={`h-5 w-5 ${showComments ? "fill-primary text-primary" : ""}`} />
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

        {/* Comments Section */}
        {showComments && (
          <div className="border-t pt-3 space-y-3" data-testid={`comments-section-${id}`}>
            {/* Comment Input */}
            <div className="flex gap-2">
              <Textarea
                placeholder={isAuthenticated ? "Write a comment..." : "Log in to comment"}
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                disabled={!isAuthenticated || postCommentMutation.isPending}
                className="min-h-[60px] resize-none flex-1"
                data-testid={`input-comment-${id}`}
              />
              <Button
                size="icon"
                onClick={handleSubmitComment}
                disabled={!newComment.trim() || postCommentMutation.isPending}
                data-testid={`button-submit-comment-${id}`}
              >
                {postCommentMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>

            {!isAuthenticated && (
              <button
                onClick={() => onLoginRequired?.()}
                className="text-sm text-primary hover:underline"
                data-testid={`button-login-to-comment-${id}`}
              >
                Log in to comment
              </button>
            )}

            {/* Comments List */}
            {commentsLoading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : commentsData?.comments && commentsData.comments.length > 0 ? (
              <div className="space-y-3 max-h-[300px] overflow-y-auto">
                {commentsData.comments.map((comment) => (
                  <div key={comment.id} className="flex gap-2" data-testid={`comment-${comment.id}`}>
                    <Avatar className="h-8 w-8 flex-shrink-0">
                      <AvatarImage src={comment.user?.profileImageUrl} alt={comment.user?.username || comment.user?.firstName || "User"} />
                      <AvatarFallback className="text-xs">
                        {(comment.user?.username || comment.user?.firstName || "U").charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm">
                          {comment.user?.username || (comment.user ? `${comment.user.firstName} ${comment.user.lastName}` : "User")}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatCommentTime(comment.createdAt)}
                        </span>
                      </div>
                      <p className="text-sm">{comment.content}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-2">
                No comments yet. Be the first to comment!
              </p>
            )}
          </div>
        )}
      </div>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this post?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The post will be permanently removed from the platform.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletePostMutation.mutate()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deletePostMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deletePostMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
