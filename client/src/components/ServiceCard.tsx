import { Clock, Calendar } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface ServiceCardProps {
  id: string;
  name: string;
  image: string;
  price: number;
  duration: number;
  category?: string;
  description?: string;
  available?: boolean;
  onBook?: (id: string) => void;
  onClick?: (id: string) => void;
}

export default function ServiceCard({
  id,
  name,
  image,
  price,
  duration,
  category,
  description,
  available = true,
  onBook,
  onClick,
}: ServiceCardProps) {
  return (
    <Card
      className="overflow-visible hover-elevate cursor-pointer"
      onClick={() => onClick?.(id)}
      data-testid={`card-service-${id}`}
    >
      <div className="relative">
        <div className="aspect-[16/9] overflow-hidden rounded-t-md">
          <img
            src={image}
            alt={name}
            className="w-full h-full object-cover transition-transform duration-300 hover:scale-105"
          />
        </div>
        {category && (
          <Badge className="absolute top-2 left-2">
            {category}
          </Badge>
        )}
      </div>

      <div className="p-4 space-y-3">
        <div>
          <h3 className="font-semibold" data-testid={`text-service-name-${id}`}>
            {name}
          </h3>
          {description && (
            <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
              {description}
            </p>
          )}
        </div>

        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-1">
            <Clock className="h-4 w-4" />
            <span>{duration} min</span>
          </div>
          <span className="font-semibold text-foreground" data-testid={`text-service-price-${id}`}>
            ${price.toFixed(2)}
          </span>
        </div>

        <Button
          className="w-full"
          disabled={!available}
          onClick={(e) => {
            e.stopPropagation();
            onBook?.(id);
          }}
          data-testid={`button-book-service-${id}`}
        >
          <Calendar className="h-4 w-4 mr-2" />
          {available ? "Book Now" : "Unavailable"}
        </Button>
      </div>
    </Card>
  );
}
