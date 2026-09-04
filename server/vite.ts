import type { Express } from 'express';
import { createServer as createViteServer, createLogger } from "vite";
import type { Server } from 'node:http';
import viteConfig from "../vite.config";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { metaForPath, injectMetaIntoHtml } from "./seo-inject";
import { createSsrPipeline, type RenderFn } from "./ssr";

import { publicOrigin } from "./origin";
const viteLogger = createLogger();

export async function setupVite(server: Server, app: Express) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server, path: "/vite-hmr" },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);

  // Dev SSR: same pipeline as production, but the render module is loaded
  // through vite.ssrLoadModule on every request (keeps HMR live) and nothing
  // is cached. SSR failures log and fall back to the CSR shell.
  const ssrPipeline = createSsrPipeline({
    getRender: async () =>
      (await vite.ssrLoadModule("/src/entry-server.tsx")).render as RenderFn,
    cacheTtlMs: 0,
  });

  app.use("/{*path}", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "..",
        "client",
        "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );
      let page = await vite.transformIndexHtml(url, template);
      // Inject per-route SEO meta tags so Googlebot gets full HEAD
      // metadata even without executing JS. Same logic as production
      // (server/static.ts). Unknown routes return 404.
      // originalUrl, not req.path — inside app.use("/{*path}") Express
      // strips the matched wildcard, so req.path is "/" for every request
      // (same bug static.ts fixed in d56aaab).
      const rawPath = url.split("?")[0].split("#")[0] || "/";
      const meta = metaForPath(rawPath);
      if (!meta) {
        const fallbackHtml = injectMetaIntoHtml(page, {
          title: "Page not found — Rivers Real Estate",
          description: "The page you're looking for doesn't exist.",
          canonical: `${publicOrigin()}${rawPath}`,
          noindex: true,
        });
        res.status(404).set({ "Content-Type": "text/html" }).end(fallbackHtml);
        return;
      }
      page = injectMetaIntoHtml(page, meta);
      const search = url.split("?")[1] || "";
      const rendered = await ssrPipeline.renderInto(page, rawPath, search, {
        cacheable: false,
      });
      res.status(200).set({ "Content-Type": "text/html" }).end(rendered ?? page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}
