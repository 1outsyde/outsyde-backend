import { MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface HeroSectionProps {
  backgroundImage: string;
  location?: string;
  onLocationChange?: (location: string) => void;
  onExplore?: () => void;
}

export default function HeroSection({
  backgroundImage,
  location = "",
  onLocationChange,
  onExplore,
}: HeroSectionProps) {
  return (
    <section className="relative h-[60vh] min-h-[400px] flex items-center justify-center overflow-hidden" data-testid="hero-section">
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `url(${backgroundImage})` }}
      />
      <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/40 to-black/70" />

      <div className="relative z-10 text-center px-4 max-w-2xl mx-auto">
        <h1 className="font-serif text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-4" data-testid="text-hero-title">
          Discover Local Businesses Near You
        </h1>
        <p className="text-lg md:text-xl text-white/90 mb-8" data-testid="text-hero-subtitle">
          Support your community. Shop local. Book services. Connect with small businesses.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto">
          <div className="relative flex-1">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
            <Input
              type="text"
              value={location}
              onChange={(e) => onLocationChange?.(e.target.value)}
              placeholder="Enter your location"
              className="pl-10 h-12 bg-white/95 border-0"
              data-testid="input-location"
            />
          </div>
          <Button size="lg" className="h-12" onClick={onExplore} data-testid="button-explore">
            Explore
          </Button>
        </div>
      </div>
    </section>
  );
}
