import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import HeroSection from "@/components/HeroSection";
import SearchFilter from "@/components/SearchFilter";
import FeedPost from "@/components/FeedPost";
import BusinessCard from "@/components/BusinessCard";
import CreatePostDialog from "@/components/CreatePostDialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { PenSquare } from "lucide-react";
import heroImage from "@assets/generated_images/local_community_marketplace_hero.png";
import coffeeShopImage from "@assets/generated_images/coffee_shop_vendor_storefront.png";
import type { Business, User } from "@shared/schema";
import { getQueryFn, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface HomePageProps {
  onViewBusiness: (id: string) => void;
  onViewPhotographer?: (id: string) => void;
  onLoginRequired?: () => void;
}

interface FeedPostData {
  id: string;
  authorId: string;
  authorType: "customer" | "vendor" | "photographer";
  postType?: "text" | "product" | "service";
  content: string;
  imageUrl?: string;
  taggedBusinessId?: string;
  taggedPhotographerId?: string;
  productId?: string;
  serviceId?: string;
  likesCount: number;
  commentsCount: number;
  createdAt: string;
  author: {
    id: string;
    name: string;
    profileImageUrl?: string;
    businessId?: string | null;
    photographerId?: string | null;
  } | null;
  taggedBusiness: {
    id: string;
    name: string;
    logoImage?: string;
  } | null;
  taggedPhotographer: {
    id: string;
    displayName: string;
  } | null;
  product?: {
    id: string;
    name: string;
    description?: string | null;
    price: number;
    imageUrl?: string | null;
    businessId: string;
  } | null;
  service?: {
    id: string;
    name: string;
    description?: string | null;
    price: number;
    durationMinutes?: number | null;
    businessId: string;
  } | null;
}

export default function HomePage({ onViewBusiness, onViewPhotographer, onLoginRequired }: HomePageProps) {
  const [location, setLocation] = useState("");
  const [searchValue, setSearchValue] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [showFeed, setShowFeed] = useState(false);
  const [likedPosts, setLikedPosts] = useState<Set<string>>(new Set());
  const [savedPosts, setSavedPosts] = useState<Set<string>>(new Set());
  const [likedBusinesses, setLikedBusinesses] = useState<Set<string>>(new Set());

  const queryClient = useQueryClient();

  const { data: user } = useQuery<User | null>({
    queryKey: ["/api/auth/user"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    retry: false,
  });

  const { data: businessesResponse, isLoading: businessesLoading } = useQuery<{ businesses: Business[] }>({
    queryKey: ["/api/businesses"],
  });
  const businesses = businessesResponse?.businesses;

  const { data: feedResponse, isLoading: feedLoading } = useQuery<{ posts: FeedPostData[] }>({
    queryKey: ["/api/feed"],
  });
  const feedPosts = feedResponse?.posts || [];

  const likeMutation = useMutation({
    mutationFn: async (postId: string) => {
      const res = await apiRequest("POST", `/api/feed/${postId}/like`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/feed"] });
    },
  });

  const unlikeMutation = useMutation({
    mutationFn: async (postId: string) => {
      const res = await apiRequest("DELETE", `/api/feed/${postId}/like`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/feed"] });
    },
  });

  const { toast } = useToast();

  const addToCartMutation = useMutation({
    mutationFn: async (productId: string) => {
      const res = await apiRequest("POST", "/api/cart/items", { productId, quantity: 1 });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/cart"] });
      toast({
        title: "Added to cart",
        description: "Product has been added to your cart.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to add product to cart. Please try again.",
        variant: "destructive",
      });
    },
  });

  const categories = [
    "All",
    "Food & Drinks",
    "Beauty",
    "Health",
    "Shopping",
    "Services",
  ];

  const handleCategoryToggle = (category: string) => {
    if (selectedCategories.includes(category)) {
      setSelectedCategories(selectedCategories.filter((c) => c !== category));
    } else {
      setSelectedCategories([...selectedCategories, category]);
    }
  };

  const toggleLikePost = (id: string) => {
    const newLiked = new Set(likedPosts);
    if (newLiked.has(id)) {
      newLiked.delete(id);
      unlikeMutation.mutate(id);
    } else {
      newLiked.add(id);
      likeMutation.mutate(id);
    }
    setLikedPosts(newLiked);
  };

  const toggleSavePost = (id: string) => {
    const newSaved = new Set(savedPosts);
    if (newSaved.has(id)) {
      newSaved.delete(id);
    } else {
      newSaved.add(id);
    }
    setSavedPosts(newSaved);
  };

  const toggleLikeBusiness = (id: string) => {
    const newLiked = new Set(likedBusinesses);
    if (newLiked.has(id)) {
      newLiked.delete(id);
    } else {
      newLiked.add(id);
    }
    setLikedBusinesses(newLiked);
  };

  const defaultImage = coffeeShopImage;

  const mapBusinessToCard = (business: Business) => ({
    id: business.id,
    name: business.name,
    category: business.category,
    image: business.coverImage || defaultImage,
    avatar: business.logoImage || undefined,
    description: business.description || "Discover what this local business has to offer.",
    location: business.city && business.state ? `${business.city}, ${business.state}` : "Local Business",
    rating: business.rating || 0,
    reviewCount: business.reviewCount || 0,
    hasProducts: business.hasProducts || false,
    hasServices: business.hasServices || false,
  });

  const formatTimestamp = (dateStr: string) => {
    try {
      return formatDistanceToNow(new Date(dateStr), { addSuffix: true });
    } catch {
      return "recently";
    }
  };

  return (
    <div className="min-h-screen pb-20 md:pb-0" data-testid="page-home">
      {!showFeed ? (
        <HeroSection
          backgroundImage={heroImage}
          location={location}
          onLocationChange={setLocation}
          onExplore={() => setShowFeed(true)}
        />
      ) : (
        <div className="max-w-7xl mx-auto px-4 py-6">
          <SearchFilter
            searchValue={searchValue}
            onSearchChange={setSearchValue}
            categories={categories}
            selectedCategories={selectedCategories}
            onCategoryToggle={handleCategoryToggle}
          />
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 py-6">
        {!showFeed && (
          <>
            <h2 className="text-2xl font-bold mb-6">Discover Nearby Businesses</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-12">
              {businessesLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="space-y-3">
                    <Skeleton className="h-48 w-full rounded-md" />
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-4 w-1/2" />
                  </div>
                ))
              ) : businesses && businesses.length > 0 ? (
                businesses.slice(0, 8).map((business) => {
                  const cardData = mapBusinessToCard(business);
                  return (
                    <BusinessCard
                      key={cardData.id}
                      {...cardData}
                      isLiked={likedBusinesses.has(cardData.id)}
                      onLike={toggleLikeBusiness}
                      onClick={onViewBusiness}
                      onBook={onViewBusiness}
                      onShop={onViewBusiness}
                    />
                  );
                })
              ) : (
                <p className="col-span-4 text-center text-muted-foreground py-8">
                  No businesses found. Check back soon!
                </p>
              )}
            </div>
          </>
        )}

        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold">
            {showFeed ? "Your Feed" : "Latest from the Community"}
          </h2>
          {user && (
            <CreatePostDialog
              trigger={
                <Button data-testid="button-create-post">
                  <PenSquare className="h-4 w-4 mr-2" />
                  Create Post
                </Button>
              }
            />
          )}
        </div>

        <div className="max-w-2xl mx-auto space-y-6">
          {feedLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-3">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="space-y-1">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                </div>
                <Skeleton className="h-64 w-full rounded-md" />
                <Skeleton className="h-4 w-full" />
              </div>
            ))
          ) : feedPosts.length > 0 ? (
            feedPosts.map((post) => (
              <FeedPost
                key={post.id}
                id={post.id}
                authorName={post.author?.name || "Unknown User"}
                authorAvatar={post.author?.profileImageUrl}
                authorType={post.authorType}
                authorBusinessId={post.author?.businessId}
                authorPhotographerId={post.author?.photographerId}
                postType={post.postType || "text"}
                taggedBusinessName={post.taggedBusiness?.name}
                taggedPhotographerName={post.taggedPhotographer?.displayName}
                postImage={post.imageUrl}
                content={post.content}
                likes={post.likesCount}
                comments={post.commentsCount}
                timestamp={formatTimestamp(post.createdAt)}
                isLiked={likedPosts.has(post.id)}
                isSaved={savedPosts.has(post.id)}
                product={post.product}
                service={post.service}
                isAuthenticated={!!user}
                isAdmin={!!user?.isAdmin}
                onLike={toggleLikePost}
                onSave={toggleSavePost}
                onShare={(id) => console.log("Share:", id)}
                onViewBusiness={onViewBusiness}
                onViewPhotographer={onViewPhotographer}
                onAddToCart={(productId) => {
                  if (!user) {
                    toast({
                      title: "Login required",
                      description: "Please log in to add items to your cart.",
                      variant: "destructive",
                    });
                    return;
                  }
                  addToCartMutation.mutate(productId);
                }}
                onBookService={(serviceId) => {
                  if (post.service?.businessId) {
                    onViewBusiness(post.service.businessId);
                  }
                }}
                onLoginRequired={onLoginRequired}
              />
            ))
          ) : (
            <div className="text-center py-12">
              <p className="text-muted-foreground mb-4">
                No posts yet. Be the first to share something!
              </p>
              {user && (
                <CreatePostDialog
                  trigger={
                    <Button data-testid="button-create-first-post">
                      <PenSquare className="h-4 w-4 mr-2" />
                      Create the First Post
                    </Button>
                  }
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
