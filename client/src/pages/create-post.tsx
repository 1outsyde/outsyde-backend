import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Camera, Image, Loader2, ArrowLeft } from "lucide-react";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import type { User } from "@shared/schema";

interface TaggableBusiness {
  id: string;
  name: string;
  logoImage?: string;
}

interface TaggablePhotographer {
  id: string;
  displayName: string;
}

interface CreatePostPageProps {
  onBack: () => void;
}

export default function CreatePostPage({ onBack }: CreatePostPageProps) {
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
      setContent("");
      setImageUrl("");
      setTaggedBusinessId("");
      setTaggedPhotographerId("");
      onBack();
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to create post",
        variant: "destructive",
      });
    },
  });

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
    return (
      <div className="container max-w-lg mx-auto p-4 pb-24">
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground">Please sign in to create posts</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const hasTaggableEntities = 
    (taggableBusinesses?.businesses?.length ?? 0) > 0 || 
    (taggablePhotographers?.photographers?.length ?? 0) > 0;

  const getRoleDescription = () => {
    if (isVendor) return "Share updates about your business, products, or services with your customers.";
    if (isPhotographer) return "Showcase your work, share behind-the-scenes, or announce availability.";
    return "Share your experience with a business or photographer you've used.";
  };

  return (
    <div className="container max-w-lg mx-auto p-4 pb-24">
      <div className="flex items-center gap-3 mb-6">
        <Button
          size="icon"
          variant="ghost"
          onClick={onBack}
          data-testid="button-back-from-create"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-xl font-bold">Create Post</h1>
          <p className="text-sm text-muted-foreground">{getRoleDescription()}</p>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <div>
            <Label htmlFor="content">What's on your mind?</Label>
            <Textarea
              id="content"
              placeholder={
                isVendor 
                  ? "Share news about your business..." 
                  : isPhotographer 
                    ? "Share your latest work or availability..."
                    : "Share your experience..."
              }
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="mt-2 min-h-[120px]"
              data-testid="textarea-post-content"
            />
          </div>

          <div>
            <Label htmlFor="imageUrl" className="flex items-center gap-2">
              <Image className="h-4 w-4" />
              Image URL (optional)
            </Label>
            <Input
              id="imageUrl"
              placeholder="https://example.com/image.jpg"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              className="mt-2"
              data-testid="input-image-url"
            />
          </div>

          {isCustomer && (
            <div className="space-y-4">
              {!hasTaggableEntities ? (
                <p className="text-sm text-muted-foreground">
                  You can only tag businesses or photographers you've ordered from or booked.
                </p>
              ) : (
                <>
                  {(taggableBusinesses?.businesses?.length ?? 0) > 0 && (
                    <div>
                      <Label>Tag a Business</Label>
                      <Select value={taggedBusinessId} onValueChange={setTaggedBusinessId}>
                        <SelectTrigger className="mt-2" data-testid="select-tag-business">
                          <SelectValue placeholder="Select a business" />
                        </SelectTrigger>
                        <SelectContent>
                          {taggableBusinesses?.businesses.map((b) => (
                            <SelectItem key={b.id} value={b.id}>
                              {b.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  {(taggablePhotographers?.photographers?.length ?? 0) > 0 && (
                    <div>
                      <Label>Tag a Photographer</Label>
                      <Select value={taggedPhotographerId} onValueChange={setTaggedPhotographerId}>
                        <SelectTrigger className="mt-2" data-testid="select-tag-photographer">
                          <SelectValue placeholder="Select a photographer" />
                        </SelectTrigger>
                        <SelectContent>
                          {taggablePhotographers?.photographers.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.displayName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          <Button
            onClick={handleSubmit}
            disabled={createPostMutation.isPending}
            className="w-full"
            data-testid="button-submit-post"
          >
            {createPostMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Camera className="h-4 w-4 mr-2" />
            )}
            Post
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
