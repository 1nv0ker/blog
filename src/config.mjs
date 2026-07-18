import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { SafeError } from "./errors.mjs";

export const DEFAULT_WORKSPACE_ROOT = "C:\\work\\MIYA-LLC-WEB\\miyaip2026";
export const CONFIG_DIRECTORY_NAME = ".sanity-blog";
export const CONFIG_FILE_NAME = "config.json";
export const CONFIG_MAX_BYTES = 64 * 1024;

const ALLOWED_CONFIG_KEYS = new Set([
  "publisherApiOrigin",
  "projectId",
  "dataset",
  "apiVersion",
  "sanityToken",
  "workspaceRoot",
]);
const execFileAsync = promisify(execFile);

function configError(code, safeMessage, cause) {
  return new SafeError({
    category: "configuration",
    code,
    retryable: false,
    resultUnknown: false,
    safeMessage,
    cause,
  });
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

function requireTrimmedString(value, field, maximumLength = 512) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw configError("INVALID_CONFIG", `Configuration field ${field} is invalid.`);
  }
  return value;
}

function validateOrigin(value) {
  const origin = requireTrimmedString(value, "publisherApiOrigin", 2048);
  let parsed;
  try {
    parsed = new URL(origin);
  } catch (error) {
    throw configError("INVALID_CONFIG", "publisherApiOrigin must be a bare HTTPS origin.", error);
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== origin
  ) {
    throw configError("INVALID_CONFIG", "publisherApiOrigin must be a bare HTTPS origin.");
  }

  return origin;
}

function validateApiVersion(value) {
  const apiVersion = requireTrimmedString(value, "apiVersion", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(apiVersion)) {
    throw configError("INVALID_CONFIG", "apiVersion must use YYYY-MM-DD.");
  }

  const parsed = new Date(`${apiVersion}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== apiVersion) {
    throw configError("INVALID_CONFIG", "apiVersion is not a valid calendar date.");
  }
  return apiVersion;
}

function validateWorkspaceRoot(value) {
  const workspaceRoot = requireTrimmedString(value, "workspaceRoot", 4096);
  if (!path.win32.isAbsolute(workspaceRoot) && !path.posix.isAbsolute(workspaceRoot)) {
    throw configError("INVALID_CONFIG", "workspaceRoot must be an absolute path.");
  }
  return path.normalize(workspaceRoot);
}

export function validateConfigObject(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw configError("INVALID_CONFIG", "Configuration must be a JSON object.");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw configError("INVALID_CONFIG", "Configuration must be a plain JSON object.");
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      throw configError("INVALID_CONFIG", "Configuration contains an unknown field.");
    }
  }

  const publisherApiOrigin = validateOrigin(input.publisherApiOrigin);
  const projectId = requireTrimmedString(input.projectId, "projectId", 64);
  const dataset = requireTrimmedString(input.dataset, "dataset", 64);
  const apiVersion = validateApiVersion(input.apiVersion);
  const sanityToken = requireTrimmedString(input.sanityToken, "sanityToken", 4096);
  const workspaceRoot = validateWorkspaceRoot(input.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT);

  if (!/^[a-z0-9][a-z0-9-]*$/u.test(projectId)) {
    throw configError("INVALID_CONFIG", "projectId contains unsupported characters.");
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(dataset)) {
    throw configError("INVALID_CONFIG", "dataset contains unsupported characters.");
  }

  const config = {
    publisherApiOrigin,
    projectId,
    dataset,
    apiVersion,
    workspaceRoot,
  };
  Object.defineProperty(config, "sanityToken", {
    configurable: false,
    enumerable: false,
    value: sanityToken,
    writable: false,
  });
  return Object.freeze(config);
}

export function getConfigPaths(homeDir = os.homedir()) {
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) {
    throw configError("INVALID_HOME_DIRECTORY", "The home directory must be an absolute path.");
  }
  const configDirectory = path.join(homeDir, CONFIG_DIRECTORY_NAME);
  return {
    homeDir,
    configDirectory,
    configPath: path.join(configDirectory, CONFIG_FILE_NAME),
    publishedDirectory: path.join(configDirectory, "published"),
  };
}

export async function defaultWindowsAcl(targetPath, { kind }) {
  const userName = process.env.USERNAME;
  if (!userName) {
    throw new Error("Windows user identity is unavailable.");
  }

  const grant = kind === "directory" ? `${userName}:(OI)(CI)F` : `${userName}:F`;
  await execFileAsync(
    "icacls.exe",
    [targetPath, "/inheritance:r", "/grant:r", grant],
    { windowsHide: true, timeout: 15_000 },
  );
}

export async function applyPrivatePermissions(
  targetPath,
  kind,
  { platform = process.platform, acl = defaultWindowsAcl } = {},
) {
  if (platform === "win32") {
    if (typeof acl !== "function") {
      throw configError("UNSAFE_PERMISSIONS", "A Windows ACL helper is required.");
    }
    try {
      await acl(targetPath, { kind });
    } catch (error) {
      throw configError("UNSAFE_PERMISSIONS", "Unable to restrict access to the current user.", error);
    }
    return;
  }

  const expectedMode = kind === "directory" ? 0o700 : 0o600;
  try {
    await chmod(targetPath, expectedMode);
    const stats = await lstat(targetPath);
    if ((stats.mode & 0o077) !== 0) {
      throw new Error("Permissions remain accessible to other users.");
    }
  } catch (error) {
    throw configError("UNSAFE_PERMISSIONS", "Unable to restrict access to the current user.", error);
  }
}

export async function assertOrdinaryPath(targetPath, kind, code = "UNSAFE_CONFIG_PATH") {
  let stats;
  try {
    stats = await lstat(targetPath);
  } catch (error) {
    if (isMissing(error)) {
      throw configError("CONFIG_NOT_FOUND", "Sanity blog configuration was not found.", error);
    }
    throw configError(code, "Unable to inspect a protected local path.", error);
  }

  const valid = kind === "directory" ? stats.isDirectory() : stats.isFile();
  if (stats.isSymbolicLink() || !valid) {
    throw configError(code, "A protected local path is not an ordinary file or directory.");
  }
  return stats;
}

async function assertWorkspaceDirectory(workspaceRoot) {
  let stats;
  try {
    stats = await lstat(workspaceRoot);
  } catch (error) {
    throw configError("INVALID_WORKSPACE_ROOT", "The configured workspaceRoot is unavailable.", error);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw configError(
      "INVALID_WORKSPACE_ROOT",
      "The configured workspaceRoot must be an ordinary directory.",
    );
  }
}

async function readConfigFile(configPath, expectedStats) {
  let handle;
  try {
    handle = await open(configPath, fsConstants.O_RDONLY);
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) {
      throw configError("UNSAFE_CONFIG_PATH", "Configuration must be an ordinary file.");
    }
    if (
      expectedStats.dev !== openedStats.dev ||
      (expectedStats.ino !== 0 && openedStats.ino !== 0 && expectedStats.ino !== openedStats.ino)
    ) {
      throw configError("UNSAFE_CONFIG_PATH", "Configuration changed while it was being opened.");
    }
    if (openedStats.size > CONFIG_MAX_BYTES) {
      throw configError("CONFIG_TOO_LARGE", "Configuration exceeds the size limit.");
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle?.close();
  }
}

export async function loadConfig({
  homeDir = os.homedir(),
  platform = process.platform,
  acl = defaultWindowsAcl,
} = {}) {
  const { configDirectory, configPath } = getConfigPaths(homeDir);
  const directoryStats = await assertOrdinaryPath(configDirectory, "directory");
  if (directoryStats.isSymbolicLink()) {
    throw configError("UNSAFE_CONFIG_PATH", "Configuration directory cannot be a symbolic link.");
  }
  await applyPrivatePermissions(configDirectory, "directory", { platform, acl });

  const fileStats = await assertOrdinaryPath(configPath, "file");
  if (fileStats.size > CONFIG_MAX_BYTES) {
    throw configError("CONFIG_TOO_LARGE", "Configuration exceeds the size limit.");
  }
  await applyPrivatePermissions(configPath, "file", { platform, acl });

  const source = await readConfigFile(configPath, fileStats);
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw configError("INVALID_CONFIG", "Configuration is not valid JSON.", error);
  }

  const config = validateConfigObject(parsed);
  await assertWorkspaceDirectory(config.workspaceRoot);
  return config;
}

export async function checkConfig(options = {}) {
  const config = await loadConfig(options);
  const { configPath } = getConfigPaths(options.homeDir ?? os.homedir());
  return {
    configured: true,
    target: {
      projectId: config.projectId,
      dataset: config.dataset,
      apiVersion: config.apiVersion,
    },
    workspaceRoot: config.workspaceRoot,
    configPath,
  };
}

async function ensurePrivateDirectory(directoryPath, permissions) {
  try {
    await mkdir(directoryPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
  const stats = await lstat(directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw configError("UNSAFE_CONFIG_PATH", "Configuration directory must be ordinary.");
  }
  await applyPrivatePermissions(directoryPath, "directory", permissions);
}

async function atomicWriteConfig(configPath, source, permissions) {
  const directory = path.dirname(configPath);
  const temporaryPath = path.join(
    directory,
    `.config.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    await handle.writeFile(source, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await applyPrivatePermissions(temporaryPath, "file", permissions);

    try {
      const targetStats = await lstat(configPath);
      if (targetStats.isSymbolicLink() || !targetStats.isFile()) {
        throw configError("UNSAFE_CONFIG_PATH", "Configuration target must be an ordinary file.");
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }

    await rename(temporaryPath, configPath);
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function initializeConfig(
  input,
  {
    homeDir = os.homedir(),
    platform = process.platform,
    acl = defaultWindowsAcl,
  } = {},
) {
  const config = validateConfigObject(input);
  await assertWorkspaceDirectory(config.workspaceRoot);
  const { configDirectory, configPath } = getConfigPaths(homeDir);

  try {
    await mkdir(homeDir, { recursive: true });
    await ensurePrivateDirectory(configDirectory, { platform, acl });
    const persisted = {
      publisherApiOrigin: config.publisherApiOrigin,
      projectId: config.projectId,
      dataset: config.dataset,
      apiVersion: config.apiVersion,
      sanityToken: config.sanityToken,
      workspaceRoot: config.workspaceRoot,
    };
    const source = `${JSON.stringify(persisted, null, 2)}\n`;
    if (Buffer.byteLength(source) > CONFIG_MAX_BYTES) {
      throw configError("CONFIG_TOO_LARGE", "Configuration exceeds the size limit.");
    }
    await atomicWriteConfig(configPath, source, { platform, acl });
    return await checkConfig({ homeDir, platform, acl });
  } catch (error) {
    if (error instanceof SafeError) {
      throw error;
    }
    throw configError("CONFIG_WRITE_FAILED", "Unable to initialize configuration.", error);
  }
}
