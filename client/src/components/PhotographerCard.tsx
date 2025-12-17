import { Heart, MapPin, Star, Camera } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

interface PhotographerCardProps {
  id: string;
  displayName: string;
  bio?: string | null;
  city?: string | null;
  state?: string | null;
  hourlyRate: number;
  rating?: number | null;
  reviewCount?: number | null;
  specialties?: string[] | null;
  logoImage?: string | null;
  coverImage?: string | null;
  isLiked?: boolean;
  onLike?: (id: string) => void;
  onClick?: (id: string) => void;
  onBook?: (id: string) => void;
}

export default function PhotographerCard({
  id,
  displayName,
  bio,
  city,
  state,
  hourlyRate,
  rating = 0,
  reviewCount = 0,
  specialties = [],
  logoImage,
  coverImage,
  isLiked = false,
  onLike,
  onClick,
  onBook,
}: PhotographerCardProps) {
  const location = [city, state].filter(Boolean).join(", ");
  const displayRating = (rating || 0) / 10;
  const displayHourlyRate = hourlyRate / 100;

  return (
    <Card
      className="overflow-visible hover-elevate cursor-pointer"
      onClick={() => onClick?.(id)}
      data-testid={`card-photographer-${id}`}
    >
      <div className="relative">
        <div className="aspect-[4/3] overflow-hidden rounded-t-md bg-gradient-to-br from-primary/20 to-primary/5">
          {coverImage ? (
            <img
              src={coverImage}
              alt={displayName}
              className="w-full h-full object-cover transition-transform duration-300 hover:scale-105"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Camera className="h-16 w-16 text-muted-foreground/30" />
            </div>
          )}
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="absolute top-2 right-2 bg-background/80 backdrop-blur-sm"
          onClick={(e) => {
            e.stopPropagation();
            onLike?.(id);
          }}
          data-testid={`button-like-photographer-${id}`}
        >
          <Heart
            className={`h-5 w-5 ${isLiked ? "fill-red-500 text-red-500" : ""}`}
          />
        </Button>
        <Badge className="absolute bottom-2 left-2" data-testid={`badge-photographer-${id}`}>
          Photographer
        </Badge>
      </div>

      <div className="p-4 space-y-3">
        <div className="flex items-start gap-3">
          <Avatar className="h-10 w-10 border">
            <AvatarImage src={logoImage || undefined} alt={displayName} />
            <AvatarFallback>{displayName.charAt(0)}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold truncate" data-testid={`text-photographer-name-${id}`}>
              {displayName}
            </h3>
            {location && (
              <div className="flex items-center gap-1 text-sm text-muted-foreground">
                <MapPin className="h-3 w-3" />
                <span className="truncate">{location}</span>
              </div>
            )}
          </div>
        </div>

        {bio && (
          <p className="text-sm text-muted-foreground line-clamp-2" data-testid={`text-bio-${id}`}>
            {bio}
          </p>
        )}

        {specialties && specialties.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {specialties.slice(0, 3).map((specialty, i) => (
              <Badge key={i} variant="secondary" className="text-xs">
                {specialty}
              </Badge>
            ))}
            {specialties.length > 3 && (
              <Badge variant="outline" className="text-xs">
                +{specialties.length - 3}
              </Badge>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
              <span className="font-medium">{displayRating.toFixed(1)}</span>
              <span className="text-sm text-muted-foreground">({reviewCount || 0})</span>
            </div>
            <span className="text-sm font-medium text-primary">${displayHourlyRate}/hr</span>
          </div>
          <Button
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              onBook?.(id);
            }}
            data-testid={`button-book-photographer-${id}`}
          >
            <Camera className="h-4 w-4 mr-1" />
            Book
          </Button>
        </div>
      </div>
    </Card>
  );
}
