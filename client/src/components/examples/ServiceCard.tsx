import ServiceCard from "../ServiceCard";
import hairSalonImage from "@assets/generated_images/hair_salon_vendor_storefront.png";

export default function ServiceCardExample() {
  return (
    <div className="max-w-sm">
      <ServiceCard
        id="1"
        name="Full Hair Styling Session"
        image={hairSalonImage}
        price={85}
        duration={60}
        category="Hair Care"
        description="Complete styling including wash, cut, and style. Perfect for any occasion."
        onBook={(id) => console.log("Book service:", id)}
        onClick={(id) => console.log("View service:", id)}
      />
    </div>
  );
}
