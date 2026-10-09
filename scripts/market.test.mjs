import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, verify } from "node:crypto"
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

const script = new URL("./market.mjs", import.meta.url).pathname
const immutable = new URL("./check-immutable.mjs", import.meta.url).pathname

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "codeg-market-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const release = join(root, "plugins/demo/1.0.0")
  await mkdir(release, { recursive: true })
  const manifest = {
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    tier: "declarative",
    permissions: ["ui:status-bar"],
    contributes: { statusBarItems: [{ text: "Ready" }] },
  }
  const catalog = {
    schemaVersion: 1,
    plugins: [
      {
        id: "demo",
        name: "Demo",
        description: "Reviewed release",
        version: "1.0.0",
        minCodegVersion: "0.32.0",
      },
    ],
  }
  await writeFile(join(root, "catalog.json"), JSON.stringify(catalog))
  await writeFile(join(release, "manifest.json"), JSON.stringify(manifest))
  await writeFile(join(release, "styles.css"), ".workspace { color: red; }")
  return { root, release, manifest, catalog }
}

function run(root, command, env = {}) {
  return spawnSync(process.execPath, [script, command], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
}

test("builds a compatible signed-catalog payload and copies immutable resources", async (t) => {
  const { root, release } = await fixture(t)
  const result = run(root, "build", { MARKET_SEQUENCE: "12345" })
  assert.equal(result.status, 0, result.stderr)
  const index = JSON.parse(await readFile(join(root, "dist/index.json")))
  assert.equal(index.schemaVersion, 1)
  assert.equal(index.sequence, 12345)
  assert.ok(Date.parse(index.expiresAt) > Date.now())
  assert.ok(Date.parse(index.expiresAt) <= Date.now() + 30 * 86400000)
  for (const [file, field] of [
    ["manifest.json", "manifestSha256"],
    ["styles.css", "stylesSha256"],
  ]) {
    const bytes = await readFile(join(release, file))
    assert.equal(
      index.plugins[0][field],
      createHash("sha256").update(bytes).digest("hex")
    )
    assert.deepEqual(
      await readFile(join(root, "dist/plugins/demo/1.0.0", file)),
      bytes
    )
  }
})

for (const [name, mutate] of [
  [
    "external CSS resources",
    async ({ release }) =>
      writeFile(join(release, "styles.css"), '@import "https://example.com";'),
  ],
  [
    "plugin JavaScript",
    async ({ release }) => writeFile(join(release, "main.js"), "alert(1)"),
  ],
  [
    "symlink resources",
    async ({ release }) => {
      await rm(join(release, "styles.css"))
      await symlink("manifest.json", join(release, "styles.css"))
    },
  ],
  [
    "symlink plugin root",
    async ({ root }) => {
      await rename(join(root, "plugins"), join(root, "elsewhere"))
      await symlink("elsewhere", join(root, "plugins"))
    },
  ],
  [
    "unsupported permissions",
    async ({ release, manifest }) =>
      writeFile(
        join(release, "manifest.json"),
        JSON.stringify({ ...manifest, permissions: ["fs:read"] })
      ),
  ],
  [
    "null permissions",
    async ({ release, manifest }) =>
      writeFile(
        join(release, "manifest.json"),
        JSON.stringify({ ...manifest, permissions: null })
      ),
  ],
  [
    "null contributions",
    async ({ release, manifest }) =>
      writeFile(
        join(release, "manifest.json"),
        JSON.stringify({ ...manifest, contributes: null })
      ),
  ],
  [
    "unknown manifest fields",
    async ({ release, manifest }) =>
      writeFile(
        join(release, "manifest.json"),
        JSON.stringify({ ...manifest, entry: "main.js" })
      ),
  ],
  [
    "catalog metadata mismatch",
    async ({ root, catalog }) => {
      catalog.plugins[0].name = "Other"
      await writeFile(join(root, "catalog.json"), JSON.stringify(catalog))
    },
  ],
  [
    "oversized manifest",
    async ({ release }) =>
      writeFile(join(release, "manifest.json"), " ".repeat(512 * 1024 + 1)),
  ],
]) {
  test(`rejects ${name} before publishing`, async (t) => {
    const value = await fixture(t)
    await mutate(value)
    const result = run(value.root, "check")
    assert.notEqual(result.status, 0)
    assert.ok(!result.stderr.includes("Cannot find module"), result.stderr)
  })
}

test("signs exact index bytes and rejects a different publication key", async (t) => {
  const { root } = await fixture(t)
  assert.equal(run(root, "build").status, 0)
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const rawPublic = Buffer.from(
    publicKey.export({ format: "jwk" }).x,
    "base64url"
  )
  await writeFile(
    join(root, "public-key.txt"),
    rawPublic.toString("base64") + "\n"
  )
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString()
  const signed = run(root, "sign", { MARKET_SIGNING_PRIVATE_KEY: pem })
  assert.equal(signed.status, 0, signed.stderr)
  assert.ok(!signed.stdout.includes(pem))
  const index = await readFile(join(root, "dist/index.json"))
  const signature = Buffer.from(
    (await readFile(join(root, "dist/index.json.sig"), "utf8")).trim(),
    "base64"
  )
  assert.ok(verify(null, index, publicKey, signature))
  assert.equal(
    verify(
      null,
      Buffer.concat([index, Buffer.from(" ")]),
      publicKey,
      signature
    ),
    false
  )
  const other = generateKeyPairSync("ed25519")
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString()
  assert.notEqual(
    run(root, "sign", { MARKET_SIGNING_PRIVATE_KEY: other }).status,
    0
  )
})

test("allows new releases and rejects adding files to an existing release path", async (t) => {
  const { root, release } = await fixture(t)
  function git(...args) {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        ...args,
      ],
      { cwd: root, encoding: "utf8" }
    )
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git("init", "-b", "main")
  git("add", ".")
  git("commit", "-m", "Initial release")
  const base = git("rev-parse", "HEAD")
  await mkdir(join(root, "plugins/demo/1.1.0"))
  await writeFile(join(root, "plugins/demo/1.1.0/manifest.json"), "{}")
  git("add", ".")
  git("commit", "-m", "New release")
  const check = () =>
    spawnSync(process.execPath, [immutable, base], {
      cwd: root,
      encoding: "utf8",
    })
  const added = check()
  assert.equal(added.status, 0, added.stderr)
  await writeFile(join(release, "extra.json"), "{}")
  git("add", ".")
  git("commit", "-m", "Modify published directory")
  const changed = check()
  assert.notEqual(changed.status, 0)
  assert.ok(!changed.stderr.includes("Cannot find module"), changed.stderr)
})
