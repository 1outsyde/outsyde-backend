import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { PenSquare, Image, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import type { User } from "@shared/schema";
import { getQueryFn } from "@/lib/queryClient";

interface TaggableBusiness {
  id: string;
  name: string;
  logoImage?: string;
}

interface TaggablePhotographer {
  id: string;
  displayName: string;
}

interface CreatePostDialogProps {
  trigger?: React.ReactNode;
}

export default function CreatePostDialog({ trigger }: CreatePostDialogProps) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [taggedBusinessId, setTaggedBusinessId] = useState<string>("");
  const [taggedPhotographerId, setTaggedPhotographerId] = useState<string>("");
  
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: user } = useQuery<User | null>({
    queryKey: ["/api/auth/user"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    retry: false,
  });

  const isVendor = user?.isVendor ?? false;
  const isPhotographer = user?.isPhotographer ?? false;
  const isCustomer = user && !isVendor && !isPhotographer;

  const { data: taggableBusinesses } = useQuery<{ businesses: TaggableBusiness[] }>({
    queryKey: ["/api/feed/taggable-businesses"],
    enabled: Boolean(user && isCustomer),
  });

  const { data: taggablePhotographers } = useQuery<{ photographers: TaggablePhotographer[] }>({
    queryKey: ["/api/feed/taggable-photographers"],
    enabled: Boolean(user && isCustomer),
  });

  const createPostMutation = useMutation({
    mutationFn: async (postData: { content: string; imageUrl?: string; taggedBusinessId?: string; taggedPhotographerId?: string }) => {
      const res = await apiRequest("POST", "/api/feed", postData);
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Post created",
        description: "Your post has been shared with the community.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/feed"] });
      setOpen(false);
      resetForm();
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to create post",
        variant: "destructive",
      });
    },
  });

  const resetForm = () => {
    setContent("");
    setImageUrl("");
    setTaggedBusinessId("");
    setTaggedPhotographerId("");
  };

  const handleSubmit = () => {
    if (!content.trim()) {
      toast({
        title: "Content required",
        description: "Please write something before posting.",
        variant: "destructive",
      });
      return;
    }

    if (isCustomer && !taggedBusinessId && !taggedPhotographerId) {
      toast({
        title: "Tag required",
        description: "Please tag a business or photographer you've used.",
        variant: "destructive",
      });
      return;
    }

    createPostMutation.mutate({
      content: content.trim(),
      imageUrl: imageUrl || undefined,
      taggedBusinessId: taggedBusinessId || undefined,
      taggedPhotographerId: taggedPhotographerId || undefined,
    });
  };

  if (!user) {
    return null;
  }

  const hasTaggableEntities = 
    (taggableBusinesses?.businesses?.length ?? 0) > 0 || 
    (taggablePhotographers?.photographers?.length ?? 0) > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button data-testid="button-create-post">
            <PenSquare className="h-4 w-4 mr-2" />
            Create Post
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Create a Post</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-4">
          <div className="space-y-2">
            <Label htmlFor="post-content">What's on your mind?</Label>
            <Textarea
              id="post-content"
              placeholder={
                isCustomer 
                  ? "Share your experience with a local business or photographer..."
                  : "Share an update with your followers..."
              }
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="min-h-[120px] resize-none"
              data-testid="input-post-content"
            />
            <p className="text-xs text-muted-foreground text-right">
              {content.length}/2000
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="image-url">Image URL (optional)</Label>
            <div className="flex gap-2">
              <input
                id="image-url"
                type="text"
                placeholder="https://example.com/image.jpg"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                data-testid="input-post-image"
              />
              <Button size="icon" variant="outline" type="button">
                <Image className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {isCustomer && (
            <>
              {!hasTaggableEntities ? (
                <p className="text-sm text-muted-foreground p-3 bg-muted rounded-md">
                  You can only create posts after purchasing from or booking with a local business or photographer.
                </p>
              ) : (
                <div className="space-y-4">
                  {(taggableBusinesses?.businesses?.length ?? 0) > 0 && (
                    <div className="space-y-2">
                      <Label>Tag a Business (required if no photographer tagged)</Label>
                      <Select value={taggedBusinessId} onValueChange={setTaggedBusinessId}>
                        <SelectTrigger data-testid="select-tag-business">
                          <SelectValue placeholder="Select a business..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          {taggableBusinesses?.businesses?.map((business) => (
                            <SelectItem key={business.id} value={business.id}>
                              {business.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {(taggablePhotographers?.photographers?.length ?? 0) > 0 && (
                    <div className="space-y-2">
                      <Label>Tag a Photographer (required if no business tagged)</Label>
                      <Select value={taggedPhotographerId} onValueChange={setTaggedPhotographerId}>
                        <SelectTrigger data-testid="select-tag-photographer">
                          <SelectValue placeholder="Select a photographer..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          {taggablePhotographers?.photographers?.map((photographer) => (
                            <SelectItem key={photographer.id} value={photographer.id}>
                              {photographer.displayName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setOpen(false)} data-testid="button-cancel-post">
              Cancel
            </Button>
            <Button 
              onClick={handleSubmit} 
              disabled={createPostMutation.isPending || !content.trim() || (Boolean(isCustomer) && !hasTaggableEntities)}
              data-testid="button-submit-post"
            >
              {createPostMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Post
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
