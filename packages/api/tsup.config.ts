import fs from "fs/promises";

import { defineConfig, Options } from "tsup";

await fs.rm("dist", { recursive: true }).catch(() => {});

const options: Options = {
  entry: [
    "src/config/index.node.ts",
    "src/extensions/index.ts",
    "src/pg/index.ts",
    "src/pg/index.node.ts",
    "src/sqlite/index.ts",
    "src/sqlite/index.node.ts",
    "src/mysql/index.ts",
    "src/mysql/index.node.ts",
    "src/relations/index.ts",
    "src/sql/index.ts",
  ],
  outDir: "dist",
  dts: true,
  sourcemap: false,
  minify: false,
};

export default defineConfig([
  {
    ...options,
    format: "esm",
  },
  {
    ...options,
    format: "cjs",
    shims: true,
  },
]);
