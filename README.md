# @cynosure-mcp/webcam

MCP server for capturing still images from an attached webcam. Supports Windows, macOS, and Linux. **No system dependencies required** — ffmpeg is bundled automatically via npm.

## Installation

```bash
npx @cynosure-mcp/webcam
```

Or install globally:

```bash
npm install -g @cynosure-mcp/webcam
webcam
```

## Tools

| Tool                   | Description                                                               |
| ---------------------- | ------------------------------------------------------------------------- |
| `list_webcam_devices`  | List all available webcam / video capture devices on the system           |
| `capture_webcam_image` | Capture a still image from a webcam; returns the image inline and on disk |

## Configuration

| Variable            | Required | Description                                                                                                                                                          |
| ------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEBCAM_DEVICE`     | No       | Default camera device. Windows: device name (e.g. `Integrated Camera`). macOS: AVFoundation index (`0`). Linux: device path (`/dev/video0`). Auto-detected if unset. |
| `WEBCAM_OUTPUT_DIR` | No       | Directory for saved images. Defaults to a system temp directory.                                                                                                     |

## MCP Config

```json
{
  "mcpServers": {
    "webcam": {
      "command": "npx",
      "args": ["@cynosure-mcp/webcam"],
      "env": {
        "WEBCAM_DEVICE": "Integrated Camera"
      }
    }
  }
}
```

## Platform Notes

### Windows

Uses DirectShow (`dshow`) via ffmpeg. Run `list_webcam_devices` to see the exact device name, then pass it as the `device` argument to `capture_webcam_image` or set it as `WEBCAM_DEVICE`.

### macOS

Uses AVFoundation via ffmpeg. Device indices are numeric (e.g. `"0"` for the first camera). Run `list_webcam_devices` to see available devices.

### Linux

Uses Video4Linux2 (`v4l2`) via ffmpeg. Devices appear as `/dev/video0`, `/dev/video1`, etc. Run `list_webcam_devices` to enumerate them.

## License

MIT
