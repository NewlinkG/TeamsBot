const fs = require("fs");
const path = require("path");

module.exports = async function (context, req) {
  const fileName = req.params.file;

  // Default to index.html
  let filePath = path.join(__dirname, "../tabs-portal", fileName || "index.html");

  // If the file does not exist or is a route (like 'comment'), fallback to index.html
  if (!fileName || !fs.existsSync(filePath)) {
    filePath = path.join(__dirname, "../tabs-portal/index.html");
  }

  const contentType = filePath.endsWith(".js")
    ? "application/javascript"
    : filePath.endsWith(".css")
    ? "text/css"
    : filePath.endsWith(".json")
    ? "application/json"
    : "text/html";

  const content = fs.readFileSync(filePath);
  context.res = {
    status: 200,
    headers: { "Content-Type": contentType },
    body: content
  };
};
