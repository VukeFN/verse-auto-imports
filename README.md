<div align="center">

**This project is built and maintained for the Verse community for free.**
**If you find it helpful, consider supporting its development!**

<a href="https://www.paypal.com/donate/?hosted_button_id=SANPYNE27HHYA">
  <img src="https://raw.githubusercontent.com/aha999/DonateButtons/master/Paypal.png" alt="Donate via PayPal" width="180" style="vertical-align: middle;"/>
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://buymeacoffee.com/vukefn">
  <img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee" width="180" style="vertical-align: middle;"/>
</a>
&nbsp;&nbsp;&nbsp;
<a href="https://discord.gg/yw5cT2Yu3h">
  <img src="https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join Discord" width="180" style="vertical-align: middle;"/>
</a>

</div>

---

# Verse Auto Imports

**Intelligent import management for Verse development in UEFN**

Stop manually managing imports in your Verse code. This extension automatically detects missing imports, provides smart suggestions, and keeps your code organized with zero configuration.

![Demo of auto-importing](https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExNnlhamd5NTNsOHJtMHVtMjRhY2RnemQ2OGJjYWFpaG00c2M3ejdlYiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/8OzEx3geM5xFE9zU1O/giphy.gif)

## Key Features

- **Automatic Import Detection** - Detects missing imports in real-time as you code
- **Multi-Option Quick Fixes** - Choose from multiple import options when VS Code finds ambiguous identifiers
- **Full Path Conversion** - Convert relative imports to full path format with CodeLens
- **Smart Error Recognition** - Enhanced pattern matching for various Verse compiler errors
- **Path Tree Caching** - Fast identifier resolution with automatic cache updates
- **Zero Configuration** - Works perfectly out of the box with sensible defaults
- **Import Organization** - Sorts and consolidates imports with proper spacing, in an order Verse can actually resolve
- **Comment-Aware** - Imports inside block comments stay commented out, and files keep their own line endings
- **Flexible Configuration** - Customize behavior to match your coding style

## Quick Start

### Installation

1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X`)
3. Search for "Verse Auto Imports"
4. Click Install

### Basic Usage

Just start coding! The extension works automatically:

```verse
# Type this - you'll get an error for missing import
if(MyCharacter := Player.GetFortCharacter[]){}

# Extension automatically adds: using { /Fortnite.com/Characters }
# Or shows you quick fix options to choose from!
```

**That's it!** The extension handles the rest automatically.

## Documentation

For detailed documentation, see the **[Wiki](https://github.com/VukeFN/verse-auto-imports/wiki)**:

- **[Features](https://github.com/VukeFN/verse-auto-imports/wiki/Features)** - Complete guide to all features
- **[Configuration](https://github.com/VukeFN/verse-auto-imports/wiki/Configuration)** - All settings and options
- **[Troubleshooting](https://github.com/VukeFN/verse-auto-imports/wiki/Troubleshooting)** - Common issues and solutions

## Requirements

- **VS Code:** 1.85.0 or newer
- **Environment:** Working with `.verse` files in a UEFN project
- **Language Server:** Verse language support enabled

## What's New

See [CHANGELOG.md](CHANGELOG.md) for the complete version history.

## Contributing

Found a bug or want to contribute? We welcome issues and pull requests!

- **GitHub Repository:** [verse-auto-imports](https://github.com/VukeFN/verse-auto-imports)
- **Discord:** [Join our community](https://discord.gg/yw5cT2Yu3h)
- **Issues:** Report bugs and request features

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=VukeFN/verse-auto-imports&type=Date)](https://star-history.com/#VukeFN/verse-auto-imports&Date)

## License

This project is licensed under a proprietary license. See the [LICENSE.md](LICENSE.md) file for full details.

Copyright © 2026 VukeFN. All rights reserved.
