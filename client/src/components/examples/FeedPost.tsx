import { useState } from "react";
import FeedPost from "../FeedPost";
import coffeeShopImage from "@assets/generated_images/coffee_shop_vendor_storefront.png";

export default function FeedPostExample() {
  const [isLiked, setIsLiked] = useState(false);
  const [isSaved, setIsSaved] = useState(false);

  return (
    <div className="max-w-lg">
      <FeedPost
        id="1"
        businessName="Sunrise Coffee Co."
        businessCategory="Coffee & Cafe"
        postImage={coffeeShopImage}
        caption="Fresh batch of our signature caramel lattes ready to go! Stop by today and get 20% off your first order. We're supporting local farmers with every cup you enjoy."
        likes={234}
        comments={18}
        timestamp="2h ago"
        isLiked={isLiked}
        isSaved={isSaved}
        onLike={() => setIsLiked(!isLiked)}
        onSave={() => setIsSaved(!isSaved)}
        onComment={(id) => console.log("Comment on:", id)}
        onShare={(id) => console.log("Share:", id)}
        onBusinessClick={(id) => console.log("View business:", id)}
      />
    </div>
  );
}
