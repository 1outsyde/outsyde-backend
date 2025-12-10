import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Users, Copy, Check, Gift, Loader2 } from "lucide-react";

interface ReferralData {
  referralCode: string;
  referralLink: string;
  bonusForReferrer: number;
  bonusForNewUser: number;
  referredBy: string | null;
}

export default function ReferralCard() {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [applyCode, setApplyCode] = useState("");

  const { data, isLoading } = useQuery<ReferralData>({
    queryKey: ["/api/referral/code"],
  });

  const applyMutation = useMutation({
    mutationFn: async (referralCode: string) => {
      const response = await apiRequest("POST", "/api/referral/apply", { referralCode });
      return response.json();
    },
    onSuccess: (result) => {
      if (result.success) {
        toast({
          title: "Referral Applied!",
          description: `You've earned ${result.pointsEarned} bonus points!`,
        });
        queryClient.invalidateQueries({ queryKey: ["/api/referral/code"] });
        queryClient.invalidateQueries({ queryKey: ["/api/points/balance"] });
        queryClient.invalidateQueries({ queryKey: ["/api/points/history"] });
        setApplyCode("");
      } else {
        toast({
          title: "Error",
          description: result.error || "Failed to apply referral code",
          variant: "destructive",
        });
      }
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to apply referral code",
        variant: "destructive",
      });
    },
  });

  const copyToClipboard = async () => {
    if (!data?.referralCode) return;
    
    try {
      await navigator.clipboard.writeText(data.referralCode);
      setCopied(true);
      toast({
        title: "Copied!",
        description: "Referral code copied to clipboard",
      });
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      toast({
        title: "Error",
        description: "Failed to copy code",
        variant: "destructive",
      });
    }
  };

  const copyLink = async () => {
    if (!data?.referralLink) return;
    
    try {
      await navigator.clipboard.writeText(data.referralLink);
      toast({
        title: "Copied!",
        description: "Referral link copied to clipboard",
      });
    } catch (err) {
      toast({
        title: "Error",
        description: "Failed to copy link",
        variant: "destructive",
      });
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Users className="h-5 w-5 text-primary" />
          Refer Friends, Earn Points
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg bg-primary/10 p-4">
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-sm font-medium">Your Referral Code</span>
            <div className="flex items-center gap-2">
              <code 
                className="rounded bg-background px-3 py-1 font-mono text-lg font-bold"
                data-testid="text-referral-code"
              >
                {data?.referralCode || "..."}
              </code>
              <Button 
                size="icon" 
                variant="ghost"
                onClick={copyToClipboard}
                data-testid="button-copy-referral-code"
              >
                {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <Button 
            variant="outline" 
            size="sm" 
            className="w-full mt-2"
            onClick={copyLink}
            data-testid="button-copy-referral-link"
          >
            Copy Invite Link
          </Button>
        </div>

        <div className="flex items-start gap-3 text-sm">
          <Gift className="h-5 w-5 text-primary shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Earn 500 points ($5 value) for each friend who joins!</p>
            <p className="text-muted-foreground">Your friend gets 200 bonus points too.</p>
          </div>
        </div>

        {!data?.referredBy && (
          <div className="border-t pt-4">
            <p className="text-sm font-medium mb-2">Have a referral code?</p>
            <div className="flex gap-2">
              <Input
                placeholder="Enter code"
                value={applyCode}
                onChange={(e) => setApplyCode(e.target.value.toUpperCase())}
                className="font-mono uppercase"
                maxLength={20}
                data-testid="input-apply-referral-code"
              />
              <Button
                onClick={() => applyCode && applyMutation.mutate(applyCode)}
                disabled={!applyCode || applyMutation.isPending}
                data-testid="button-apply-referral-code"
              >
                {applyMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Apply"
                )}
              </Button>
            </div>
          </div>
        )}

        {data?.referredBy && (
          <div className="rounded-lg bg-green-50 dark:bg-green-900/20 p-3 text-sm">
            <p className="text-green-700 dark:text-green-400 flex items-center gap-2">
              <Check className="h-4 w-4" />
              You were referred by a friend and earned bonus points!
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
