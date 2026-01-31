import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin, TrendingUp, Plane, Loader2, Store, Camera, Package, Wrench, Navigation, X, User } from "lucide-react";
import SearchFilter from "@/components/SearchFilter";
import BusinessCard from "@/components/BusinessCard";
import PhotographerCard from "@/components/PhotographerCard";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import coffeeShopImage from "@assets/generated_images/coffee_shop_vendor_storefront.png";
import hairSalonImage from "@assets/generated_images/hair_salon_vendor_storefront.png";
import jewelryImage from "@assets/generated_images/jewelry_artisan_vendor_image.png";
import yogaImage from "@assets/generated_images/yoga_studio_vendor_image.png";
import type { Business, Photographer, City, SearchIndexEntry } from "@shared/schema";

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

type SearchTab = "all" | "businesses" | "photographers" | "products" | "services" | "consumers";

const SPECIALTY_FILTERS = [
  "Taste", "Presentation", "Ambiance", "Speed", "Quality", 
  "Service", "Value", "Experience", "Expertise", "Family-Friendly"
];

export default function SearchPage({ onViewBusiness, onViewPhotographer }: SearchPageProps) {
  const [searchValue, setSearchValue] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedSpecialty, setSelectedSpecialty] = useState<string | null>(null);
  const [likedBusinesses, setLikedBusinesses] = useState<Set<string>>(new Set());
  const [likedPhotographers, setLikedPhotographers] = useState<Set<string>>(new Set());
  const [selectedCity, setSelectedCity] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SearchTab>("all");
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locationLoading, setLocationLoading] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  const categories = [
    "All",
    "Food & Drinks",
    "Beauty",
    "Health",
    "Shopping",
    "Services",
    "Entertainment",
  ];

  const requestLocation = () => {
    if (!navigator.geolocation) {
      setLocationError("Geolocation is not supported by your browser");
      return;
    }

    setLocationLoading(true);
    setLocationError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
        setLocationLoading(false);
      },
      (error) => {
        setLocationError("Unable to get your location. Results will be sorted by rating.");
        setLocationLoading(false);
      },
      { timeout: 10000, enableHighAccuracy: false }
    );
  };

  const { data: citiesData, isLoading: citiesLoading } = useQuery<{ cities: City[] }>({
    queryKey: ["/api/cities"],
  });

  const cities = citiesData?.cities || [];
  const selectedCityData = cities.find((c) => c.id === selectedCity);

  const getEntityTypesForTab = (): string[] | undefined => {
    switch (activeTab) {
      case "businesses":
        return ["business"];
      case "photographers":
        return ["photographer"];
      case "products":
        return ["product"];
      case "services":
        return ["service", "photographer_service"];
      case "consumers":
        return ["consumer"];
      default:
        return undefined;
    }
  };

  const { data: unifiedSearchData, isLoading: searchLoading } = useQuery<{
    results: SearchIndexEntry[];
    total: number;
  }>({
    queryKey: [
      "/api/unified-search",
      searchValue,
      selectedCityData?.name,
      selectedCategories.filter(c => c !== "All").join(","),
      activeTab,
      userLocation?.lat,
      userLocation?.lng,
      selectedSpecialty,
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      const queryParts: string[] = [];
      if (searchValue) queryParts.push(searchValue);
      if (selectedSpecialty) queryParts.push(selectedSpecialty);
      if (queryParts.length > 0) params.append("q", queryParts.join(" "));
      if (selectedCityData) params.append("city", selectedCityData.name);
      if (selectedCategories.length > 0 && !selectedCategories.includes("All")) {
        params.append("category", selectedCategories[0]);
      }
      const entityTypes = getEntityTypesForTab();
      if (entityTypes) params.append("types", entityTypes.join(","));
      if (userLocation) {
        params.append("lat", userLocation.lat.toString());
        params.append("lng", userLocation.lng.toString());
      }

      const response = await fetch(`/api/unified-search?${params.toString()}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to search");
      return response.json();
    },
  });

  const allResults = unifiedSearchData?.results || [];
  const results = selectedSpecialty 
    ? allResults.filter(r => 
        (r.knownFor as string[] | undefined)?.some(k => 
          k.toLowerCase().includes(selectedSpecialty.toLowerCase())
        )
      )
    : allResults;
  const totalResults = results.length;

  const businessResults = results.filter(r => r.entityType === "business");
  const photographerResults = results.filter(r => r.entityType === "photographer");
  const productResults = results.filter(r => r.entityType === "product");
  const serviceResults = results.filter(r => r.entityType === "service" || r.entityType === "photographer_service");
  const consumerResults = results.filter(r => r.entityType === "consumer");

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

  const getDefaultImage = (category: string | null) => {
    return categoryImageMap[category || ""] || coffeeShopImage;
  };

  const formatRating = (rating: number | null) => {
    if (!rating) return 0;
    return rating / 10;
  };

  const formatPrice = (priceCents: number | null) => {
    if (!priceCents) return "";
    return `$${(priceCents / 100).toFixed(2)}`;
  };

  const handleViewPhotographer = (id: string) => {
    if (onViewPhotographer) {
      onViewPhotographer(id);
    } else {
      window.location.href = `/photographer/${id}`;
    }
  };

  const handleResultClick = (result: SearchIndexEntry) => {
    if (result.entityType === "business") {
      onViewBusiness(result.entityId);
    } else if (result.entityType === "photographer") {
      handleViewPhotographer(result.entityId);
    } else if (result.entityType === "product" && result.parentId) {
      onViewBusiness(result.parentId);
    } else if (result.entityType === "service" && result.parentId) {
      onViewBusiness(result.parentId);
    } else if (result.entityType === "photographer_service" && result.parentId) {
      handleViewPhotographer(result.parentId);
    } else if (result.entityType === "consumer") {
      window.location.href = `/profile/${result.entityId}`;
    }
  };

  const getResultIcon = (entityType: string) => {
    switch (entityType) {
      case "business":
        return <Store className="h-4 w-4" />;
      case "photographer":
        return <Camera className="h-4 w-4" />;
      case "product":
        return <Package className="h-4 w-4" />;
      case "service":
      case "photographer_service":
        return <Wrench className="h-4 w-4" />;
      case "consumer":
        return <User className="h-4 w-4" />;
      default:
        return null;
    }
  };

  const getResultTypeBadge = (entityType: string) => {
    const labels: Record<string, string> = {
      business: "Business",
      photographer: "Photographer",
      product: "Product",
      service: "Service",
      photographer_service: "Photo Service",
      consumer: "Person",
    };
    return labels[entityType] || entityType;
  };

  return (
    <div className="min-h-screen pb-20 md:pb-0" data-testid="page-search">
      <div className="max-w-7xl mx-auto px-4 py-6">
        <h1 className="text-2xl font-bold mb-2">Discover Local Businesses & Photographers</h1>
        <p className="text-muted-foreground mb-4">
          Find products, services, and creative professionals in your area
        </p>

        {!userLocation && (
          <Card className="mb-4 bg-primary/5 border-primary/20">
            <CardContent className="p-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Navigation className="h-5 w-5 text-primary" />
                <div>
                  <p className="font-medium text-sm">Enable location for better results</p>
                  <p className="text-xs text-muted-foreground">
                    See nearby businesses and photographers first
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={requestLocation}
                disabled={locationLoading}
                data-testid="button-enable-location"
              >
                {locationLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Enable"
                )}
              </Button>
            </CardContent>
          </Card>
        )}

        {userLocation && (
          <Badge variant="secondary" className="mb-4 gap-1">
            <Navigation className="h-3 w-3" />
            Location enabled - showing nearest first
            <X
              className="h-3 w-3 ml-1 cursor-pointer"
              onClick={() => setUserLocation(null)}
            />
          </Badge>
        )}

        <SearchFilter
          searchValue={searchValue}
          onSearchChange={setSearchValue}
          categories={categories}
          selectedCategories={selectedCategories}
          onCategoryToggle={handleCategoryToggle}
        />

        <div className="mt-6 mb-4">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as SearchTab)}>
            <TabsList className="flex-wrap h-auto gap-1">
              <TabsTrigger value="all" data-testid="tab-all">
                All ({totalResults})
              </TabsTrigger>
              <TabsTrigger value="businesses" data-testid="tab-businesses">
                <Store className="h-4 w-4 mr-1" />
                Businesses
              </TabsTrigger>
              <TabsTrigger value="photographers" data-testid="tab-photographers">
                <Camera className="h-4 w-4 mr-1" />
                Photographers
              </TabsTrigger>
              <TabsTrigger value="consumers" data-testid="tab-consumers">
                <User className="h-4 w-4 mr-1" />
                Consumers
              </TabsTrigger>
              <TabsTrigger value="products" data-testid="tab-products">
                <Package className="h-4 w-4 mr-1" />
                Products
              </TabsTrigger>
              <TabsTrigger value="services" data-testid="tab-services">
                <Wrench className="h-4 w-4 mr-1" />
                Services
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="mb-4">
          <p className="text-sm text-muted-foreground mb-2">Filter by what they're known for:</p>
          <div className="flex flex-wrap gap-2">
            {SPECIALTY_FILTERS.map((specialty) => (
              <Badge
                key={specialty}
                variant={selectedSpecialty === specialty ? "default" : "outline"}
                className={`cursor-pointer transition-colors ${
                  selectedSpecialty === specialty 
                    ? "bg-primary text-primary-foreground" 
                    : "hover-elevate"
                }`}
                onClick={() => setSelectedSpecialty(
                  selectedSpecialty === specialty ? null : specialty
                )}
                data-testid={`filter-specialty-${specialty.toLowerCase().replace(/\s+/g, '-')}`}
              >
                {selectedSpecialty === specialty && <X className="h-3 w-3 mr-1" />}
                {specialty}
              </Badge>
            ))}
          </div>
        </div>

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

        {selectedCityData && (
          <Card className="mb-6 bg-primary/5 border-primary/20 overflow-visible">
            <CardContent className="p-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <MapPin className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="font-medium">
                    Discovering in {selectedCityData.name}, {selectedCityData.state}
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
                  {userLocation && " • Sorted by distance"}
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
              {results.map((result) => (
                <Card
                  key={`${result.entityType}-${result.entityId}`}
                  className="overflow-hidden cursor-pointer hover-elevate"
                  onClick={() => handleResultClick(result)}
                  data-testid={`search-result-${result.entityType}-${result.entityId}`}
                >
                  <div className="aspect-[4/3] relative">
                    <img
                      src={result.imageUrl || getDefaultImage(result.category)}
                      alt={result.name}
                      className="absolute inset-0 w-full h-full object-cover"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                    <Badge
                      className="absolute top-2 left-2 gap-1"
                      variant="secondary"
                    >
                      {getResultIcon(result.entityType)}
                      {getResultTypeBadge(result.entityType)}
                    </Badge>
                    {result.priceCents && (
                      <Badge
                        className="absolute top-2 right-2"
                        variant="default"
                      >
                        {formatPrice(result.priceCents)}
                      </Badge>
                    )}
                  </div>
                  <CardContent className="p-4">
                    <h3 className="font-semibold truncate">{result.name}</h3>
                    {result.description && (
                      <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
                        {result.description}
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-2 text-sm text-muted-foreground">
                      {result.city && (
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {result.city}, {result.state}
                        </span>
                      )}
                    </div>
                    {(result.rating ?? 0) > 0 && (
                      <div className="flex items-center gap-1 mt-2">
                        <span className="text-yellow-500">★</span>
                        <span className="text-sm font-medium">
                          {formatRating(result.rating)}
                        </span>
                        {(result.reviewCount ?? 0) > 0 && (
                          <span className="text-sm text-muted-foreground">
                            ({result.reviewCount} reviews)
                          </span>
                        )}
                      </div>
                    )}
                    {result.category && (
                      <Badge variant="outline" className="mt-2">
                        {result.category}
                      </Badge>
                    )}
                    {result.knownFor && (result.knownFor as string[]).length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {(result.knownFor as string[]).slice(0, 3).map((specialty) => (
                          <Badge 
                            key={specialty} 
                            variant="secondary" 
                            className="text-xs"
                            data-testid={`badge-known-for-${specialty.toLowerCase().replace(/\s+/g, '-')}`}
                          >
                            {specialty}
                          </Badge>
                        ))}
                        {(result.knownFor as string[]).length > 3 && (
                          <Badge variant="secondary" className="text-xs">
                            +{(result.knownFor as string[]).length - 3}
                          </Badge>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {!searchLoading && totalResults === 0 && (
            <div className="text-center py-12">
              <MapPin className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No results found</h3>
              <p className="text-muted-foreground">
                {selectedCity
                  ? "No discoverable users found in this area yet"
                  : "Try adjusting your search criteria"}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
