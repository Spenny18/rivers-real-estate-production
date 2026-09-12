import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, cp } from "node:fs/promises";
import path from "node:path";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "axios",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  // SSR render bundle (client/src/entry-server.tsx → dist/ssr/entry-server.cjs).
  // noExternal bundles every dependency into one self-contained CJS file, so
  // the express bundle (also CJS) can require() it without touching the
  // ESM/CJS interop of individual packages, and the Dockerfile needs no
  // changes — dist/ is copied wholesale.
  console.log("building ssr bundle...");
  await viteBuild({
    build: {
      ssr: "src/entry-server.tsx",
      outDir: path.resolve("dist/ssr"),
      emptyOutDir: true,
      rollupOptions: {
        output: { format: "cjs", entryFileNames: "entry-server.cjs" },
      },
    },
    ssr: { noExternal: true },
  });

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });

  // Files the server reads at runtime rather than bundles: the brand fonts
  // the market-report renderer hands to resvg. dist/ is copied wholesale into
  // the image, so they ride along at dist/assets/fonts.
  console.log("copying server assets...");
  await cp("server/assets", "dist/assets", { recursive: true });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
