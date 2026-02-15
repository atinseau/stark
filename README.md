# stark

An Agent Client Protocol (ACP) client implementation available in both TypeScript and Rust.

## TypeScript Implementation

The original implementation in TypeScript/Bun.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.6. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Rust Implementation

A Rust port of the TypeScript implementation, located in the `rust_implementation/` folder.

To build and run:

```bash
cd rust_implementation
cargo build --release
cargo run
```

See [rust_implementation/README.md](rust_implementation/README.md) for more details on the Rust version.

## Features

Both implementations provide:
- ACP protocol client for GitHub Copilot
- Beautiful colored terminal output
- File system operations (read/write)
- Terminal process management
- Permission handling
- Session management
- Real-time tool call tracking and logging
