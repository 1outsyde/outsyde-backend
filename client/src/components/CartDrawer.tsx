import { Minus, Plus, X, ShoppingBag, Trash2 } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";

interface CartItem {
  id: string;
  name: string;
  image: string;
  price: number;
  quantity: number;
  vendorName: string;
}

interface CartDrawerProps {
  items: CartItem[];
  pointsBalance: number;
  pointsToRedeem: number;
  onUpdateQuantity: (id: string, quantity: number) => void;
  onRemove: (id: string) => void;
  onRedeemPoints: (points: number) => void;
  onCheckout: () => void;
}

export default function CartDrawer({
  items,
  pointsBalance,
  pointsToRedeem,
  onUpdateQuantity,
  onRemove,
  onRedeemPoints,
  onCheckout,
}: CartDrawerProps) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const pointsDiscount = pointsToRedeem * 0.01;
  const total = Math.max(0, subtotal - pointsDiscount);
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline" size="icon" className="relative" data-testid="button-cart">
          <ShoppingBag className="h-5 w-5" />
          {itemCount > 0 && (
            <Badge
              className="absolute -top-2 -right-2 h-5 w-5 p-0 flex items-center justify-center"
              data-testid="badge-cart-count"
            >
              {itemCount}
            </Badge>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-md flex flex-col" data-testid="cart-drawer">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ShoppingBag className="h-5 w-5" />
            Your Cart ({itemCount})
          </SheetTitle>
        </SheetHeader>

        {items.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
            <ShoppingBag className="h-16 w-16 text-muted-foreground mb-4" />
            <h3 className="font-semibold mb-2">Your cart is empty</h3>
            <p className="text-sm text-muted-foreground">
              Add items from local businesses to get started
            </p>
          </div>
        ) : (
          <>
            <ScrollArea className="flex-1 -mx-6 px-6">
              <div className="space-y-4 py-4">
                {items.map((item) => (
                  <div key={item.id} className="flex gap-3" data-testid={`cart-item-${item.id}`}>
                    <div className="h-20 w-20 rounded-md overflow-hidden bg-muted">
                      <img
                        src={item.image}
                        alt={item.name}
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium text-sm truncate">{item.name}</h4>
                      <p className="text-xs text-muted-foreground">{item.vendorName}</p>
                      <p className="font-semibold mt-1">${item.price.toFixed(2)}</p>
                      <div className="flex items-center gap-2 mt-2">
                        <Button
                          size="icon"
                          variant="outline"
                          className="h-7 w-7"
                          onClick={() =>
                            onUpdateQuantity(item.id, Math.max(0, item.quantity - 1))
                          }
                          data-testid={`button-decrease-${item.id}`}
                        >
                          <Minus className="h-3 w-3" />
                        </Button>
                        <span className="w-8 text-center text-sm">{item.quantity}</span>
                        <Button
                          size="icon"
                          variant="outline"
                          className="h-7 w-7"
                          onClick={() => onUpdateQuantity(item.id, item.quantity + 1)}
                          data-testid={`button-increase-${item.id}`}
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => onRemove(item.id)}
                      data-testid={`button-remove-${item.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>

            <div className="border-t pt-4 space-y-4">
              {pointsBalance > 0 && (
                <div className="p-3 bg-primary/5 rounded-md">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium">Loyalty Points</span>
                    <span className="text-sm text-muted-foreground">
                      Balance: {pointsBalance}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      placeholder="Points to redeem"
                      value={pointsToRedeem || ""}
                      onChange={(e) =>
                        onRedeemPoints(Math.min(pointsBalance, parseInt(e.target.value) || 0))
                      }
                      className="h-9"
                      data-testid="input-redeem-points"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onRedeemPoints(pointsBalance)}
                      data-testid="button-redeem-all"
                    >
                      Use All
                    </Button>
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Subtotal</span>
                  <span>${subtotal.toFixed(2)}</span>
                </div>
                {pointsDiscount > 0 && (
                  <div className="flex justify-between text-sm text-green-600">
                    <span>Points Discount</span>
                    <span>-${pointsDiscount.toFixed(2)}</span>
                  </div>
                )}
                <Separator />
                <div className="flex justify-between font-semibold">
                  <span>Total</span>
                  <span data-testid="text-cart-total">${total.toFixed(2)}</span>
                </div>
              </div>

              <Button className="w-full" onClick={onCheckout} data-testid="button-checkout">
                Proceed to Checkout
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
