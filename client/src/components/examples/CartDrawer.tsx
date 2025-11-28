import { useState } from "react";
import CartDrawer from "../CartDrawer";
import jewelryImage from "@assets/generated_images/jewelry_artisan_vendor_image.png";

export default function CartDrawerExample() {
  const [items, setItems] = useState([
    {
      id: "1",
      name: "Handcrafted Silver Pendant",
      image: jewelryImage,
      price: 45.99,
      quantity: 1,
      vendorName: "Artisan Jewelry Co.",
    },
    {
      id: "2",
      name: "Organic Coffee Beans",
      image: jewelryImage,
      price: 18.99,
      quantity: 2,
      vendorName: "Sunrise Coffee",
    },
  ]);
  const [pointsToRedeem, setPointsToRedeem] = useState(0);

  const handleUpdateQuantity = (id: string, quantity: number) => {
    if (quantity === 0) {
      setItems(items.filter((item) => item.id !== id));
    } else {
      setItems(items.map((item) => (item.id === id ? { ...item, quantity } : item)));
    }
  };

  return (
    <CartDrawer
      items={items}
      pointsBalance={2450}
      pointsToRedeem={pointsToRedeem}
      onUpdateQuantity={handleUpdateQuantity}
      onRemove={(id) => setItems(items.filter((item) => item.id !== id))}
      onRedeemPoints={setPointsToRedeem}
      onCheckout={() => console.log("Checkout clicked")}
    />
  );
}
