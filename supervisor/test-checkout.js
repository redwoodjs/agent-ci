const { execSync } = require("child_process");
try {
  execSync(
    "node /home/runner/_work/opposite-actions/opposite-actions/.github/actions/checkout/dist/index.js",
    { stdio: "inherit" },
  );
} catch (e) {
  console.log(e.message);
}
