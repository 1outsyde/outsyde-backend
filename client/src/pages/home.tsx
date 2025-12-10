import { useState } from "react";
import HeroSection from "@/components/HeroSection";
import SearchFilter from "@/components/SearchFilter";
import FeedPost from "@/components/FeedPost";
import BusinessCard from "@/components/BusinessCard";
import heroImage from "@assets/generated_images/local_community_marketplace_hero.png";
import coffeeShopImage from "@assets/generated_images/coffee_shop_vendor_storefront.png";
import hairSalonImage from "@assets/generated_images/hair_salon_vendor_storefront.png";
import jewelryImage from "@assets/generated_images/jewelry_artisan_vendor_image.png";
import produceImage from "@assets/generated_images/organic_produce_vendor_image.png";
import yogaImage from "@assets/generated_images/yoga_studio_vendor_image.png";

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
      postImage: produceImage,
      caption: "Fresh harvest just arrived from local farms! Organic vegetables, fruits, and herbs. Support local agriculture and eat healthy.",
      likes: 312,
      comments: 28,
      timestamp: "6h ago",
    },
  ];

  // todo: remove mock functionality
  const nearbyBusinesses = [
    {
      id: "1",
      name: "Sunrise Coffee Co.",
      category: "Coffee & Cafe",
      image: coffeeShopImage,
      description: "Artisanal coffee and fresh pastries made daily. Supporting local farmers since 2015.",
      location: "Downtown, 0.5 mi away",
      rating: 4.8,
      reviewCount: 124,
      hasProducts: true,
      hasServices: false,
    },
    {
      id: "2",
      name: "Bella's Hair Studio",
      category: "Beauty",
      image: hairSalonImage,
      description: "Expert stylists specializing in modern cuts, vibrant colors, and personalized styling.",
      location: "Midtown, 0.8 mi away",
      rating: 4.9,
      reviewCount: 89,
      hasProducts: true,
      hasServices: true,
    },
    {
      id: "3",
      name: "Artisan Jewelry Co.",
      category: "Shopping",
      image: jewelryImage,
      description: "Handcrafted jewelry made with love. Unique pieces for every occasion.",
      location: "Arts District, 1.2 mi away",
      rating: 4.7,
      reviewCount: 56,
      hasProducts: true,
      hasServices: false,
    },
    {
      id: "4",
      name: "Zen Yoga Studio",
      category: "Health",
      image: yogaImage,
      description: "Find your inner peace with our expert-led yoga and meditation classes.",
      location: "Wellness Center, 0.6 mi away",
      rating: 4.9,
      reviewCount: 203,
      hasProducts: false,
      hasServices: true,
    },
  ];

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
              {nearbyBusinesses.map((business) => (
                <BusinessCard
                  key={business.id}
                  {...business}
                  isLiked={likedBusinesses.has(business.id)}
                  onLike={toggleLikeBusiness}
                  onClick={onViewBusiness}
                  onBook={onViewBusiness}
                  onShop={onViewBusiness}
                />
              ))}
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
