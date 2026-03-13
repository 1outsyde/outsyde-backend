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
import { setupAuth, getSession } from "./replitAuth";
import { initializePushService, sendCartReminderNotifications, isPushConfigured } from "./pushService";
import { startDraftCleanupJob } from "./bookingStateMachine";
import passport from "passport";

function isOnReplit(): boolean {
  return !!(process.env.REPL_IDENTITY || process.env.WEB_REPL_RENEWAL || process.env.REPL_ID);
}

const app = express();
const httpServer = createServer(app);

// CORS configuration - mobile apps use JWT auth (no cookies needed)
// Web clients on same origin don't need CORS, mobile apps use Authorization headers
const allowedOrigins = [
  // Replit dev/preview domains
  /\.replit\.dev$/,
  /\.replit\.app$/,
  /\.janeway\.replit\.dev$/,
  // Local development
  'http://localhost:5000',
  'http://localhost:3000',
  'http://localhost:8081', // Expo
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, curl, server-to-server)
    // Mobile apps using JWT don't send cookies, so CSRF is not a concern
    if (!origin) return callback(null, true);
    
    // Check against allowed origins (strings and regexes)
    const isAllowed = allowedOrigins.some(allowed => {
      if (allowed instanceof RegExp) {
        return allowed.test(origin);
      }
      return allowed === origin;
    });
    
    if (isAllowed) {
      return callback(null, true);
    }
    
    // Reject unknown origins
    callback(new Error('CORS not allowed'), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

// =======================
// Stripe Webhook (RAW BODY)
// =======================
// Handler function for both routes
const handleStripeWebhook = async (req: any, res: any) => {
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

    const uuid = req.params.uuid || "external";
    await WebhookHandlers.processWebhook(req.body as Buffer, sig, uuid);

    res.status(200).json({ received: true });
  } catch (error: any) {
    console.error("Webhook error:", error.message);
    res.status(400).json({ error: "Webhook processing error" });
  }
};

// Route with UUID (Replit managed webhooks)
app.post(
  "/api/stripe/webhook/:uuid",
  express.raw({ type: "application/json" }),
  handleStripeWebhook
);

// Route without UUID (external hosting like Render)
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  handleStripeWebhook
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

    // Only setup managed webhook on Replit - external hosting uses STRIPE_WEBHOOK_SECRET
    if (isOnReplit()) {
      log("Setting up managed webhook...", "stripe");
      // Get the domain from Replit environment
      const replitDomains = process.env.REPLIT_DOMAINS;
      if (replitDomains) {
        const primaryDomain = replitDomains.split(",")[0];
        const webhookUrl = `https://${primaryDomain}/api/stripe/webhook`;
        log(`Webhook configured: ${webhookUrl}`, "stripe");
        await stripeSync.findOrCreateManagedWebhook(
          webhookUrl,
          {
            enabled_events: ["*"],
            description: "Managed webhook for Outsyde marketplace",
          }
        );
      } else {
        log("REPLIT_DOMAINS not set - skipping managed webhook setup", "stripe");
      }
    } else {
      log("Using STRIPE_WEBHOOK_SECRET for webhook verification (external hosting)", "stripe");
    }

    log("Setting up subscription tier products...", "stripe");
    await stripeService.setupSubscriptionProducts();
    await stripeService.setupAlaCarteProducts();
    log("Subscription products ready", "stripe");
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

  // Seed influencer tiers and point config if not already present
  const { seedInfluencerTiersAndConfig } = await import("./influencerTrackingService");
  await seedInfluencerTiersAndConfig();

  await initStripe();

  // Conditionally setup auth based on platform
  if (isOnReplit()) {
    await setupAuth(app);
    log("Replit Auth configured (Google OAuth enabled)", "auth");
  } else {
    // For external hosting (Render, etc.) - setup basic session without Replit OIDC
    app.set("trust proxy", 1);
    app.use(getSession());
    app.use(passport.initialize());
    app.use(passport.session());
    passport.serializeUser((user: Express.User, cb) => cb(null, user));
    passport.deserializeUser((user: Express.User, cb) => cb(null, user));
    
    // Stub login/logout routes for external hosting
    // TODO: Implement your own auth strategy (e.g., Passport Local, Google OAuth, etc.)
    app.get("/api/login", (_req, res) => {
      res.status(501).json({ 
        error: "Authentication not configured", 
        message: "Please configure an auth strategy for external hosting (e.g., Passport Local, Google OAuth)" 
      });
    });
    
    app.get("/api/logout", (req, res) => {
      req.logout(() => {
        res.redirect("/");
      });
    });
    
    log("Session-based auth configured (external hosting mode - implement your own auth strategy)", "auth");
  }

  setInterval(() => storage.cleanupExpiredTokens(), 60 * 60 * 1000);

  initializePushService();

  if (isPushConfigured()) {
    setInterval(sendCartReminderNotifications, 30 * 60 * 1000);
  }

  // Start booking draft cleanup job (runs every 60 seconds)
  startDraftCleanupJob(60000);
  console.log("Booking draft cleanup job started");

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
