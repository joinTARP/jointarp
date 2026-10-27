import type { ElectrobunConfig } from "electrobun";

import manifest from "./package.json";
import { appId } from "./src/shared/brand";

export default {
  app: {
    name: "TARP",
    identifier: appId,
    version: manifest.version,
    description: manifest.description,
    urlSchemes: process.env.TARP_BUILD_CHANNEL === "stable" ? ["tarp"] : [],
  },
  release: { baseUrl: "https://github.com/joinTARP/TARP/releases/latest/download" },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/main/index.ts",
      alias: { "@shared": "./src/shared" },
      external: ["quickjs-emscripten", "node-datachannel"],
    },
    buildFolder: "out/desktop",
    artifactFolder: "release",
    copy: {
      "out/renderer": "views/main",
      "out/runtime/node_modules": "node_modules",
      "out/runtime/smoke.js": "smoke.js",
      LICENSE: "LICENSE",
      "NOTICE.md": "NOTICE.md",
    },
    watch: ["src/main", "src/shared", "../../packages/core/src", "../../packages/module/src"],
    watchIgnore: ["out/**", "release/**", "src/renderer/**"],
    mac: {
      bundleCEF: false,
      icons: "out/icon.iconset",
      codesign: process.env.TARP_CODESIGN === "1",
      notarize: process.env.TARP_NOTARIZE === "1",
    },
    win: { bundleCEF: false, icon: "build/icon-win.png" },
    linux: { bundleCEF: false, icon: "build/icon.png" },
  },
  runtime: { exitOnLastWindowClosed: false },
} satisfies ElectrobunConfig;
