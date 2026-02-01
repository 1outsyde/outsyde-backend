import { useLocation } from "wouter";
import PulseFeedViewer from "@/components/PulseFeedViewer";

interface PulsePageProps {
  isAuthenticated?: boolean;
}

export default function PulsePage({ isAuthenticated = false }: PulsePageProps) {
  const [, setLocation] = useLocation();

  const handleLoginRequired = () => {
    setLocation("/");
  };

  return (
    <div className="h-screen w-full" data-testid="pulse-page">
      <PulseFeedViewer 
        isAuthenticated={isAuthenticated}
        onLoginRequired={handleLoginRequired}
      />
    </div>
  );
}
