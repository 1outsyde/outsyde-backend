import { useState } from "react";
import ProductCard from "../ProductCard";
import jewelryImage from "@assets/generated_images/jewelry_artisan_vendor_image.png";

export default function ProductCardExample() {
  const [isLiked, setIsLiked] = useState(false);

  return (
    <div className="max-w-[200px]">
      <ProductCard
        id="1"
        name="Handcrafted Silver Pendant Necklace"
        image={jewelryImage}
        price={45.99}
        originalPrice={59.99}
        category="Jewelry"
        isLiked={isLiked}
        onLike={() => setIsLiked(!isLiked)}
        onAddToCart={(id) => console.log("Add to cart:", id)}
        onClick={(id) => console.log("View product:", id)}
      />
    </div>
  );
}
