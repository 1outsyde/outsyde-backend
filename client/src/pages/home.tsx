import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import HeroSection from "@/components/HeroSection";
import SearchFilter from "@/components/SearchFilter";
import FeedPost from "@/components/FeedPost";
import BusinessCard from "@/components/BusinessCard";
import { Skeleton } from "@/components/ui/skeleton";
import heroImage from "@assets/generated_images/local_community_marketplace_hero.png";
import coffeeShopImage from "@assets/generated_images/coffee_shop_vendor_storefront.png";
import hairSalonImage from "@assets/generated_images/hair_salon_vendor_storefront.png";
import type { Business } from "@shared/schema";

interface HomePageProps {
  onViewBusiness: (id: string) => void;
}

export default function HomePage({ onViewBusiness }: HomePageProps) {
  const [location, setLocation] = useState("");
  const [searchValue, setSearchValue] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [showFeed, setShowFeed] = useState(false);
  const [likedPosts, setLikedPosts] = useState<Set<string>>(new Set());
  const [savedPosts, setSavedPosts] = useState<Set<string>>(new Set());
  const [likedBusinesses, setLikedBusinesses] = useState<Set<string>>(new Set());

  const { data: businessesResponse, isLoading: businessesLoading } = useQuery<{ businesses: Business[] }>({
    queryKey: ["/api/businesses"],
  });
  const businesses = businessesResponse?.businesses;

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
    } else {
      newLiked.add(id);
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

  // todo: remove mock functionality
  const feedPosts = [
    {
      id: "1",
      businessName: "Sunrise Coffee Co.",
      businessCategory: "Coffee & Cafe",
      postImage: coffeeShopImage,
      caption: "Fresh batch of our signature caramel lattes ready to go! Stop by today and get 20% off your first order. We're supporting local farmers with every cup you enjoy.",
      likes: 234,
      comments: 18,
      timestamp: "2h ago",
    },
    {
      id: "2",
      businessName: "Bella's Hair Studio",
      businessCategory: "Beauty",
      postImage: hairSalonImage,
      caption: "New fall colors are in! Book your appointment now and get a free deep conditioning treatment. Limited slots available this week.",
      likes: 189,
      comments: 12,
      timestamp: "4h ago",
    },
    {
      id: "3",
      businessName: "Green Valley Organics",
      businessCategory: "Food & Drinks",
      postImage: coffeeShopImage,
      caption: "Fresh harvest just arrived from local farms! Organic vegetables, fruits, and herbs. Support local agriculture and eat healthy.",
      likes: 312,
      comments: 28,
      timestamp: "6h ago",
    },
  ];

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

        <h2 className="text-2xl font-bold mb-6">
          {showFeed ? "Your Feed" : "Latest from Local Businesses"}
        </h2>
        <div className="max-w-2xl mx-auto space-y-6">
          {feedPosts.map((post) => (
            <FeedPost
              key={post.id}
              {...post}
              isLiked={likedPosts.has(post.id)}
              isSaved={savedPosts.has(post.id)}
              onLike={toggleLikePost}
              onSave={toggleSavePost}
              onComment={(id) => console.log("Comment:", id)}
              onShare={(id) => console.log("Share:", id)}
              onBusinessClick={onViewBusiness}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
