import "express-session";

declare module "express-session" {
  interface SessionData {
    userId: string;
    isVendor: boolean;
    businessId?: string;
  }
}
