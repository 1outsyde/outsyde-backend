import { useState } from "react";
import SearchFilter from "@/components/SearchFilter";
import BusinessCard from "@/components/BusinessCard";
import coffeeShopImage from "@assets/generated_images/coffee_shop_vendor_storefront.png";
import hairSalonImage from "@assets/generated_images/hair_salon_vendor_storefront.png";
import jewelryImage from "@assets/generated_images/jewelry_artisan_vendor_image.png";
import produceImage from "@assets/generated_images/organic_produce_vendor_image.png";
import yogaImage from "@assets/generated_images/yoga_studio_vendor_image.png";

interface SearchPageProps {
  onViewBusiness: (id: string) => void;
  onMessage: (id: string) => void;
}

export default function SearchPage({ onViewBusiness, onMessage }: SearchPageProps) {
  const [searchValue, setSearchValue] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [likedBusinesses, setLikedBusinesses] = useState<Set<string>>(new Set());

  const categories = [
    "All",
    "Food & Drinks",
    "Beauty",
    "Health",
    "Shopping",
    "Services",
    "Entertainment",
  ];

  // todo: remove mock functionality
  const allBusinesses = [
    {
      id: "1",
      name: "Sunrise Coffee Co.",
      category: "Food & Drinks",
      image: coffeeShopImage,
      description: "Artisanal coffee and fresh pastries made daily.",
      location: "Downtown, 0.5 mi",
      rating: 4.8,
      reviewCount: 124,
    },
    {
      id: "2",
      name: "Bella's Hair Studio",
      category: "Beauty",
      image: hairSalonImage,
      description: "Expert stylists for modern cuts and colors.",
      location: "Midtown, 0.8 mi",
      rating: 4.9,
      reviewCount: 89,
    },
    {
      id: "3",
      name: "Artisan Jewelry Co.",
      category: "Shopping",
      image: jewelryImage,
      description: "Handcrafted jewelry for every occasion.",
      location: "Arts District, 1.2 mi",
      rating: 4.7,
      reviewCount: 56,
    },
    {
      id: "4",
      name: "Zen Yoga Studio",
      category: "Health",
      image: yogaImage,
      description: "Expert-led yoga and meditation classes.",
      location: "Wellness Center, 0.6 mi",
      rating: 4.9,
      reviewCount: 203,
    },
    {
      id: "5",
      name: "Green Valley Organics",
      category: "Food & Drinks",
      image: produceImage,
      description: "Fresh organic produce from local farms.",
      location: "Farmers Market, 1.0 mi",
      rating: 4.8,
      reviewCount: 167,
    },
    {
      id: "6",
      name: "Urban Cuts Barbershop",
      category: "Beauty",
      image: hairSalonImage,
      description: "Classic cuts and modern styles for men.",
      location: "Main Street, 0.4 mi",
      rating: 4.6,
      reviewCount: 78,
    },
  ];

  const filteredBusinesses = allBusinesses.filter((business) => {
    const matchesSearch =
      !searchValue ||
      business.name.toLowerCase().includes(searchValue.toLowerCase()) ||
      business.description.toLowerCase().includes(searchValue.toLowerCase());

    const matchesCategory =
      selectedCategories.length === 0 ||
      selectedCategories.includes("All") ||
      selectedCategories.includes(business.category);

    return matchesSearch && matchesCategory;
  });

  const handleCategoryToggle = (category: string) => {
    if (selectedCategories.includes(category)) {
      setSelectedCategories(selectedCategories.filter((c) => c !== category));
    } else {
      setSelectedCategories([...selectedCategories, category]);
    }
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

  return (
    <div className="min-h-screen pb-20 md:pb-0" data-testid="page-search">
      <div className="max-w-7xl mx-auto px-4 py-6">
        <h1 className="text-2xl font-bold mb-6">Discover Local Businesses</h1>

        <SearchFilter
          searchValue={searchValue}
          onSearchChange={setSearchValue}
          categories={categories}
          selectedCategories={selectedCategories}
          onCategoryToggle={handleCategoryToggle}
        />

        <div className="mt-6">
          <p className="text-sm text-muted-foreground mb-4">
            {filteredBusinesses.length} businesses found
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filteredBusinesses.map((business) => (
              <BusinessCard
                key={business.id}
                {...business}
                isLiked={likedBusinesses.has(business.id)}
                onLike={toggleLikeBusiness}
                onClick={onViewBusiness}
                onMessage={onMessage}
              />
            ))}
          </div>

          {filteredBusinesses.length === 0 && (
            <div className="text-center py-12">
              <p className="text-muted-foreground">No businesses found matching your criteria.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
