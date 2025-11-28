import { useState } from "react";
import BusinessCard from "../BusinessCard";
import coffeeShopImage from "@assets/generated_images/coffee_shop_vendor_storefront.png";

export default function BusinessCardExample() {
  const [isLiked, setIsLiked] = useState(false);

  return (
    <div className="max-w-sm">
      <BusinessCard
        id="1"
        name="Sunrise Coffee Co."
        category="Coffee & Cafe"
        image={coffeeShopImage}
        description="Artisanal coffee and fresh pastries made daily. Supporting local farmers since 2015."
        location="Downtown, 0.5 mi away"
        rating={4.8}
        reviewCount={124}
        isLiked={isLiked}
        onLike={() => setIsLiked(!isLiked)}
        onClick={(id) => console.log("Clicked business:", id)}
        onMessage={(id) => console.log("Message business:", id)}
      />
    </div>
  );
}
