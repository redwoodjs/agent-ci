const { execSync } = require("child_process");
const repoRoot = execSync(`git rev-parse --show-toplevel`).toString().trim();
console.log("repoRoot:", repoRoot);
const buf = execSync(`git ls-files --cached --others --exclude-standard -z`, {
  cwd: repoRoot,
  env: { PATH: process.env.PATH },
});
const files = buf.toString("utf8").split("\0");
console.log("ls-files sample:", files.slice(0, 5));
console.log("has package.json at root?", files.includes("package.json"));
