import {execFile} from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {
  DEFAULT_PUBLIC_SITE_ORIGIN,
  DEFAULT_PUBLISHER_API_ORIGIN,
} from './constants.mjs'

export const CONFIGURATION_FIELDS = Object.freeze([
  'publisherApiOrigin',
  'projectId',
  'dataset',
  'sanityToken',
])

export const REQUIRED_CONFIGURATION_FIELDS = Object.freeze([
  'projectId',
  'sanityToken',
])

export const CONTENT_CONFIGURATION_FIELDS = Object.freeze([
  ...CONFIGURATION_FIELDS,
  'publicSiteOrigin',
])

const REINITIALIZABLE_CONFIGURATION_CODES = new Set([
  'CONFIG_NOT_FOUND',
  'INVALID_CONFIG',
  'LEGACY_CONFIG_REQUIRES_REINIT',
])

const WINDOWS_SETUP_ENVIRONMENT_KEYS = new Set([
  'ALLUSERSPROFILE',
  'APPDATA',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PUBLIC',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERDOMAIN',
  'USERNAME',
  'WINDIR',
])

const INNER_SETUP_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$setupExitCode = 1
$closeWithoutPause = $false
try {
  $Host.UI.RawUI.WindowTitle = "Sanity Blog Setup"
}
catch {
}
try {
  Write-Host "Sanity Blog configuration setup"
  $setupArgument = "--init"
  if ($env:SANITY_BLOG_SETUP_MODE -eq "content") {
    $setupArgument = "--init-content"
    Write-Host "Enter five values. Press Enter to accept displayed defaults; token input is hidden."
  }
  else {
    Write-Host "Enter four values. Press Enter to accept displayed defaults; token input is hidden."
  }
  while ($true) {
    Write-Host ""
    & $env:SANITY_BLOG_SETUP_NODE $env:SANITY_BLOG_SETUP_CLI $setupArgument
    $setupExitCode = $LASTEXITCODE
    Write-Host ""
    if ($setupExitCode -eq 0) {
      Write-Host "Configuration saved. Return to the MCP client and retry the operation." -ForegroundColor Green
      break
    }
    Write-Host "Configuration was not saved. Review the safe error above." -ForegroundColor Red
    $retryChoice = Read-Host "Press Enter to retry, or type Q to close"
    if ($retryChoice -match "^[Qq]$") {
      $closeWithoutPause = $true
      break
    }
  }
}
catch {
  Write-Host ""
  Write-Host "Configuration setup could not be completed." -ForegroundColor Red
}
if (-not $closeWithoutPause) {
  [void](Read-Host "Press Enter to close")
}
exit $setupExitCode
`

const OUTER_LAUNCH_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$setupArguments = @(
  "-NoLogo",
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
  $env:SANITY_BLOG_SETUP_COMMAND
)
Start-Process -FilePath $env:SANITY_BLOG_SETUP_POWERSHELL -WorkingDirectory $env:SANITY_BLOG_SETUP_CWD -ArgumentList $setupArguments -WindowStyle Normal
`

const INNER_SETUP_COMMAND = Buffer.from(INNER_SETUP_SCRIPT, 'utf16le').toString('base64')
const OUTER_LAUNCH_COMMAND = Buffer.from(OUTER_LAUNCH_SCRIPT, 'utf16le').toString('base64')

function defaultCliPath() {
  return fileURLToPath(new URL('../dist/cli.mjs', import.meta.url))
}

function cleanEnvironment(environment, homeDir) {
  const cleaned = {}
  for (const [key, value] of Object.entries(environment ?? {})) {
    const normalized = key.toUpperCase()
    if (WINDOWS_SETUP_ENVIRONMENT_KEYS.has(normalized) && value !== undefined) {
      cleaned[key] = value
    }
  }
  cleaned.HOME = homeDir
  cleaned.USERPROFILE = homeDir
  return cleaned
}

function environmentValue(environment, expectedKey) {
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (key.toUpperCase() === expectedKey && value !== undefined) return value
  }
  return undefined
}

function windowsPowerShellPath(environment) {
  const systemRoot = environmentValue(environment, 'SYSTEMROOT') ?? environmentValue(environment, 'WINDIR')
  if (
    typeof systemRoot !== 'string' ||
    !path.win32.isAbsolute(systemRoot) ||
    /[\u0000-\u001f\u007f]/u.test(systemRoot)
  ) {
    return undefined
  }
  return path.win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
}

function manualCommand(execPath, cliPath, setupMode) {
  return {
    command: execPath,
    args: [cliPath, setupMode === 'content' ? '--init-content' : '--init'],
  }
}

export function isReinitializableConfigurationError(error) {
  return (
    error?.category === 'configuration' &&
    REINITIALIZABLE_CONFIGURATION_CODES.has(error?.code)
  )
}

export function createConfigurationSetupLauncher({
  platform = process.platform,
  execPath = process.execPath,
  cliPath = defaultCliPath(),
  homeDir = os.homedir(),
  environment = process.env,
  execFileImpl = execFile,
  clock = Date.now,
  cooldownMs = 60_000,
  launchTimeoutMs = 10_000,
  setupMode = 'blog',
} = {}) {
  if (!['blog', 'content'].includes(setupMode)) {
    throw new TypeError('setupMode must be blog or content')
  }
  const command = manualCommand(execPath, cliPath, setupMode)
  let lastStartedAt
  let pendingLaunch

  return Object.freeze({
    command,
    async start() {
      if (platform !== 'win32') {
        return {
          setupStarted: false,
          manualSetupRequired: true,
          reason: 'INTERACTIVE_TERMINAL_REQUIRED',
          manualCommand: command,
        }
      }

      const powershellPath = windowsPowerShellPath(environment)
      if (!powershellPath) {
        return {
          setupStarted: false,
          manualSetupRequired: true,
          reason: 'POWERSHELL_UNAVAILABLE',
          manualCommand: command,
        }
      }

      if (pendingLaunch) return pendingLaunch

      const now = clock()
      if (
        Number.isFinite(lastStartedAt) &&
        Number.isFinite(now) &&
        now - lastStartedAt < cooldownMs
      ) {
        return {
          setupStarted: false,
          setupAlreadyRunning: true,
          retryAfterSeconds: Math.max(1, Math.ceil((cooldownMs - (now - lastStartedAt)) / 1000)),
        }
      }

      const childEnvironment = cleanEnvironment(environment, homeDir)
      childEnvironment.SANITY_BLOG_SETUP_NODE = execPath
      childEnvironment.SANITY_BLOG_SETUP_CLI = cliPath
      childEnvironment.SANITY_BLOG_SETUP_CWD = platform === 'win32'
        ? path.win32.dirname(cliPath)
        : path.dirname(cliPath)
      childEnvironment.SANITY_BLOG_SETUP_POWERSHELL = powershellPath
      childEnvironment.SANITY_BLOG_SETUP_COMMAND = INNER_SETUP_COMMAND
      if (setupMode === 'content') childEnvironment.SANITY_BLOG_SETUP_MODE = 'content'

      const launch = (async () => {
        const launchError = await new Promise((resolve) => {
          try {
            execFileImpl(
              powershellPath,
              [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-EncodedCommand',
                OUTER_LAUNCH_COMMAND,
              ],
              {
                encoding: 'utf8',
                env: childEnvironment,
                maxBuffer: 16 * 1024,
                timeout: launchTimeoutMs,
                windowsHide: true,
              },
              (error) => resolve(error),
            )
          } catch (error) {
            resolve(error)
          }
        })
        if (!launchError) {
          lastStartedAt = now
          return {setupStarted: true}
        }
        return {
          setupStarted: false,
          manualSetupRequired: true,
          reason: 'SETUP_LAUNCH_FAILED',
          manualCommand: command,
        }
      })()
      pendingLaunch = launch
      try {
        return await launch
      } finally {
        if (pendingLaunch === launch) pendingLaunch = undefined
      }
    },
  })
}

export function configurationSetupSummary(launchResult) {
  return {
    configured: false,
    ...launchResult,
    configurationFieldCount: CONFIGURATION_FIELDS.length,
    configurationFields: [...CONFIGURATION_FIELDS],
    requiredFields: [...REQUIRED_CONFIGURATION_FIELDS],
    defaults: {
      publisherApiOrigin: DEFAULT_PUBLISHER_API_ORIGIN,
      dataset: 'production',
    },
    nextStep: launchResult.setupStarted || launchResult.setupAlreadyRunning
      ? 'Complete the separate setup terminal, then call sanity_blog_check_config again.'
      : 'Run the manual setup command in an interactive terminal, then call sanity_blog_check_config again.',
  }
}

export function contentConfigurationSetupSummary(launchResult) {
  return {
    configured: false,
    ...launchResult,
    configurationFieldCount: CONTENT_CONFIGURATION_FIELDS.length,
    configurationFields: [...CONTENT_CONFIGURATION_FIELDS],
    requiredFields: [...REQUIRED_CONFIGURATION_FIELDS],
    defaults: {
      publisherApiOrigin: DEFAULT_PUBLISHER_API_ORIGIN,
      dataset: 'production',
      publicSiteOrigin: DEFAULT_PUBLIC_SITE_ORIGIN,
    },
    nextStep: launchResult.setupStarted || launchResult.setupAlreadyRunning
      ? 'Complete the separate setup terminal, then call sanity_content_check_config again.'
      : 'Run the manual setup command in an interactive terminal, then call sanity_content_check_config again.',
  }
}
