import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Send, MessageSquare, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatDistanceToNow } from "date-fns";

interface ProfileComment {
  id: string;
  targetType: string;
  targetId: string;
  userId: string;
  content: string;
  createdAt: string;
  authorName: string | null;
  authorUsername: string | null;
  authorImage: string | null;
}

interface ProfileCommentsProps {
  targetType: "business" | "photographer";
  targetId: string;
  isAuthenticated: boolean;
  onLoginRequired?: () => void;
}

export default function ProfileComments({
  targetType,
  targetId,
  isAuthenticated,
  onLoginRequired,
}: ProfileCommentsProps) {
  const [newComment, setNewComment] = useState("");
  const { toast } = useToast();

  const { data: commentsData, isLoading } = useQuery<{ comments: ProfileComment[] }>({
    queryKey: ["/api/profile-comments", targetType, targetId],
    queryFn: async () => {
      const response = await fetch(`/api/profile-comments/${targetType}/${targetId}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch comments");
      return response.json();
    },
  });

  const addCommentMutation = useMutation({
    mutationFn: async (content: string) => {
      const response = await apiRequest("POST", "/api/profile-comments", { targetType, targetId, content });
      return response.json();
    },
    onSuccess: () => {
      setNewComment("");
      queryClient.invalidateQueries({ queryKey: ["/api/profile-comments", targetType, targetId] });
      toast({
        title: "Comment posted",
        description: "Your comment has been added successfully.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to post comment. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = () => {
    if (!isAuthenticated) {
      onLoginRequired?.();
      return;
    }
    if (newComment.trim()) {
      addCommentMutation.mutate(newComment.trim());
    }
  };

  const comments = commentsData?.comments || [];

  return (
    <div className="space-y-6">
      {/* Comment input */}
      <Card className="overflow-visible">
        <CardContent className="p-4">
          <div className="space-y-3">
            <Textarea
              placeholder={isAuthenticated ? "Write a comment..." : "Log in to leave a comment"}
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              disabled={!isAuthenticated || addCommentMutation.isPending}
              className="resize-none"
              rows={3}
              data-testid="input-comment"
            />
            <div className="flex justify-end">
              <Button
                onClick={handleSubmit}
                disabled={!newComment.trim() || addCommentMutation.isPending}
                data-testid="button-submit-comment"
              >
                {addCommentMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Send className="h-4 w-4 mr-2" />
                )}
                Post Comment
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Comments list */}
      {isLoading ? (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <Card key={i} className="overflow-visible">
              <CardContent className="p-4">
                <div className="flex gap-3">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-16 w-full" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : comments.length === 0 ? (
        <div className="text-center py-8">
          <MessageSquare className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium mb-2">No comments yet</h3>
          <p className="text-muted-foreground">
            Be the first to leave a comment!
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {comments.map((comment) => (
            <Card key={comment.id} className="overflow-visible" data-testid={`comment-${comment.id}`}>
              <CardContent className="p-4">
                <div className="flex gap-3">
                  <Avatar className="h-10 w-10">
                    <AvatarImage src={comment.authorImage || undefined} alt={comment.authorUsername || comment.authorName || "User"} />
                    <AvatarFallback>
                      {(comment.authorUsername || comment.authorName || "U").charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium" data-testid={`comment-author-${comment.id}`}>
                        {comment.authorUsername || comment.authorName || "Anonymous"}
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {formatDistanceToNow(new Date(comment.createdAt), { addSuffix: true })}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground whitespace-pre-wrap" data-testid={`comment-content-${comment.id}`}>
                      {comment.content}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
