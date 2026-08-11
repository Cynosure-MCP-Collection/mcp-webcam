#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir, platform as osPlatform } from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegStaticPath from 'ffmpeg-static';

const execAsync = promisify(exec);

// ── ffmpeg binary path (bundled via ffmpeg-static) ────────────────────────────

const FFMPEG_BIN: string = (ffmpegStaticPath as unknown as string);
if (!FFMPEG_BIN) throw new Error('ffmpeg-static did not resolve a binary path.');

// ── Config ─────────────────────────────────────────────────────────────────────

const PLATFORM = osPlatform();
const DEFAULT_OUTPUT_DIR = path.join(tmpdir(), 'cynosure-mcp', 'webcam');

function getOutputDir(): string {
    return process.env.WEBCAM_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR;
}

function getDefaultDevice(): string | undefined {
    return process.env.WEBCAM_DEVICE;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function ensureOutputDir(): Promise<string> {
    const dir = getOutputDir();
    await fs.mkdir(dir, { recursive: true });
    return dir;
}

function generateFilename(): string {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return `webcam_${ts}.jpg`;
}

function log(msg: string): void {
    process.stderr.write(`[webcam-mcp ${new Date().toISOString()}] ${msg}\n`);
}

// ── Device listing ─────────────────────────────────────────────────────────────

function parseDshowVideoDevices(output: string): string[] {
    const devices: string[] = [];
    const lines = output.split('\n');
    let inVideoSection = false;

    function addDevice(name: string): void {
        if (!devices.includes(name)) devices.push(name);
    }

    for (const line of lines) {
        if (/DirectShow video devices/i.test(line)) {
            inVideoSection = true;
            continue;
        }
        if (/DirectShow audio devices/i.test(line)) {
            inVideoSection = false;
            continue;
        }
        if (!inVideoSection) continue;

        // Older ffmpeg builds list video devices under a section header.
        // e.g.  [dshow @ 0x1234]  "Integrated Camera"
        const nameMatch = line.match(/\]\s+"([^"]+)"/);
        if (nameMatch && !/Alternative name/i.test(line)) {
            addDevice(nameMatch[1]);
        }
    }

    // Newer ffmpeg builds may omit section headers and tag each line instead.
    // e.g.  [dshow @ 0x1234] "Integrated Camera" (video)
    for (const line of lines) {
        const nameMatch = line.match(/\]\s+"([^"]+)"\s+\(video\)\s*$/i);
        if (nameMatch) addDevice(nameMatch[1]);
    }

    return devices;
}

async function listCamerasWindows(): Promise<string[]> {
    try {
        const { stderr, stdout } = await execAsync(`"${FFMPEG_BIN}" -list_devices true -f dshow -i dummy`, { timeout: 8000 });
        return parseDshowVideoDevices(`${stderr}\n${stdout}`);
    } catch (err: unknown) {
        const e = err as { stderr?: string; stdout?: string; message?: string };
        const output = `${e.stderr ?? ''}\n${e.stdout ?? ''}\n${e.message ?? String(err)}`;
        return parseDshowVideoDevices(output);
    }
}

async function listCamerasMac(): Promise<string[]> {
    try {
        await execAsync(`"${FFMPEG_BIN}" -list_devices true -f avfoundation -i ""`, { timeout: 8000 });
    } catch (err: unknown) {
        const e = err as { stderr?: string; stdout?: string };
        const output = (e.stderr ?? e.stdout ?? String(err)).toString();
        const cameras: string[] = [];
        let inVideoSection = false;

        for (const line of output.split('\n')) {
            if (/AVFoundation video devices/i.test(line)) { inVideoSection = true; continue; }
            if (/AVFoundation audio devices/i.test(line)) { inVideoSection = false; continue; }
            if (inVideoSection) {
                const match = line.match(/\[(\d+)\]\s+(.+)/);
                if (match) cameras.push(`${match[1]}: ${match[2].trim()}`);
            }
        }
        return cameras;
    }
    return [];
}

async function listCamerasLinux(): Promise<string[]> {
    try {
        const { stdout } = await execAsync('ls /dev/video* 2>/dev/null', { timeout: 3000 });
        return stdout.trim().split('\n').filter(Boolean);
    } catch {
        return [];
    }
}

async function listCameras(): Promise<string[]> {
    if (PLATFORM === 'win32') return listCamerasWindows();
    if (PLATFORM === 'darwin') return listCamerasMac();
    return listCamerasLinux();
}

// ── Image capture ──────────────────────────────────────────────────────────────

interface CaptureOptions {
    device?: string;
    width?: number;
    height?: number;
}

function sizeFlag(opts: CaptureOptions): string {
    return opts.width && opts.height ? `-video_size ${opts.width}x${opts.height} ` : '';
}

async function resolveWindowsDevice(device?: string): Promise<string> {
    const d = device ?? getDefaultDevice();
    if (d) return d;

    const cameras = await listCamerasWindows();
    if (cameras.length === 0) {
        throw new Error('No webcam devices found. Make sure a webcam is connected and ffmpeg is installed.');
    }
    log(`Auto-selected camera: "${cameras[0]}"`);
    return cameras[0];
}

async function captureImage(opts: CaptureOptions): Promise<{ filePath: string; base64: string }> {
    const dir = await ensureOutputDir();
    const outputPath = path.join(dir, generateFilename());
    let cmd: string;

    if (PLATFORM === 'win32') {
        const deviceName = await resolveWindowsDevice(opts.device);
        cmd = `"${FFMPEG_BIN}" -f dshow ${sizeFlag(opts)}-i video="${deviceName}" -vframes 1 -q:v 2 -y "${outputPath}"`;
    } else if (PLATFORM === 'darwin') {
        const deviceIdx = opts.device ?? getDefaultDevice() ?? '0';
        cmd = `"${FFMPEG_BIN}" -f avfoundation ${sizeFlag(opts)}-i "${deviceIdx}" -vframes 1 -q:v 2 -y "${outputPath}"`;
    } else {
        const devicePath = opts.device ?? getDefaultDevice() ?? '/dev/video0';
        cmd = `"${FFMPEG_BIN}" -f v4l2 ${sizeFlag(opts)}-i "${devicePath}" -vframes 1 -q:v 2 -y "${outputPath}"`;
    }

    log(`Running: ${cmd}`);
    try {
        await execAsync(cmd, { timeout: 20000 });
    } catch (err: unknown) {
        const e = err as { stderr?: string; code?: number };
        // ffmpeg may exit non-zero even on success; verify the output file exists
        try {
            await fs.access(outputPath);
        } catch {
            throw new Error(`ffmpeg failed: ${e.stderr ?? String(err)}`);
        }
    }

    const data = await fs.readFile(outputPath);
    return { filePath: outputPath, base64: data.toString('base64') };
}

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'Webcam',
    version: '1.0.0',
    title: 'Webcam',
    description: 'Capture still images from an attached webcam.',
    icons: [{ src: 'https://unpkg.com/@cynosure-mcp/webcam@1.0.1/icon.png', mimeType: 'image/png' }],
});

// ── Tool: list_webcam_devices ──────────────────────────────────────────────────

server.registerTool(
    'list_webcam_devices',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        description: 'List all available webcam / video capture devices on this system. Use the returned device name (Windows) or index (macOS) with capture_webcam_image.',
        inputSchema: {},
    },
    async () => {
        try {
            const cameras = await listCameras();
            if (cameras.length === 0) {
                return {
                    content: [{ type: 'text', text: 'No webcam devices found. Make sure a webcam is connected and ffmpeg is installed.' }],
                };
            }
            const list = cameras.map((c, i) => `${i + 1}. ${c}`).join('\n');
            return {
                content: [{ type: 'text', text: `Found ${cameras.length} video device(s):\n\n${list}` }],
            };
        } catch (err) {
            return {
                content: [{ type: 'text', text: `Failed to list devices: ${err instanceof Error ? err.message : String(err)}` }],
                isError: true,
            };
        }
    },
);

// ── Tool: capture_webcam_image ─────────────────────────────────────────────────

server.registerTool(
    'capture_webcam_image',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        description: 'Capture a still image from an attached webcam. Returns the image inline and saves it to disk. Call list_webcam_devices first if you need to select a specific camera.',
        inputSchema: {
            device: z.string().optional().describe(
                'Camera to use. On Windows: the device name shown by list_webcam_devices (e.g. "Integrated Camera"). ' +
                'On macOS: the AVFoundation index (e.g. "0"). ' +
                'On Linux: the device path (e.g. "/dev/video0"). ' +
                'Omit to use the WEBCAM_DEVICE env var or auto-detect the first available camera.',
            ),
            width: z.number().int().positive().optional().describe('Capture width in pixels (e.g. 1280). Omit to use the camera default.'),
            height: z.number().int().positive().optional().describe('Capture height in pixels (e.g. 720). Omit to use the camera default.'),
        },
    },
    async ({ device, width, height }) => {
        try {
            const result = await captureImage({ device, width, height });
            return {
                content: [
                    { type: 'text', text: `Image captured and saved to: ${result.filePath}` },
                    { type: 'image', data: result.base64, mimeType: 'image/jpeg' },
                ],
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                content: [{
                    type: 'text',
                    text: `Failed to capture image: ${msg}\n\nTroubleshooting:\n` +
                        '1. Make sure ffmpeg is installed and available in PATH\n' +
                        '2. Make sure a webcam is connected\n' +
                        '3. Run list_webcam_devices to verify the device name\n' +
                        '4. On Windows, provide the exact device name (e.g. "Integrated Camera")',
                }],
                isError: true,
            };
        }
    },
);

// ── Start ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('Webcam MCP server running on stdio');
}

main().catch((err) => {
    process.stderr.write(`Fatal error: ${err}\n`);
    process.exit(1);
});
