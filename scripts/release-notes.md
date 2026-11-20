Blast Radius for VS Code, built for the **Neo4j Relate Hackathon 2026**.

**Install** (pick your platform: `win32-x64`, `darwin-arm64` = Apple Silicon, `darwin-x64`, `linux-x64`, `linux-arm64`):

```
code --install-extension blast-radius-<platform>.vsix
```

Then follow the README's **"Try it in 3 minutes"** to create the demo project (`node demo/setup-demo.mjs demo-shop`) and walk through both scenes: the TypeScript crash whose cause is off the stack, and the Python test where Deep trace finds the function that returned the bad value.

Needs VS Code ≥ 1.101, Node.js ≥ 22.6 and git; Python ≥ 3.8 for the Python scene. Nothing else to install: Relate runs embedded in the extension.
