const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const sourceData = path.join(root, "data");
const sourceUploads = path.join(root, "uploads");
const backupRoot = path.join(root, "backups");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const targetDir = path.join(backupRoot, timestamp);

fs.mkdirSync(targetDir, { recursive: true });

copyIfExists(sourceData, path.join(targetDir, "data"));
copyIfExists(sourceUploads, path.join(targetDir, "uploads"));

console.log(`Backup created: ${targetDir}`);

function copyIfExists(source, target) {
  if (!fs.existsSync(source)) {
    return;
  }
  fs.cpSync(source, target, { recursive: true });
}
