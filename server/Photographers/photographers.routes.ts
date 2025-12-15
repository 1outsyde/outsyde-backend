// server/Photographers/photographers.routes.ts
import { Router } from "express";
import { PhotographerController } from "./photographers.controller";

const photographersRouter = Router();

// Current photographer endpoints (must come before /:id)
photographersRouter.get("/me",                   PhotographerController.getMe);
photographersRouter.get("/me/stripe-status",     PhotographerController.getStripeStatus);
photographersRouter.post("/me/stripe-onboarding", PhotographerController.startStripeOnboarding);

// Create photographer
photographersRouter.post("/",      PhotographerController.create);
// List photographers
photographersRouter.get("/",       PhotographerController.list);
// Get one photographer
photographersRouter.get("/:id",    PhotographerController.get);
// Update photographer
photographersRouter.patch("/:id",  PhotographerController.update);
// Delete photographer
photographersRouter.delete("/:id", PhotographerController.delete);

export { photographersRouter };
