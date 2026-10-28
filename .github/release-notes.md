## Downloads

| Platform | Desktop app | CLI / team server |
| --- | --- | --- |
| macOS (Apple Silicon + Intel) | `POSTBote_*_universal.dmg` | `postbote-*-macos-universal.tar.gz` |
| Windows | `POSTBote_*_x64-setup.exe` or `.msi` | `postbote-*-windows-x86_64.zip` |
| Linux | `.AppImage`, `.deb` or `.rpm` | `postbote-*-linux-x86_64.tar.gz` / `-linux-arm64.tar.gz` |
| Docker | – | `docker run -p 8080:8080 -v postbote-data:/data ghcr.io/kaibrockelt/postbote` |

### First start of unsigned builds

- **macOS:** if macOS refuses to open the app, right-click it → *Open*, or run
  `xattr -dr com.apple.quarantine /Applications/POSTBote.app`.
- **Windows:** SmartScreen may show “Windows protected your PC” → *More info* → *Run anyway*.
- **Linux AppImage:** `chmod +x POSTBote_*.AppImage` and run it (needs WebKitGTK 4.1).

## Changes

<!-- describe the changes of this release -->
