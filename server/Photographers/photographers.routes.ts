// server/Photographers/photographers.routes.ts
import { Router, type Request, type Response } from "express";
import { PhotographerController } from "./photographers.controller";
import { getUncachableStripeClient } from "../stripe/stripeClient";
import { verifyAccessToken } from "../auth";
import { storage } from "../storage";

const photographersRouter = Router();

// Current photographer endpoints (must come before /:id)
photographersRouter.get("/me",                   PhotographerController.getMe);
photographersRouter.patch("/me",                 PhotographerController.updateMe);
photographersRouter.get("/me/stripe-status",     PhotographerController.getStripeStatus);
photographersRouter.get("/me/bookings",          PhotographerController.getBookingRecords);
photographersRouter.post("/me/stripe-onboarding", PhotographerController.startStripeOnboarding);
photographersRouter.get("/me/stripe-dashboard-link", async (req: Request, res: Response) => {
  try {
    // Resolve userId via JWT (Authorization: Bearer) then fall back to session
    let userId: string | null = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const payload = verifyAccessToken(authHeader.substring(7));
      if (payload) userId = payload.userId;
    }
    if (!userId) {
      userId = req.session?.userId ?? null;
    }
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const user = await storage.getUser(userId);
    if (!user?.isPhotographer) {
      return res.status(403).json({ error: "Not authorized as photographer" });
    }

    const photographer = await storage.getPhotographerByUserId(userId);
    if (!photographer?.stripeAccountId || !photographer?.stripeOnboardingComplete) {
      return res.status(403).json({ error: "Stripe onboarding not complete", requiresOnboarding: true });
    }

    const stripe = await getUncachableStripeClient();
    const loginLink = await stripe.accounts.loginLinks.create(photographer.stripeAccountId);
    return res.json({ url: loginLink.url });
  } catch (error) {
    console.error("[Stripe] Photographer dashboard link error:", error);
    return res.status(500).json({ error: "Failed to generate payout link" });
  }
});

// Photographer Services (must come before /:id routes)
photographersRouter.get("/me/services",          PhotographerController.getMyServices);
photographersRouter.post("/me/services",         PhotographerController.createService);
photographersRouter.patch("/me/services/:serviceId", PhotographerController.updateService);
photographersRouter.delete("/me/services/:serviceId", PhotographerController.deleteService);
photographersRouter.post("/me/services/:serviceId/go-live", PhotographerController.goLiveService);
photographersRouter.post("/me/services/:serviceId/archive", PhotographerController.archiveService);

// Photographer Availability (must come before /:id routes)
photographersRouter.get("/me/availability",          PhotographerController.getAvailability);
photographersRouter.post("/me/availability",         PhotographerController.createAvailabilitySlot);
photographersRouter.patch("/me/availability/:slotId", PhotographerController.updateAvailabilitySlot);
photographersRouter.delete("/me/availability/:slotId", PhotographerController.deleteAvailabilitySlot);

// Create photographer
photographersRouter.post("/",      PhotographerController.create);
// List photographers
photographersRouter.get("/",       PhotographerController.list);
// Get one photographer
photographersRouter.get("/:id",    PhotographerController.get);
// Get photographer's public services
photographersRouter.get("/:id/services", PhotographerController.getPublicServices);
// Update photographer
photographersRouter.patch("/:id",  PhotographerController.update);
// Delete photographer
photographersRouter.delete("/:id", PhotographerController.delete);

export { photographersRouter };
