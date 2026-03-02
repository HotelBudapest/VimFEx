import http from "node:http";
import os from "node:os";
import process from "node:process";
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs";
import path from "node:path";
import { promises as fs } from "node:fs";
import util from "util";

async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf-8").trim();
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new Error("Invalid JSON body");
    }
}

function sanitizeNoteName(name) {
    const clean = (name || "").replace(/[\r\n]/g, "").trim();
    const base = path.basename(clean);
    if (!base || base === "." || base === "..") return "";
    if (base.includes("/") || base.includes("\\"))
        return "";
    return base;
}

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

    if (req.method === "GET" && req.url === "/index.js") {
        const p = path.join(process.cwd(), "index.js");
        const js = await fs.readFile(p, "utf-8");
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
        res.end(js);
        return;
    }

    // Serve PDF.js (ESM build) from node_modules
    if (req.method === "GET" && req.url === "/vendor/pdfjs/pdf.mjs") {
        const p = path.join(process.cwd(), "node_modules", "pdfjs-dist", "build", "pdf.mjs");
        const js = await fs.readFile(p, "utf-8");
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
        res.end(js);
        return;
    }

    if (req.method === "GET" && req.url === "/vendor/pdfjs/pdf.worker.mjs") {
        const p = path.join(process.cwd(), "node_modules", "pdfjs-dist", "build", "pdf.worker.mjs");
        const js = await fs.readFile(p, "utf-8");
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
        res.end(js);
        return;
    }

    if (req.method === "GET" && req.url === "/vendor/pdfjs/pdf_viewer.mjs") {
        const p = path.join(process.cwd(), "node_modules", "pdfjs-dist", "web", "pdf_viewer.mjs");
        const js = await fs.readFile(p, "utf-8");
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
        res.end(js);
        return;
    }

    async function searchRecursive(baseDir, q, out, limit=200){
      const qlc = q.toLowerCase();
      let entries;
      try {
        entries = await fs.readdir(baseDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const e of entries){
        if (out.length >= limit) return;

        const full = path.join(baseDir, e.name);
        const nameLc = e.name.toLowerCase();

        if (nameLc.includes(qlc)){
          out.push({ path: full, type: e.isDirectory() ? "dir" : "file" });
          if (out.length >= limit) return;
        }

        if (e.isDirectory()){
          // optional: skip hidden dirs for speed
          if (e.name.startsWith(".")) continue;
          await searchRecursive(full, q, out, limit);
          if (out.length >= limit) return;
        }
      }
    }

    if (req.method === "GET" && req.url.startsWith("/api/search")) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const base = url.searchParams.get("path") || "/";
      const q = (url.searchParams.get("q") || "").trim();

      if (!q){
        res.writeHead(400, {"Content-Type":"application/json"});
        res.end(JSON.stringify({ error: "Missing q" }));
        return;
      }

      const matches = [];
      await searchRecursive(base, q, matches, 200);

      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ base, q, matches }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/note") {
        try {
            const body = await readJsonBody(req);
            const dir = (body.dir || "").trim();
            let requestedName = sanitizeNoteName(body.name || "");

            if (!dir) {
                res.writeHead(400, {"Content-Type":"application/json"});
                res.end(JSON.stringify({ error: "Missing dir" }));
                return;
            }

            if (body.name && !requestedName) {
                res.writeHead(400, {"Content-Type":"application/json"});
                res.end(JSON.stringify({ error: "Invalid filename" }));
                return;
            }

            const resolvedDir = path.resolve(dir);
            let stat;
            try {
                stat = await fs.stat(resolvedDir);
            } catch {
                stat = null;
            }
            if (!stat || !stat.isDirectory()) {
                res.writeHead(400, {"Content-Type":"application/json"});
                res.end(JSON.stringify({ error: "Invalid dir" }));
                return;
            }

            if (!requestedName) {
                const now = new Date();
                const parts = [
                    now.getFullYear(),
                    String(now.getMonth() + 1).padStart(2, "0"),
                    String(now.getDate()).padStart(2, "0"),
                    String(now.getHours()).padStart(2, "0"),
                    String(now.getMinutes()).padStart(2, "0"),
                    String(now.getSeconds()).padStart(2, "0"),
                ];
                requestedName = `note-${parts.join("")}.txt`;
            }

            if (!requestedName.toLowerCase().endsWith(".txt")) {
                requestedName = `${requestedName}.txt`;
            }

            const baseName = requestedName;
            let finalName = baseName;
            let candidatePath = path.join(resolvedDir, finalName);

            if (body.name) {
                try {
                    await fs.access(candidatePath);
                    res.writeHead(409, {"Content-Type":"application/json"});
                    res.end(JSON.stringify({ error: "File already exists" }));
                    return;
                } catch {
                    // ok to create
                }
            } else {
                let counter = 1;
                while (true) {
                    try {
                        await fs.access(candidatePath);
                        const suffix = `-${counter++}`;
                        finalName = baseName.replace(/\.txt$/i, `${suffix}.txt`);
                        candidatePath = path.join(resolvedDir, finalName);
                    } catch {
                        break;
                    }
                }
            }

            await fs.writeFile(candidatePath, "", { encoding: "utf-8", flag: "w" });

            res.writeHead(200, {"Content-Type":"application/json"});
            res.end(JSON.stringify({ path: candidatePath, name: finalName }));
        } catch (err) {
            res.writeHead(400, {"Content-Type":"application/json"});
            res.end(JSON.stringify({ error: err.message || "Failed to create note" }));
        }
        return;
    }

    if (req.method === "POST" && req.url === "/api/write-text") {
        try {
            const body = await readJsonBody(req);
            const filePath = (body.path || "").trim();
            const content = typeof body.content === "string" ? body.content : "";

            if (!filePath) {
                res.writeHead(400, {"Content-Type":"application/json"});
                res.end(JSON.stringify({ error: "Missing path" }));
                return;
            }

            if (path.extname(filePath).toLowerCase() !== ".txt") {
                res.writeHead(400, {"Content-Type":"application/json"});
                res.end(JSON.stringify({ error: "Only .txt files supported" }));
                return;
            }

            await fs.writeFile(filePath, content, "utf-8");
            res.writeHead(200, {"Content-Type":"application/json"});
            res.end(JSON.stringify({ path: filePath, bytes: Buffer.byteLength(content, "utf-8") }));
        } catch (err) {
            res.writeHead(500, {"Content-Type":"application/json"});
            res.end(JSON.stringify({ error: err.message || "Failed to write file" }));
        }
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
