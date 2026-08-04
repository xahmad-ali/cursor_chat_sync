# Cursor Chat Sync

VS Code / Cursor extension that syncs AI chat threads between devices. Cross-platform, zero runtime dependencies.

## Commands

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:

- **Cursor Sync: Export Chat History** — save chat threads to a transferable file
- **Cursor Sync: Import Chat History** — load chat threads from an exported file

## How it works

1. Open the same project on the source device and run **Export Chat History**. Pick a folder; a `Cursor_Chat_Backup` is written there (chat DB, retrieval index, and images if present).
2. Copy that backup folder to the other device.
3. Open the same project on the target device and run **Import Chat History**. Point it at the backup folder.

Only the current project's workspace storage is touched — global storage (login and other chats) is left alone.
