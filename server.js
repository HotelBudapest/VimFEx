import http from "node:http";
import process from "node:process";
import path from "node:path";
import { promises as fs } from "node:fs";

const server = http.createServer(async (req, res) => {
    const ROOT = process.cwd();
    if (req.method === "GET" && req.url === "/favicon.ico") {
        res.writeHead(204); // No Content
        res.end();
        return;
    }
    if (req.method === "GET" && req.url === "/") {
        const htmlPath = path.join(process.cwd(), "index.html");
        const html = await fs.readFile(htmlPath, "utf-8");

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
    }

    if (req.method === "GET") {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const path = url.searchParams.get("path");
        console.log(path);
        if (path === "/") {
            console.log("hi");
            const path = process.cwd();
            res.writeHead(200, {"Content-Type": "application/json"});
            const files = await fs.readdir(path, { withFileTypes: true });

            // const items = files.map(e => ({
            //   name: e.name,
            //   type: e.isDirectory() ? "dir" : "file"
            // }));

            const items = [];

            let i = 0;
            files.forEach(e => {
                const item = {};
                if (e.isDirectory()) {
                    item.name = e.name;
                    item.type = "dir";
                } else {
                    item.name = e.name;
                    item.type = "file";
                }
                items[i] = item;
                i += 1;
            });

            console.log(items)

            res.end(JSON.stringify({ path, items}));
            return;
        }
        res.writeHead(200, {"Content-Type": "application/json"});
        const files = await fs.readdir(path, { withFileTypes: true });
        const items = files.map(e => ({
          name: e.name,
          type: e.isDirectory() ? "dir" : "file"
        }));
        res.end(JSON.stringify({ path, items}));
        return;
    }
});

server.listen(3000, () => {
    console.log("listening");
});
