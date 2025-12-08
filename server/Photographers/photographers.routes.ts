// server/Photographers/photographers.routes.ts
import { Router } from "express";
import { PhotographerController } from "./photographers.controller";

const photographersRouter = Router();

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
