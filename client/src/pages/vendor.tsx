import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import VendorStorefront from "@/components/VendorStorefront";
import type { Business, VendorProduct, VendorService } from "@shared/schema";

import hairSalonImage from "@assets/generated_images/hair_salon_vendor_storefront.png";
import jewelryImage from "@assets/generated_images/jewelry_artisan_vendor_image.png";
import coffeeShopImage from "@assets/generated_images/coffee_shop_vendor_storefront.png";
import produceImage from "@assets/generated_images/organic_produce_vendor_image.png";
import yogaImage from "@assets/generated_images/yoga_studio_vendor_image.png";

interface VendorPageProps {
  vendorId: string;
  onBack: () => void;
  onLoginRequired: () => void;
  viewerIsPhotographer?: boolean;
  onCollaborate?: (id: string, name?: string) => void;
}

const fallbackImages: Record<string, string> = {
  "1": coffeeShopImage,
  "2": hairSalonImage,
  "3": jewelryImage,
  "4": yogaImage,
  "5": produceImage,
};

export default function VendorPage({ vendorId, onBack, onLoginRequired, viewerIsPhotographer = false, onCollaborate }: VendorPageProps) {
  const [isFollowing, setIsFollowing] = useState(false);

  const { data: businessData, isLoading: businessLoading } = useQuery<{ business: Business }>({
    queryKey: ["/api/businesses", vendorId],
    queryFn: async () => {
      const res = await fetch(`/api/businesses/${vendorId}`);
      if (!res.ok) throw new Error("Business not found");
      return res.json();
    },
    retry: false,
  });

  const { data: productsData, isLoading: productsLoading } = useQuery<{ products: VendorProduct[] }>({
    queryKey: ["/api/businesses", vendorId, "products"],
    queryFn: async () => {
      const res = await fetch(`/api/businesses/${vendorId}/products`);
      if (!res.ok) return { products: [] };
      return res.json();
    },
    enabled: !!businessData?.business,
  });

  const { data: servicesData, isLoading: servicesLoading } = useQuery<{ services: VendorService[] }>({
    queryKey: ["/api/businesses", vendorId, "services"],
    queryFn: async () => {
      const res = await fetch(`/api/businesses/${vendorId}/services`);
      if (!res.ok) return { services: [] };
      return res.json();
    },
    enabled: !!businessData?.business,
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

  if (businessLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]" data-testid="vendor-loading">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const business = businessData?.business;

  if (!business) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] p-4" data-testid="vendor-not-found">
        <h2 className="text-xl font-semibold mb-2">Business Not Found</h2>
        <p className="text-muted-foreground mb-4">This business doesn't exist or has been removed.</p>
        <button onClick={onBack} className="text-primary underline">Go Back</button>
      </div>
    );
  }

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
        businessHours={business.hoursOfOperation ? "See hours" : undefined}
        products={products}
        services={services}
        brandColors={business.brandColors || undefined}
        contactEmail={business.contactEmail || undefined}
        contactPhone={business.contactPhone || undefined}
        websiteUrl={business.websiteUrl || undefined}
        availableSlots={availableSlots}
        isFollowing={isFollowing}
        onFollow={() => setIsFollowing(!isFollowing)}
        onShare={() => console.log("Share vendor")}
        onLoginRequired={onLoginRequired}
        onBookService={(serviceId, date, time) =>
          console.log("Book:", serviceId, date, time)
        }
        viewerIsPhotographer={viewerIsPhotographer}
        onCollaborate={onCollaborate ? () => onCollaborate(business.id, business.name) : undefined}
      />
    </div>
  );
}
