import esbuild from "esbuild";
import { copyFile, mkdir, rm } from "fs/promises";
import path from "path";

const isWatch = process.argv.includes("--watch");
const outdir = "build";

async function build() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  await esbuild
    .context({
      entryPoints: ["src/main.ts"],
      bundle: true,
      format: "cjs",
      platform: "browser",
      target: "es2017",
      outfile: `${outdir}/main.js`,
      sourcemap: false,
      external: ["obsidian"],
    })
    .then(async (ctx) => {
      if (isWatch) {
        await ctx.watch();
        console.log("Watching for changes...");
      } else {
        await ctx.rebuild();
        await ctx.dispose();
      }
    });

  await Promise.all([
    copyFile("manifest.json", `${outdir}/manifest.json`),
    copyFile("versions.json", `${outdir}/versions.json`),
    copyFile("src/styles.css", `${outdir}/styles.css`),
  ]);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});

