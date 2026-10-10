// Electron ABI 向けのネイティブプリビルドを取得する。
//
// Visual Studio が入っていない環境では electron-rebuild がソースからの
// ビルドに失敗し、その結果ネイティブモジュールが Node ABI のままになり、
// パッケージ済みアプリが起動時に落ちる。
// このスクリプトは electron-rebuild 失敗時のフォールバックとして、
// 公式に公開されている Electron 向けプリビルドを取得する。
//
// 使い方: node tools/fetch-electron-prebuilds.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Electron 向けプリビルドが公開されているモジュールのみを対象にする
const MODULES = ["better-sqlite3"];

function readElectronVersion() {
  const pkg = path.join(repoRoot, "node_modules", "electron", "package.json");
  try {
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version;
  } catch {
    return null;
  }
}

const electronVersion = readElectronVersion();
if (!electronVersion) {
  console.log("[prebuilds] electron is not installed yet; skipping");
  process.exit(0);
}

const prebuildInstall = path.join(
  repoRoot,
  "node_modules",
  "prebuild-install",
  "bin.js",
);
if (!fs.existsSync(prebuildInstall)) {
  console.log("[prebuilds] prebuild-install is not available; skipping");
  process.exit(0);
}

let attempted = 0;
let failed = 0;

for (const name of MODULES) {
  const moduleDir = path.join(repoRoot, "node_modules", name);
  if (!fs.existsSync(moduleDir)) {
    continue;
  }

  attempted += 1;
  console.log(`[prebuilds] fetching ${name} for electron ${electronVersion}`);

  try {
    execFileSync(
      process.execPath,
      [
        prebuildInstall,
        "--runtime",
        "electron",
        "--target",
        electronVersion,
        "--arch",
        process.arch,
      ],
      { cwd: moduleDir, stdio: "inherit" },
    );
  } catch (error) {
    failed += 1;
    console.error(`[prebuilds] failed to fetch prebuild for ${name}`);
    console.error(`[prebuilds] ${error.message}`);
  }
}

if (failed > 0) {
  // インストール全体を失敗させない。アプリが起動しない場合は
  // このスクリプトを単体で再実行して原因を確認する。
  console.error(
    `[prebuilds] ${failed}/${attempted} module(s) could not be prepared. ` +
      "The packaged desktop app may fail to start.",
  );
}
