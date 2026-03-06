const { execSync } = require("child_process");
try {
  const env = Object.assign({}, process.env, { PATH: __dirname + ":/usr/bin:/bin" });
  execSync("node /home/runner/_work/machinen/machinen/.github/actions/checkout/dist/index.js", {
    stdio: "inherit",
    env,
  });
} catch (e) {
  console.log("Failed with error:", e.message);
}
