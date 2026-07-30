import express, { type Request, Response, NextFunction } from "express";
import { createServer } from "http";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { storage } from "./storage";
import { registerRoutes } from "./routes";
import { authMiddleware } from "./auth";
import vendorSubscriptionRouter from "./routes/vendorSubscription";
// stripe-replit-sync removed — no longer on Replit
import { WebhookHandlers } from "./stripe/webhookHandlers";
import { stripeService } from "./stripe/stripeService";
import { setupWebSocket } from "./websocket";
import { setupAuth, getSession } from "./replitAuth";
import { initializePushService, sendCartReminderNotifications, isPushConfigured } from "./pushService";
import { startDraftCleanupJob } from "./bookingStateMachine";
import { processScheduledDeletions } from "./services/accountDeletionService";
import passport from "passport";

// Global error handlers — prevent silent crashes
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught exception:', error);
  process.exit(1);
});

function isOnReplit(): boolean {
  return !!(process.env.REPL_IDENTITY || process.env.WEB_REPL_RENEWAL || process.env.REPL_ID);
}

const app = express();
const httpServer = createServer(app);

// Security headers
if (process.env.NODE_ENV === 'production') {
  app.use(helmet());
} else {
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
}

// Gzip compression
app.use(compression());

// Health check — must be before auth/CORS for load balancer access
app.get("/api/health", async (_req, res) => {
  try {
    await storage.getAllUsers().then(u => u.length); // lightweight DB check
    res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0', environment: process.env.NODE_ENV || 'development' });
  } catch {
    res.status(503).json({ status: 'error', message: 'Database unreachable' });
  }
});

// CORS configuration — locked down in production, permissive in development
const allowedOrigins: (string | RegExp)[] = [];

if (process.env.NODE_ENV === 'production') {
  if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);
  if (process.env.API_BASE_URL) allowedOrigins.push(process.env.API_BASE_URL);
} else {
  // Development origins
  allowedOrigins.push(
    /\.replit\.dev$/,
    /\.replit\.app$/,
    /\.janeway\.replit\.dev$/,
    `http://localhost:${process.env.PORT || 5000}`,
    'http://localhost:3000',
    'http://localhost:8081', // Expo
  );
  if (process.env.EXPO_DEV_URL) allowedOrigins.push(process.env.EXPO_DEV_URL);
  if (process.env.FRONTEND_URL) allowedOrigins.push(process.env.FRONTEND_URL);
}

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, curl, server-to-server)
    if (!origin) return callback(null, true);

    const isAllowed = allowedOrigins.some(allowed => {
      if (allowed instanceof RegExp) return allowed.test(origin);
      return allowed === origin;
    });

    if (isAllowed) return callback(null, true);

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
    log("Initializing Stripe...", "stripe");
    log("Using STRIPE_WEBHOOK_SECRET for webhook verification", "stripe");

    await stripeService.setupSubscriptionProducts();
    await stripeService.setupAlaCarteProducts();
    log("Stripe ready", "stripe");
  } catch (error) {
    console.error("Stripe initialization failed:", error);
  }
}

// =======================
// Production Environment Validation
// =======================
if (process.env.NODE_ENV === 'production') {
  const required = ['DATABASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'JWT_SECRET'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error(`[FATAL] Missing required environment variables for production: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!process.env.FRONTEND_URL) {
    console.error('[FATAL] FRONTEND_URL must be set in production for CORS security');
    process.exit(1);
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

  // Seed subscription tiers if not already present
  const { seedSubscriptionTiers } = await import("./subscriptionSeeder");
  await seedSubscriptionTiers();

  // Migration: ensure all approved business owners have canMonetize = true
  try {
    const allBusinesses = await storage.getAllBusinesses();
    for (const biz of allBusinesses) {
      if ((biz as Record<string, unknown>).approvalStatus === 'approved') {
        const owner = await storage.getUser(biz.ownerId);
        if (owner && !owner.canMonetize) {
          await storage.updateUser(owner.id, { canMonetize: true });
          console.log(`[Migration] Enabled canMonetize for user ${owner.id} (business ${biz.id})`);
        }
      }
    }
  } catch (migErr) {
    console.error("[Migration] canMonetize sync error:", migErr);
  }

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

  // Daily account deletion job — processes users whose 30-day grace period has expired
  processScheduledDeletions().catch(err => console.error("[accountDeletion] Initial run failed:", err));
  setInterval(() => {
    processScheduledDeletions().catch(err => console.error("[accountDeletion] Scheduled run failed:", err));
  }, 24 * 60 * 60 * 1000);

  await registerRoutes(httpServer, app);
  app.use('/api/vendor/subscription', authMiddleware, vendorSubscriptionRouter);
  setupWebSocket(httpServer);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    console.error(`[ERROR] ${err.message || 'Unknown error'}`, err.stack || '');
    res.status(status).json({
      success: false,
      error: {
        code: 'SERVER_ERROR',
        message: process.env.NODE_ENV === 'production'
          ? 'An unexpected error occurred'
          : (err.message || 'Internal Server Error'),
      },
    });
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

  // Graceful shutdown — required for zero-downtime deploys
  const shutdown = (signal: string) => {
    log(`${signal} received — shutting down gracefully`);
    httpServer.close(() => {
      log('HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('Forced shutdown after 10s timeout');
      process.exit(1);
    }, 10000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})();
