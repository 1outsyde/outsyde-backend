import express, { type Request, Response, NextFunction } from "express";
import { createServer } from "http";
import cors from "cors";
import { storage } from "./storage";
import { registerRoutes } from "./routes";
import { runMigrations } from "stripe-replit-sync";
import { getStripeSync } from "./stripe/stripeClient";
import { WebhookHandlers } from "./stripe/webhookHandlers";
import { stripeService } from "./stripe/stripeService";
import { setupWebSocket } from "./websocket";
import { setupAuth } from "./replitAuth";
import { initializePushService, sendCartReminderNotifications, isPushConfigured } from "./pushService";

const app = express();
const httpServer = createServer(app);

app.use(cors());

// =======================
// Stripe Webhook (RAW BODY)
// =======================
app.post(
  "/api/stripe/webhook/:uuid",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];

    if (!signature) {
      return res.status(400).json({ error: "Missing stripe-signature" });
    }

    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;

      if (!Buffer.isBuffer(req.body)) {
        console.error("STRIPE WEBHOOK ERROR: req.body is not a Buffer");
        return res.status(500).json({ error: "Webhook processing error" });
      }

      const { uuid } = req.params;
      await WebhookHandlers.processWebhook(req.body as Buffer, sig, uuid);

      res.status(200).json({ received: true });
    } catch (error: any) {
      console.error("Webhook error:", error.message);
      res.status(400).json({ error: "Webhook processing error" });
    }
  }
);

// =======================
// Standard Middleware
// =======================
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }
      if (logLine.length > 80) logLine = logLine.slice(0, 79) + "…";
      log(logLine);
    }
  });

  next();
});

function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

// =======================
// Stripe Initialization
// =======================
async function initStripe() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    log("DATABASE_URL not set - skipping Stripe initialization", "stripe");
    return;
  }

  try {
    log("Initializing Stripe schema...", "stripe");
    await runMigrations({ databaseUrl });
    log("Stripe schema ready", "stripe");

    const stripeSync = await getStripeSync();

    log("Setting up managed webhook...", "stripe");
    const webhookBaseUrl = process.env.RENDER_EXTERNAL_URL || "";
    await stripeSync.findOrCreateManagedWebhook(
      `${webhookBaseUrl}/api/stripe/webhook`,
      {
        enabled_events: ["*"],
        description: "Managed webhook for Outsyde marketplace",
      }
    );

    log("Setting up Stripe products...", "stripe");
    await stripeService.setupSubscriptionProducts();
    await stripeService.setupAlaCarteProducts();
  } catch (error) {
    console.error("Stripe initialization failed:", error);
  }
}

// =======================
// App Bootstrap
// =======================
(async () => {
  await storage.seedInitialData();
  await storage.cleanupExpiredTokens();
  await initStripe();

  await setupAuth(app);
  log("Auth configured", "auth");

  setInterval(() => storage.cleanupExpiredTokens(), 60 * 60 * 1000);

  initializePushService();

  if (isPushConfigured()) {
    setInterval(sendCartReminderNotifications, 30 * 60 * 1000);
  }

  await registerRoutes(httpServer, app);
  setupWebSocket(httpServer);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ message: err.message || "Internal Server Error" });
  });

  // =======================
  // DEV ONLY: Vite
  // =======================
  if (process.env.NODE_ENV !== "production") {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // =======================
  // Start Server
  // =======================
  const port = Number(process.env.PORT) || 5000;
  httpServer.listen({ port, host: "0.0.0.0" }, () => {
    log(`serving on port ${port}`);
  });
})();
