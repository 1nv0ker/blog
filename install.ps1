[CmdletBinding()]
param(
    [Parameter()]
    [string]$SourcePath,

    [Parameter()]
    [string]$InstallRoot = (Join-Path $HOME "plugins\sanityblog"),

    [Parameter()]
    [switch]$SkipCodexRegistration
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$NodeVersion = "22.23.1"
$GitHubMainArchiveUrl = "https://github.com/1nv0ker/blog/archive/refs/heads/main.zip"
$NodeReleaseRoot = "https://nodejs.org/download/release/v$NodeVersion"
$ExpectedNodeHashes = @{
    "win-x64" = "7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29"
    "win-arm64" = "b470fdfe3502c05151656e06d495e3f47544f2ee8b1d9c8705090f2dd5996bd0"
}
$ExpectedSkillDirectories = @(
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
    "sanity-content-tutorial-update"
)
$ForbiddenGenericSkillDirectories = @(
    "sanity-content-preview",
    "sanity-content-publish",
    "sanity-content-update"
)

function Resolve-NormalizedPath {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $providerPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    return [System.IO.Path]::GetFullPath($providerPath)
}

function Test-PathsEqual {
    param(
        [Parameter(Mandatory)]
        [string]$Left,

        [Parameter(Mandatory)]
        [string]$Right
    )

    return [System.StringComparer]::OrdinalIgnoreCase.Equals(
        (Resolve-NormalizedPath -Path $Left).TrimEnd("\", "/"),
        (Resolve-NormalizedPath -Path $Right).TrimEnd("\", "/")
    )
}

function Test-PathWithin {
    param(
        [Parameter(Mandatory)]
        [string]$Candidate,

        [Parameter(Mandatory)]
        [string]$Parent
    )

    $candidatePath = (Resolve-NormalizedPath -Path $Candidate).TrimEnd("\", "/")
    $parentPath = (Resolve-NormalizedPath -Path $Parent).TrimEnd("\", "/")
    if ([System.StringComparer]::OrdinalIgnoreCase.Equals($candidatePath, $parentPath)) {
        return $true
    }
    $parentPrefix = $parentPath + [System.IO.Path]::DirectorySeparatorChar
    return $candidatePath.StartsWith(
        $parentPrefix,
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Assert-NoReparseAncestors {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $cursor = Resolve-NormalizedPath -Path $Path
    while (-not (Test-Path -LiteralPath $cursor)) {
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or (Test-PathsEqual -Left $parent -Right $cursor)) {
            break
        }
        $cursor = $parent
    }
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        $item = Get-Item -LiteralPath $cursor -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "InstallRoot cannot traverse a symbolic link or junction: $cursor"
        }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or (Test-PathsEqual -Left $parent -Right $cursor)) {
            break
        }
        $cursor = $parent
    }
}

function Assert-ExistingSanityBlogDirectory {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $children = @(Get-ChildItem -LiteralPath $Path -Force)
    if ($children.Count -eq 0) {
        if ([System.IO.Path]::GetFileName($Path) -cne "sanityblog") {
            throw "An empty InstallRoot must be named sanityblog."
        }
        return
    }

    $manifestPath = Join-Path $Path ".codex-plugin\plugin.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Refusing to replace a non-sanityblog directory: $Path"
    }
    $manifestItem = Get-Item -LiteralPath $manifestPath -Force
    if (
        ($manifestItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $manifestItem.Length -gt 65536
    ) {
        throw "The existing sanityblog manifest is unsafe."
    }
    try {
        $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
    }
    catch {
        throw "The existing sanityblog manifest is invalid."
    }
    if ([string]$manifest.name -cne "sanityblog") {
        throw "Refusing to replace a plugin directory not owned by sanityblog: $Path"
    }
}

function Assert-SafeInstallTarget {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $fullPath = Resolve-NormalizedPath -Path $Path
    $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
    if (Test-PathsEqual -Left $fullPath -Right $pathRoot) {
        throw "InstallRoot cannot be a filesystem root."
    }
    if (Test-PathsEqual -Left $fullPath -Right $HOME) {
        throw "InstallRoot cannot be the home directory."
    }
    Assert-NoReparseAncestors -Path $fullPath
    if (Test-Path -LiteralPath $fullPath) {
        $item = Get-Item -LiteralPath $fullPath -Force
        if (-not $item.PSIsContainer) {
            throw "InstallRoot exists and is not a directory: $fullPath"
        }
        Assert-ExistingSanityBlogDirectory -Path $fullPath
    }
    elseif ([System.IO.Path]::GetFileName($fullPath) -cne "sanityblog") {
        throw "A new InstallRoot must be named sanityblog."
    }
}
function Remove-OwnedDirectory {
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        [string]$ExpectedParent
    )

    $fullPath = Resolve-NormalizedPath -Path $Path
    $actualParent = Split-Path -Parent $fullPath
    if (-not (Test-PathsEqual -Left $actualParent -Right $ExpectedParent)) {
        throw "Refusing to remove a directory outside the expected parent: $fullPath"
    }
    if (Test-Path -LiteralPath $fullPath) {
        Remove-Item -LiteralPath $fullPath -Recurse -Force
    }
}

function Assert-NoReparsePoints {
    param(
        [Parameter(Mandatory)]
        [System.IO.FileSystemInfo]$Item
    )

    if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Source contains a symbolic link or junction: $($Item.FullName)"
    }
    if ($Item.PSIsContainer) {
        $unsafeItem = Get-ChildItem -LiteralPath $Item.FullName -Force -Recurse |
            Where-Object {
                ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
            } |
            Select-Object -First 1
        if ($null -ne $unsafeItem) {
            throw "Source contains a symbolic link or junction: $($unsafeItem.FullName)"
        }
    }
}

function Assert-SourceTree {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    foreach ($requiredPath in @(
        ".gitattributes",
        ".claude-plugin\plugin.json",
        ".codex-plugin\plugin.json",
        "install.sh",
        "package.json",
        "package-lock.json",
        "src\server.mjs",
        "src\cli.mjs",
        "dist\cli.mjs",
        "dist\server.mjs",
        "scripts\configure-install.mjs"
    )) {
        if (-not (Test-Path -LiteralPath (Join-Path $Path $requiredPath) -PathType Leaf)) {
            throw "Source is missing required file: $requiredPath"
        }
    }

    $skillsPath = Join-Path $Path "skills"
    if (-not (Test-Path -LiteralPath $skillsPath -PathType Container)) {
        throw "Source is missing required directory: skills"
    }

    foreach ($genericSkill in $ForbiddenGenericSkillDirectories) {
        if (Test-Path -LiteralPath (Join-Path $skillsPath $genericSkill)) {
            throw "Source contains forbidden generic skill directory: $genericSkill"
        }
    }

    $expectedSkills = @($ExpectedSkillDirectories | Sort-Object)
    $actualSkills = @(
        Get-ChildItem -LiteralPath $skillsPath -Directory -Force |
            Sort-Object -Property Name |
            ForEach-Object { $_.Name }
    )
    if ($actualSkills.Count -ne $expectedSkills.Count) {
        throw (
            "Source must contain exactly $($expectedSkills.Count) skill directories; " +
            "found $($actualSkills.Count)."
        )
    }
    for ($index = 0; $index -lt $expectedSkills.Count; $index += 1) {
        if (-not [System.StringComparer]::Ordinal.Equals(
            $actualSkills[$index],
            $expectedSkills[$index]
        )) {
            throw (
                "Source skill inventory is invalid. Expected " +
                "$($expectedSkills -join ', '); found $($actualSkills -join ', ')."
            )
        }
    }

    foreach ($skillDirectory in $ExpectedSkillDirectories) {
        foreach ($requiredSkillPath in @("SKILL.md", "agents\openai.yaml")) {
            $relativeSkillPath = Join-Path $skillDirectory $requiredSkillPath
            if (-not (
                Test-Path `
                    -LiteralPath (Join-Path $skillsPath $relativeSkillPath) `
                    -PathType Leaf
            )) {
                throw "Source is missing required skill file: skills\$relativeSkillPath"
            }
        }
    }
}

function Copy-SourceTree {
    param(
        [Parameter(Mandatory)]
        [string]$From,

        [Parameter(Mandatory)]
        [string]$To
    )

    $excludedNames = @(".git", "node_modules", "runtime")
    New-Item -ItemType Directory -Path $To | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $From -Force) {
        if ($excludedNames -contains $item.Name) {
            continue
        }
        Assert-NoReparsePoints -Item $item
        $destination = Join-Path $To $item.Name
        Copy-Item -LiteralPath $item.FullName -Destination $destination -Recurse -Force
    }
}

function Invoke-Download {
    param(
        [Parameter(Mandatory)]
        [string]$Uri,

        [Parameter(Mandatory)]
        [string]$Destination
    )

    Invoke-WebRequest `
        -UseBasicParsing `
        -Uri $Uri `
        -OutFile $Destination `
        -Headers @{ "User-Agent" = "sanityblog-installer/0.1" }
    if (-not (Test-Path -LiteralPath $Destination -PathType Leaf)) {
        throw "Download did not create the expected file."
    }
}

function Get-OfficialNodeHash {
    param(
        [Parameter(Mandatory)]
        [string]$ChecksumFile,

        [Parameter(Mandatory)]
        [string]$ArchiveName
    )

    $pattern = "^(?<hash>[0-9A-Fa-f]{64})\s+\*?" +
        [System.Text.RegularExpressions.Regex]::Escape($ArchiveName) +
        "\s*$"
    $hashes = @()
    foreach ($line in Get-Content -LiteralPath $ChecksumFile) {
        $match = [System.Text.RegularExpressions.Regex]::Match($line, $pattern)
        if ($match.Success) {
            $hashes += $match.Groups["hash"].Value.ToLowerInvariant()
        }
    }
    if ($hashes.Count -ne 1) {
        throw "Official checksum list does not contain exactly one entry for $ArchiveName."
    }
    return $hashes[0]
}

function Get-NodePlatform {
    $architecture = $null
    try {
        $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    }
    catch {
        $architecture = $env:PROCESSOR_ARCHITEW6432
        if ([string]::IsNullOrWhiteSpace($architecture)) {
            $architecture = $env:PROCESSOR_ARCHITECTURE
        }
    }

    switch ($architecture.ToUpperInvariant()) {
        { $_ -in @("X64", "AMD64") } {
            return "win-x64"
        }
        "ARM64" {
            return "win-arm64"
        }
        default {
            throw "Unsupported Windows architecture: $architecture"
        }
    }
}

function Test-SanityBlogConfiguration {
    param(
        [Parameter(Mandatory)]
        [string]$NodePath,

        [Parameter(Mandatory)]
        [string]$CliPath
    )

    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & $NodePath $CliPath --check *> $null
        return $LASTEXITCODE -eq 0
    }
    catch {
        return $false
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
}

if (-not [System.Environment]::Is64BitOperatingSystem) {
    throw "sanityblog requires 64-bit Windows."
}

try {
    [System.Net.ServicePointManager]::SecurityProtocol =
        [System.Net.ServicePointManager]::SecurityProtocol -bor
        [System.Net.SecurityProtocolType]::Tls12
}
catch {
    Write-Verbose "TLS policy is managed by this PowerShell runtime."
}

$resolvedInstallRoot = Resolve-NormalizedPath -Path $InstallRoot
Assert-SafeInstallTarget -Path $resolvedInstallRoot
$installParent = Split-Path -Parent $resolvedInstallRoot
New-Item -ItemType Directory -Path $installParent -Force | Out-Null

$resolvedSourcePath = $null
if (-not [string]::IsNullOrWhiteSpace($SourcePath)) {
    $resolvedSourcePath = (Resolve-Path -LiteralPath $SourcePath).Path
    if (-not (Test-Path -LiteralPath $resolvedSourcePath -PathType Container)) {
        throw "SourcePath must be a directory."
    }
    if (
        (Test-PathWithin -Candidate $resolvedInstallRoot -Parent $resolvedSourcePath) -or
        (Test-PathWithin -Candidate $resolvedSourcePath -Parent $resolvedInstallRoot)
    ) {
        throw "InstallRoot and SourcePath cannot contain one another."
    }
}

$operationId = [System.Guid]::NewGuid().ToString("N")
$workRoot = Join-Path $installParent ".sanityblog-install-$operationId"
$stageRoot = Join-Path $workRoot "stage"
$backupRoot = Join-Path $installParent ".sanityblog-backup-$operationId"
$marketplacePath = Join-Path $HOME ".agents\plugins\marketplace.json"
$promoted = $false
$completed = $false
$rollbackPermitted = $true
$tokenEnvironmentScrubbed = $false
$hadOriginalSanityBlogToken = $false
$originalSanityBlogToken = $null

New-Item -ItemType Directory -Path $workRoot | Out-Null

try {
    $originalSanityBlogToken = [Environment]::GetEnvironmentVariable(
        "SANITY_BLOG_TOKEN",
        "Process"
    )
    $hadOriginalSanityBlogToken = $null -ne $originalSanityBlogToken
    Remove-Item Env:SANITY_BLOG_TOKEN -ErrorAction SilentlyContinue
    $tokenEnvironmentScrubbed = $true
    if ($null -ne $resolvedSourcePath) {
        Write-Host "Copying sanityblog source from SourcePath..."
        $sourceRoot = $resolvedSourcePath
    }
    else {
        Write-Host "Downloading sanityblog from GitHub main..."
        $sourceArchive = Join-Path $workRoot "sanityblog-main.zip"
        $sourceExtract = Join-Path $workRoot "source"
        Invoke-Download -Uri $GitHubMainArchiveUrl -Destination $sourceArchive
        Expand-Archive -LiteralPath $sourceArchive -DestinationPath $sourceExtract
        $sourceCandidates = @(
            Get-ChildItem -LiteralPath $sourceExtract -Directory -Force |
                Where-Object {
                    (Test-Path -LiteralPath (Join-Path $_.FullName "package.json") -PathType Leaf) -and
                    (Test-Path -LiteralPath (Join-Path $_.FullName "src\server.mjs") -PathType Leaf)
                }
        )
        if ($sourceCandidates.Count -ne 1) {
            throw "GitHub archive did not contain exactly one sanityblog source tree."
        }
        $sourceRoot = $sourceCandidates[0].FullName
    }

    Assert-SourceTree -Path $sourceRoot
    Copy-SourceTree -From $sourceRoot -To $stageRoot

    $nodePlatform = Get-NodePlatform
    $nodeArchiveName = "node-v$NodeVersion-$nodePlatform.zip"
    $nodeArchive = Join-Path $workRoot $nodeArchiveName
    $checksumFile = Join-Path $workRoot "SHASUMS256.txt"

    Write-Host "Downloading portable Node.js $NodeVersion for $nodePlatform..."
    Invoke-Download -Uri "$NodeReleaseRoot/$nodeArchiveName" -Destination $nodeArchive
    Invoke-Download -Uri "$NodeReleaseRoot/SHASUMS256.txt" -Destination $checksumFile

    $pinnedHash = $ExpectedNodeHashes[$nodePlatform]
    $officialHash = Get-OfficialNodeHash `
        -ChecksumFile $checksumFile `
        -ArchiveName $nodeArchiveName
    if ($officialHash -cne $pinnedHash) {
        throw "The official Node.js checksum does not match the pinned installer checksum."
    }
    $downloadedFileHash = Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256
    $downloadedHash = $downloadedFileHash.Hash.ToLowerInvariant()
    if ($downloadedHash -cne $pinnedHash) {
        throw "The downloaded Node.js archive failed SHA-256 verification."
    }

    $nodeExtract = Join-Path $workRoot "node"
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract
    $nodeDistribution = Join-Path $nodeExtract "node-v$NodeVersion-$nodePlatform"
    if (-not (Test-Path -LiteralPath (Join-Path $nodeDistribution "node.exe") -PathType Leaf)) {
        throw "The verified Node.js archive did not contain node.exe."
    }

    $runtimeRoot = Join-Path $stageRoot "runtime"
    New-Item -ItemType Directory -Path $runtimeRoot | Out-Null
    foreach ($runtimeItem in Get-ChildItem -LiteralPath $nodeDistribution -Force) {
        Copy-Item `
            -LiteralPath $runtimeItem.FullName `
            -Destination (Join-Path $runtimeRoot $runtimeItem.Name) `
            -Recurse `
            -Force
    }

    $nodeExecutable = Join-Path $runtimeRoot "node.exe"
    $npmCli = Join-Path $runtimeRoot "node_modules\npm\bin\npm-cli.js"
    if (-not (Test-Path -LiteralPath $npmCli -PathType Leaf)) {
        throw "The portable Node.js distribution did not contain npm."
    }

    Write-Host "Installing production dependencies with portable npm..."
    Push-Location $stageRoot
    try {
        & $nodeExecutable $npmCli ci --omit=dev --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }

    $configureScript = Join-Path $stageRoot "scripts\configure-install.mjs"
    $writeMcpOutput = & $nodeExecutable `
        $configureScript `
        write-mcp `
        --plugin-root $stageRoot `
        --install-root $resolvedInstallRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Generating MCP configuration failed."
    }
    $null = $writeMcpOutput

    if (Test-Path -LiteralPath $resolvedInstallRoot) {
        [System.IO.Directory]::Move($resolvedInstallRoot, $backupRoot)
    }
    try {
        [System.IO.Directory]::Move($stageRoot, $resolvedInstallRoot)
        $promoted = $true
    }
    catch {
        if (
            (Test-Path -LiteralPath $backupRoot) -and
            -not (Test-Path -LiteralPath $resolvedInstallRoot)
        ) {
            [System.IO.Directory]::Move($backupRoot, $resolvedInstallRoot)
        }
        throw
    }

    $installedNode = Join-Path $resolvedInstallRoot "runtime\node.exe"
    $installedCli = Join-Path $resolvedInstallRoot "dist\cli.mjs"
    if (Test-SanityBlogConfiguration -NodePath $installedNode -CliPath $installedCli) {
        Write-Host "Existing sanityblog configuration is valid."
    }
    else {
        Write-Host "Sanityblog publisher/Sanity configuration is missing or invalid; starting setup..."
        $rollbackPermitted = $false
        $configurationExitCode = 1
        try {
            if ($hadOriginalSanityBlogToken) {
                $env:SANITY_BLOG_TOKEN = $originalSanityBlogToken
            }
            & $installedNode $installedCli --init
            $configurationExitCode = $LASTEXITCODE
        }
        finally {
            Remove-Item Env:SANITY_BLOG_TOKEN -ErrorAction SilentlyContinue
        }
        if ($configurationExitCode -ne 0) {
            throw "Sanityblog publisher/Sanity setup failed with exit code $configurationExitCode."
        }
    }

    $marketplaceName = $null
    try {
        $installedConfigureScript = Join-Path $resolvedInstallRoot "scripts\configure-install.mjs"
        $mergeOutput = & $installedNode `
            $installedConfigureScript `
            merge-marketplace `
            --marketplace $marketplacePath `
            --install-root $resolvedInstallRoot
        if ($LASTEXITCODE -ne 0) {
            throw "Updating the personal plugin marketplace failed."
        }
        $mergeResult = ($mergeOutput -join [System.Environment]::NewLine) | ConvertFrom-Json
        $marketplaceName = [string]$mergeResult.marketplaceName
        if ([string]::IsNullOrWhiteSpace($marketplaceName)) {
            throw "The personal plugin marketplace does not have a valid name."
        }
    }
    catch {
        Write-Warning (
            "Plugin and Sanity configuration were installed, but personal marketplace " +
            "registration failed. Fix $marketplacePath and rerun the installer."
        )
    }

    $completed = $true
    if (-not $SkipCodexRegistration -and -not [string]::IsNullOrWhiteSpace($marketplaceName)) {
        $codexCommand = Get-Command codex -ErrorAction SilentlyContinue
        if ($null -ne $codexCommand) {
            $pluginSelector = "sanityblog@$marketplaceName"
            try {
                & $codexCommand plugin add $pluginSelector --json *> $null
                if ($LASTEXITCODE -eq 0) {
                    Write-Host "Codex plugin registration completed."
                }
                else {
                    Write-Warning (
                        "Installation completed, but Codex registration failed. " +
                        "Retry with: codex plugin add `"$pluginSelector`" --json"
                    )
                }
            }
            catch {
                Write-Warning (
                    "Installation completed, but Codex registration failed. " +
                    "Retry with: codex plugin add `"$pluginSelector`" --json"
                )
            }
        }
    }

    Write-Host "sanityblog installed at $resolvedInstallRoot"
}
catch {
    $originalError = $_
    if (-not $rollbackPermitted -and $promoted) {
        throw (
            "Publisher/Sanity setup failed after the new plugin was activated. " +
            "The new plugin was retained to remain compatible with any new config; " +
            "the previous plugin backup, if any, remains at $backupRoot. " +
            "Original error: $($originalError.Exception.Message)"
        )
    }
    try {
        if ($promoted -and (Test-Path -LiteralPath $resolvedInstallRoot)) {
            Remove-OwnedDirectory `
                -Path $resolvedInstallRoot `
                -ExpectedParent $installParent
            $promoted = $false
        }
        if (
            (Test-Path -LiteralPath $backupRoot) -and
            -not (Test-Path -LiteralPath $resolvedInstallRoot)
        ) {
            [System.IO.Directory]::Move($backupRoot, $resolvedInstallRoot)
        }
    }
    catch {
        throw (
            "Installation failed and automatic rollback was incomplete. " +
            "The previous installation may remain at $backupRoot. " +
            "Original error: $($originalError.Exception.Message)"
        )
    }
    throw $originalError
}
finally {
    if ($tokenEnvironmentScrubbed) {
        if ($hadOriginalSanityBlogToken) {
            $env:SANITY_BLOG_TOKEN = $originalSanityBlogToken
        }
        else {
            Remove-Item Env:SANITY_BLOG_TOKEN -ErrorAction SilentlyContinue
        }
    }
    if ($completed -and (Test-Path -LiteralPath $backupRoot)) {
        try {
            Remove-OwnedDirectory -Path $backupRoot -ExpectedParent $installParent
        }
        catch {
            Write-Warning "Could not remove the previous-installation backup: $backupRoot"
        }
    }
    if (Test-Path -LiteralPath $workRoot) {
        try {
            Remove-OwnedDirectory -Path $workRoot -ExpectedParent $installParent
        }
        catch {
            Write-Warning "Could not remove the temporary install directory: $workRoot"
        }
    }
}
