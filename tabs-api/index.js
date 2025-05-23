const fs = require("fs");
const path = require("path");

module.exports = async function (context, req) {
  let filePath = path.join(__dirname, "../tabs-portal", req.params.file || "index.html");

  if (!fs.existsSync(filePath)) {
    context.res = {
      status: 404,
      body: "Not found"
    };
    return;
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
