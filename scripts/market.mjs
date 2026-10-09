import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto"
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { TextDecoder } from "node:util"

const limit = 512 * 1024
const decoder = new TextDecoder("utf-8", { fatal: true })
const idPattern = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const root = process.cwd()
const output = join(root, "dist")

function requireValue(condition, message) {
  if (!condition) throw new Error(message)
}

function fields(value, allowed, label) {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    `${label}: expected object`
  )
  requireValue(
    Object.keys(value).every((key) => allowed.includes(key)),
    `${label}: unknown field`
  )
}

function version(value) {
  return (
    typeof value === "string" &&
    versionPattern.test(value) &&
    value.split(".").every((part) => BigInt(part) <= 18446744073709551615n)
  )
}

async function resource(path) {
  const bytes = await readFile(path)
  requireValue(bytes.length <= limit, `${path}: file exceeds 512 KiB`)
  return {
    bytes,
    text: decoder.decode(bytes),
    hash: createHash("sha256").update(bytes).digest("hex"),
  }
}

function manifest(value, id, release) {
  fields(
    value,
    ["id", "name", "version", "tier", "permissions", "contributes"],
    id
  )
  requireValue(
    value.id === id &&
      value.version === release &&
      value.tier === "declarative",
    `${id}: invalid manifest identity or tier`
  )
  requireValue(
    typeof value.name === "string" && value.name.trim(),
    `${id}: name required`
  )
  const permissions = value.permissions === undefined ? [] : value.permissions
  requireValue(
    Array.isArray(permissions) &&
      permissions.every((item) => item === "ui:status-bar"),
    `${id}: unsupported permission`
  )
  const contributes = value.contributes === undefined ? {} : value.contributes
  fields(contributes, ["statusBarItems"], `${id}.contributes`)
  const items =
    contributes.statusBarItems === undefined ? [] : contributes.statusBarItems
  requireValue(Array.isArray(items), `${id}: invalid statusBarItems`)
  for (const item of items) {
    fields(item, ["text"], `${id}.statusBarItems`)
    requireValue(
      typeof item.text === "string" && Buffer.byteLength(item.text) <= 120,
      `${id}: invalid status text`
    )
  }
  requireValue(
    items.length === 0 || permissions.includes("ui:status-bar"),
    `${id}: status bar permission required`
  )
}

async function directory(path) {
  requireValue(
    (await lstat(path)).isDirectory(),
    `${path}: real directory required`
  )
  const entries = await readdir(path, { withFileTypes: true })
  requireValue(
    entries.every((entry) => !entry.isSymbolicLink()),
    `${path}: symlinks are forbidden`
  )
  return entries
}

async function releases() {
  const files = new Map()
  const manifests = new Map()
  const path = join(root, "plugins")
  let ids
  try {
    ids = await directory(path)
  } catch (error) {
    if (error.code === "ENOENT") return { files, manifests }
    throw error
  }
  for (const id of ids) {
    requireValue(
      id.isDirectory() && idPattern.test(id.name),
      `Invalid plugin directory: ${id.name}`
    )
    for (const release of await directory(join(path, id.name))) {
      requireValue(
        release.isDirectory() && version(release.name),
        `Invalid release directory: ${release.name}`
      )
      const prefix = `plugins/${id.name}/${release.name}`
      const entries = await directory(join(root, prefix))
      requireValue(
        entries.every(
          (entry) =>
            entry.isFile() &&
            ["manifest.json", "styles.css"].includes(entry.name)
        ),
        `${prefix}: unexpected resource`
      )
      const bundle = new Map()
      for (const entry of entries) {
        const file = `${prefix}/${entry.name}`
        const value = await resource(join(root, file))
        if (entry.name === "styles.css")
          requireValue(
            !/[@\\]|url/i.test(value.text),
            `${file}: external CSS resources forbidden`
          )
        bundle.set(entry.name, value)
        files.set(file, value.bytes)
      }
      requireValue(bundle.has("manifest.json"), `${prefix}: manifest missing`)
      const parsed = JSON.parse(bundle.get("manifest.json").text)
      manifest(parsed, id.name, release.name)
      manifests.set(prefix, { parsed, bundle })
    }
  }
  return { files, manifests }
}

async function catalog() {
  const source = JSON.parse((await resource(join(root, "catalog.json"))).text)
  fields(source, ["schemaVersion", "plugins"], "catalog")
  requireValue(
    source.schemaVersion === 1 &&
      Array.isArray(source.plugins) &&
      source.plugins.length <= 500,
    "Invalid catalog schema or size"
  )
  const { files, manifests } = await releases()
  const ids = new Set()
  const plugins = source.plugins.map((entry) => {
    fields(
      entry,
      ["id", "name", "description", "version", "minCodegVersion"],
      "catalog plugin"
    )
    requireValue(
      typeof entry.id === "string" &&
        idPattern.test(entry.id) &&
        !ids.has(entry.id),
      "Invalid or duplicate plugin ID"
    )
    ids.add(entry.id)
    requireValue(
      version(entry.version) && version(entry.minCodegVersion),
      `${entry.id}: invalid version`
    )
    requireValue(
      typeof entry.name === "string" &&
        entry.name.trim() &&
        Buffer.byteLength(entry.name) <= 120,
      `${entry.id}: invalid name`
    )
    requireValue(
      typeof entry.description === "string" &&
        Buffer.byteLength(entry.description) <= 1024,
      `${entry.id}: invalid description`
    )
    const release = manifests.get(`plugins/${entry.id}/${entry.version}`)
    requireValue(
      release && release.parsed.name === entry.name,
      `${entry.id}: missing release or catalog metadata mismatch`
    )
    return {
      ...entry,
      manifestSha256: release.bundle.get("manifest.json").hash,
      ...(release.bundle.has("styles.css")
        ? { stylesSha256: release.bundle.get("styles.css").hash }
        : {}),
    }
  })
  return { files, plugins }
}

async function build() {
  const { files, plugins } = await catalog()
  const now = Date.now()
  const sequence = Number(process.env.MARKET_SEQUENCE ?? now)
  requireValue(
    Number.isSafeInteger(sequence) && sequence > 0,
    "Invalid catalog sequence"
  )
  const bytes =
    JSON.stringify(
      {
        schemaVersion: 1,
        sequence,
        expiresAt: new Date(now + 14 * 86400000).toISOString(),
        plugins,
      },
      null,
      2
    ) + "\n"
  requireValue(Buffer.byteLength(bytes) <= 1024 * 1024, "Catalog exceeds 1 MiB")
  await rm(output, { recursive: true, force: true })
  await mkdir(output)
  await writeFile(join(output, "index.json"), bytes)
  for (const [file, content] of files) {
    await mkdir(join(output, file, ".."), { recursive: true })
    await writeFile(join(output, file), content)
  }
  await writeFile(join(output, ".nojekyll"), "")
  await writeFile(
    join(output, "index.html"),
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Codeg 插件市场</title><h1>Codeg 插件市场</h1><p>请在 Codeg 设置 → 插件中浏览和安装经过审核的插件。</p><p><a href="index.json">插件目录</a> · <a href="https://github.com/longzhenwei/codeg-plugin-market">投稿与发布说明</a></p></html>\n'
  )
  console.log(`Built catalog sequence ${sequence}, ${plugins.length} plugins`)
}

async function signCatalog() {
  requireValue(
    process.env.MARKET_SIGNING_PRIVATE_KEY,
    "MARKET_SIGNING_PRIVATE_KEY is required"
  )
  const key = createPrivateKey(process.env.MARKET_SIGNING_PRIVATE_KEY)
  requireValue(
    key.asymmetricKeyType === "ed25519",
    "Signing key must be Ed25519"
  )
  const publicKey = Buffer.from(
    createPublicKey(key).export({ format: "jwk" }).x,
    "base64url"
  ).toString("base64")
  requireValue(
    publicKey === (await readFile(join(root, "public-key.txt"), "utf8")).trim(),
    "Signing key differs from the pinned public key"
  )
  const bytes = await readFile(join(output, "index.json"))
  const index = JSON.parse(bytes)
  requireValue(
    Date.parse(index.expiresAt) > Date.now() &&
      Date.parse(index.expiresAt) <= Date.now() + 30 * 86400000,
    "Catalog expiry is invalid"
  )
  await writeFile(
    join(output, "index.json.sig"),
    sign(null, bytes, key).toString("base64") + "\n"
  )
  await writeFile(join(output, "public-key.txt"), publicKey + "\n")
  console.log(`Signed catalog sequence ${index.sequence}`)
}

try {
  switch (process.argv[2]) {
    case "check":
      await catalog()
      console.log("Catalog and release validation passed")
      break
    case "build":
      await build()
      break
    case "sign":
      await signCatalog()
      break
    default:
      throw new Error("Usage: node scripts/market.mjs <check|build|sign>")
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
