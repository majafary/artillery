const http = require("http");
const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "server.log");

// Clear log on start
fs.writeFileSync(LOG_FILE, "=== Mock Server Started ===\n");

let requestCount = 0;

const server = http.createServer((req, res) => {
  requestCount++;
  const reqNum = requestCount;

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    // Random delay between 200-500ms
    const delay = Math.floor(Math.random() * 300) + 200;

    setTimeout(() => {
      const timestamp = new Date().toISOString();
      const logEntry = `REQ ${String(reqNum).padStart(
        3,
        "0"
      )} | ${timestamp} | ${delay}ms | ${req.method} ${
        req.url
      } | BODY: ${body}\n`;

      fs.appendFileSync(LOG_FILE, logEntry);
      console.log(
        `REQ ${reqNum} | ${delay}ms | Body: ${body.substring(0, 80)}`
      );

      // Return 201 for all requests
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: "tok-" + reqNum,
          refresh_token: "ref-" + reqNum,
          response_type_code: "SUCCESS",
        })
      );
    }, delay);
  });
});

server.listen(3000, () => {
  console.log("Mock server running on http://localhost:3000");
  console.log("Response delay: 200-500ms");
  console.log("Response code: 201");
  console.log("Log file: " + LOG_FILE);
});
