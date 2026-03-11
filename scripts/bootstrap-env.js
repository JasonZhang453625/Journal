const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env");
const envExamplePath = path.join(root, ".env.example");

if (!fs.existsSync(envExamplePath)) {
  console.error(".env.example not found.");
  process.exit(1);
}

if (fs.existsSync(envPath)) {
  console.error(".env already exists. Delete it first if you want to regenerate.");
  process.exit(1);
}

const randomSecret = crypto.randomBytes(48).toString("hex");
const template = fs.readFileSync(envExamplePath, "utf8");
const output = template.replace("replace-this-with-a-long-random-secret", randomSecret);

fs.writeFileSync(envPath, output, "utf8");
console.log(".env created successfully.");
console.log("Remember to edit DOMAIN and LETSENCRYPT_EMAIL before deployment.");
