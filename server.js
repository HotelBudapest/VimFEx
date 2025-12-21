import http from "node:http";
import process from "node:process";
import { createReadStream } from "node:fs";
import path from "node:path";
import { promises as fs } from "node:fs";

const server = http.createServer(async (req, res) => {
    const ROOT = process.cwd();
    console.log(req.url);
    if (req.method === "GET" && req.url === "/favicon.ico") {
        res.writeHead(204); // No Content
        res.end();
        return;
    }
    if (req.method === "GET" && req.url === "/") {
        const getRootDir = () => path.parse(process.cwd()).root;
        console.log(getRootDir())
        const htmlPath = path.join(process.cwd(), "index.html");
        const html = await fs.readFile(htmlPath, "utf-8");

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
    }

    if (req.method === "GET" && req.url.startsWith("/api/list")) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const path = url.searchParams.get("path");
        console.log(url);
        if (path === "/") {
            console.log("hi");
            const path = "/";
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




    if (req.method === "GET" && req.url.startsWith("/api/file")){
        const url = new URL(req.url, `http://${req.headers.host}`);
        const n_path = url.searchParams.get("path");

        const ext = path.extname(n_path).toLowerCase();
        const stat = await fs.stat(n_path);
        const contentType =
            ext === ".pdf" ? "application/pdf" :
            ext === ".txt" ? "text/plain; charset=utf-8" :
            "application/octet-stream";

        res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": stat.size,
        });

        createReadStream(n_path).pipe(res);
        return;
    }
});

server.listen(3000, () => {
    console.log("listening");
});
