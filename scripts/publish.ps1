# One-time publish to GitHub: public repo + required topics + v0.1.0 release with the 5 VSIX builds.
# Run from the repo folder, after `gh auth login` and after checking the README's AI paragraph:
#   powershell -ExecutionPolicy Bypass -File scripts\publish.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$repo = "RelateBugFinder"
$description = "Neo4j-Relate-Hackathon entry. Relate Bug Finder: a VS Code extension that ranks the functions behind a stack trace, even ones not on the stack, from a code graph + git history in embedded Neo4j Relate. Deep trace, blast radius, MCP tools for AI agents."

if (git status --porcelain) { throw "Uncommitted changes: commit them first." }
$vsix = Get-ChildItem dist-vsix\*.vsix -ErrorAction SilentlyContinue
if (@($vsix).Count -lt 5) { throw "Expected 5 files in dist-vsix. Run: npm run package:all" }

gh repo create $repo --public --source . --push --description $description
if ($LASTEXITCODE) { exit $LASTEXITCODE }
gh repo edit --add-topic relate --add-topic relate-neo4j-hackathon --add-topic neo4j --add-topic vscode-extension --add-topic mcp --add-topic debugging
if ($LASTEXITCODE) { exit $LASTEXITCODE }
gh release create v0.1.0 @($vsix.FullName) --title "Relate Bug Finder v0.1.0" --notes-file scripts\release-notes.md
if ($LASTEXITCODE) { exit $LASTEXITCODE }

gh repo view --json url,repositoryTopics --jq '.url + "  topics: " + ([.repositoryTopics[].name] | join(", "))'
