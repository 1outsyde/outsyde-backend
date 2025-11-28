import { Gift, ChevronRight, TrendingUp } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

interface LoyaltyPointsCardProps {
  points: number;
  nextRewardAt: number;
  tierName: string;
  rewardsAvailable: number;
  onViewRewards?: () => void;
}

export default function LoyaltyPointsCard({
  points,
  nextRewardAt,
  tierName,
  rewardsAvailable,
  onViewRewards,
}: LoyaltyPointsCardProps) {
  const progress = (points / nextRewardAt) * 100;

  return (
    <Card className="overflow-visible bg-gradient-to-br from-primary/90 to-primary p-6 text-primary-foreground" data-testid="card-loyalty-points">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <p className="text-sm opacity-80">Your Points</p>
          <p className="text-5xl font-bold" data-testid="text-points-balance">{points.toLocaleString()}</p>
        </div>
        <div className="flex items-center gap-1 bg-white/20 rounded-full px-3 py-1">
          <TrendingUp className="h-4 w-4" />
          <span className="text-sm font-medium">{tierName}</span>
        </div>
      </div>

      <div className="mb-4">
        <div className="flex justify-between text-sm mb-2">
          <span className="opacity-80">Next reward at {nextRewardAt.toLocaleString()} pts</span>
          <span className="font-medium">{Math.round(progress)}%</span>
        </div>
        <Progress value={progress} className="h-2 bg-white/30" data-testid="progress-reward" />
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Gift className="h-5 w-5" />
          <span className="font-medium" data-testid="text-rewards-available">
            {rewardsAvailable} rewards available
          </span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={onViewRewards}
          data-testid="button-view-rewards"
        >
          View Rewards
          <ChevronRight className="h-4 w-4 ml-1" />
        </Button>
      </div>
    </Card>
  );
}
