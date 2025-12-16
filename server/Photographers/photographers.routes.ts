// server/Photographers/photographers.routes.ts
import { Router } from "express";
import { PhotographerController } from "./photographers.controller";

const photographersRouter = Router();

// Current photographer endpoints (must come before /:id)
photographersRouter.get("/me",                   PhotographerController.getMe);
photographersRouter.patch("/me",                 PhotographerController.updateMe);
photographersRouter.get("/me/stripe-status",     PhotographerController.getStripeStatus);
photographersRouter.get("/me/bookings",          PhotographerController.getBookingRecords);
photographersRouter.post("/me/stripe-onboarding", PhotographerController.startStripeOnboarding);

// Photographer Services (must come before /:id routes)
photographersRouter.get("/me/services",          PhotographerController.getMyServices);
photographersRouter.post("/me/services",         PhotographerController.createService);
photographersRouter.patch("/me/services/:serviceId", PhotographerController.updateService);
photographersRouter.delete("/me/services/:serviceId", PhotographerController.deleteService);

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
