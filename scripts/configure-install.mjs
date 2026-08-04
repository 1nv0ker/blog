#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_NAME = "sanityblog";
const RUNTIME_PLATFORMS = Object.freeze({
  windows: Object.freeze({
    installedSegments: Object.freeze(["runtime", "node.exe"]),
    portablePath: "runtime/node.exe",
  }),
  macos: Object.freeze({
    installedSegments: Object.freeze(["runtime", "bin", "node"]),
    portablePath: "runtime/bin/node",
  }),
});
const RESERVED_PLUGIN_FIELDS = new Set([
  "name",
  "source",
  "policy",
  "category",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function assertSafeDestination(filePath) {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Refusing to replace a non-regular file: ${filePath}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function writeUtf8Atomic(filePath, contents) {
  const absolutePath = path.resolve(filePath);
  const directory = path.dirname(absolutePath);
  await mkdir(directory, { recursive: true });
  await assertSafeDestination(absolutePath);

  const temporaryPath = path.join(
    directory,
    `.${path.basename(absolutePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, absolutePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    (left.ino === 0 || right.ino === 0 || left.ino === right.ino) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

async function acquireMarketplaceLock(
  marketplacePath,
  { attempts = 200, retryDelayMs = 50, staleAfterMs = 5 * 60_000 } = {},
) {
  const lockPath = `${path.resolve(marketplacePath)}.sanityblog.lock`;
  await mkdir(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(
        stringifyJson({ pid: process.pid, createdAt: new Date().toISOString(), nonce: randomUUID() }),
        "utf8",
      );
      await handle.sync();
      return async () => {
        await handle.close();
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== "EEXIST") {
        throw error;
      }

      try {
        const firstStats = await lstat(lockPath);
        if (firstStats.isSymbolicLink() || !firstStats.isFile()) {
          throw new Error(`Marketplace lock is not a regular file: ${lockPath}`);
        }
        if (Date.now() - firstStats.mtimeMs > staleAfterMs) {
          await readFile(lockPath, "utf8");
          const secondStats = await lstat(lockPath);
          if (sameFileIdentity(firstStats, secondStats)) {
            await rm(lockPath);
            continue;
          }
        }
      } catch (inspectionError) {
        if (inspectionError?.code === "ENOENT") {
          continue;
        }
        throw inspectionError;
      }
      await delay(retryDelayMs);
    }
  }
  throw new Error("Timed out waiting for the personal marketplace lock.");
}
function stringifyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeCodexManifestMcp({ pluginRoot, mcpServers }) {
  const manifestPath = path.join(
    path.resolve(pluginRoot),
    ".codex-plugin",
    "plugin.json",
  );
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Codex plugin manifest is invalid: ${error.message}`);
  }
  if (!isPlainObject(manifest) || manifest.name !== PLUGIN_NAME) {
    throw new Error("Codex plugin manifest does not belong to sanityblog.");
  }
  manifest.mcpServers = mcpServers;
  await writeUtf8Atomic(manifestPath, stringifyJson(manifest));
  return manifestPath;
}

export async function writeMcpConfigurations({
  pluginRoot,
  installRoot,
  runtimePlatform = "windows",
}) {
  const absolutePluginRoot = path.resolve(pluginRoot);
  const absoluteInstallRoot = path.resolve(installRoot);
  const runtime = RUNTIME_PLATFORMS[runtimePlatform];
  if (!runtime) {
    throw new Error(
      `Unsupported runtime platform: ${String(runtimePlatform)}.`,
    );
  }
  const codexServers = {
    [PLUGIN_NAME]: {
      command: path.join(absoluteInstallRoot, ...runtime.installedSegments),
      args: [path.join(absoluteInstallRoot, "dist", "server.mjs")],
    },
  };
  const portableRoot = "${CLAUDE_PLUGIN_ROOT}";
  const compatibleConfiguration = {
    mcpServers: {
      [PLUGIN_NAME]: {
        command: `${portableRoot}/${runtime.portablePath}`,
        args: [`${portableRoot}/dist/server.mjs`],
      },
    },
  };

  const codexManifestPath = await writeCodexManifestMcp({
    pluginRoot: absolutePluginRoot,
    mcpServers: codexServers,
  });
  await writeUtf8Atomic(
    path.join(absolutePluginRoot, ".mcp.json"),
    stringifyJson(compatibleConfiguration),
  );

  return {
    codexManifestPath,
    compatibleMcpPath: path.join(absolutePluginRoot, ".mcp.json"),
  };
}

function marketplaceRootFor(marketplacePath) {
  return path.dirname(path.dirname(path.dirname(path.resolve(marketplacePath))));
}

function toPortablePath(value) {
  return value.split(path.sep).join("/");
}

export function marketplaceSourcePath({ installRoot, marketplacePath }) {
  const absoluteInstallRoot = path.resolve(installRoot);
  const marketplaceRoot = marketplaceRootFor(marketplacePath);
  const relativePath = path.relative(marketplaceRoot, absoluteInstallRoot);
  const isInsideMarketplace =
    relativePath === "" ||
    (!path.isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`));

  if (isInsideMarketplace) {
    return relativePath === "" ? "./" : `./${toPortablePath(relativePath)}`;
  }
  return toPortablePath(absoluteInstallRoot);
}

async function readMarketplace(marketplacePath) {
  await assertSafeDestination(marketplacePath);
  try {
    const raw = await readFile(marketplacePath, "utf8");
    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Marketplace JSON is invalid: ${error.message}`);
    }
    return { raw, value };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        raw: undefined,
        value: {
          name: "personal",
          interface: {
            displayName: "Personal",
          },
          plugins: [],
        },
      };
    }
    throw error;
  }
}

function validateMarketplace(value) {
  if (!isPlainObject(value)) {
    throw new Error("Marketplace JSON must contain an object.");
  }
  if (value.name !== undefined) {
    if (
      typeof value.name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.name)
    ) {
      throw new Error("Marketplace name is invalid.");
    }
  }
  if (value.interface !== undefined && !isPlainObject(value.interface)) {
    throw new Error("Marketplace interface must be an object.");
  }
  if (value.plugins !== undefined && !Array.isArray(value.plugins)) {
    throw new Error("Marketplace plugins must be an array.");
  }
}

function createPluginEntry(existingEntry, sourcePath) {
  const entry = {
    name: PLUGIN_NAME,
    source: {
      source: "local",
      path: sourcePath,
    },
    policy: {
      installation: "INSTALLED_BY_DEFAULT",
      authentication: "ON_INSTALL",
    },
    category:
      typeof existingEntry?.category === "string"
        ? existingEntry.category
        : "Productivity",
  };
  if (isPlainObject(existingEntry)) {
    for (const [key, value] of Object.entries(existingEntry)) {
      if (!RESERVED_PLUGIN_FIELDS.has(key)) {
        entry[key] = value;
      }
    }
  }
  return entry;
}

export async function mergeMarketplace({ marketplacePath, installRoot }) {
  const absoluteMarketplacePath = path.resolve(marketplacePath);
  const releaseLock = await acquireMarketplaceLock(absoluteMarketplacePath);
  try {
    const { raw, value } = await readMarketplace(absoluteMarketplacePath);
    validateMarketplace(value);

    const marketplace = {
      ...value,
      name: value.name ?? "personal",
      interface: value.interface ?? { displayName: "Personal" },
    };
    const existingPlugins = value.plugins ?? [];
    const sourcePath = marketplaceSourcePath({
      installRoot,
      marketplacePath: absoluteMarketplacePath,
    });
    const mergedPlugins = [];
    let inserted = false;
    for (const entry of existingPlugins) {
      if (isPlainObject(entry) && entry.name === PLUGIN_NAME) {
        if (!inserted) {
          mergedPlugins.push(createPluginEntry(entry, sourcePath));
          inserted = true;
        }
        continue;
      }
      mergedPlugins.push(entry);
    }
    if (!inserted) {
      mergedPlugins.push(createPluginEntry(undefined, sourcePath));
    }
    marketplace.plugins = mergedPlugins;

    const serialized = stringifyJson(marketplace);
    const changed = raw !== serialized;
    if (changed) {
      await writeUtf8Atomic(absoluteMarketplacePath, serialized);
    }
    return {
      marketplaceName: marketplace.name,
      sourcePath,
      changed,
    };
  } finally {
    await releaseLock();
  }
}
function parseOptions(args) {
  if (args.length === 0) {
    throw new Error(
      "Use write-mcp or merge-marketplace with the required path options.",
    );
  }
  const command = args[0];
  const options = {};
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}.`);
    }
    const optionName = key.slice(2);
    if (optionName in options) {
      throw new Error(`Duplicate option: ${key}`);
    }
    options[optionName] = value;
  }
  return { command, options };
}

function requireOptions(options, requiredNames, optionalNames = []) {
  const expected = new Set([...requiredNames, ...optionalNames]);
  for (const name of Object.keys(options)) {
    if (!expected.has(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
  }
  for (const name of requiredNames) {
    if (!options[name]) {
      throw new Error(`Missing option: --${name}`);
    }
  }
}

async function main() {
  const { command, options } = parseOptions(process.argv.slice(2));
  let result;
  if (command === "write-mcp") {
    requireOptions(
      options,
      ["plugin-root", "install-root"],
      ["runtime-platform"],
    );
    result = await writeMcpConfigurations({
      pluginRoot: options["plugin-root"],
      installRoot: options["install-root"],
      runtimePlatform: options["runtime-platform"] ?? "windows",
    });
  } else if (command === "merge-marketplace") {
    requireOptions(options, ["marketplace", "install-root"]);
    result = await mergeMarketplace({
      marketplacePath: options.marketplace,
      installRoot: options["install-root"],
    });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`configure-install failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
