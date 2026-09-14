import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { appendFile, copyFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
await build({
  entryPoints: ["src/browser.ts"],
  outfile: "dist/browser.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  inject: [resolve("src/browser/buffer.ts")],
  alias: { "#nitro-runtime": resolve("src/runtime/browser.ts") },
  logLevel: "info",
  legalComments: "linked",
});

execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.browser.json"], {
  stdio: "inherit",
});
await copyFile("artifacts/browser-types/browser.d.ts", "dist/browser.d.ts");

const require = createRequire(import.meta.url);
for (const dependency of ["@noble/hashes", "@noble/ciphers", "fflate", "buffer"]) {
  await appendFile(
    "dist/browser.js.LEGAL.txt",
    `\n\n${dependency}\n${await readFile(resolve("node_modules", dependency, "LICENSE"), "utf8")}`,
  );
}
for (const dependency of ["base64-js", "ieee754"]) {
  const directory = dirname(require.resolve(`${dependency}/package.json`, { paths: [resolve("node_modules/buffer")] }));
  await appendFile(
    "dist/browser.js.LEGAL.txt",
    `\n\n${dependency}\n${await readFile(join(directory, "LICENSE"), "utf8")}`,
  );
}
