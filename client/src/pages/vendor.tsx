import { useState } from "react";
import VendorStorefront from "@/components/VendorStorefront";
import hairSalonImage from "@assets/generated_images/hair_salon_vendor_storefront.png";
import jewelryImage from "@assets/generated_images/jewelry_artisan_vendor_image.png";
import coffeeShopImage from "@assets/generated_images/coffee_shop_vendor_storefront.png";
import produceImage from "@assets/generated_images/organic_produce_vendor_image.png";
import yogaImage from "@assets/generated_images/yoga_studio_vendor_image.png";

interface VendorPageProps {
  vendorId: string;
  onBack: () => void;
  onMessage: (id: string) => void;
}

export default function VendorPage({ vendorId, onBack, onMessage }: VendorPageProps) {
  const [isFollowing, setIsFollowing] = useState(false);

  const today = new Date();
  const formatDate = (offset: number) => {
    const date = new Date(today);
    date.setDate(date.getDate() + offset);
    return date.toISOString().split("T")[0];
  };

  // todo: remove mock functionality
  const vendorsData: Record<string, any> = {
    "1": {
      id: "1",
      name: "Sunrise Coffee Co.",
      banner: coffeeShopImage,
      category: "Coffee & Cafe",
      location: "Downtown, 0.5 mi away",
      rating: 4.8,
      reviewCount: 124,
      description: "Welcome to Sunrise Coffee Co.! We've been serving our community with the finest artisanal coffee and fresh pastries since 2015. Every cup is carefully crafted with beans sourced from sustainable farms.",
      businessHours: "Open 7 AM - 8 PM",
      products: [
        { id: "1", name: "Signature Blend Beans", image: coffeeShopImage, price: 18.99 },
        { id: "2", name: "Organic Cold Brew", image: coffeeShopImage, price: 12.99 },
        { id: "3", name: "Coffee Gift Set", image: coffeeShopImage, price: 45.99, originalPrice: 55.99 },
      ],
      services: [],
    },
    "2": {
      id: "2",
      name: "Bella's Hair Studio",
      banner: hairSalonImage,
      category: "Beauty & Wellness",
      location: "Midtown, 0.8 mi away",
      rating: 4.9,
      reviewCount: 89,
      description: "Welcome to Bella's Hair Studio! We've been serving our community for over 10 years, specializing in modern cuts, vibrant colors, and personalized styling. Our team of expert stylists is dedicated to making you look and feel your best.",
      businessHours: "Open 9 AM - 7 PM",
      products: [
        { id: "1", name: "Hair Styling Gel", image: jewelryImage, price: 24.99 },
        { id: "2", name: "Organic Shampoo", image: jewelryImage, price: 18.99 },
      ],
      services: [
        { id: "1", name: "Full Hair Styling", image: hairSalonImage, price: 85, duration: 60, category: "Hair Care", description: "Complete styling including wash, cut, and style." },
        { id: "2", name: "Hair Coloring", image: hairSalonImage, price: 120, duration: 90, category: "Hair Care", description: "Professional coloring with premium products." },
        { id: "3", name: "Quick Trim", image: hairSalonImage, price: 35, duration: 30, category: "Hair Care", description: "Fast and precise trim to maintain your style." },
      ],
    },
    "3": {
      id: "3",
      name: "Artisan Jewelry Co.",
      banner: jewelryImage,
      category: "Shopping",
      location: "Arts District, 1.2 mi away",
      rating: 4.7,
      reviewCount: 56,
      description: "Discover unique handcrafted jewelry made with love and attention to detail. Each piece tells a story and is crafted to be one-of-a-kind.",
      businessHours: "Open 10 AM - 6 PM",
      products: [
        { id: "1", name: "Silver Pendant Necklace", image: jewelryImage, price: 45.99 },
        { id: "2", name: "Gemstone Earrings", image: jewelryImage, price: 38.99 },
        { id: "3", name: "Gold Ring Set", image: jewelryImage, price: 89.99, originalPrice: 99.99 },
        { id: "4", name: "Beaded Bracelet", image: jewelryImage, price: 28.99 },
      ],
      services: [],
    },
    "4": {
      id: "4",
      name: "Zen Yoga Studio",
      banner: yogaImage,
      category: "Health & Fitness",
      location: "Wellness Center, 0.6 mi away",
      rating: 4.9,
      reviewCount: 203,
      description: "Find your inner peace with our expert-led yoga and meditation classes. We offer classes for all skill levels in a serene and welcoming environment.",
      businessHours: "Open 6 AM - 9 PM",
      products: [],
      services: [
        { id: "1", name: "Beginner Yoga Class", image: yogaImage, price: 25, duration: 60, category: "Yoga", description: "Perfect for those new to yoga." },
        { id: "2", name: "Advanced Vinyasa", image: yogaImage, price: 30, duration: 75, category: "Yoga", description: "Challenging flow for experienced practitioners." },
        { id: "3", name: "Meditation Session", image: yogaImage, price: 20, duration: 45, category: "Mindfulness", description: "Guided meditation for stress relief." },
      ],
    },
    "5": {
      id: "5",
      name: "Green Valley Organics",
      banner: produceImage,
      category: "Food & Drinks",
      location: "Farmers Market, 1.0 mi away",
      rating: 4.8,
      reviewCount: 167,
      description: "Fresh organic produce sourced directly from local farms. We believe in sustainable agriculture and supporting our local farming community.",
      businessHours: "Open 8 AM - 5 PM",
      products: [
        { id: "1", name: "Organic Veggie Box", image: produceImage, price: 35.99 },
        { id: "2", name: "Fresh Fruit Basket", image: produceImage, price: 28.99 },
        { id: "3", name: "Farm Fresh Eggs", image: produceImage, price: 8.99 },
      ],
      services: [],
    },
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

  const vendor = vendorsData[vendorId] || vendorsData["1"];

  return (
    <div className="pb-20 md:pb-0" data-testid="page-vendor">
      <VendorStorefront
        {...vendor}
        availableSlots={availableSlots}
        isFollowing={isFollowing}
        onFollow={() => setIsFollowing(!isFollowing)}
        onMessage={() => onMessage(vendor.id)}
        onShare={() => console.log("Share vendor")}
        onBookService={(serviceId, date, time) =>
          console.log("Book:", serviceId, date, time)
        }
      />
    </div>
  );
}
