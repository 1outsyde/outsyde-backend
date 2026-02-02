import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { PenSquare, Image, Loader2, X, Video } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import type { User } from "@shared/schema";
import { getQueryFn } from "@/lib/queryClient";
import { MediaUploader } from "@/components/MediaUploader";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
  const [mediaUrl, setMediaUrl] = useState("");
  const [mediaType, setMediaType] = useState<"image" | "video" | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | undefined>();
  const [feedSurface, setFeedSurface] = useState<"pro" | "pulse">("pro");
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
    mutationFn: async (postData: { 
      content: string; 
      feedSurface: "pro" | "pulse";
      media?: { url: string; type: "image" | "video"; thumbnailUrl?: string };
      taggedBusinessId?: string; 
      taggedPhotographerId?: string;
    }) => {
      const res = await apiRequest("POST", "/api/feed", postData);
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Post created",
        description: feedSurface === "pulse" 
          ? "Your Pulse video is now live!" 
          : "Your post has been shared with the community.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/feed"] });
      queryClient.invalidateQueries({ queryKey: ["/api/pulse/feed"] });
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
    setMediaUrl("");
    setMediaType(null);
    setThumbnailUrl(undefined);
    setFeedSurface("pro");
    setTaggedBusinessId("");
    setTaggedPhotographerId("");
  };

  const handleSubmit = () => {
    if (feedSurface === "pulse" && mediaType !== "video") {
      toast({
        title: "Video required",
        description: "Pulse posts require a video. Please upload a video.",
        variant: "destructive",
      });
      return;
    }

    if (feedSurface === "pro" && !content.trim()) {
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

    const postData: {
      content: string;
      feedSurface: "pro" | "pulse";
      media?: { url: string; type: "image" | "video"; thumbnailUrl?: string };
      taggedBusinessId?: string;
      taggedPhotographerId?: string;
    } = {
      content: content.trim(),
      feedSurface,
      taggedBusinessId: taggedBusinessId || undefined,
      taggedPhotographerId: taggedPhotographerId || undefined,
    };

    if (mediaUrl && mediaType) {
      postData.media = {
        url: mediaUrl,
        type: mediaType,
        thumbnailUrl: thumbnailUrl,
      };
    }

    createPostMutation.mutate(postData);
  };

  const handleMediaUpload = (url: string, type: "image" | "video", thumb?: string) => {
    setMediaUrl(url);
    setMediaType(type);
    setThumbnailUrl(thumb);
    if (type === "video") {
      setFeedSurface("pulse");
    }
  };

  const clearMedia = () => {
    setMediaUrl("");
    setMediaType(null);
    setThumbnailUrl(undefined);
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
          <Tabs value={feedSurface} onValueChange={(v) => setFeedSurface(v as "pro" | "pulse")}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="pro" className="flex items-center gap-2" data-testid="tab-pro-feed">
                <Image className="h-4 w-4" />
                Pro Feed
              </TabsTrigger>
              <TabsTrigger value="pulse" className="flex items-center gap-2" data-testid="tab-pulse-feed">
                <Video className="h-4 w-4" />
                Pulse
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {feedSurface === "pulse" && (
            <p className="text-sm text-muted-foreground bg-muted p-3 rounded-md">
              Pulse is for short-form vertical videos. Upload a video (max 15s) to share on the discovery feed.
            </p>
          )}

          <div className="space-y-2">
            <Label htmlFor="post-content">
              {feedSurface === "pulse" ? "Caption (optional)" : "What's on your mind?"}
            </Label>
            <Textarea
              id="post-content"
              placeholder={
                feedSurface === "pulse"
                  ? "Add a caption to your video..."
                  : isCustomer 
                    ? "Share your experience with a local business or photographer..."
                    : "Share an update with your followers..."
              }
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="min-h-[80px] resize-none"
              data-testid="input-post-content"
            />
            <p className="text-xs text-muted-foreground text-right">
              {content.length}/2000
            </p>
          </div>

          <div className="space-y-2">
            <Label>{feedSurface === "pulse" ? "Video (required)" : "Media (optional)"}</Label>
            {mediaUrl ? (
              <div className="relative">
                {mediaType === "video" ? (
                  <video
                    src={mediaUrl}
                    poster={thumbnailUrl}
                    className="w-full h-48 object-cover rounded-lg"
                    controls
                    muted
                    data-testid="video-preview"
                  />
                ) : (
                  <img
                    src={mediaUrl}
                    alt="Preview"
                    className="w-full h-48 object-cover rounded-lg"
                    data-testid="image-preview"
                  />
                )}
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  className="absolute top-2 right-2"
                  onClick={clearMedia}
                  data-testid="button-remove-media"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <MediaUploader
                onUploadComplete={handleMediaUpload}
                allowVideo={true}
                allowImage={feedSurface === "pro"}
                maxVideoDuration={15}
                buttonVariant="outline"
                buttonClassName="w-full"
              >
                {feedSurface === "pulse" ? (
                  <>
                    <Video className="h-4 w-4 mr-2" />
                    Upload Video
                  </>
                ) : (
                  <>
                    <Image className="h-4 w-4 mr-2" />
                    Upload Media
                  </>
                )}
              </MediaUploader>
            )}
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
              disabled={
                createPostMutation.isPending || 
                (feedSurface === "pulse" && mediaType !== "video") ||
                (feedSurface === "pro" && !content.trim()) ||
                (Boolean(isCustomer) && !hasTaggableEntities)
              }
              data-testid="button-submit-post"
            >
              {createPostMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {feedSurface === "pulse" ? "Post to Pulse" : "Post"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
