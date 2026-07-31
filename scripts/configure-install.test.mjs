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

const EXPECTED_SKILLS = [
  "sanity-blog-preview",
  "sanity-blog-publish",
  "sanity-blog-update",
  "sanity-content-alternative-preview",
  "sanity-content-alternative-publish",
  "sanity-content-alternative-update",
  "sanity-content-blog-en-preview",
  "sanity-content-blog-en-publish",
  "sanity-content-blog-en-update",
  "sanity-content-comparison-preview",
  "sanity-content-comparison-publish",
  "sanity-content-comparison-update",
  "sanity-content-guide-preview",
  "sanity-content-guide-publish",
  "sanity-content-guide-update",
  "sanity-content-solution-preview",
  "sanity-content-solution-publish",
  "sanity-content-solution-update",
  "sanity-content-tutorial-preview",
  "sanity-content-tutorial-publish",
  "sanity-content-tutorial-update",
];
const FORBIDDEN_GENERIC_SKILLS = [
  "sanity-content-preview",
  "sanity-content-publish",
  "sanity-content-update",
];

async function temporaryHome(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sanityblog-install-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function sourceTreeFixture(t) {
  const root = path.join(await temporaryHome(t), "source");
  for (const relativePath of [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "package.json",
    "package-lock.json",
    "src/server.mjs",
    "src/cli.mjs",
    "dist/cli.mjs",
    "dist/server.mjs",
    "scripts/configure-install.mjs",
  ]) {
    const target = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "{}\n", "utf8");
  }
  for (const skill of EXPECTED_SKILLS) {
    for (const relativePath of ["SKILL.md", "agents/openai.yaml"]) {
      const target = path.join(root, "skills", skill, ...relativePath.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "fixture\n", "utf8");
    }
  }
  return root;
}

function assertSourceTree(sourceRoot) {
  const installerPath = fileURLToPath(new URL("../install.ps1", import.meta.url));
  const command = [
    "$tokens=$null;",
    "$errors=$null;",
    "$ast=[System.Management.Automation.Language.Parser]::ParseFile(",
    "$env:SANITYBLOG_INSTALLER_PARSE_PATH,",
    "[ref]$tokens,",
    "[ref]$errors",
    ");",
    "if ($errors.Count -ne 0) { exit 3 };",
    "$functionAst=$ast.Find({",
    "param($node)",
    "$node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and",
    '$node.Name -ceq "Assert-SourceTree"',
    "}, $true);",
    "if ($null -eq $functionAst) { exit 4 };",
    "$ExpectedSkillDirectories=@(",
    "$env:SANITYBLOG_EXPECTED_SKILLS -split ';'",
    ");",
    "$ForbiddenGenericSkillDirectories=@(",
    "$env:SANITYBLOG_FORBIDDEN_SKILLS -split ';'",
    ");",
    "Invoke-Expression $functionAst.Extent.Text;",
    "try {",
    "Assert-SourceTree -Path $env:SANITYBLOG_SOURCE_TREE;",
    '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }',
  ].join(" ");
  const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SANITYBLOG_INSTALLER_PARSE_PATH: installerPath,
        SANITYBLOG_SOURCE_TREE: sourceRoot,
        SANITYBLOG_EXPECTED_SKILLS: EXPECTED_SKILLS.join(";"),
        SANITYBLOG_FORBIDDEN_SKILLS: FORBIDDEN_GENERIC_SKILLS.join(";"),
      },
    },
  );
}

test("generated MCP configurations always use the portable runtime", async (t) => {
  const home = await temporaryHome(t);
  const pluginRoot = path.join(home, "stage");
  const installRoot = path.join(home, "plugins", "sanityblog");
  const manifestDirectory = path.join(pluginRoot, ".codex-plugin");
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(
    path.join(manifestDirectory, "plugin.json"),
    JSON.stringify({
      name: "sanityblog",
      version: "0.1.0",
      skills: "./skills/",
      mcpServers: "./legacy.mcp.json",
    }),
    "utf8",
  );

  await writeMcpConfigurations({ pluginRoot, installRoot });

  const manifest = JSON.parse(
    await readFile(path.join(manifestDirectory, "plugin.json"), "utf8"),
  );
  assert.deepEqual(manifest.mcpServers, {
    sanityblog: {
      command: path.join(installRoot, "runtime", "node.exe"),
      args: [path.join(installRoot, "dist", "server.mjs")],
    },
  });
  assert.equal(manifest.skills, "./skills/");

  const compatible = JSON.parse(
    await readFile(path.join(pluginRoot, ".mcp.json"), "utf8"),
  );
  assert.deepEqual(compatible, {
    mcpServers: {
      sanityblog: {
        command: "${CLAUDE_PLUGIN_ROOT}/runtime/node.exe",
        args: ["${CLAUDE_PLUGIN_ROOT}/dist/server.mjs"],
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

test(
  "source tree requires exactly 21 type-specific skills and both manifests",
  { skip: process.platform !== "win32" },
  async (t) => {
    const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
    let result = assertSourceTree(pluginRoot);
    assert.equal(result.status, 0, result.stderr);

    const sourceRoot = await sourceTreeFixture(t);
    result = assertSourceTree(sourceRoot);
    assert.equal(result.status, 0, result.stderr);

    const generic = path.join(
      sourceRoot,
      "skills",
      FORBIDDEN_GENERIC_SKILLS[0],
    );
    await mkdir(generic);
    result = assertSourceTree(sourceRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /forbidden generic skill directory/u);
    await rm(generic, { recursive: true });

    const extra = path.join(sourceRoot, "skills", "unexpected-skill");
    await mkdir(extra);
    result = assertSourceTree(sourceRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /exactly 21 skill directories/u);
    await rm(extra, { recursive: true });

    const agent = path.join(
      sourceRoot,
      "skills",
      EXPECTED_SKILLS[0],
      "agents",
      "openai.yaml",
    );
    await rm(agent);
    result = assertSourceTree(sourceRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /missing required skill file/u);
    await writeFile(agent, "fixture\n", "utf8");

    const claudeManifest = path.join(
      sourceRoot,
      ".claude-plugin",
      "plugin.json",
    );
    await rm(claudeManifest);
    result = assertSourceTree(sourceRoot);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /missing required file/u);
  },
);

test("Windows installer pins downloads and never accepts a credential argument", async () => {
  const installerPath = fileURLToPath(new URL("../install.ps1", import.meta.url));
  const installer = await readFile(installerPath, "utf8");
  const expectedBlock = installer.match(
    /\$ExpectedSkillDirectories = @\((?<body>[\s\S]*?)\r?\n\)/u,
  );
  assert.ok(expectedBlock?.groups?.body);
  assert.deepEqual(
    [...expectedBlock.groups.body.matchAll(/"([^"]+)"/gu)].map(
      ([, skill]) => skill,
    ),
    EXPECTED_SKILLS,
  );

  assert.match(installer, /\$NodeVersion = "22\.23\.1"/u);
  assert.match(
    installer,
    /github\.com\/1nv0ker\/blog\/archive\/refs\/heads\/main\.zip/u,
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
  assert.match(installer, /"\.claude-plugin\\plugin\.json"/u);
  assert.match(installer, /"\.codex-plugin\\plugin\.json"/u);
  assert.match(installer, /Source is missing required directory: skills/u);
  assert.match(installer, /Source contains forbidden generic skill directory/u);
  assert.match(
    installer,
    /Source must contain exactly \$\(\$expectedSkills\.Count\) skill directories/u,
  );
  assert.match(installer, /@\(?"SKILL\.md", "agents\\openai\.yaml"\)?/u);
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
