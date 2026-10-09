import { execFileSync } from "node:child_process"

const base = process.argv[2]
if (!base || !/^[a-f0-9]{40}$/.test(base))
  throw new Error("A full base commit SHA is required")
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean)
const previous = new Set(
  git("ls-tree", "-r", "--name-only", base, "--", "plugins").map((path) =>
    path.split("/").slice(0, 3).join("/")
  )
)
const changed = git("diff", "--name-only", `${base}...HEAD`, "--", "plugins")
for (const path of changed) {
  if (previous.has(path.split("/").slice(0, 3).join("/"))) {
    throw new Error(
      `Published release paths are immutable: ${path}. Publish a new version instead.`
    )
  }
}
console.log("Immutable release validation passed")
