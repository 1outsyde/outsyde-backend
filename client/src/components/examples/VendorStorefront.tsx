import { useState } from "react";
import VendorStorefront from "../VendorStorefront";
import hairSalonImage from "@assets/generated_images/hair_salon_vendor_storefront.png";
import jewelryImage from "@assets/generated_images/jewelry_artisan_vendor_image.png";

export default function VendorStorefrontExample() {
  const [isFollowing, setIsFollowing] = useState(false);

  const today = new Date();
  const formatDate = (offset: number) => {
    const date = new Date(today);
    date.setDate(date.getDate() + offset);
    return date.toISOString().split("T")[0];
  };

  const products = [
    { id: "1", name: "Hair Styling Gel", image: jewelryImage, price: 24.99 },
    { id: "2", name: "Organic Shampoo", image: jewelryImage, price: 18.99, originalPrice: 24.99 },
    { id: "3", name: "Conditioning Mask", image: jewelryImage, price: 32.99 },
  ];

  const services = [
    { id: "1", name: "Full Hair Styling", image: hairSalonImage, price: 85, duration: 60, category: "Hair Care" },
    { id: "2", name: "Hair Coloring", image: hairSalonImage, price: 120, duration: 90, category: "Hair Care" },
    { id: "3", name: "Quick Trim", image: hairSalonImage, price: 35, duration: 30, category: "Hair Care" },
  ];

  const availableSlots = {
    [formatDate(0)]: [
      { time: "9:00 AM", available: true },
      { time: "11:00 AM", available: true },
      { time: "2:00 PM", available: true },
    ],
    [formatDate(1)]: [
      { time: "10:00 AM", available: true },
      { time: "1:00 PM", available: true },
    ],
  };

  return (
    <VendorStorefront
      id="1"
      name="Bella's Hair Studio"
      banner={hairSalonImage}
      category="Beauty & Wellness"
      location="Downtown, 0.3 mi away"
      rating={4.9}
      reviewCount={89}
      description="Welcome to Bella's Hair Studio! We've been serving our community for over 10 years, specializing in modern cuts, vibrant colors, and personalized styling. Our team of expert stylists is dedicated to making you look and feel your best."
      businessHours="Open 9 AM - 7 PM"
      products={products}
      services={services}
      availableSlots={availableSlots}
      isFollowing={isFollowing}
      onFollow={() => setIsFollowing(!isFollowing)}
      onMessage={() => console.log("Message vendor")}
      onShare={() => console.log("Share vendor")}
      onBookService={(serviceId, date, time) =>
        console.log("Book:", serviceId, date, time)
      }
    />
  );
}
