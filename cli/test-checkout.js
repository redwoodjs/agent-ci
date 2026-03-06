const { execSync } = require("child_process");
try {
  execSync("node /home/runner/_work/machinen/machinen/.github/actions/checkout/dist/index.js", {
    stdio: "inherit",
  });
} catch (e) {
  console.log(e.message);
}
