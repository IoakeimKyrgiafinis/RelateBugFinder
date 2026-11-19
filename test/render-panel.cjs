// Renders the real webview HTML with a VS Code Dark+ palette for screenshots: node test/render-panel.cjs <state.json> <out.html>
const fs = require("fs"), path = require("path");
const [stateFile, outFile] = process.argv.slice(2);
let html = fs.readFileSync(path.join(__dirname, "panel.html"), "utf8").replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
const theme = `<style>:root{--vscode-font-family:-apple-system,Segoe UI,Ubuntu,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,Consolas,monospace;
--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-editor-background:#1e1e1e;--vscode-panel-border:#3c3c3c;--vscode-charts-red:#f14c4c;
--vscode-charts-orange:#d18616;--vscode-charts-blue:#3794ff;--vscode-textLink-foreground:#3794ff;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;
--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#fff;--vscode-inputValidation-errorBackground:#5a1d1d;--vscode-inputValidation-errorBorder:#be1100;
--vscode-input-background:#3c3c3c;--vscode-input-foreground:#ccc;--vscode-focusBorder:#007fd4}body{background:#1e1e1e;width:760px}</style>`;
const boot = `<script>window.acquireVsCodeApi=()=>({postMessage(){}});</script>`;
const fire = `<script>setTimeout(()=>window.postMessage(${fs.readFileSync(stateFile, "utf8")},"*"),0)</script>`;
html = html.replace("<head>", "<head>" + theme + boot).replace(/<script nonce="[^"]+">/, "<script>").replace("</body>", fire + "</body>");
fs.writeFileSync(outFile, html);
