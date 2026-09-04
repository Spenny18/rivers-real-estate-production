import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes } from "./routes";
import { redirectForPath } from "./redirects";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { startSyncCron } from "./rets-sync";
import { startLeadAlertCron } from "./lead-alert-cron";
import { storage } from "./storage";

import { warnIfPublicOriginUnset } from "./origin";
const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    // 12 MB ceiling so the admin condo editor can POST hero images as base64
    // data URLs (typical hero PNG ~2-3 MB; base64 inflates ~33%).
    limit: "12mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: "12mb" }));

// Fly only needs to know that the Node process can answer. Keep the health
// check independent of SQLite and third-party services so transient load does
// not cause healthy machines to be removed from service.
app.get("/healthz", (_req, res) => {
  res.status(200).type("text/plain").send("ok");
});

// 301 www → apex. Both hostnames resolve to this app; without the redirect
// Google indexes duplicate content across the two hosts.
app.use((req, res, next) => {
  if (req.hostname === "www.riversrealestate.ca") {
    return res.redirect(301, `https://riversrealestate.ca${req.originalUrl}`);
  }
  next();
});

// 301s for legacy WordPress-era URLs (see server/redirects.ts for the
// audited map). Sits before all routes so dev and prod behave identically.
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  const target = redirectForPath(req.path);
  if (target && target !== req.path) return res.redirect(301, target);
  next();
});

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

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

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  // Old MLS-number detail URLs permanently consolidate onto the canonical
  // address/subdivision/city permalink. Slug URLs continue to SSR normally.
  app.get("/mls/:segment", (req, res, next) => {
    // A previous condo-card response omitted the canonical slug fields and
    // briefly emitted this public URL. Preserve it as a permanent migration
    // redirect rather than leaving shared/bookmarked copies as a 404.
    if (req.params.segment === "1405-property") {
      const affected = storage.getMlsListingById("A2332075");
      if (affected) return res.redirect(301, `/mls/${storage.getMlsSeoSlug(affected)}`);
    }
    const legacy = storage.getMlsListingById(req.params.segment);
    const oldSlug = legacy ?? storage.getMlsListingByLegacySeoSlug(req.params.segment);
    if (!oldSlug) return next();
    return res.redirect(301, `/mls/${storage.getMlsSeoSlug(oldSlug)}`);
  });

  try {
    startSyncCron();
  } catch (err) {
    console.error("[mls-sync] failed to start cron:", err);
  }
  try {
    startLeadAlertCron();
  } catch (err) {
    console.error("[lead-alerts] failed to start cron:", err);
  }

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      // reusePort is Linux-only; macOS throws ENOTSUP so skip it in local dev.
      ...(process.platform === "linux" ? { reusePort: true } : {}),
    },
    () => {
      log(`serving on port ${port}`);
      // Says so once at boot rather than letting a fallback origin quietly
      // become the deployed behaviour — it decides booking links, outbound
      // email and the Google OAuth redirect URI.
      warnIfPublicOriginUnset();
    },
  );
})();
