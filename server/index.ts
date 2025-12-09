// server/index.ts
import express from "express";
import cors from "cors";
import { storage } from "./storage";
import { photographersRouter } from "./Photographers/photographers.routes";

// -------------------------------
// CREATE EXPRESS APP
// -------------------------------
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// -------------------------------
// ROUTES
// -------------------------------
app.use("/api/photographers", photographersRouter);

// Health check
app.get("/", (req, res) => {
  res.json({ success: true, message: "OutSyde API is running" });
});

// -------------------------------
// START SERVER
// -------------------------------
const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
  console.log(`[express] API running on port ${PORT}`);

  try {
    await storage.cleanupExpiredTokens();
  } catch (err) {
    console.error("Token cleanup failed:", err);
  }
});
