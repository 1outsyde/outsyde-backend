import { Gift, ChevronRight, TrendingUp, Coins, History } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";

interface PointsBalance {
  balance: number;
  dollarValue: number;
  formattedBalance: string;
  formattedDollarValue: string;
}

interface LoyaltyPointsCardProps {
  onViewHistory?: () => void;
  onUsePoints?: () => void;
  compact?: boolean;
}

export default function LoyaltyPointsCard({
  onViewHistory,
  onUsePoints,
  compact = false,
}: LoyaltyPointsCardProps) {
  const { data: pointsData, isLoading } = useQuery<PointsBalance>({
    queryKey: ["/api/points/balance"],
  });

  if (isLoading) {
    return (
      <Card className="overflow-visible bg-gradient-to-br from-primary/90 to-primary p-6 text-primary-foreground" data-testid="card-loyalty-points">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <Skeleton className="h-4 w-20 mb-2 bg-white/30" />
            <Skeleton className="h-12 w-32 bg-white/30" />
          </div>
        </div>
        <Skeleton className="h-4 w-40 bg-white/30" />
      </Card>
    );
  }

  const points = pointsData?.balance || 0;
  const dollarValue = pointsData?.dollarValue || 0;

  if (compact) {
    return (
      <Card className="overflow-visible bg-gradient-to-br from-primary/90 to-primary p-4 text-primary-foreground" data-testid="card-loyalty-points-compact">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-white/20 flex items-center justify-center">
              <Coins className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm opacity-80">Outsyde Points</p>
              <p className="text-xl font-bold" data-testid="text-points-balance-compact">{points.toLocaleString()}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm opacity-80">Value</p>
            <p className="text-lg font-semibold" data-testid="text-points-value-compact">${dollarValue.toFixed(2)}</p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="overflow-visible bg-gradient-to-br from-primary/90 to-primary p-6 text-primary-foreground" data-testid="card-loyalty-points">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <p className="text-sm opacity-80">Your Outsyde Points</p>
          <p className="text-5xl font-bold" data-testid="text-points-balance">{points.toLocaleString()}</p>
        </div>
        <div className="flex items-center gap-1 bg-white/20 rounded-full px-3 py-1">
          <TrendingUp className="h-4 w-4" />
          <span className="text-sm font-medium">100pts = $1</span>
        </div>
      </div>

      <div className="mb-4 p-3 bg-white/10 rounded-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Gift className="h-5 w-5" />
            <span className="font-medium">Available Credit</span>
          </div>
          <span className="text-2xl font-bold" data-testid="text-dollar-value">${dollarValue.toFixed(2)}</span>
        </div>
        <p className="text-sm opacity-80 mt-1">
          Use at any Outsyde business for instant discounts
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {points > 0 && onUsePoints && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onUsePoints}
            data-testid="button-use-points"
          >
            <Gift className="h-4 w-4 mr-1" />
            Use Points
          </Button>
        )}
        {onViewHistory && (
          <Button
            variant="ghost"
            size="sm"
            className="bg-white/10 hover:bg-white/20 text-primary-foreground"
            onClick={onViewHistory}
            data-testid="button-view-history"
          >
            <History className="h-4 w-4 mr-1" />
            View History
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        )}
      </div>
    </Card>
  );
}
