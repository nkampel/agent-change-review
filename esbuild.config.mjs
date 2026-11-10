import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";
import builtins from "builtin-modules";

const watch = process.argv[2] === "watch";

/**
 * The release artifact is `main.js` in the repo root. When a dev vault exists
 * (`test_vault/`, untracked), every build is also installed into it so
 * Obsidian (with the Hot Reload plugin) picks it up.
 */
const DEV_VAULT_PLUGIN = "test_vault/.obsidian/plugins/agent-change-review";

const installIntoDevVault = {
  name: "install-into-dev-vault",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0 || !fs.existsSync("test_vault")) return;
      fs.mkdirSync(DEV_VAULT_PLUGIN, { recursive: true });
      for (const f of ["main.js", "manifest.json", "styles.css"]) {
        fs.copyFileSync(f, path.join(DEV_VAULT_PLUGIN, f));
      }
      // Lets the Hot Reload plugin reload this plugin after every build.
      fs.writeFileSync(path.join(DEV_VAULT_PLUGIN, ".hotreload"), "");
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: watch ? "inline" : false,
  treeShaking: true,
  outfile: "main.js",
  plugins: [installIntoDevVault],
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
