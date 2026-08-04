#!/usr/bin/env bash

# macOS ships Bash 3.2, where nounset treats declared empty arrays as unbound.
set -eo pipefail
umask 077

NODE_VERSION="22.23.1"
GITHUB_MAIN_ARCHIVE_URL="https://github.com/1nv0ker/blog/archive/refs/heads/main.tar.gz"
NODE_RELEASE_ROOT="https://nodejs.org/download/release/v${NODE_VERSION}"
DARWIN_ARM64_NODE_SHA256="ef28d8fab2c0e4314522d4bb1b7173270aa3937e93b92cb7de79c112ac1fa953"
DARWIN_X64_NODE_SHA256="b8da981b8a0b1241b70249204916da76c63573ddf5814dbd2d1e41069105cb81"

EXPECTED_SKILL_DIRECTORIES=(
  "sanity-blog-preview"
  "sanity-blog-publish"
  "sanity-blog-update"
  "sanity-content-alternative-preview"
  "sanity-content-alternative-publish"
  "sanity-content-alternative-update"
  "sanity-content-blog-en-preview"
  "sanity-content-blog-en-publish"
  "sanity-content-blog-en-update"
  "sanity-content-comparison-preview"
  "sanity-content-comparison-publish"
  "sanity-content-comparison-update"
  "sanity-content-guide-preview"
  "sanity-content-guide-publish"
  "sanity-content-guide-update"
  "sanity-content-solution-preview"
  "sanity-content-solution-publish"
  "sanity-content-solution-update"
  "sanity-content-tutorial-preview"
  "sanity-content-tutorial-publish"
  "sanity-content-tutorial-update"
)
FORBIDDEN_GENERIC_SKILL_DIRECTORIES=(
  "sanity-content-preview"
  "sanity-content-publish"
  "sanity-content-update"
)

SOURCE_PATH=""
INSTALL_ROOT="${HOME:-}/plugins/sanityblog"
SKIP_CODEX_REGISTRATION=0

WORK_ROOT=""
BACKUP_ROOT=""
BACKUP_INSTALL=""
INSTALL_PARENT=""
PROMOTED=0
COMPLETED=0
ROLLBACK_PERMITTED=1
TOKEN_ENVIRONMENT_SCRUBBED=0
HAD_ORIGINAL_SANITY_BLOG_TOKEN=0
ORIGINAL_SANITY_BLOG_TOKEN=""

usage() {
  cat <<'EOF'
Install or update the sanityblog plugin on macOS.

Usage:
  install.sh [--source-path PATH] [--install-root PATH]
             [--skip-codex-registration]

Options:
  --source-path PATH          Install from a local source tree instead of GitHub.
  --install-root PATH         Destination (default: ~/plugins/sanityblog).
  --skip-codex-registration  Do not run "codex plugin add" after installation.
  -h, --help                  Show this help.

The installer supports Apple Silicon and Intel Macs. It downloads a pinned
portable Node.js runtime, installs production dependencies, preserves an
existing valid installation until promotion succeeds, and never accepts a
Sanity credential on the command line.
EOF
}

fail() {
  printf 'sanityblog installer failed: %s\n' "$1" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Required command is unavailable: $1"
  fi
}

has_non_whitespace() {
  case "$1" in
    *[![:space:]]*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

normalize_path() {
  local input="$1"
  local raw
  local part
  local result
  local old_ifs
  local -a input_parts=()
  local -a normalized_parts=()

  case "$input" in
    *$'\n'*|*$'\r'*)
      fail "Paths cannot contain newlines."
      ;;
  esac
  if [[ "$input" = /* ]]; then
    raw="$input"
  else
    raw="$PWD/$input"
  fi

  old_ifs="$IFS"
  IFS="/"
  read -r -a input_parts <<< "$raw"
  IFS="$old_ifs"
  for part in "${input_parts[@]}"; do
    case "$part" in
      ""|".")
        ;;
      "..")
        if ((${#normalized_parts[@]} > 0)); then
          unset "normalized_parts[$((${#normalized_parts[@]} - 1))]"
          normalized_parts=("${normalized_parts[@]}")
        fi
        ;;
      *)
        normalized_parts+=("$part")
        ;;
    esac
  done

  result="/"
  for part in "${normalized_parts[@]}"; do
    result="${result%/}/$part"
  done
  printf '%s\n' "$result"
}

path_is_within() {
  local candidate="$1"
  local parent="$2"
  if [[ "$parent" = "/" ]]; then
    [[ "$candidate" = /* ]]
    return
  fi
  [[ "$candidate" = "$parent" || "$candidate" = "$parent/"* ]]
}

assert_no_symlink_ancestors() {
  local target="$1"
  local relative="${target#/}"
  local part
  local cursor=""
  local old_ifs
  local -a parts=()

  old_ifs="$IFS"
  IFS="/"
  read -r -a parts <<< "$relative"
  IFS="$old_ifs"
  for part in "${parts[@]}"; do
    [[ -n "$part" ]] || continue
    cursor="$cursor/$part"
    if [[ -L "$cursor" ]]; then
      fail "Path cannot traverse a symbolic link: $cursor"
    fi
  done
}

manifest_name() {
  local manifest_path="$1"
  if [[ ! -f "$manifest_path" || -L "$manifest_path" ]]; then
    fail "Plugin manifest is not a regular file: $manifest_path"
  fi
  if [[ "$(/usr/bin/stat -f '%z' "$manifest_path")" -gt 65536 ]]; then
    fail "Plugin manifest is unexpectedly large: $manifest_path"
  fi
  /usr/bin/plutil -extract name raw -o - "$manifest_path" 2>/dev/null
}

assert_existing_sanityblog_directory() {
  local target="$1"
  local manifest_path="$target/.codex-plugin/plugin.json"
  local name
  local -a children=()

  shopt -s nullglob dotglob
  children=("$target"/*)
  shopt -u nullglob dotglob
  if ((${#children[@]} == 0)); then
    if [[ "$(basename "$target")" != "sanityblog" ]]; then
      fail "An empty install root must be named sanityblog."
    fi
    return
  fi

  if [[ ! -f "$manifest_path" || -L "$manifest_path" ]]; then
    fail "Refusing to replace a non-sanityblog directory: $target"
  fi
  if ! name="$(manifest_name "$manifest_path")" || [[ "$name" != "sanityblog" ]]; then
    fail "Refusing to replace a plugin directory not owned by sanityblog: $target"
  fi
}

assert_safe_install_target() {
  local target="$1"
  local normalized_home

  normalized_home="$(normalize_path "$HOME")"
  if [[ "$target" = "/" ]]; then
    fail "Install root cannot be the filesystem root."
  fi
  if [[ "$target" = "$normalized_home" ]]; then
    fail "Install root cannot be the home directory."
  fi
  assert_no_symlink_ancestors "$target"
  if [[ -e "$target" || -L "$target" ]]; then
    if [[ ! -d "$target" || -L "$target" ]]; then
      fail "Install root exists and is not a regular directory: $target"
    fi
    assert_existing_sanityblog_directory "$target"
  elif [[ "$(basename "$target")" != "sanityblog" ]]; then
    fail "A new install root must be named sanityblog."
  fi
}

assert_safe_source_tree() {
  local source_root="$1"
  local unsafe_path
  local source_entry
  local source_entry_name
  local required_path
  local skill
  local relative_skill_path
  local generic_skill
  local expected_index
  local entry
  local -a skill_entries=()
  local -a actual_skills=()
  local -a source_entries=()

  shopt -s nullglob dotglob
  source_entries=("$source_root"/*)
  shopt -u nullglob dotglob
  for source_entry in "${source_entries[@]}"; do
    source_entry_name="$(basename "$source_entry")"
    case "$source_entry_name" in
      ".git"|"node_modules"|"runtime")
        continue
        ;;
    esac
    unsafe_path="$(find "$source_entry" -type l -print -quit)"
    if [[ -n "$unsafe_path" ]]; then
      fail "Source contains a symbolic link: $unsafe_path"
    fi
    unsafe_path="$(
      find "$source_entry" ! -type f ! -type d ! -type l -print -quit
    )"
    if [[ -n "$unsafe_path" ]]; then
      fail "Source contains a non-regular filesystem entry: $unsafe_path"
    fi
  done

  for required_path in \
    ".gitattributes" \
    ".claude-plugin/plugin.json" \
    ".codex-plugin/plugin.json" \
    "install.ps1" \
    "install.sh" \
    "package.json" \
    "package-lock.json" \
    "src/server.mjs" \
    "src/cli.mjs" \
    "dist/cli.mjs" \
    "dist/server.mjs" \
    "scripts/configure-install.mjs"; do
    if [[ ! -f "$source_root/$required_path" ]]; then
      fail "Source is missing required file: $required_path"
    fi
  done
  if [[ "$(manifest_name "$source_root/.codex-plugin/plugin.json")" != "sanityblog" ]]; then
    fail "Codex plugin manifest does not belong to sanityblog."
  fi
  if [[ "$(manifest_name "$source_root/.claude-plugin/plugin.json")" != "sanityblog" ]]; then
    fail "Claude plugin manifest does not belong to sanityblog."
  fi

  if [[ ! -d "$source_root/skills" ]]; then
    fail "Source is missing required directory: skills"
  fi
  for generic_skill in "${FORBIDDEN_GENERIC_SKILL_DIRECTORIES[@]}"; do
    if [[ -e "$source_root/skills/$generic_skill" ]]; then
      fail "Source contains forbidden generic skill directory: $generic_skill"
    fi
  done

  shopt -s nullglob dotglob
  skill_entries=("$source_root/skills"/*)
  shopt -u nullglob dotglob
  while IFS= read -r skill; do
    [[ -n "$skill" ]] && actual_skills+=("$skill")
  done < <(
    for entry in "${skill_entries[@]}"; do
      if [[ -d "$entry" ]]; then
        basename "$entry"
      fi
    done | LC_ALL=C sort
  )

  if ((${#actual_skills[@]} != ${#EXPECTED_SKILL_DIRECTORIES[@]})); then
    fail "Source must contain exactly ${#EXPECTED_SKILL_DIRECTORIES[@]} skill directories; found ${#actual_skills[@]}."
  fi
  for ((expected_index = 0; expected_index < ${#EXPECTED_SKILL_DIRECTORIES[@]}; expected_index += 1)); do
    if [[ "${actual_skills[$expected_index]}" != "${EXPECTED_SKILL_DIRECTORIES[$expected_index]}" ]]; then
      fail "Source skill inventory is invalid."
    fi
  done

  for skill in "${EXPECTED_SKILL_DIRECTORIES[@]}"; do
    for relative_skill_path in "SKILL.md" "agents/openai.yaml"; do
      if [[ ! -f "$source_root/skills/$skill/$relative_skill_path" ]]; then
        fail "Source is missing required skill file: skills/$skill/$relative_skill_path"
      fi
    done
  done
}

copy_source_tree() {
  local source_root="$1"
  local stage_root="$2"
  local item
  local name
  local -a entries=()

  mkdir "$stage_root"
  shopt -s nullglob dotglob
  entries=("$source_root"/*)
  shopt -u nullglob dotglob
  for item in "${entries[@]}"; do
    name="$(basename "$item")"
    case "$name" in
      ".git"|"node_modules"|"runtime")
        continue
        ;;
    esac
    cp -R "$item" "$stage_root/"
  done
}

download_file() {
  local uri="$1"
  local destination="$2"
  curl \
    --proto '=https' \
    --proto-redir '=https' \
    --tlsv1.2 \
    --fail \
    --location \
    --silent \
    --show-error \
    --user-agent "sanityblog-installer/0.2" \
    --output "$destination" \
    "$uri"
  if [[ ! -f "$destination" || -L "$destination" ]]; then
    fail "Download did not create the expected regular file."
  fi
}

assert_source_archive_safe() {
  local archive="$1"
  local listing="$2"
  local verbose_listing="$3"
  local entry

  tar -tzf "$archive" > "$listing"
  while IFS= read -r entry; do
    case "$entry" in
      /*|".."|../*|*/../*|*/..)
        fail "Source archive contains an unsafe path: $entry"
        ;;
    esac
  done < "$listing"

  tar -tvzf "$archive" > "$verbose_listing"
  if awk '
    substr($1, 1, 1) == "l" || substr($1, 1, 1) == "h" { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$verbose_listing"; then
    fail "Source archive contains a symbolic or hard link."
  fi
}

official_node_hash() {
  local checksum_file="$1"
  local archive_name="$2"
  local hash
  local count

  hash="$(
    awk -v expected="$archive_name" '
      $2 == expected || $2 == "*" expected {
        print tolower($1)
      }
    ' "$checksum_file"
  )"
  count="$(
    printf '%s\n' "$hash" |
      awk '
        NF == 1 && length($1) == 64 && $1 !~ /[^0-9a-f]/ { count += 1 }
        END { print count + 0 }
      '
  )"
  if [[ "$count" != "1" ]]; then
    fail "Official checksum list does not contain exactly one entry for $archive_name."
  fi
  printf '%s\n' "$hash"
}

node_platform() {
  local machine
  machine="$(uname -m)"
  case "$machine" in
    "arm64")
      printf '%s\n' "darwin-arm64"
      ;;
    "x86_64")
      printf '%s\n' "darwin-x64"
      ;;
    *)
      fail "Unsupported macOS architecture: $machine"
      ;;
  esac
}

safe_remove_owned_directory() {
  local target="$1"
  local expected_parent="$2"
  local normalized_target
  local normalized_parent
  local name

  normalized_target="$(normalize_path "$target")"
  normalized_parent="$(normalize_path "$expected_parent")"
  if [[ "$(dirname "$normalized_target")" != "$normalized_parent" ]]; then
    printf 'Refusing to remove a directory outside the expected parent: %s\n' \
      "$normalized_target" >&2
    return 1
  fi
  name="$(basename "$normalized_target")"
  case "$name" in
    "sanityblog"|.sanityblog-install-*|.sanityblog-backup-*)
      ;;
    *)
      printf 'Refusing to remove an unowned directory: %s\n' "$normalized_target" >&2
      return 1
      ;;
  esac
  if [[ -L "$normalized_target" ]]; then
    printf 'Refusing to remove a symbolic link: %s\n' "$normalized_target" >&2
    return 1
  fi
  if [[ -e "$normalized_target" ]]; then
    rm -rf -- "$normalized_target"
  fi
}

restore_token_environment() {
  if ((TOKEN_ENVIRONMENT_SCRUBBED == 0)); then
    return
  fi
  if ((HAD_ORIGINAL_SANITY_BLOG_TOKEN == 1)); then
    export SANITY_BLOG_TOKEN="$ORIGINAL_SANITY_BLOG_TOKEN"
  else
    unset SANITY_BLOG_TOKEN || true
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  restore_token_environment

  if ((status != 0 && COMPLETED == 0 && PROMOTED == 1)); then
    if ((ROLLBACK_PERMITTED == 0)); then
      printf '%s\n' \
        "Publisher/Sanity setup failed after the new plugin was activated." \
        "The new plugin was retained to remain compatible with any new config." \
        "The previous plugin backup, if any, remains at: $BACKUP_ROOT" >&2
    else
      if [[ -e "$INSTALL_ROOT" ]]; then
        if safe_remove_owned_directory "$INSTALL_ROOT" "$INSTALL_PARENT"; then
          PROMOTED=0
        else
          printf 'Warning: automatic rollback could not remove: %s\n' \
            "$INSTALL_ROOT" >&2
        fi
      fi
      if [[ -e "$BACKUP_INSTALL" && ! -e "$INSTALL_ROOT" ]]; then
        if ! mv "$BACKUP_INSTALL" "$INSTALL_ROOT"; then
          printf 'Warning: automatic rollback could not restore: %s\n' \
            "$BACKUP_INSTALL" >&2
        fi
      fi
    fi
  fi

  if [[ -n "$BACKUP_ROOT" && -e "$BACKUP_ROOT" ]] &&
    { ((COMPLETED == 1)) || [[ ! -e "$BACKUP_INSTALL" ]]; }; then
    safe_remove_owned_directory "$BACKUP_ROOT" "$INSTALL_PARENT" ||
      printf 'Warning: could not remove previous-installation backup container: %s\n' \
        "$BACKUP_ROOT" >&2
  fi
  if [[ -n "$WORK_ROOT" && -e "$WORK_ROOT" ]]; then
    safe_remove_owned_directory "$WORK_ROOT" "$INSTALL_PARENT" ||
      printf 'Warning: could not remove temporary install directory: %s\n' "$WORK_ROOT" >&2
  fi
  exit "$status"
}

parse_arguments() {
  while (($# > 0)); do
    case "$1" in
      "--source-path")
        if (($# < 2)) || [[ -z "$2" ]]; then
          fail "Missing value for --source-path."
        fi
        SOURCE_PATH="$2"
        shift 2
        ;;
      "--install-root")
        if (($# < 2)) || [[ -z "$2" ]]; then
          fail "Missing value for --install-root."
        fi
        INSTALL_ROOT="$2"
        shift 2
        ;;
      "--skip-codex-registration")
        SKIP_CODEX_REGISTRATION=1
        shift
        ;;
      "-h"|"--help")
        usage
        exit 0
        ;;
      *)
        fail "Unknown argument: $1"
        ;;
    esac
  done
}

main() {
  local resolved_source_path=""
  local source_root
  local source_archive
  local source_extract
  local source_listing
  local source_verbose_listing
  local candidate
  local operation_id
  local stage_root
  local node_platform_value
  local node_archive_name
  local node_archive
  local checksum_file
  local pinned_hash
  local published_hash
  local downloaded_hash
  local node_extract
  local node_distribution
  local runtime_root
  local node_executable
  local npm_cli
  local configure_script
  local installed_node
  local installed_cli
  local installed_configure_script
  local marketplace_path
  local check_output
  local check_error_code
  local interactive_setup_available=0
  local merge_output
  local marketplace_name=""
  local plugin_selector
  local -a source_candidates=()

  parse_arguments "$@"
  if [[ -z "${HOME:-}" ]]; then
    fail "HOME must be set."
  fi
  if [[ "$(uname -s)" != "Darwin" ]]; then
    fail "This one-click installer supports macOS only."
  fi
  if [[ "$(/usr/bin/id -u)" = "0" ]]; then
    fail "Do not run this installer with sudo or as root."
  fi

  require_command curl
  require_command tar
  require_command shasum
  require_command awk
  require_command find
  require_command sort
  if [[ ! -x "/usr/bin/plutil" || ! -x "/usr/bin/stat" ]]; then
    fail "Required macOS system utilities are unavailable."
  fi

  INSTALL_ROOT="$(normalize_path "$INSTALL_ROOT")"
  assert_safe_install_target "$INSTALL_ROOT"
  INSTALL_PARENT="$(dirname "$INSTALL_ROOT")"
  assert_no_symlink_ancestors "$INSTALL_PARENT"
  mkdir -p "$INSTALL_PARENT"
  assert_no_symlink_ancestors "$INSTALL_PARENT"

  if [[ -n "$SOURCE_PATH" ]]; then
    resolved_source_path="$(normalize_path "$SOURCE_PATH")"
    if [[ ! -d "$resolved_source_path" || -L "$resolved_source_path" ]]; then
      fail "Source path must be a regular directory."
    fi
    assert_no_symlink_ancestors "$resolved_source_path"
    if path_is_within "$INSTALL_ROOT" "$resolved_source_path" ||
      path_is_within "$resolved_source_path" "$INSTALL_ROOT"; then
      fail "Install root and source path cannot contain one another."
    fi
  fi

  operation_id="$(date +%s).$$.${RANDOM}"
  WORK_ROOT="$(mktemp -d "$INSTALL_PARENT/.sanityblog-install-${operation_id}.XXXXXX")"
  BACKUP_ROOT="$(mktemp -d "$INSTALL_PARENT/.sanityblog-backup-${operation_id}.XXXXXX")"
  BACKUP_INSTALL="$BACKUP_ROOT/sanityblog"
  stage_root="$WORK_ROOT/stage"
  marketplace_path="$HOME/.agents/plugins/marketplace.json"

  if [[ "${SANITY_BLOG_TOKEN+x}" = "x" ]]; then
    HAD_ORIGINAL_SANITY_BLOG_TOKEN=1
    ORIGINAL_SANITY_BLOG_TOKEN="$SANITY_BLOG_TOKEN"
  fi
  unset SANITY_BLOG_TOKEN || true
  TOKEN_ENVIRONMENT_SCRUBBED=1

  if [[ -n "$resolved_source_path" ]]; then
    printf 'Copying sanityblog source from --source-path...\n'
    source_root="$resolved_source_path"
  else
    printf 'Downloading sanityblog from GitHub main...\n'
    source_archive="$WORK_ROOT/sanityblog-main.tar.gz"
    source_extract="$WORK_ROOT/source"
    source_listing="$WORK_ROOT/source-archive.list"
    source_verbose_listing="$WORK_ROOT/source-archive.verbose"
    download_file "$GITHUB_MAIN_ARCHIVE_URL" "$source_archive"
    assert_source_archive_safe "$source_archive" "$source_listing" "$source_verbose_listing"
    mkdir "$source_extract"
    tar -xzf "$source_archive" -C "$source_extract"

    shopt -s nullglob
    for candidate in "$source_extract"/*; do
      if [[ -d "$candidate" &&
        -f "$candidate/package.json" &&
        -f "$candidate/src/server.mjs" ]]; then
        source_candidates+=("$candidate")
      fi
    done
    shopt -u nullglob
    if ((${#source_candidates[@]} != 1)); then
      fail "GitHub archive did not contain exactly one sanityblog source tree."
    fi
    source_root="${source_candidates[0]}"
  fi

  assert_safe_source_tree "$source_root"
  copy_source_tree "$source_root" "$stage_root"

  node_platform_value="$(node_platform)"
  node_archive_name="node-v${NODE_VERSION}-${node_platform_value}.tar.gz"
  node_archive="$WORK_ROOT/$node_archive_name"
  checksum_file="$WORK_ROOT/SHASUMS256.txt"
  case "$node_platform_value" in
    "darwin-arm64")
      pinned_hash="$DARWIN_ARM64_NODE_SHA256"
      ;;
    "darwin-x64")
      pinned_hash="$DARWIN_X64_NODE_SHA256"
      ;;
    *)
      fail "Unsupported Node.js platform: $node_platform_value"
      ;;
  esac

  printf 'Downloading portable Node.js %s for %s...\n' "$NODE_VERSION" "$node_platform_value"
  download_file "$NODE_RELEASE_ROOT/$node_archive_name" "$node_archive"
  download_file "$NODE_RELEASE_ROOT/SHASUMS256.txt" "$checksum_file"
  published_hash="$(official_node_hash "$checksum_file" "$node_archive_name")"
  if [[ "$published_hash" != "$pinned_hash" ]]; then
    fail "The official Node.js checksum does not match the pinned installer checksum."
  fi
  downloaded_hash="$(shasum -a 256 "$node_archive" | awk '{ print tolower($1) }')"
  if [[ "$downloaded_hash" != "$pinned_hash" ]]; then
    fail "The downloaded Node.js archive failed SHA-256 verification."
  fi

  node_extract="$WORK_ROOT/node"
  mkdir "$node_extract"
  tar -xzf "$node_archive" -C "$node_extract"
  node_distribution="$node_extract/node-v${NODE_VERSION}-${node_platform_value}"
  if [[ ! -x "$node_distribution/bin/node" ]]; then
    fail "The verified Node.js archive did not contain an executable bin/node."
  fi

  runtime_root="$stage_root/runtime"
  mkdir "$runtime_root"
  cp -R "$node_distribution/." "$runtime_root/"
  node_executable="$runtime_root/bin/node"
  npm_cli="$runtime_root/lib/node_modules/npm/bin/npm-cli.js"
  if [[ ! -x "$node_executable" || ! -f "$npm_cli" ]]; then
    fail "The portable Node.js distribution is incomplete."
  fi

  printf 'Installing production dependencies with portable npm...\n'
  (
    cd "$stage_root"
    "$node_executable" "$npm_cli" ci \
      --omit=dev \
      --ignore-scripts \
      --no-audit \
      --no-fund
  )

  configure_script="$stage_root/scripts/configure-install.mjs"
  "$node_executable" \
    "$configure_script" \
    write-mcp \
    --plugin-root "$stage_root" \
    --install-root "$INSTALL_ROOT" \
    --runtime-platform macos >/dev/null

  assert_safe_install_target "$INSTALL_ROOT"
  if [[ -e "$INSTALL_ROOT" || -L "$INSTALL_ROOT" ]]; then
    mv "$INSTALL_ROOT" "$BACKUP_INSTALL"
  fi
  if ! mv "$stage_root" "$INSTALL_ROOT"; then
    if [[ -e "$BACKUP_INSTALL" && ! -e "$INSTALL_ROOT" ]]; then
      mv "$BACKUP_INSTALL" "$INSTALL_ROOT"
    fi
    fail "Activating the staged plugin failed."
  fi
  PROMOTED=1

  installed_node="$INSTALL_ROOT/runtime/bin/node"
  installed_cli="$INSTALL_ROOT/dist/cli.mjs"
  if ! "$installed_node" "$installed_cli" --help >/dev/null 2>&1; then
    fail "Installed plugin smoke check failed; the previous installation will be restored."
  fi
  if check_output="$("$installed_node" "$installed_cli" --check 2>&1)"; then
    printf 'Existing sanityblog configuration is valid.\n'
  else
    check_error_code="$(
      "$installed_node" -e '
        try {
          const value = JSON.parse(process.argv[1]);
          const code = value?.error?.code;
          if (typeof code !== "string") process.exit(1);
          process.stdout.write(code);
        } catch {
          process.exit(1);
        }
      ' "$check_output" 2>/dev/null || true
    )"
    case "$check_error_code" in
      "CONFIG_NOT_FOUND"|"INVALID_CONFIG"|"LEGACY_CONFIG_REQUIRES_REINIT")
        ;;
      *)
        fail "Installed plugin configuration check failed unexpectedly; the previous installation will be restored."
        ;;
    esac
    printf 'Sanityblog publisher/Sanity configuration is missing or invalid; starting setup...\n'
    if (: </dev/tty) 2>/dev/null; then
      interactive_setup_available=1
    elif ! (
      ((HAD_ORIGINAL_SANITY_BLOG_TOKEN == 1)) &&
        has_non_whitespace "$ORIGINAL_SANITY_BLOG_TOKEN" &&
        has_non_whitespace "${SANITY_BLOG_PROJECT_ID:-}"
    ); then
      fail "Setup requires a terminal or non-empty SANITY_BLOG_PROJECT_ID and SANITY_BLOG_TOKEN; the previous installation will be restored."
    fi
    if ((HAD_ORIGINAL_SANITY_BLOG_TOKEN == 1)); then
      export SANITY_BLOG_TOKEN="$ORIGINAL_SANITY_BLOG_TOKEN"
    fi
    ROLLBACK_PERMITTED=0
    if ((interactive_setup_available == 1)); then
      "$installed_node" "$installed_cli" --init </dev/tty
    else
      "$installed_node" "$installed_cli" --init </dev/null
    fi
    unset SANITY_BLOG_TOKEN || true
  fi

  installed_configure_script="$INSTALL_ROOT/scripts/configure-install.mjs"
  if merge_output="$(
    "$installed_node" \
      "$installed_configure_script" \
      merge-marketplace \
      --marketplace "$marketplace_path" \
      --install-root "$INSTALL_ROOT"
  )"; then
    if ! marketplace_name="$(
      "$installed_node" -e '
        const value = JSON.parse(process.argv[1]);
        if (typeof value.marketplaceName !== "string" || value.marketplaceName.length === 0) {
          process.exit(1);
        }
        process.stdout.write(value.marketplaceName);
      ' "$merge_output"
    )"; then
      marketplace_name=""
      printf 'Warning: personal marketplace registration returned an invalid name.\n' >&2
    fi
  else
    printf '%s\n' \
      "Warning: plugin and Sanity configuration were installed, but personal marketplace" \
      "registration failed. Fix $marketplace_path and rerun the installer." >&2
  fi

  COMPLETED=1
  if ((SKIP_CODEX_REGISTRATION == 0)) &&
    [[ -n "$marketplace_name" ]] &&
    command -v codex >/dev/null 2>&1; then
    plugin_selector="sanityblog@$marketplace_name"
    if codex plugin add "$plugin_selector" --json >/dev/null 2>&1; then
      printf 'Codex plugin registration completed.\n'
    else
      printf 'Warning: Codex registration failed. Retry with: codex plugin add "%s" --json\n' \
        "$plugin_selector" >&2
    fi
  fi

  printf 'sanityblog installed at %s\n' "$INSTALL_ROOT"
}

trap cleanup EXIT
main "$@"
