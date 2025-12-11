import express, { type Request, Response, NextFunction } from "express";
import { createServer } from "http";
import cors from "cors";
import { storage } from "./storage";
import { registerRoutes } from "./routes";
import { setupVite } from "./vite";
import { runMigrations } from "stripe-replit-sync";
import { getStripeSync } from "./stripe/stripeClient";
import { WebhookHandlers } from "./stripe/webhookHandlers";
import { setupWebSocket } from "./websocket";
import { setupAuth } from "./replitAuth";
import { initializePushService, sendCartReminderNotifications, isPushConfigured } from "./pushService";

const app = express();
const httpServer = createServer(app);

app.use(cors());

// CRITICAL: Stripe webhook route MUST be registered BEFORE express.json()
// The webhook needs the raw Buffer body, not parsed JSON
app.post(
  '/api/stripe/webhook/:uuid',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const signature = req.headers['stripe-signature'];

    if (!signature) {
      return res.status(400).json({ error: 'Missing stripe-signature' });
    }

    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;

      if (!Buffer.isBuffer(req.body)) {
        console.error('STRIPE WEBHOOK ERROR: req.body is not a Buffer');
        return res.status(500).json({ error: 'Webhook processing error' });
      }

      const { uuid } = req.params;
      await WebhookHandlers.processWebhook(req.body as Buffer, sig, uuid);

      res.status(200).json({ received: true });
    } catch (error: any) {
      console.error('Webhook error:', error.message);
      res.status(400).json({ error: 'Webhook processing error' });
    }
  }
);

// Now apply JSON middleware for all other routes
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

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

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

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

// Initialize Stripe schema and sync data on startup
async function initStripe() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    log('DATABASE_URL not set - skipping Stripe initialization', 'stripe');
    return;
  }

  try {
    log('Initializing Stripe schema...', 'stripe');
    await runMigrations({ databaseUrl });
    log('Stripe schema ready', 'stripe');

    const stripeSync = await getStripeSync();

    log('Setting up managed webhook...', 'stripe');
    const webhookBaseUrl = `https://${process.env.REPLIT_DOMAINS?.split(',')[0]}`;
    const { webhook, uuid } = await stripeSync.findOrCreateManagedWebhook(
      `${webhookBaseUrl}/api/stripe/webhook`,
      {
        enabled_events: ['*'],
        description: 'Managed webhook for Outsyde marketplace',
      }
    );
    log(`Webhook configured: ${webhook.url}`, 'stripe');

    // Sync all existing Stripe data in background
    stripeSync.syncBackfill()
      .then(() => log('Stripe data synced', 'stripe'))
      .catch((err: any) => console.error('Error syncing Stripe data:', err));
  } catch (error) {
    console.error('Failed to initialize Stripe:', error);
  }
}

(async () => {
  await storage.seedInitialData();
  await storage.cleanupExpiredTokens();
  await initStripe();

  // Set up Replit Auth (Google OAuth)
  await setupAuth(app);
  log("Replit Auth configured (Google OAuth enabled)", "auth");

  setInterval(async () => {
    try {
      await storage.cleanupExpiredTokens();
      log("Expired tokens cleaned up", "auth");
    } catch (error) {
      console.error("Token cleanup error:", error);
    }
  }, 60 * 60 * 1000);

  initializePushService();
  
  if (isPushConfigured()) {
    setInterval(async () => {
      try {
        const sentCount = await sendCartReminderNotifications();
        if (sentCount > 0) {
          log(`Sent ${sentCount} cart reminder notifications`, "push");
        }
      } catch (error) {
        console.error("Cart reminder error:", error);
      }
    }, 30 * 60 * 1000);
    log("Cart reminder notifications scheduled (every 30 min)", "push");
  }

  await registerRoutes(httpServer, app);

  // Set up WebSocket server for real-time chat
  setupWebSocket(httpServer);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  await setupVite(httpServer, app);

  const port = 5000;
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
    },
    () => {
      log(`serving on port ${port}`);
    }
  );
})();
