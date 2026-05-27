# Mergiraf Setup Guide

Mergiraf is an AST-aware merge driver that resolves approximately 50% of merge conflicts that git's line-based algorithm cannot handle. It is particularly valuable for parallel agent workflows where multiple agents modify the same files concurrently.

## Why Agents Need Mergiraf

When running multiple agents in parallel, common scenarios produce merge conflicts with standard git:

- Two agents adding imports to the same file
- Two agents adding functions in the same region of a file
- Two agents modifying adjacent lines in configuration files

Mergiraf understands the syntax tree of each file type and can automatically resolve these structural conflicts, cutting human intervention on merge conflicts roughly in half.

## Installation

### macOS (Homebrew)

```bash
brew install mergiraf
```

### Linux

Download the latest binary from the [Codeberg releases](https://codeberg.org/mergiraf/mergiraf/releases), or install via Cargo:

```bash
cargo install mergiraf
```

### Any Platform (Cargo)

Requires the Rust toolchain:

```bash
cargo install mergiraf
```

### Verify Installation

```bash
mergiraf --version
```

## Configuration

### Automatic (Recommended)

Use the AgentFactory CLI to configure mergiraf:

```bash
# Configure for the entire repository
af-setup mergiraf

# Configure only for agent worktrees (recommended)
af-setup mergiraf --worktree-only

# Preview changes without modifying anything
af-setup mergiraf --dry-run
```

### Manual Configuration

If you prefer to configure mergiraf manually, two things need to be set up:

#### 1. Git Attributes

Create or update `.gitattributes` in your repository root:

```gitattributes
# AST-aware merge driver for supported file types
*.ts merge=mergiraf
*.tsx merge=mergiraf
*.js merge=mergiraf
*.jsx merge=mergiraf
*.mjs merge=mergiraf
*.json merge=mergiraf
*.yaml merge=mergiraf
*.yml merge=mergiraf
*.py merge=mergiraf
*.go merge=mergiraf
*.rs merge=mergiraf
*.java merge=mergiraf
*.css merge=mergiraf
*.html merge=mergiraf
```

#### 2. Git Merge Driver

Register the mergiraf merge driver in your git configuration:

```bash
git config merge.mergiraf.name "mergiraf"
git config merge.mergiraf.driver "mergiraf merge --git %O %A %B -s %S -x %X -y %Y -p %P"
```

Or equivalently as a one-liner:

```bash
git config merge.mergiraf.driver "mergiraf merge --git %O %A %B -s %S -x %X -y %Y -p %P"
```

## Lock File Strategy

Lock files should use the `merge=ours` strategy -- keep the current version and regenerate after merge:

```gitattributes
pnpm-lock.yaml merge=ours
package-lock.json merge=ours
yarn.lock merge=ours
```

After merging, regenerate the lock file:

```bash
pnpm install   # or npm install / yarn install
```

## AgentFactory Integration

Mergiraf integrates with AgentFactory at multiple levels:

### Repository Configuration

Set `mergeDriver: 'mergiraf'` in `.donmai/config.yaml` to auto-configure new agent worktrees:

```yaml
apiVersion: v1
kind: RepositoryConfig
mergeDriver: mergiraf
```

### Orchestrator

The orchestrator automatically configures mergiraf via worktree-local git config (`git config --worktree`) in each new agent worktree when `mergeDriver` is set to `mergiraf` in the repository config. If mergiraf is not installed, it falls back silently to the default git merge driver.

### Merge Workflow

The merge workflow template references mergiraf for conflict resolution during branch merges and rebases.

## Supported Languages

| Language | Extensions | AST Support |
|------------|------------------|-------------|
| TypeScript | `.ts`, `.tsx` | Full |
| JavaScript | `.js`, `.jsx` | Full |
| JSON | `.json` | Full |
| YAML | `.yaml`, `.yml` | Full |
| Python | `.py` | Full |
| Go | `.go` | Full |
| Rust | `.rs` | Full |
| Java | `.java` | Full |
| CSS | `.css` | Full |
| HTML | `.html` | Full |

## Temporarily Disabling

To bypass mergiraf for edge cases:

```bash
# Override the merge driver to git's built-in default for one operation
git -c merge.mergiraf.driver=true merge <branch>
```

Or disable in the repository configuration:

```yaml
# .donmai/config.yaml
mergeDriver: default
```

## Troubleshooting

### "mergiraf not found"

Ensure mergiraf is installed and on your PATH. See the [Installation](#installation) section above.

### Merge still fails after enabling mergiraf

Mergiraf resolves structural conflicts (e.g., two additions in the same region). It cannot resolve semantic conflicts (e.g., two different implementations of the same function). These still require manual resolution.

### Per-worktree config not working

Ensure git worktree config extensions are enabled:

```bash
git config extensions.worktreeConfig true
```

### Checking what mergiraf resolved

To see merge details after a merge operation:

```bash
git log --merge
```

## License

Mergiraf is licensed under GPLv3 and hosted on [Codeberg](https://codeberg.org/mergiraf/mergiraf). It is used as an external tool and is **not bundled** with AgentFactory. Users install it separately on their systems.
