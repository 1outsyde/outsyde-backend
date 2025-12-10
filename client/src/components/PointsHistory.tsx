import { ArrowDown, ArrowUp, Coins, Store } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";

interface PointTransaction {
  id: string;
  userId: string;
  type: 'earn' | 'redeem';
  points: number;
  dollarAmountCents: number;
  businessId: string | null;
  businessName: string | null;
  referenceType: string | null;
  referenceId: string | null;
  balanceAfter: number;
  description: string | null;
  createdAt: string;
}

interface PointsHistoryProps {
  limit?: number;
  showTitle?: boolean;
}

export default function PointsHistory({ limit = 20, showTitle = true }: PointsHistoryProps) {
  const { data, isLoading } = useQuery<{ transactions: PointTransaction[] }>({
    queryKey: ["/api/points/history"],
  });

  const transactions = data?.transactions || [];

  if (isLoading) {
    return (
      <Card className="overflow-visible" data-testid="card-points-history">
        {showTitle && (
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Coins className="h-5 w-5" />
              Points History
            </CardTitle>
          </CardHeader>
        )}
        <CardContent>
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center justify-between p-3 rounded-md bg-muted/50">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div>
                    <Skeleton className="h-4 w-32 mb-1" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                </div>
                <Skeleton className="h-6 w-20" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (transactions.length === 0) {
    return (
      <Card className="overflow-visible" data-testid="card-points-history">
        {showTitle && (
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Coins className="h-5 w-5" />
              Points History
            </CardTitle>
          </CardHeader>
        )}
        <CardContent className="text-center py-8">
          <Coins className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">
            No points transactions yet
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            Earn points by shopping at Outsyde businesses!
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-visible" data-testid="card-points-history">
      {showTitle && (
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Coins className="h-5 w-5" />
            Points History
          </CardTitle>
        </CardHeader>
      )}
      <CardContent>
        <div className="space-y-3">
          {transactions.map((transaction) => (
            <div
              key={transaction.id}
              className="flex items-center justify-between p-3 rounded-md bg-muted/50"
              data-testid={`transaction-item-${transaction.id}`}
            >
              <div className="flex items-center gap-3">
                <div className={`h-10 w-10 rounded-full flex items-center justify-center ${
                  transaction.type === 'earn' 
                    ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400' 
                    : 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400'
                }`}>
                  {transaction.type === 'earn' ? (
                    <ArrowDown className="h-5 w-5" />
                  ) : (
                    <ArrowUp className="h-5 w-5" />
                  )}
                </div>
                <div>
                  <p className="font-medium">
                    {transaction.type === 'earn' ? 'Points Earned' : 'Points Redeemed'}
                  </p>
                  {transaction.businessName && (
                    <p className="text-sm text-muted-foreground flex items-center gap-1">
                      <Store className="h-3 w-3" />
                      {transaction.businessName}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {format(new Date(transaction.createdAt), "MMM d, yyyy 'at' h:mm a")}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <Badge 
                  variant={transaction.type === 'earn' ? 'default' : 'secondary'}
                  className={transaction.type === 'earn' ? 'bg-green-600' : ''}
                >
                  {transaction.type === 'earn' ? '+' : '-'}{transaction.points.toLocaleString()} pts
                </Badge>
                <p className="text-xs text-muted-foreground mt-1">
                  Balance: {transaction.balanceAfter.toLocaleString()}
                </p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
