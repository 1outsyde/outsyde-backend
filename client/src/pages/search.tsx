import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin, TrendingUp, Plane, Loader2, Store, Camera } from "lucide-react";
import SearchFilter from "@/components/SearchFilter";
import BusinessCard from "@/components/BusinessCard";
import PhotographerCard from "@/components/PhotographerCard";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import coffeeShopImage from "@assets/generated_images/coffee_shop_vendor_storefront.png";
import hairSalonImage from "@assets/generated_images/hair_salon_vendor_storefront.png";
import jewelryImage from "@assets/generated_images/jewelry_artisan_vendor_image.png";
import yogaImage from "@assets/generated_images/yoga_studio_vendor_image.png";
import type { Business, Photographer, City } from "@shared/schema";

interface SearchPageProps {
  onViewBusiness: (id: string) => void;
  onViewPhotographer?: (id: string) => void;
}

const categoryImageMap: Record<string, string> = {
  "Food & Drinks": coffeeShopImage,
  "Beauty": hairSalonImage,
  "Shopping": jewelryImage,
  "Health": yogaImage,
};

type SearchTab = "all" | "businesses" | "photographers";

export default function SearchPage({ onViewBusiness, onViewPhotographer }: SearchPageProps) {
  const [searchValue, setSearchValue] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [likedBusinesses, setLikedBusinesses] = useState<Set<string>>(new Set());
  const [likedPhotographers, setLikedPhotographers] = useState<Set<string>>(new Set());
  const [selectedCity, setSelectedCity] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SearchTab>("all");

  const categories = [
    "All",
    "Food & Drinks",
    "Beauty",
    "Health",
    "Shopping",
    "Services",
    "Entertainment",
  ];

  // Fetch cities from API
  const { data: citiesData, isLoading: citiesLoading } = useQuery<{ cities: City[] }>({
    queryKey: ["/api/cities"],
  });

  // Fetch unified search results
  const { data: searchData, isLoading: searchLoading } = useQuery<{ 
    businesses: Business[]; 
    photographers: Photographer[] 
  }>({
    queryKey: ["/api/search", selectedCity, selectedCategories.join(","), searchValue],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedCity) {
        const city = cities.find(c => c.id === selectedCity);
        if (city) params.append("city", city.name);
      }
      if (selectedCategories.length > 0 && !selectedCategories.includes("All")) {
        params.append("category", selectedCategories[0]);
      }
      if (searchValue) params.append("search", searchValue);
      
      const response = await fetch(`/api/search?${params.toString()}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to search");
      return response.json();
    },
  });

  const cities = citiesData?.cities || [];
  const businesses = searchData?.businesses || [];
  const photographers = searchData?.photographers || [];

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

  const toggleLikePhotographer = (id: string) => {
    const newLiked = new Set(likedPhotographers);
    if (newLiked.has(id)) {
      newLiked.delete(id);
    } else {
      newLiked.add(id);
    }
    setLikedPhotographers(newLiked);
  };

  const handleCitySelect = (cityId: string) => {
    setSelectedCity(selectedCity === cityId ? null : cityId);
  };

  const selectedCityData = cities.find((c) => c.id === selectedCity);

  const getBusinessImage = (business: Business) => {
    return categoryImageMap[business.category] || coffeeShopImage;
  };

  const formatRating = (rating: number | null) => {
    if (!rating) return 0;
    return rating / 10;
  };

  const handleViewPhotographer = (id: string) => {
    if (onViewPhotographer) {
      onViewPhotographer(id);
    } else {
      window.location.href = `/photographer/${id}`;
    }
  };

  // Filter results based on active tab
  const filteredBusinesses = activeTab === "photographers" ? [] : businesses;
  const filteredPhotographers = activeTab === "businesses" ? [] : photographers;

  const totalResults = filteredBusinesses.length + filteredPhotographers.length;

  return (
    <div className="min-h-screen pb-20 md:pb-0" data-testid="page-search">
      <div className="max-w-7xl mx-auto px-4 py-6">
        <h1 className="text-2xl font-bold mb-2">Discover Local Businesses & Photographers</h1>
        <p className="text-muted-foreground mb-6">
          Find and support small businesses and creative professionals in your area
        </p>

        <SearchFilter
          searchValue={searchValue}
          onSearchChange={setSearchValue}
          categories={categories}
          selectedCategories={selectedCategories}
          onCategoryToggle={handleCategoryToggle}
        />

        {/* Result Type Tabs */}
        <div className="mt-6 mb-4">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as SearchTab)}>
            <TabsList>
              <TabsTrigger value="all" data-testid="tab-all">
                All ({businesses.length + photographers.length})
              </TabsTrigger>
              <TabsTrigger value="businesses" data-testid="tab-businesses">
                <Store className="h-4 w-4 mr-1" />
                Businesses ({businesses.length})
              </TabsTrigger>
              <TabsTrigger value="photographers" data-testid="tab-photographers">
                <Camera className="h-4 w-4 mr-1" />
                Photographers ({photographers.length})
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Explore Cities Section */}
        <div className="mt-6 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Plane className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-semibold">Explore Cities</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Traveling? Discover local businesses and photographers wherever you go
          </p>
          
          {citiesLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {[...Array(8)].map((_, i) => (
                <Skeleton key={i} className="aspect-[4/3] rounded-md" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {cities.map((city) => (
                <Card
                  key={city.id}
                  className={`relative overflow-hidden cursor-pointer group hover-elevate ${
                    selectedCity === city.id ? "ring-2 ring-primary" : ""
                  }`}
                  onClick={() => handleCitySelect(city.id)}
                  data-testid={`city-card-${city.id}`}
                >
                  <div className="aspect-[4/3] relative">
                    <img
                      src={city.imageUrl || "https://images.unsplash.com/photo-1496442226666-8d4d0e62e6e9?w=400&h=300&fit=crop"}
                      alt={city.name}
                      className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
                    
                    {city.trending && (
                      <Badge 
                        className="absolute top-2 right-2 bg-primary/90"
                        variant="default"
                      >
                        <TrendingUp className="h-3 w-3 mr-1" />
                        Trending
                      </Badge>
                    )}
                    
                    <div className="absolute bottom-0 left-0 right-0 p-3 text-white">
                      <h3 className="font-semibold text-lg">{city.name}</h3>
                      <div className="flex items-center gap-1 text-sm opacity-90">
                        <MapPin className="h-3 w-3" />
                        <span>{city.state}</span>
                        <span className="mx-1">•</span>
                        <span>{(city.businessCount || 0).toLocaleString()} businesses</span>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Selected City Banner */}
        {selectedCityData && (
          <Card className="mb-6 bg-primary/5 border-primary/20 overflow-visible">
            <CardContent className="p-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <MapPin className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="font-medium">
                    Exploring {selectedCityData.name}, {selectedCityData.state}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {totalResults} results found
                  </p>
                </div>
              </div>
              <Badge
                variant="outline"
                className="cursor-pointer"
                onClick={() => setSelectedCity(null)}
                data-testid="button-clear-city"
              >
                Clear
              </Badge>
            </CardContent>
          </Card>
        )}

        {/* Search Results */}
        <div className="mt-6">
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-muted-foreground">
              {searchLoading ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Searching...
                </span>
              ) : (
                <>
                  {totalResults} results found
                  {selectedCityData && ` in ${selectedCityData.name}`}
                </>
              )}
            </p>
          </div>

          {searchLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {[...Array(8)].map((_, i) => (
                <Card key={i} className="overflow-hidden">
                  <Skeleton className="aspect-[4/3]" />
                  <div className="p-4 space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                    <Skeleton className="h-3 w-full" />
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {/* Photographers (shown first in combined view) */}
              {filteredPhotographers.map((photographer) => (
                <PhotographerCard
                  key={`photographer-${photographer.id}`}
                  id={photographer.id}
                  displayName={photographer.displayName}
                  bio={photographer.bio}
                  city={photographer.city}
                  state={photographer.state}
                  hourlyRate={photographer.hourlyRate}
                  rating={photographer.rating}
                  reviewCount={photographer.reviewCount}
                  specialties={photographer.specialties}
                  logoImage={photographer.logoImage}
                  coverImage={photographer.coverImage}
                  isLiked={likedPhotographers.has(photographer.id)}
                  onLike={toggleLikePhotographer}
                  onClick={handleViewPhotographer}
                  onBook={handleViewPhotographer}
                />
              ))}
              
              {/* Businesses */}
              {filteredBusinesses.map((business) => (
                <BusinessCard
                  key={`business-${business.id}`}
                  id={business.id}
                  name={business.name}
                  category={business.category}
                  image={getBusinessImage(business)}
                  description={business.description || ""}
                  location={`${business.city || ""}, ${business.state || ""}`}
                  rating={formatRating(business.rating)}
                  reviewCount={business.reviewCount || 0}
                  hasServices={business.category === "Beauty & Wellness" || business.category === "Health & Fitness"}
                  hasProducts={business.category === "Food & Drinks" || business.category === "Shopping"}
                  isLiked={likedBusinesses.has(business.id)}
                  onLike={toggleLikeBusiness}
                  onClick={onViewBusiness}
                  onBook={onViewBusiness}
                  onShop={onViewBusiness}
                />
              ))}
            </div>
          )}

          {!searchLoading && totalResults === 0 && (
            <div className="text-center py-12">
              <MapPin className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No results found</h3>
              <p className="text-muted-foreground">
                {selectedCity
                  ? "Try selecting a different city or adjusting your filters"
                  : "Try adjusting your search criteria"}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
