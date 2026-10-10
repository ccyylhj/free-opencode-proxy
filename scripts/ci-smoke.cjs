// CI boot check for the packaged exe. Needs NO login and NO npm:
// spawns PROXY_BIN and passes if it boots far enough to either list models
// or fail cleanly on the opencode backend (both prove the SEA binary runs).
// Real functional tests (chat 200/403) happen on a logged-in machine.
const { spawn } = require("child_process");

const bin = process.env.PROXY_BIN;
const port = process.env.PROXY_PORT || "6450";
if (!bin) {
  console.error("PROXY_BIN env required");
  process.exit(1);
}

const p = spawn(bin, [], {
  env: { ...process.env, PROXY_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
let finished = false;
const finish = (code, msg) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  console.log(msg);
  try { p.kill("SIGKILL"); } catch {}
  setTimeout(() => process.exit(code), 1000);
};
const timer = setTimeout(() => finish(1, "SMOKE FAIL: timeout\n" + out.slice(-800)), 120000);

p.stdout.on("data", (d) => { out += d.toString(); check(); });
p.stderr.on("data", (d) => { out += d.toString(); });
p.on("error", (e) => {
  if (!finished) finish(1, "SPAWN ERROR: " + e.message);
});
p.on("exit", (code, signal) => {
  if (!finished) {
    finish(
      out.includes("Failed to start opencode backend:") ? 0 : 1,
      `exited(code=${code} signal=${signal}) tail:\n` + out.slice(-800)
    );
  }
});

function check() {
  if (!out.includes(`oc-api-proxy on http://0.0.0.0:${port}`)) return;
  if (/Models \((free only|allowlist|all)\):/.test(out)) {
    finish(0, "BOOT OK (backend up, models listed)");
  }
}
