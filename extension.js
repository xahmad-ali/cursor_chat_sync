// cursor-chat-sync — extension.js  v0.0.8
// Syncs Cursor AI chat history for the current project between devices.
//
// HOW IT WORKS:
// Each project's chat history lives in a single file:
//   workspaceStorage/{hash}/state.vscdb
// The hash is the same across Mac and Windows for the same project path structure.
// We copy ONLY this file (+ retrieval index + images) — nothing else.
// globalStorage is NEVER touched — that would corrupt login and all other chats.
//
// Import on Windows uses a detached .bat script to bypass the SQLite file lock.

const vscode = require('vscode');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const cp     = require('child_process');

// ─────────────────────────────────────────────────────────────────────────────
function activate(context) {

    // ── EXPORT ───────────────────────────────────────────────────────────────
    const exportCmd = vscode.commands.registerCommand(
        'cursor-chat-sync.exportChat',
        async () => {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                vscode.window.showErrorMessage('Open a project folder first!');
                return;
            }

            const storagePath = getCursorStoragePath();
            const wsDir = findWorkspaceStorageDir(storagePath, workspaceFolders[0].uri.fsPath);

            if (!wsDir) {
                vscode.window.showErrorMessage(
                    "No Cursor storage found for this project yet.\n" +
                    "Open a chat in this project first, then try again."
                );
                return;
            }

            const dbPath = path.join(wsDir, 'state.vscdb');
            if (!fs.existsSync(dbPath)) {
                vscode.window.showErrorMessage(
                    "No chat database found for this project yet.\n" +
                    "Start a chat in this project first, then try again."
                );
                return;
            }

            // Pick export destination
            const targetUri = await vscode.window.showOpenDialog({
                canSelectFolders : true,
                canSelectFiles   : false,
                canSelectMany    : false,
                openLabel        : 'Select Export Location',
            });
            if (!targetUri || !targetUri.length) return;

            const dest = path.join(targetUri[0].fsPath, 'Cursor_Chat_Backup');
            fs.mkdirSync(dest, { recursive: true });

            // Copy state.vscdb only — this is the chat database
            fs.copyFileSync(dbPath, path.join(dest, 'state.vscdb'));

            // Copy retrieval index if present (codebase embeddings)
            const srcVec = path.join(wsDir, 'anysphere.cursor-retrieval');
            if (fs.existsSync(srcVec)) {
                copyDirRecursive(srcVec, path.join(dest, 'anysphere.cursor-retrieval'));
            }

            // Copy images folder if present (images attached to chats)
            const srcImages = path.join(wsDir, 'images');
            if (fs.existsSync(srcImages)) {
                copyDirRecursive(srcImages, path.join(dest, 'images'));
            }

            vscode.window.showInformationMessage(
                '✅ Export complete!\n' +
                'Backup saved to: ' + dest + '\n\n' +
                'Transfer the Cursor_Chat_Backup folder to your other device.'
            );
        }
    );

    // ── IMPORT ───────────────────────────────────────────────────────────────
    const importCmd = vscode.commands.registerCommand(
        'cursor-chat-sync.importChat',
        async () => {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                vscode.window.showErrorMessage('Open your target project folder first!');
                return;
            }

            // Pick the backup folder
            const sourceUri = await vscode.window.showOpenDialog({
                canSelectFolders : true,
                canSelectFiles   : false,
                canSelectMany    : false,
                openLabel        : 'Select Cursor_Chat_Backup Folder',
            });
            if (!sourceUri || !sourceUri.length) return;

            const backupDir = sourceUri[0].fsPath;

            // Validate — must contain state.vscdb
            if (!fs.existsSync(path.join(backupDir, 'state.vscdb'))) {
                vscode.window.showErrorMessage(
                    'No state.vscdb found in the selected folder.\n' +
                    'Make sure you selected the Cursor_Chat_Backup folder itself.'
                );
                return;
            }

            // Find destination workspace storage slot
            const storagePath = getCursorStoragePath();
            const destDir = findWorkspaceStorageDir(storagePath, workspaceFolders[0].uri.fsPath);

            if (!destDir) {
                vscode.window.showErrorMessage(
                    'No storage slot found for this project.\n' +
                    'Open this project in Cursor at least once first, then try again.'
                );
                return;
            }

            // Platform-specific import
            if (process.platform === 'win32') {
                await runWindowsSwap(backupDir, destDir);
            } else {
                await runUnixSwap(backupDir, destDir);
            }
        }
    );

    context.subscriptions.push(exportCmd, importCmd);
}

// ─────────────────────────────────────────────────────────────────────────────
// WINDOWS — detached .bat swap script to bypass SQLite file lock
// ─────────────────────────────────────────────────────────────────────────────
async function runWindowsSwap(backupDir, destDir) {

    const batPath    = path.join(os.tmpdir(), 'cursor_sync_swap.bat');
    const srcDb      = path.join(backupDir, 'state.vscdb');
    const destDb     = path.join(destDir,   'state.vscdb');
    const destWal    = path.join(destDir,   'state.vscdb-wal');
    const destShm    = path.join(destDir,   'state.vscdb-shm');
    const srcVec     = path.join(backupDir, 'anysphere.cursor-retrieval');
    const destVec    = path.join(destDir,   'anysphere.cursor-retrieval');
    const srcImages  = path.join(backupDir, 'images');
    const destImages = path.join(destDir,   'images');

    // Cursor executable locations (standard installs)
    const cursorExe1 = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Cursor', 'Cursor.exe');
    const cursorExe2 = path.join(process.env.PROGRAMFILES || '', 'Cursor', 'Cursor.exe');

    const lines = [
        '@echo off',
        'echo [cursor-chat-sync] Waiting for Cursor to close...',
        'timeout /t 3 /nobreak >nul',

        ':: Delete stale WAL and SHM so SQLite starts clean',
        `if exist "${destWal}" del /f /q "${destWal}"`,
        `if exist "${destShm}" del /f /q "${destShm}"`,

        ':: Copy state.vscdb — retry until lock is released',
        ':RETRY',
        `copy /y "${srcDb}" "${destDb}" >nul 2>&1`,
        'if errorlevel 1 (',
        '    echo [cursor-chat-sync] File still locked, retrying...',
        '    timeout /t 2 /nobreak >nul',
        '    goto RETRY',
        ')',

        ':: Copy retrieval index if present',
        `if exist "${srcVec}" (`,
        `    if not exist "${destVec}" mkdir "${destVec}"`,
        `    robocopy "${srcVec}" "${destVec}" /e /is /it >nul 2>&1`,
        ')',

        ':: Copy images if present',
        `if exist "${srcImages}" (`,
        `    if not exist "${destImages}" mkdir "${destImages}"`,
        `    robocopy "${srcImages}" "${destImages}" /e /is /it >nul 2>&1`,
        ')',

        ':: Relaunch Cursor',
        'echo [cursor-chat-sync] Done. Relaunching Cursor...',
        `if exist "${cursorExe1}" (`,
        `    start "" "${cursorExe1}"`,
        `) else if exist "${cursorExe2}" (`,
        `    start "" "${cursorExe2}"`,
        ') else (',
        '    start "" cursor',
        ')',

        ':: Self-delete',
        `del /f /q "${batPath}"`,
    ];

    fs.writeFileSync(batPath, lines.join('\r\n'), 'utf8');

    const choice = await vscode.window.showWarningMessage(
        '⚠️  Cursor needs to restart to import the chat history.\n\n' +
        'It will close, copy the files, and relaunch automatically.\n\n' +
        'Save your work first, then click Proceed.',
        { modal: true },
        'Proceed'
    );

    if (choice !== 'Proceed') {
        fs.unlinkSync(batPath);
        return;
    }

    // Launch .bat fully detached so it survives after Cursor exits
    cp.spawn('cmd.exe', ['/c', batPath], {
        detached    : true,
        stdio       : 'ignore',
        windowsHide : false,
    }).unref();

    await sleep(500);
    vscode.commands.executeCommand('workbench.action.quit');
}

// ─────────────────────────────────────────────────────────────────────────────
// macOS / Linux — detached shell script swap
// ─────────────────────────────────────────────────────────────────────────────
async function runUnixSwap(backupDir, destDir) {

    const shPath     = path.join(os.tmpdir(), 'cursor_sync_swap.sh');
    const srcDb      = path.join(backupDir, 'state.vscdb');
    const destDb     = path.join(destDir,   'state.vscdb');
    const destWal    = path.join(destDir,   'state.vscdb-wal');
    const destShm    = path.join(destDir,   'state.vscdb-shm');
    const srcVec     = path.join(backupDir, 'anysphere.cursor-retrieval');
    const destVec    = path.join(destDir,   'anysphere.cursor-retrieval');
    const srcImages  = path.join(backupDir, 'images');
    const destImages = path.join(destDir,   'images');

    const lines = [
        '#!/usr/bin/env bash',
        'echo "[cursor-chat-sync] Waiting for Cursor to release locks..."',
        'sleep 3',

        '# Remove stale WAL/SHM',
        `rm -f "${destWal}"`,
        `rm -f "${destShm}"`,

        '# Copy state.vscdb — retry up to 8 times',
        'for i in $(seq 1 8); do',
        `    cp "${srcDb}" "${destDb}" 2>/dev/null && break`,
        '    echo "[cursor-chat-sync] Locked, retrying..." && sleep 2',
        'done',

        '# Copy retrieval index',
        `[ -d "${srcVec}" ] && cp -r "${srcVec}/." "${destVec}/"`,

        '# Copy images',
        `[ -d "${srcImages}" ] && cp -r "${srcImages}/." "${destImages}/"`,

        '# Relaunch Cursor',
        'echo "[cursor-chat-sync] Done. Relaunching Cursor..."',
        process.platform === 'darwin' ? 'open -a Cursor' : 'nohup cursor . &',

        '# Self-delete',
        `rm -f "${shPath}"`,
    ];

    fs.writeFileSync(shPath, lines.join('\n'), 'utf8');
    fs.chmodSync(shPath, 0o755);

    const choice = await vscode.window.showWarningMessage(
        '⚠️  Cursor needs to restart to import the chat history.\n\n' +
        'It will close, copy the files, and relaunch automatically.\n\n' +
        'Save your work first, then click Proceed.',
        { modal: true },
        'Proceed'
    );

    if (choice !== 'Proceed') {
        fs.unlinkSync(shPath);
        return;
    }

    cp.spawn('/bin/bash', [shPath], { detached: true, stdio: 'ignore' }).unref();
    await sleep(500);
    vscode.commands.executeCommand('workbench.action.quit');
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function getCursorStoragePath() {
    const home = os.homedir();
    if (process.platform === 'win32') {
        return path.join(process.env.APPDATA || '', 'Cursor', 'User', 'workspaceStorage');
    } else if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage');
    } else {
        return path.join(home, '.config', 'Cursor', 'User', 'workspaceStorage');
    }
}

function findWorkspaceStorageDir(storagePath, projectFsPath) {
    const target    = path.normalize(projectFsPath).toLowerCase();
    const isWindows = process.platform === 'win32';
    const isMac     = process.platform === 'darwin';

    let exactMatch  = '';
    let substrMatch = '';

    for (const folder of fs.readdirSync(storagePath)) {
        const jsonPath = path.join(storagePath, folder, 'workspace.json');
        if (!fs.existsSync(jsonPath)) continue;
        try {
            const { folder: uri } = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            if (!uri) continue;

            // Skip folders that belong to the wrong OS.
            // On Windows: reject Mac-style paths like file:///Users/apple/...
            // On Mac: reject Windows-style paths like file:///d%3A/...
            const uriLower = uri.toLowerCase();
            if (isWindows && uriLower.match(/file:\/\/\/users\//)) continue;
            if (isMac    && uriLower.match(/file:\/\/\/[a-z](%3a|:)\//)) continue;

            const candidate = normalizePath(uri);

            if (target === candidate) {
                exactMatch = path.join(storagePath, folder);
                break; // exact match wins immediately
            }

            if (!substrMatch && (target.includes(candidate) || candidate.includes(target))) {
                substrMatch = path.join(storagePath, folder);
            }
        } catch (_) { /* skip unreadable */ }
    }

    return exactMatch || substrMatch;
}

function copyDirRecursive(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src,  entry.name);
        const d = path.join(dest, entry.name);
        entry.isDirectory() ? copyDirRecursive(s, d) : fs.copyFileSync(s, d);
    }
}

function normalizePath(inputPath) {
    if (!inputPath) return '';
    let p = decodeURIComponent(inputPath);
    p = p.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
    p = p.replace(/^([a-zA-Z])\|/, '$1:');
    return path.normalize(p).toLowerCase();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
function deactivate() {}
module.exports = { activate, deactivate };