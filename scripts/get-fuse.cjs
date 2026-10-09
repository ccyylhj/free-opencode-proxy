// Prints the NODE_SEA_FUSE_* sentinel found in the local node.exe,
// so build-win.bat works across Node versions (the fuse changes between releases).
const fs = require("fs");
const data = fs.readFileSync(process.execPath);
const m = data.toString("binary").match(/NODE_SEA_FUSE_[0-9a-f]+/);
if (!m) {
  console.error("sentinel fuse not found in " + process.execPath);
  process.exit(1);
}
console.log(m[0]);
