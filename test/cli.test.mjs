import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

async function isolatedHome(t) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "sanityblog-cli-"));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  return homeDir;
}

function childEnvironment(homeDir) {
  const environment = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
  };
  delete environment.SANITY_BLOG_PROJECT_ID;
  delete environment.SANITY_BLOG_DATASET;
  delete environment.SANITY_BLOG_TOKEN;
  return environment;
}

test("non-interactive init reports explicit missing Sanity input", async (t) => {
  const homeDir = await isolatedHome(t);
  const result = spawnSync(process.execPath, [cliPath, "--init"], {
    encoding: "utf8",
    env: childEnvironment(homeDir),
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.category, "configuration");
  assert.equal(payload.error.code, "CONFIG_INPUT_REQUIRED");
});

test("non-interactive init persists only three fields without exposing token", async (t) => {
  const homeDir = await isolatedHome(t);
  const secret = "cli-secret-never-print";
  const environment = {
    ...childEnvironment(homeDir),
    SANITY_BLOG_PROJECT_ID: "project-id",
    SANITY_BLOG_DATASET: "production",
    SANITY_BLOG_TOKEN: secret,
  };
  const result = spawnSync(process.execPath, [cliPath, "--init"], {
    encoding: "utf8",
    env: environment,
    timeout: 60_000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret, "u"));
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.configured, true);

  const configPath = path.join(homeDir, ".sanity-blog", "config.json");
  const persisted = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(Object.keys(persisted), ["projectId", "dataset", "sanityToken"]);
  assert.equal(persisted.sanityToken, secret);
});
