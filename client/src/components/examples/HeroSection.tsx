import { useState } from "react";
import HeroSection from "../HeroSection";
import heroImage from "@assets/generated_images/local_community_marketplace_hero.png";

export default function HeroSectionExample() {
  const [location, setLocation] = useState("");

  return (
    <HeroSection
      backgroundImage={heroImage}
      location={location}
      onLocationChange={setLocation}
      onExplore={() => console.log("Explore:", location)}
    />
  );
}
