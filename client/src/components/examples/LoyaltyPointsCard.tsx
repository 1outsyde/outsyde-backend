import LoyaltyPointsCard from "../LoyaltyPointsCard";

export default function LoyaltyPointsCardExample() {
  return (
    <div className="max-w-md">
      <LoyaltyPointsCard
        points={2450}
        nextRewardAt={3000}
        tierName="Gold"
        rewardsAvailable={3}
        onViewRewards={() => console.log("View rewards clicked")}
      />
    </div>
  );
}
