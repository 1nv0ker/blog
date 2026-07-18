import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  marketplaceSourcePath,
  mergeMarketplace,
  writeMcpConfigurations,
} from "./configure-install.mjs";

async function temporaryHome(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sanityblog-install-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("generated MCP configurations always use the portable runtime", async (t) => {
  const home = await temporaryHome(t);
  const pluginRoot = path.join(home, "stage");
  const installRoot = path.join(home, "plugins", "sanityblog");
  await mkdir(pluginRoot, { recursive: true });

  await writeMcpConfigurations({ pluginRoot, installRoot });

  const codex = JSON.parse(
    await readFile(path.join(pluginRoot, ".codex-mcp.json"), "utf8"),
  );
  assert.deepEqual(codex, {
    sanityblog: {
      command: path.join(installRoot, "runtime", "node.exe"),
      args: [path.join(installRoot, "src", "server.mjs")],
    },
  });

  const compatible = JSON.parse(
    await readFile(path.join(pluginRoot, ".mcp.json"), "utf8"),
  );
  assert.deepEqual(compatible, {
    mcpServers: {
      sanityblog: {
        command: "${CLAUDE_PLUGIN_ROOT}/runtime/node.exe",
        args: ["${CLAUDE_PLUGIN_ROOT}/src/server.mjs"],
      },
    },
  });
});

test("marketplace merge preserves other plugins and is idempotent", async (t) => {
  const home = await temporaryHome(t);
  const marketplacePath = path.join(
    home,
    ".agents",
    "plugins",
    "marketplace.json",
  );
  const installRoot = path.join(home, "plugins", "sanityblog");
  const otherPlugin = {
    name: "other-plugin",
    source: { source: "local", path: "./plugins/other-plugin" },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_DEMAND",
    },
    custom: { keep: true },
  };
  const original = {
    name: "personal-lab",
    interface: { displayName: "Personal Lab", theme: "custom" },
    customTopLevel: true,
    plugins: [
      otherPlugin,
      {
        name: "sanityblog",
        source: { source: "local", path: "./old/location" },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_DEMAND",
        },
        customPluginField: "preserved",
      },
      {
        name: "sanityblog",
        source: { source: "local", path: "./duplicate" },
      },
    ],
  };
  await mkdir(path.dirname(marketplacePath), { recursive: true });
  await writeFile(marketplacePath, JSON.stringify(original), "utf8");

  const first = await mergeMarketplace({ marketplacePath, installRoot });
  assert.deepEqual(first, {
    marketplaceName: "personal-lab",
    sourcePath: "./plugins/sanityblog",
    changed: true,
  });

  const mergedText = await readFile(marketplacePath, "utf8");
  const merged = JSON.parse(mergedText);
  assert.equal(merged.customTopLevel, true);
  assert.deepEqual(merged.interface, original.interface);
  assert.deepEqual(merged.plugins[0], otherPlugin);
  const sanityEntries = merged.plugins.filter(
    (entry) => entry?.name === "sanityblog",
  );
  assert.equal(sanityEntries.length, 1);
  assert.deepEqual(sanityEntries[0], {
    name: "sanityblog",
    source: { source: "local", path: "./plugins/sanityblog" },
    policy: {
      installation: "INSTALLED_BY_DEFAULT",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
    customPluginField: "preserved",
  });

  const directoryEntries = await readdir(path.dirname(marketplacePath));
  assert.equal(directoryEntries.some((name) => name.endsWith(".tmp")), false);

  const second = await mergeMarketplace({ marketplacePath, installRoot });
  assert.equal(second.changed, false);
  assert.equal(await readFile(marketplacePath, "utf8"), mergedText);
});

test("concurrent marketplace merges serialize and leave no lock or partial JSON", async (t) => {
  const home = await temporaryHome(t);
  const marketplacePath = path.join(
    home,
    ".agents",
    "plugins",
    "marketplace.json",
  );
  const installRoot = path.join(home, "plugins", "sanityblog");
  await mkdir(path.dirname(marketplacePath), { recursive: true });
  await writeFile(
    marketplacePath,
    JSON.stringify({
      name: "personal",
      plugins: [{ name: "keep-me", source: { source: "local", path: "./keep" } }],
    }),
    "utf8",
  );

  await Promise.all(
    Array.from({ length: 20 }, () => mergeMarketplace({ marketplacePath, installRoot })),
  );

  const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  assert.equal(marketplace.plugins.some((entry) => entry?.name === "keep-me"), true);
  assert.equal(
    marketplace.plugins.filter((entry) => entry?.name === "sanityblog").length,
    1,
  );
  const directoryEntries = await readdir(path.dirname(marketplacePath));
  assert.equal(directoryEntries.some((name) => name.endsWith(".sanityblog.lock")), false);
  assert.equal(directoryEntries.some((name) => name.endsWith(".tmp")), false);
});
test("missing personal marketplace is created with the default identity", async (t) => {
  const home = await temporaryHome(t);
  const marketplacePath = path.join(
    home,
    ".agents",
    "plugins",
    "marketplace.json",
  );
  const installRoot = path.join(home, "plugins", "sanityblog");

  const result = await mergeMarketplace({ marketplacePath, installRoot });
  const marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));

  assert.equal(result.marketplaceName, "personal");
  assert.equal(marketplace.name, "personal");
  assert.deepEqual(marketplace.interface, { displayName: "Personal" });
  assert.equal(marketplace.plugins[0].source.path, "./plugins/sanityblog");
});

test("marketplace paths outside the personal root remain absolute", async (t) => {
  const home = await temporaryHome(t);
  const marketplacePath = path.join(
    home,
    ".agents",
    "plugins",
    "marketplace.json",
  );
  const installRoot = path.resolve(home, "..", "outside", "sanityblog");

  assert.equal(
    marketplaceSourcePath({ marketplacePath, installRoot }),
    installRoot.split(path.sep).join("/"),
  );
});

test("Windows installer pins downloads and never accepts a credential argument", async () => {
  const installerPath = fileURLToPath(new URL("../install.ps1", import.meta.url));
  const installer = await readFile(installerPath, "utf8");

  assert.match(installer, /\$NodeVersion = "22\.23\.1"/u);
  assert.match(
    installer,
    /github\.com\/1nv0ker\/dashboard\/archive\/refs\/heads\/main\.zip/u,
  );
  assert.match(installer, /nodejs\.org\/download\/release/u);
  assert.match(
    installer,
    /7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29/u,
  );
  assert.match(
    installer,
    /b470fdfe3502c05151656e06d495e3f47544f2ee8b1d9c8705090f2dd5996bd0/u,
  );
  assert.match(
    installer,
    /& \$nodeExecutable \$npmCli ci --omit=dev --ignore-scripts/u,
  );
  assert.match(installer, /\[string\]\$SourcePath/u);
  assert.match(installer, /\[string\]\$InstallRoot/u);
  assert.match(installer, /\[switch\]\$SkipCodexRegistration/u);
  assert.match(installer, /function Assert-ExistingSanityBlogDirectory/u);
  assert.match(installer, /Refusing to replace a non-sanityblog directory/u);
  assert.match(installer, /Assert-NoReparseAncestors/u);
  assert.match(installer, /Remove-Item Env:SANITY_BLOG_TOKEN/u);
  assert.match(installer, /\$rollbackPermitted = \$false/u);
  assert.match(installer, /personal marketplace.*registration failed/isu);
  assert.match(installer, /function Test-SanityBlogConfiguration/u);
  assert.match(installer, /& \$NodePath \$CliPath --check/u);
  assert.match(
    installer,
    /Test-SanityBlogConfiguration -NodePath \$installedNode -CliPath \$installedCli/u,
  );
  assert.doesNotMatch(installer, /& \$installedNode \$installedCli --check/u);
  assert.match(installer, /& \$installedNode \$installedCli --init/u);
  assert.match(installer, /Get-Command codex/u);
  assert.match(installer, /plugin add \$pluginSelector --json/u);
  assert.doesNotMatch(installer, /plugin marketplace add/iu);
  assert.doesNotMatch(installer, /\bgit\s+(?:clone|pull)\b/iu);
  assert.doesNotMatch(installer, /--(?:sanity-)?token\b/iu);
  assert.doesNotMatch(installer, /\[string\]\s*\$(?:sanity)?token\b/iu);
});

test(
  "Windows installer parses without PowerShell syntax errors",
  { skip: process.platform !== "win32" },
  async () => {
    const installerPath = fileURLToPath(
      new URL("../install.ps1", import.meta.url),
    );
    const command = [
      "$tokens=$null;",
      "$errors=$null;",
      "[System.Management.Automation.Language.Parser]::ParseFile(",
      "$env:SANITYBLOG_INSTALLER_PARSE_PATH,",
      "[ref]$tokens,",
      "[ref]$errors",
      ") | Out-Null;",
      "if ($errors.Count -ne 0) {",
      "$errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) };",
      "exit 1",
      "}",
    ].join(" ");
    const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SANITYBLOG_INSTALLER_PARSE_PATH: installerPath,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
  },
);
