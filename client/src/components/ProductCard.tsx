import { ShoppingCart, Heart } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface ProductCardProps {
  id: string;
  name: string;
  image: string;
  price: number;
  originalPrice?: number;
  category?: string;
  inStock?: boolean;
  isLiked?: boolean;
  onAddToCart?: (id: string) => void;
  onLike?: (id: string) => void;
  onClick?: (id: string) => void;
}

export default function ProductCard({
  id,
  name,
  image,
  price,
  originalPrice,
  category,
  inStock = true,
  isLiked = false,
  onAddToCart,
  onLike,
  onClick,
}: ProductCardProps) {
  const discount = originalPrice
    ? Math.round(((originalPrice - price) / originalPrice) * 100)
    : 0;

  return (
    <Card
      className="overflow-visible hover-elevate cursor-pointer"
      onClick={() => onClick?.(id)}
      data-testid={`card-product-${id}`}
    >
      <div className="relative">
        <div className="aspect-square overflow-hidden rounded-t-md">
          <img
            src={image}
            alt={name}
            className="w-full h-full object-cover transition-transform duration-300 hover:scale-105"
          />
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="absolute top-2 right-2 bg-background/80 backdrop-blur-sm"
          onClick={(e) => {
            e.stopPropagation();
            onLike?.(id);
          }}
          data-testid={`button-like-product-${id}`}
        >
          <Heart
            className={`h-4 w-4 ${isLiked ? "fill-red-500 text-red-500" : ""}`}
          />
        </Button>
        {discount > 0 && (
          <Badge className="absolute top-2 left-2" variant="destructive">
            -{discount}%
          </Badge>
        )}
        {!inStock && (
          <div className="absolute inset-0 bg-background/60 flex items-center justify-center rounded-t-md">
            <Badge variant="secondary">Out of Stock</Badge>
          </div>
        )}
      </div>

      <div className="p-3 space-y-2">
        {category && (
          <Badge variant="secondary" data-testid={`badge-product-category-${id}`}>
            {category}
          </Badge>
        )}
        <h3 className="font-medium text-sm line-clamp-2" data-testid={`text-product-name-${id}`}>
          {name}
        </h3>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <span className="font-bold" data-testid={`text-product-price-${id}`}>
              ${price.toFixed(2)}
            </span>
            {originalPrice && (
              <span className="text-sm text-muted-foreground line-through">
                ${originalPrice.toFixed(2)}
              </span>
            )}
          </div>
          <Button
            size="icon"
            variant="default"
            disabled={!inStock}
            onClick={(e) => {
              e.stopPropagation();
              onAddToCart?.(id);
            }}
            data-testid={`button-add-cart-${id}`}
          >
            <ShoppingCart className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
