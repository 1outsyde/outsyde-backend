import { useState } from "react";
import { MapPin, TrendingUp, Plane } from "lucide-react";
import SearchFilter from "@/components/SearchFilter";
import BusinessCard from "@/components/BusinessCard";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import coffeeShopImage from "@assets/generated_images/coffee_shop_vendor_storefront.png";
import hairSalonImage from "@assets/generated_images/hair_salon_vendor_storefront.png";
import jewelryImage from "@assets/generated_images/jewelry_artisan_vendor_image.png";
import produceImage from "@assets/generated_images/organic_produce_vendor_image.png";
import yogaImage from "@assets/generated_images/yoga_studio_vendor_image.png";

interface SearchPageProps {
  onViewBusiness: (id: string) => void;
  onMessage: (id: string) => void;
}

interface CityData {
  id: string;
  name: string;
  state: string;
  businessCount: number;
  image: string;
  trending: boolean;
}

export default function SearchPage({ onViewBusiness, onMessage }: SearchPageProps) {
  const [searchValue, setSearchValue] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [likedBusinesses, setLikedBusinesses] = useState<Set<string>>(new Set());
  const [selectedCity, setSelectedCity] = useState<string | null>(null);

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
  const majorCities: CityData[] = [
    {
      id: "nyc",
      name: "New York",
      state: "NY",
      businessCount: 2450,
      image: "https://images.unsplash.com/photo-1496442226666-8d4d0e62e6e9?w=400&h=300&fit=crop",
      trending: true,
    },
    {
      id: "atl",
      name: "Atlanta",
      state: "GA",
      businessCount: 1820,
      image: "https://images.unsplash.com/photo-1575917649705-5b59aaa12e6b?w=400&h=300&fit=crop",
      trending: true,
    },
    {
      id: "mia",
      name: "Miami",
      state: "FL",
      businessCount: 1650,
      image: "https://images.unsplash.com/photo-1506966953602-c20cc11f75e3?w=400&h=300&fit=crop",
      trending: false,
    },
    {
      id: "la",
      name: "Los Angeles",
      state: "CA",
      businessCount: 2100,
      image: "https://images.unsplash.com/photo-1534190760961-74e8c1c5c3da?w=400&h=300&fit=crop",
      trending: true,
    },
    {
      id: "chi",
      name: "Chicago",
      state: "IL",
      businessCount: 1450,
      image: "https://images.unsplash.com/photo-1494522855154-9297ac14b55f?w=400&h=300&fit=crop",
      trending: false,
    },
    {
      id: "hou",
      name: "Houston",
      state: "TX",
      businessCount: 1380,
      image: "https://images.unsplash.com/photo-1530089711124-9ca31fb9e863?w=400&h=300&fit=crop",
      trending: false,
    },
    {
      id: "dal",
      name: "Dallas",
      state: "TX",
      businessCount: 1290,
      image: "https://images.unsplash.com/photo-1545194445-dddb8f4487c6?w=400&h=300&fit=crop",
      trending: false,
    },
    {
      id: "dc",
      name: "Washington",
      state: "DC",
      businessCount: 980,
      image: "https://images.unsplash.com/photo-1501466044931-62695aada8e9?w=400&h=300&fit=crop",
      trending: false,
    },
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
      city: "nyc",
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
      city: "nyc",
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
      city: "atl",
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
      city: "la",
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
      city: "mia",
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
      city: "atl",
    },
    {
      id: "7",
      name: "Soul Food Kitchen",
      category: "Food & Drinks",
      image: coffeeShopImage,
      description: "Authentic southern comfort food made with love.",
      location: "Peachtree, 0.3 mi",
      rating: 4.9,
      reviewCount: 312,
      city: "atl",
    },
    {
      id: "8",
      name: "Beach Vibes Boutique",
      category: "Shopping",
      image: jewelryImage,
      description: "Trendy beachwear and accessories.",
      location: "Ocean Drive, 0.2 mi",
      rating: 4.7,
      reviewCount: 145,
      city: "mia",
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

    const matchesCity = !selectedCity || business.city === selectedCity;

    return matchesSearch && matchesCategory && matchesCity;
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

  const handleCitySelect = (cityId: string) => {
    setSelectedCity(selectedCity === cityId ? null : cityId);
  };

  const selectedCityData = majorCities.find((c) => c.id === selectedCity);

  return (
    <div className="min-h-screen pb-20 md:pb-0" data-testid="page-search">
      <div className="max-w-7xl mx-auto px-4 py-6">
        <h1 className="text-2xl font-bold mb-2">Discover Local Businesses</h1>
        <p className="text-muted-foreground mb-6">
          Find and support small businesses in your area or explore new cities
        </p>

        <SearchFilter
          searchValue={searchValue}
          onSearchChange={setSearchValue}
          categories={categories}
          selectedCategories={selectedCategories}
          onCategoryToggle={handleCategoryToggle}
        />

        {/* Explore Cities Section */}
        <div className="mt-8 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Plane className="h-5 w-5 text-primary" />
            <h2 className="text-xl font-semibold">Explore Cities</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Traveling? Discover local businesses to support wherever you go
          </p>
          
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {majorCities.map((city) => (
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
                    src={city.image}
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
                      <span>{city.businessCount.toLocaleString()} businesses</span>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
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
                    {filteredBusinesses.length} businesses found
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

        {/* Business Results */}
        <div className="mt-6">
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-muted-foreground">
              {filteredBusinesses.length} businesses found
              {selectedCityData && ` in ${selectedCityData.name}`}
            </p>
          </div>

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
              <MapPin className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No businesses found</h3>
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
