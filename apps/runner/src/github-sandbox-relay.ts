// gh's documented http_unix_socket transport sends ordinary HTTP with the original
// Host header. Git's HTTPS transport helper connects through loopback. Neither needs a provider token
// or a custom TLS trust store; only this relay knows the attempt-scoped broker ticket.
export const githubSandboxRelayScript = String.raw`import base64
import hmac
import http.client
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import threading
import time
import urllib.parse

MAX_BODY = 128 * 1024 * 1024
HOSTS = {"github.com", "api.github.com", "uploads.github.com"}
DROP_HEADERS = {"authorization", "proxy-authorization", "cookie", "host", "connection", "transfer-encoding", "content-length", "accept-encoding", "x-opencompany-github-ticket"}

class Relay(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def fail(self, status, message):
        body = json.dumps({"message": message}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def read_body(self):
        encoding = self.headers.get("Transfer-Encoding", "").lower()
        if encoding and encoding != "chunked":
            raise ValueError("Unsupported transfer encoding")
        if encoding:
            body = bytearray()
            while True:
                line = self.rfile.readline(1024)
                size = int(line.split(b";", 1)[0].strip(), 16)
                if size < 0 or size + len(body) > MAX_BODY:
                    raise ValueError("GitHub request exceeds 128 MiB")
                if not size:
                    # Consume bounded trailer lines, without forwarding them.
                    for _ in range(100):
                        if self.rfile.readline(8192) == b"\r\n":
                            return bytes(body)
                    raise ValueError("Invalid request trailers")
                part = self.rfile.read(size)
                if len(part) != size or self.rfile.read(2) != b"\r\n":
                    raise ValueError("Incomplete request body")
                body.extend(part)
        size = int(self.headers.get("Content-Length", "0"))
        if size < 0 or size > MAX_BODY:
            raise ValueError("GitHub request exceeds 128 MiB")
        body = self.rfile.read(size)
        if len(body) != size:
            raise ValueError("Incomplete request body")
        return body

    def relay(self):
        connection = None
        started = False
        try:
            self.connection.settimeout(600)
            token = self.server.config["localToken"]
            auth = self.headers.get("Authorization", "")
            basic = "Basic " + base64.b64encode(("x-access-token:" + token).encode()).decode()
            if (self.server.git_transport or self.headers.get("Host", "").lower() in HOSTS) and not any(hmac.compare_digest(auth, expected) for expected in ["token " + token, "Bearer " + token, basic]):
                self.fail(401, "Invalid sandbox GitHub capability")
                return
            host = self.headers.get("Host", "").lower()
            git = self.server.git_transport
            if git:
                if not self.path.startswith("/git/"):
                    self.fail(400, "Invalid Git relay path")
                    return
                host = "github.com"
                path = "/" + self.path[len("/git/"):]
            else:
                path = self.path
            if not path.startswith("/") or path.startswith("//"):
                self.fail(400, "Invalid GitHub request path")
                return
            body = self.read_body()
            headers = {k: v for k, v in self.headers.items() if k.lower() not in DROP_HEADERS}
            headers["Accept-Encoding"] = "identity"
            if host in HOSTS:
                target = urllib.parse.urlsplit(self.server.config["brokerUrl"])
                headers["x-opencompany-github-ticket"] = self.server.config["ticket"]
                connection_type = http.client.HTTPSConnection if target.scheme == "https" else http.client.HTTPConnection
                connection = connection_type(target.hostname, target.port, timeout=600)
                target_path = target.path.rstrip("/") + "/broker/github/" + host + path
            elif not git and re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+", host):
                # Signed download redirects go directly from the sandbox without either
                # the broker ticket or provider auth. The runner is not an open proxy.
                connection = http.client.HTTPSConnection(host, timeout=600)
                target_path = path
            else:
                self.fail(400, "Unsupported GitHub relay host")
                return
            connection.request(self.command, target_path, body=body, headers=headers)
            response = connection.getresponse()
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() in {"connection", "keep-alive", "proxy-authenticate", "transfer-encoding", "content-length", "set-cookie", "trailer", "upgrade"}:
                    continue
                if git and name.lower() == "location":
                    location = urllib.parse.urlsplit(urllib.parse.urljoin("https://github.com" + path, value))
                    if location.scheme == "https" and location.netloc == "github.com":
                        value = self.server.git_origin + "/git" + location.path
                        if location.query:
                            value += "?" + location.query
                self.send_header(name, value)
            self.send_header("Connection", "close")
            self.end_headers()
            started = True
            self.close_connection = True
            if self.command != "HEAD":
                while True:
                    chunk = response.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (ValueError, OverflowError):
            if not started:
                self.fail(400, "Invalid or oversized GitHub relay request")
        except Exception:
            if not started:
                self.fail(502, "GitHub relay request failed")
        finally:
            if connection:
                connection.close()

    do_GET = do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = relay

class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    def handle_error(self, *_):
        pass

class TcpServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    def handle_error(self, *_):
        pass

root = os.path.dirname(os.path.abspath(sys.argv[1]))
with open(sys.argv[1]) as file:
    config = json.load(file)
os.umask(0o077)
unix = UnixServer(os.path.join(root, "http.sock"), Relay)
tcp = TcpServer(("127.0.0.1", 0), Relay)
origin = "http://127.0.0.1:" + str(tcp.server_address[1])
# Override only the HTTPS remote helper. Rewriting repository URLs in Git config
# would also rewrite "git remote -v" and break gh's repository discovery.
original_exec = subprocess.check_output(["git", "--exec-path"], text=True).strip()
git_core = os.path.join(root, "git-core")
os.mkdir(git_core)
for name in os.listdir(original_exec):
    os.symlink(os.path.join(original_exec, name), os.path.join(git_core, name))
helper_path = os.path.join(git_core, "git-remote-https")
os.unlink(helper_path)
helper = """#!/usr/bin/env python3
import os, sys, urllib.parse
args = sys.argv[1:]
if len(args) >= 2:
    url = urllib.parse.urlsplit(args[1])
    if url.scheme == "https" and url.hostname == "github.com" and url.port in (None, 443):
        args[1] = ORIGIN + "/git" + url.path + (("?" + url.query) if url.query else "")
os.execv(REAL_HELPER, [REAL_HELPER] + args)
""".replace("ORIGIN", repr(origin)).replace("REAL_HELPER", repr(os.path.join(original_exec, "git-remote-https")))
with open(helper_path, "w") as file:
    file.write(helper)
os.chmod(helper_path, 0o700)
for server, git in [(unix, False), (tcp, True)]:
    server.config = config
    server.git_transport = git
    server.git_origin = origin
    threading.Thread(target=server.serve_forever, daemon=True).start()
with open(os.path.join(root, "ready.tmp"), "w") as file:
    json.dump({"port": tcp.server_address[1]}, file)
os.replace(os.path.join(root, "ready.tmp"), os.path.join(root, "ready.json"))
# A crashed runner cannot run cleanup. Bound the orphan's lifetime independently.
time.sleep(config["lifetimeSeconds"])
shutil.rmtree(root)
`;
