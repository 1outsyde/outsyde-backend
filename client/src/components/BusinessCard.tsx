import { Heart, MapPin, Star, MessageCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface BusinessCardProps {
  id: string;
  name: string;
  category: string;
  image: string;
  avatar?: string;
  description: string;
  location: string;
  rating: number;
  reviewCount: number;
  isLiked?: boolean;
  onLike?: (id: string) => void;
  onClick?: (id: string) => void;
  onMessage?: (id: string) => void;
}

export default function BusinessCard({
  id,
  name,
  category,
  image,
  avatar,
  description,
  location,
  rating,
  reviewCount,
  isLiked = false,
  onLike,
  onClick,
  onMessage,
}: BusinessCardProps) {
  return (
    <Card
      className="overflow-visible hover-elevate cursor-pointer"
      onClick={() => onClick?.(id)}
      data-testid={`card-business-${id}`}
    >
      <div className="relative">
        <div className="aspect-[4/3] overflow-hidden rounded-t-md">
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
          data-testid={`button-like-${id}`}
        >
          <Heart
            className={`h-5 w-5 ${isLiked ? "fill-red-500 text-red-500" : ""}`}
          />
        </Button>
        <Badge className="absolute bottom-2 left-2" data-testid={`badge-category-${id}`}>
          {category}
        </Badge>
      </div>

      <div className="p-4 space-y-3">
        <div className="flex items-start gap-3">
          <Avatar className="h-10 w-10 border">
            <AvatarImage src={avatar} alt={name} />
            <AvatarFallback>{name.charAt(0)}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold truncate" data-testid={`text-business-name-${id}`}>
              {name}
            </h3>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <MapPin className="h-3 w-3" />
              <span className="truncate">{location}</span>
            </div>
          </div>
        </div>

        <p className="text-sm text-muted-foreground line-clamp-2" data-testid={`text-description-${id}`}>
          {description}
        </p>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
            <span className="font-medium">{rating.toFixed(1)}</span>
            <span className="text-sm text-muted-foreground">({reviewCount})</span>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              onMessage?.(id);
            }}
            data-testid={`button-message-${id}`}
          >
            <MessageCircle className="h-4 w-4 mr-1" />
            Chat
          </Button>
        </div>
      </div>
    </Card>
  );
}
