import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes } from "./routes";
import { redirectForPath } from "./redirects";
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { startSyncCron } from "./rets-sync";
import { startLeadAlertCron } from "./lead-alert-cron";
import { startCrmSyncCron } from "./fub-sync";
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

// Whether backups are current, for the outside uptime monitor
// (.github/workflows/uptime.yml). 200 when both the continuous copy and the
// daily backup are recent, 503 with the reason otherwise. Ages only — nothing
// about where the backups live.
app.get("/healthz/backup", async (_req, res) => {
  try {
    const { litestreamEnabled, litestreamFreshness, litestreamProcess } = await import("./litestream");
    const { backupStatus } = await import("./backup");
    const problems: string[] = [];
    const on = litestreamEnabled();
    const proc = litestreamProcess();
    const fresh = on.ok ? await litestreamFreshness() : null;
    if (on.ok) {
      if (!proc.running) problems.push("continuous backup isn't running");
      if (fresh?.error) problems.push("can't reach the backup storage");
      // The MLS sync alone writes several times an hour, so two quiet hours
      // means copies have stopped arriving.
      else if (fresh && (fresh.ageMinutes === null || fresh.ageMinutes > 120)) problems.push("no continuous backup in the last 2 hours");
    }
    const daily = backupStatus();
    const lastDaily = daily.lastOk?.finishedAt ?? null;
    const dailyHours = lastDaily ? Math.round((Date.now() - Date.parse(lastDaily)) / 3_600_000) : null;
    if (daily.configured && (dailyHours === null || dailyHours > 30)) problems.push("no daily backup in the last 30 hours");
    res.status(problems.length ? 503 : 200).json({
      ok: problems.length === 0,
      problems,
      continuous: on.ok ? { running: proc.running, restarts: proc.restarts, lastCopyMinutesAgo: fresh?.ageMinutes ?? null } : { off: on.reason },
      daily: { lastSuccessHoursAgo: dailyHours },
    });
  } catch (e: any) {
    res.status(503).json({ ok: false, problems: [String(e?.message ?? e).slice(0, 200)] });
  }
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

  // Above this, the body is described by size alone and never serialised.
  // 2KB is far more than the 500 characters a log line actually shows.
  const MAX_LOGGED_BODY_BYTES = 2048;

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse !== undefined) {
        // Ask Content-Length how big the body is instead of serialising it to
        // find out. The previous version called JSON.stringify() on the whole
        // response and only then sliced the string to 500 characters, so
        // printing half a line of /api/admin/blog meant serialising 877KB —
        // synchronously, on the one thread that also has to answer /healthz
        // within five seconds. On a shared CPU that is a real contributor to
        // the health check flapping and the machine being pulled out of
        // rotation. Express has already computed this number; use it.
        const declared = Number(res.get("content-length"));
        const size = Number.isFinite(declared) ? declared : null;
        if (size !== null && size <= MAX_LOGGED_BODY_BYTES) {
          const body = JSON.stringify(capturedJsonResponse);
          logLine += ` :: ${body.length > 500 ? `${body.slice(0, 500)}…` : body}`;
        } else {
          // Unknown length means a streamed or chunked body — still not worth
          // serialising blind just to describe it.
          logLine += ` :: (${size ?? "unknown"} bytes, body omitted)`;
        }
      }
      // Drop the reference either way: on a large response this is the whole
      // result set, and nothing should hold it past the request.
      capturedJsonResponse = undefined;

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
    const migrated = req.params.segment === "1405-property"
      ? storage.getMlsListingById("A2332075")
      : undefined;
    const listing = migrated
      ?? storage.getMlsListingById(req.params.segment)
      ?? storage.getMlsListingByLegacySeoSlug(req.params.segment);
    if (!listing) return next();
    // An alias generator can resolve a slug that is already canonical (a
    // listing whose address produces one unambiguous base slug gets the same
    // string from every format). Redirecting that to itself is an infinite
    // 301 loop, so hand canonical URLs to the SSR renderer instead.
    const canonical = storage.getMlsSeoSlug(listing);
    if (canonical === req.params.segment) return next();
    return res.redirect(301, `/mls/${canonical}`);
  });

  try {
    startSyncCron();
  } catch (err) {
    console.error("[mls-sync] failed to start cron:", err);
  }
  try {
    const { startMyListingsCron } = await import("./my-listings");
    startMyListingsCron();
  } catch (err) {
    console.error("[my-listings] failed to start cron:", err);
  }
  try {
    const { startHistorySyncCron } = await import("./rets-history-sync");
    startHistorySyncCron();
  } catch (err) {
    console.error("[mls-history] failed to start cron:", err);
  }
  try {
    const { startMarketReportCron } = await import("./market-report-store");
    startMarketReportCron();
  } catch (err) {
    console.error("[market-reports] failed to start cron:", err);
  }
  try {
    const { startNewsletterCron } = await import("./newsletter");
    startNewsletterCron();
  } catch (err) {
    console.error("[newsletter] failed to start cron:", err);
  }
  try {
    startLeadAlertCron();
  } catch (err) {
    console.error("[lead-alerts] failed to start cron:", err);
  }
  try {
    const { startReturnAlertCron } = await import("./return-alerts");
    startReturnAlertCron();
  } catch (err) {
    console.error("[return-alerts] failed to start cron:", err);
  }
  try {
    const { startShowingReminderCron } = await import("./showing-reminders");
    startShowingReminderCron();
  } catch (err) {
    console.error("[reminders] failed to start cron:", err);
  }
  try {
    const { startAutomationsCron } = await import("./automations");
    startAutomationsCron();
  } catch (err) {
    console.error("[automations] failed to start:", err);
  }
  try {
    const { startBulkTextSender } = await import("./bulk-texts");
    startBulkTextSender();
  } catch (err) {
    console.error("[bulk-texts] failed to start:", err);
  }
  try {
    const { startInboxEmailCron } = await import("./gmail-inbox");
    startInboxEmailCron();
  } catch (err) {
    console.error("[inbox] failed to start gmail sync:", err);
  }
  try {
    startCrmSyncCron();
  } catch (err) {
    console.error("[crm-sync] failed to start cron:", err);
  }
  try {
    const { startBackupCron } = await import("./backup");
    startBackupCron();
  } catch (err) {
    console.error("[backup] failed to start cron:", err);
  }
  try {
    // Continuous backup to R2 (server/litestream.ts).
    const { startLitestream } = await import("./litestream");
    startLitestream();
  } catch (err) {
    console.error("[litestream] failed to start:", err);
  }
  try {
    const { startDbMaintenance } = await import("./db-maintenance");
    startDbMaintenance();
  } catch (err) {
    console.error("[db-maintenance] failed to start:", err);
  }
  try {
    const { startDealInboxCron } = await import("./deal-inbox");
    startDealInboxCron();
  } catch (err) {
    console.error("[deal-inbox] failed to start cron:", err);
  }
  try {
    const { startAiVisibilityCron } = await import("./ai-visibility");
    startAiVisibilityCron();
  } catch (err) {
    console.error("[ai-visibility] failed to start cron:", err);
  }
  try {
    const { scheduleSitemapSubmit } = await import("./search-console");
    scheduleSitemapSubmit();
  } catch (err) {
    console.error("[search-console] failed to schedule sitemap submit:", err);
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
      // Pre-render the busiest pages into the SSR cache once the server has
      // settled, so the first visitor after a deploy doesn't wait on a cold
      // render. After this, stale-while-revalidate (server/ssr.ts) keeps
      // them warm. One page at a time, to stay out of real traffic's way.
      if (process.env.NODE_ENV === "production") {
        setTimeout(async () => {
          for (const path of ["/", "/neighbourhoods", "/condos", "/blog", "/about"]) {
            const t0 = Date.now();
            try {
              const r = await fetch(`http://127.0.0.1:${port}${path}`, {
                headers: { "User-Agent": "RiversWarmup/1.0", accept: "text/html" },
                signal: AbortSignal.timeout(30_000),
              });
              await r.text();
              log(`[warmup] ${path} ${r.status} in ${Date.now() - t0}ms`);
            } catch (e: any) {
              log(`[warmup] ${path} failed: ${e?.message ?? e}`);
            }
          }
        }, 15_000);
        // The SEO keyword report (what "Improve" plans against): reloaded from
        // disk at startup; crawl a fresh one only if there's none at all.
        import("./seo-report-cache")
          .then((m) => m.scheduleBootSeoReport())
          .catch((e) => log(`[seo-keywords] boot scheduling failed: ${e?.message ?? e}`));
      }
    },
  );
})();
