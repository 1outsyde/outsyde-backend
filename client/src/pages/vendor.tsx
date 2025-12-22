import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import VendorStorefront from "@/components/VendorStorefront";
import type { Business, VendorProduct, VendorService, Photographer, PhotographerService, StaffMember } from "@shared/schema";

import hairSalonImage from "@assets/generated_images/hair_salon_vendor_storefront.png";
import jewelryImage from "@assets/generated_images/jewelry_artisan_vendor_image.png";
import coffeeShopImage from "@assets/generated_images/coffee_shop_vendor_storefront.png";
import produceImage from "@assets/generated_images/organic_produce_vendor_image.png";
import yogaImage from "@assets/generated_images/yoga_studio_vendor_image.png";

interface VendorPageProps {
  vendorId: string;
  vendorType?: "business" | "photographer";
  onBack: () => void;
  onLoginRequired: () => void;
  viewerIsPhotographer?: boolean;
  onCollaborate?: (id: string, name?: string) => void;
  isAuthenticated?: boolean;
}

const fallbackImages: Record<string, string> = {
  "1": coffeeShopImage,
  "2": hairSalonImage,
  "3": jewelryImage,
  "4": yogaImage,
  "5": produceImage,
};

export default function VendorPage({ vendorId, vendorType = "business", onBack, onLoginRequired, viewerIsPhotographer = false, onCollaborate, isAuthenticated = false }: VendorPageProps) {
  const [isFollowing, setIsFollowing] = useState(false);

  // Fetch business data
  const { data: businessData, isLoading: businessLoading } = useQuery<{ business: Business }>({
    queryKey: ["/api/businesses", vendorId],
    queryFn: async () => {
      const res = await fetch(`/api/businesses/${vendorId}`);
      if (!res.ok) throw new Error("Business not found");
      return res.json();
    },
    retry: false,
    enabled: vendorType === "business",
  });

  // Fetch photographer data
  const { data: photographerData, isLoading: photographerLoading } = useQuery<{ photographer: Photographer }>({
    queryKey: ["/api/photographers", vendorId],
    queryFn: async () => {
      const res = await fetch(`/api/photographers/${vendorId}`);
      if (!res.ok) throw new Error("Photographer not found");
      return res.json();
    },
    retry: false,
    enabled: vendorType === "photographer",
  });

  // Fetch photographer services
  const { data: photographerServicesData } = useQuery<{ services: PhotographerService[] }>({
    queryKey: ["/api/photographers", vendorId, "services"],
    queryFn: async () => {
      const res = await fetch(`/api/photographers/${vendorId}/services`);
      if (!res.ok) return { services: [] };
      return res.json();
    },
    enabled: vendorType === "photographer" && !!photographerData?.photographer,
  });

  const { data: productsData, isLoading: productsLoading } = useQuery<{ products: VendorProduct[] }>({
    queryKey: ["/api/businesses", vendorId, "products"],
    queryFn: async () => {
      const res = await fetch(`/api/businesses/${vendorId}/products`);
      if (!res.ok) return { products: [] };
      return res.json();
    },
    enabled: vendorType === "business" && !!businessData?.business,
  });

  const { data: servicesData, isLoading: servicesLoading } = useQuery<{ services: VendorService[] }>({
    queryKey: ["/api/businesses", vendorId, "services"],
    queryFn: async () => {
      const res = await fetch(`/api/businesses/${vendorId}/services`);
      if (!res.ok) return { services: [] };
      return res.json();
    },
    enabled: vendorType === "business" && !!businessData?.business,
  });

  // Fetch staff members for the business
  const { data: staffData } = useQuery<{ staff: StaffMember[] }>({
    queryKey: ["/api/businesses", vendorId, "staff"],
    queryFn: async () => {
      const res = await fetch(`/api/businesses/${vendorId}/staff`);
      if (!res.ok) return { staff: [] };
      return res.json();
    },
    enabled: vendorType === "business" && !!businessData?.business,
  });

  const today = new Date();
  const formatDate = (offset: number) => {
    const date = new Date(today);
    date.setDate(date.getDate() + offset);
    return date.toISOString().split("T")[0];
  };

  const availableSlots = {
    [formatDate(0)]: [
      { time: "9:00 AM", available: true },
      { time: "10:00 AM", available: false },
      { time: "11:00 AM", available: true },
      { time: "2:00 PM", available: true },
      { time: "3:00 PM", available: true },
    ],
    [formatDate(1)]: [
      { time: "9:00 AM", available: true },
      { time: "10:00 AM", available: true },
      { time: "11:00 AM", available: true },
      { time: "1:00 PM", available: true },
    ],
    [formatDate(2)]: [
      { time: "10:00 AM", available: true },
      { time: "2:00 PM", available: true },
      { time: "4:00 PM", available: true },
    ],
    [formatDate(4)]: [
      { time: "9:00 AM", available: true },
      { time: "11:00 AM", available: true },
    ],
  };

  const isLoading = vendorType === "business" ? businessLoading : photographerLoading;
  
  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]" data-testid="vendor-loading">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const business = businessData?.business;
  const photographer = photographerData?.photographer;

  if (vendorType === "business" && !business) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] p-4" data-testid="vendor-not-found">
        <h2 className="text-xl font-semibold mb-2">Business Not Found</h2>
        <p className="text-muted-foreground mb-4">This business doesn't exist or has been removed.</p>
        <button onClick={onBack} className="text-primary underline">Go Back</button>
      </div>
    );
  }

  if (vendorType === "photographer" && !photographer) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] p-4" data-testid="vendor-not-found">
        <h2 className="text-xl font-semibold mb-2">Photographer Not Found</h2>
        <p className="text-muted-foreground mb-4">This photographer doesn't exist or has been removed.</p>
        <button onClick={onBack} className="text-primary underline">Go Back</button>
      </div>
    );
  }

  // For business view
  if (vendorType === "business" && business) {
    const products = (productsData?.products || []).map(p => ({
      id: p.id,
      name: p.name,
      image: p.imageUrl || fallbackImages[vendorId] || jewelryImage,
      price: p.price / 100,
      originalPrice: p.compareAtPrice ? p.compareAtPrice / 100 : undefined,
      category: p.category || undefined,
    }));

    const services = (servicesData?.services || []).map(s => ({
      id: s.id,
      name: s.name,
      image: fallbackImages[vendorId] || hairSalonImage,
      price: s.price / 100,
      duration: s.durationMinutes,
      category: s.category || undefined,
      description: s.description || undefined,
    }));

    const location = business.city && business.state 
      ? `${business.city}, ${business.state}` 
      : business.city || "Location not specified";

    // Check if business has completed Stripe onboarding and can accept bookings
    const canAcceptBookings = !!(business.stripeAccountId && business.stripeOnboardingComplete);

    return (
      <div className="pb-20 md:pb-0" data-testid="page-vendor">
        <VendorStorefront
          id={business.id}
          ownerId={business.ownerId}
          name={business.name}
          avatar={business.logoImage || undefined}
          banner={business.coverImage || fallbackImages[vendorId] || coffeeShopImage}
          category={business.category}
          location={location}
          rating={(business.rating || 0) / 10}
          reviewCount={business.reviewCount || 0}
          description={business.description || "Welcome to our store!"}
          tagline={business.tagline || undefined}
          hoursOfOperation={business.hoursOfOperation || undefined}
          products={products}
          services={services}
          brandColors={business.brandColors || undefined}
          contactEmail={business.contactEmail || undefined}
          contactPhone={business.contactPhone || undefined}
          websiteUrl={business.websiteUrl || undefined}
          availableSlots={availableSlots}
          staff={staffData?.staff || []}
          isFollowing={isFollowing}
          onFollow={() => setIsFollowing(!isFollowing)}
          onShare={() => console.log("Share vendor")}
          onLoginRequired={onLoginRequired}
          onBookService={(serviceId, date, time, staffId) =>
            console.log("Book:", serviceId, date, time, "staffId:", staffId)
          }
          viewerIsPhotographer={viewerIsPhotographer}
          onCollaborate={onCollaborate ? () => onCollaborate(business.id, business.name) : undefined}
          isAuthenticated={isAuthenticated}
          storefrontType="business"
          canAcceptBookings={canAcceptBookings}
        />
      </div>
    );
  }

  // For photographer view
  if (vendorType === "photographer" && photographer) {
    const photographerServices = (photographerServicesData?.services || []).map(s => ({
      id: s.id,
      name: s.name,
      image: fallbackImages[vendorId] || hairSalonImage,
      price: s.priceCents ? s.priceCents / 100 : 0,
      duration: s.estimatedDurationMinutes || undefined,
      category: s.category || undefined,
      description: s.description || undefined,
    }));

    const location = photographer.city && photographer.state 
      ? `${photographer.city}, ${photographer.state}` 
      : photographer.city || "Location not specified";

    // Check if photographer has completed Stripe onboarding and can accept bookings
    const canAcceptBookings = !!(photographer.stripeAccountId && photographer.stripeOnboardingComplete);

    return (
      <div className="pb-20 md:pb-0" data-testid="page-vendor">
        <VendorStorefront
          id={photographer.id}
          ownerId={photographer.userId}
          name={photographer.displayName || "Photographer"}
          avatar={photographer.logoImage || undefined}
          banner={photographer.coverImage || fallbackImages[vendorId] || coffeeShopImage}
          category="Photography"
          location={location}
          rating={0}
          reviewCount={0}
          description={photographer.bio || "Professional photographer available for bookings."}
          tagline={photographer.specialties?.join(", ") || undefined}
          hoursOfOperation={photographer.hoursOfOperation || undefined}
          products={[]}
          services={photographerServices}
          brandColors={photographer.brandColors || undefined}
          contactEmail={undefined}
          contactPhone={undefined}
          websiteUrl={photographer.portfolioUrl || undefined}
          availableSlots={availableSlots}
          isFollowing={isFollowing}
          onFollow={() => setIsFollowing(!isFollowing)}
          onShare={() => console.log("Share photographer")}
          onLoginRequired={onLoginRequired}
          onBookService={(serviceId, date, time) =>
            console.log("Book photographer:", serviceId, date, time)
          }
          viewerIsPhotographer={viewerIsPhotographer}
          isAuthenticated={isAuthenticated}
          storefrontType="photographer"
          canAcceptBookings={canAcceptBookings}
        />
      </div>
    );
  }

  return null;
}
