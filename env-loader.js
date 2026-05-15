const fs = require("fs");
const lines = fs.readFileSync(".env", "utf8").split("\n");
for (const line of lines) {
  const [key, ...rest] = line.split("=");
  if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
}
