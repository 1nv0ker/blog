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

import {
  DEFAULT_PUBLISHER_API_ORIGIN,
  DEFAULT_SANITY_API_VERSION,
} from "./constants.mjs";
import { SafeError } from "./errors.mjs";

export const CONFIG_DIRECTORY_NAME = ".sanity-blog";
export const CONFIG_FILE_NAME = "config.json";
export const CONFIG_MAX_BYTES = 64 * 1024;
export const LEGACY_DEFAULT_WORKSPACE_ROOT = "C:\\work\\MIYA-LLC-WEB\\miyaip2026";

export function getDefaultWorkspaceRoot(homeDir = os.homedir()) {
  return path.join(homeDir, CONFIG_DIRECTORY_NAME, "workspace");
}

export const DEFAULT_WORKSPACE_ROOT = getDefaultWorkspaceRoot();

const ALLOWED_CONFIG_KEYS = new Set([
  "publisherApiOrigin",
  "projectId",
  "dataset",
  "apiVersion",
  "sanityToken",
  "workspaceRoot",
]);
const LEGACY_MANAGED_FIELDS = ["publisherApiOrigin", "apiVersion", "workspaceRoot"];
const execFileAsync = promisify(execFile);
const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$targetPath = $env:SANITY_BLOG_ACL_TARGET
$kind = $env:SANITY_BLOG_ACL_KIND
if ([string]::IsNullOrWhiteSpace($targetPath)) {
  throw "The ACL target path is missing."
}
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($null -eq $currentSid) {
  throw "The current Windows SID is unavailable."
}
if ($kind -eq "directory") {
  $item = [System.IO.DirectoryInfo]::new($targetPath)
  $ownerSecurity = $item.GetAccessControl(
    [System.Security.AccessControl.AccessControlSections]::Owner
  )
  $security = $item.GetAccessControl(
    [System.Security.AccessControl.AccessControlSections]::Access
  )
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $currentSid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
}
elseif ($kind -eq "file") {
  $item = [System.IO.FileInfo]::new($targetPath)
  $ownerSecurity = $item.GetAccessControl(
    [System.Security.AccessControl.AccessControlSections]::Owner
  )
  $security = $item.GetAccessControl(
    [System.Security.AccessControl.AccessControlSections]::Access
  )
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $currentSid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
}
else {
  throw "The ACL target kind is invalid."
}
$currentOwner = $ownerSecurity.GetOwner(
  [System.Security.Principal.SecurityIdentifier]
)
if ($currentOwner.Value -ne $currentSid.Value) {
  throw "The ACL target is not owned by the current Windows user."
}
$security.SetAccessRuleProtection($true, $false)
foreach ($existingRule in @($security.Access)) {
  [void]$security.RemoveAccessRuleSpecific($existingRule)
}
[void]$security.AddAccessRule($rule)
$item.SetAccessControl($security)
$verified = Get-Acl -LiteralPath $targetPath
$verifiedOwner = $verified.GetOwner([System.Security.Principal.SecurityIdentifier])
$rules = @($verified.Access)
if (-not $verified.AreAccessRulesProtected -or $verifiedOwner.Value -ne $currentSid.Value) {
  throw "The protected owner-only ACL was not applied."
}
if ($rules.Count -ne 1) {
  throw "The protected ACL contains unexpected access rules."
}
$verifiedRule = $rules[0]
$verifiedSid = $verifiedRule.IdentityReference.Translate(
  [System.Security.Principal.SecurityIdentifier]
)
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
if (
  $verifiedSid.Value -ne $currentSid.Value -or
  $verifiedRule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
  $verifiedRule.IsInherited -or
  (($verifiedRule.FileSystemRights -band $fullControl) -ne $fullControl)
) {
  throw "The protected ACL verification failed."
}
if ($kind -eq "directory") {
  $expectedInheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  if (($verifiedRule.InheritanceFlags -band $expectedInheritance) -ne $expectedInheritance) {
    throw "The protected directory ACL inheritance flags are invalid."
  }
}
elseif ($verifiedRule.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None) {
  throw "The protected file ACL inheritance flags are invalid."
}
`;
const WINDOWS_ACL_COMMAND = Buffer.from(WINDOWS_ACL_SCRIPT, "utf16le").toString("base64");
const WINDOWS_ACL_ENVIRONMENT_KEYS = new Set([
  "ALLUSERSPROFILE",
  "APPDATA",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PSMODULEPATH",
  "PUBLIC",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

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

function hasOwn(input, key) {
  return input !== null && typeof input === "object" && Object.hasOwn(input, key);
}

function usesManagedDefaults(input) {
  return !LEGACY_MANAGED_FIELDS.some((field) => hasOwn(input, field));
}

export function validateConfigObject(input, { homeDir = os.homedir() } = {}) {
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

  const projectId = requireTrimmedString(input.projectId, "projectId", 64);
  const dataset = requireTrimmedString(input.dataset, "dataset", 64);
  const sanityToken = requireTrimmedString(input.sanityToken, "sanityToken", 4096);

  if (!/^[a-z0-9][a-z0-9-]*$/u.test(projectId)) {
    throw configError("INVALID_CONFIG", "projectId contains unsupported characters.");
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(dataset)) {
    throw configError("INVALID_CONFIG", "dataset contains unsupported characters.");
  }

  let publisherApiOrigin = DEFAULT_PUBLISHER_API_ORIGIN;
  let apiVersion = DEFAULT_SANITY_API_VERSION;
  let workspaceRoot = getDefaultWorkspaceRoot(homeDir);

  if (!usesManagedDefaults(input)) {
    if (!hasOwn(input, "publisherApiOrigin") || !hasOwn(input, "apiVersion")) {
      throw configError(
        "LEGACY_CONFIG_REQUIRES_REINIT",
        "Legacy configuration is incomplete. Run the initializer again.",
      );
    }
    try {
      publisherApiOrigin = validateOrigin(input.publisherApiOrigin);
      apiVersion = validateApiVersion(input.apiVersion);
    } catch (error) {
      throw configError(
        "LEGACY_CONFIG_REQUIRES_REINIT",
        "Legacy configuration targets unsupported managed settings. Run the initializer again.",
        error,
      );
    }
    if (
      publisherApiOrigin !== DEFAULT_PUBLISHER_API_ORIGIN ||
      apiVersion !== DEFAULT_SANITY_API_VERSION
    ) {
      throw configError(
        "LEGACY_CONFIG_REQUIRES_REINIT",
        "Legacy configuration targets unsupported managed settings. Run the initializer again.",
      );
    }
    workspaceRoot = hasOwn(input, "workspaceRoot")
      ? validateWorkspaceRoot(input.workspaceRoot)
      : LEGACY_DEFAULT_WORKSPACE_ROOT;
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

function windowsAclEnvironment(targetPath, kind) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (WINDOWS_ACL_ENVIRONMENT_KEYS.has(key.toUpperCase()) && value !== undefined) {
      environment[key] = value;
    }
  }
  environment.SANITY_BLOG_ACL_TARGET = targetPath;
  environment.SANITY_BLOG_ACL_KIND = kind;
  return environment;
}

function getWindowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (
    typeof systemRoot !== "string" ||
    !path.win32.isAbsolute(systemRoot) ||
    /[\u0000-\u001f\u007f]/u.test(systemRoot)
  ) {
    throw new Error("The Windows system root is unavailable.");
  }
  return path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}
export async function defaultWindowsAcl(targetPath, { kind }) {
  await execFileAsync(
    getWindowsPowerShellPath(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", WINDOWS_ACL_COMMAND],
    {
      env: windowsAclEnvironment(targetPath, kind),
      windowsHide: true,
      timeout: 30_000,
    },
  );
}
function samePathIdentity(left, right) {
  return (
    left.dev === right.dev &&
    (left.ino === 0 || right.ino === 0 || left.ino === right.ino)
  );
}

function isExpectedPathKind(stats, kind) {
  return kind === "directory" ? stats.isDirectory() : stats.isFile();
}

export async function applyPrivatePermissions(
  targetPath,
  kind,
  { platform = process.platform, acl = defaultWindowsAcl } = {},
) {
  let beforeStats;
  try {
    beforeStats = await lstat(targetPath);
    if (beforeStats.isSymbolicLink() || !isExpectedPathKind(beforeStats, kind)) {
      throw new Error("The protected path has an unsafe type.");
    }

    if (platform === "win32") {
      if (typeof acl !== "function") {
        throw new Error("A Windows ACL helper is required.");
      }
      await acl(targetPath, { kind });
    } else {
      const expectedMode = kind === "directory" ? 0o700 : 0o600;
      await chmod(targetPath, expectedMode);
    }

    const afterStats = await lstat(targetPath);
    if (
      afterStats.isSymbolicLink() ||
      !isExpectedPathKind(afterStats, kind) ||
      !samePathIdentity(beforeStats, afterStats)
    ) {
      throw new Error("The protected path changed while permissions were applied.");
    }
    if (platform !== "win32" && (afterStats.mode & 0o077) !== 0) {
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
    if (!samePathIdentity(expectedStats, openedStats)) {
      throw configError("UNSAFE_CONFIG_PATH", "Configuration changed while it was being opened.");
    }
    if (openedStats.size > CONFIG_MAX_BYTES) {
      throw configError("CONFIG_TOO_LARGE", "Configuration exceeds the size limit.");
    }
    return await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    if (error instanceof SafeError) {
      throw error;
    }
    if (isMissing(error)) {
      throw configError(
        "UNSAFE_CONFIG_PATH",
        "Configuration changed while it was being opened.",
        error,
      );
    }
    throw configError("CONFIG_READ_FAILED", "Unable to read Sanity blog configuration.", error);
  } finally {
    await handle?.close().catch(() => {});
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

  const config = validateConfigObject(parsed, { homeDir });
  if (usesManagedDefaults(parsed)) {
    await assertManagedWorkspace(config.workspaceRoot, { platform, acl });
  } else {
    await assertWorkspaceDirectory(config.workspaceRoot);
  }
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
    throw configError("UNSAFE_CONFIG_PATH", "Protected local directories must be ordinary.");
  }
  await applyPrivatePermissions(directoryPath, "directory", permissions);
}

async function assertManagedWorkspace(workspaceRoot, permissions) {
  for (const directoryPath of [
    workspaceRoot,
    path.join(workspaceRoot, "blog"),
    path.join(workspaceRoot, "blog", "assets"),
  ]) {
    let stats;
    try {
      stats = await lstat(directoryPath);
    } catch (error) {
      throw configError(
        "INVALID_WORKSPACE_ROOT",
        "The managed workspace is incomplete or unavailable.",
        error,
      );
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw configError(
        "UNSAFE_CONFIG_PATH",
        "Managed workspace directories must be ordinary directories.",
      );
    }
    await applyPrivatePermissions(directoryPath, "directory", permissions);
  }
}
async function ensureManagedWorkspace(workspaceRoot, permissions) {
  await ensurePrivateDirectory(workspaceRoot, permissions);
  await ensurePrivateDirectory(path.join(workspaceRoot, "blog"), permissions);
  await ensurePrivateDirectory(path.join(workspaceRoot, "blog", "assets"), permissions);
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
  const managedConfiguration = usesManagedDefaults(input);
  const config = validateConfigObject(input, { homeDir });
  const { configDirectory, configPath } = getConfigPaths(homeDir);

  try {
    await mkdir(homeDir, { recursive: true });
    await ensurePrivateDirectory(configDirectory, { platform, acl });
    if (managedConfiguration) {
      await ensureManagedWorkspace(config.workspaceRoot, { platform, acl });
    } else {
      await assertWorkspaceDirectory(config.workspaceRoot);
    }

    const persisted = managedConfiguration
      ? {
          projectId: config.projectId,
          dataset: config.dataset,
          sanityToken: config.sanityToken,
        }
      : {
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
