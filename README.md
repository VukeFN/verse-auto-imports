# Verse Auto Imports

**Intelligent import management for Verse development in UEFN**

Stop manually managing imports in your Verse code. This extension automatically detects missing imports, provides smart suggestions, and keeps your code organized with zero configuration.

![Demo of auto-importing](https://i.postimg.cc/wjgcS0cF/demo.gif)

## Key Features

- **Automatic Import Detection** - Detects missing imports in real-time as you code
- **Multi-Option Quick Fixes** - Choose from multiple import options when VS Code finds ambiguous identifiers
- **Smart Error Recognition** - Enhanced pattern matching for various Verse compiler errors
- **Zero Configuration** - Works perfectly out of the box with sensible defaults
- **Import Organization** - Automatically sorts and consolidates imports with proper spacing
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

## How It Works

### Automatic Import Detection

When you use an identifier that needs an import, like `player` or `creative_device`, the Verse compiler shows an error. The extension:

1. **Detects** the error pattern
2. **Extracts** the required import information
3. **Adds** the import automatically or **shows quick fix options**

### Multi-Option Quick Fixes (NEW)

When VS Code encounters ambiguous identifiers, you now get **multiple import options** instead of guessing:

```verse
// When you type this:
MyComponent : some_component = some_component{}

// And VS Code shows: "Did you mean any of: GameFramework.some_component, UI.Components.some_component"
// You'll see quick fix options:
// ✓ Add import: using { GameFramework } (some_component from GameFramework)
// ✓ Add import: using { UI.Components } (some_component from UI.Components)
```

**How to use:**

1. Hover over the error (red squiggly line)
2. Click the lightbulb 💡 or press `Ctrl+.`
3. Choose the import option you want

## Configuration

### Essential Settings

Access settings: `Ctrl+,` → Search "Verse Auto Imports"

| Setting                   | Default      | Description                             |
| ------------------------- | ------------ | --------------------------------------- |
| `autoImport`              | `true`       | Enable/disable automatic importing      |
| `multiOptionStrategy`     | `"quickfix"` | How to handle multiple import options   |
| `importSyntax`            | `"curly"`    | Use `using { /Path }` or `using. /Path` |
| `preserveImportLocations` | `false`      | Keep existing imports where they are    |

### Multi-Option Strategies (NEW)

Control how the extension handles multiple import options:

```json
{
  "verseAutoImports.multiOptionStrategy": "quickfix" // Show quick fix menu (recommended)
  // "auto_shortest"  // Automatically choose shortest path
  // "auto_first"     // Automatically choose first option
  // "disabled"       // Ignore multi-option scenarios
}
```

### Advanced Configuration (NEW)

```json
{
  "verseAutoImports.quickFixOrdering": "confidence", // Sort quick fixes by confidence
  "verseAutoImports.showQuickFixDescriptions": true, // Show helpful descriptions
  "verseAutoImports.useDigestFiles": false, // Experimental: API-based suggestions
  "verseAutoImports.unknownIdentifierResolution": "disabled" // Enhanced identifier lookup
}
```

### Import Location Control

**Consolidated Imports (Default):** All imports moved to the top, sorted alphabetically

```json
{ "verseAutoImports.preserveImportLocations": false }
```

**Preserved Locations:** Keep existing imports where they are, add new ones at top

```json
{ "verseAutoImports.preserveImportLocations": true }
```

## Advanced Features

### Manual Import Control

Prefer manual control? Disable auto-import and use quick fixes:

```json
{ "verseAutoImports.autoImport": false }
```

Then use `Ctrl+.` on any error to see import options.

### Command Palette

- **Verse: Optimize Imports** - Sort and organize all imports in current file
- **Verse: Add Import** - Add a specific import (used by quick fixes)

### Ambiguous Import Handling

Configure preferred modules for classes that exist in multiple places:

```json
{
  "verseAutoImports.ambiguousImports": {
    "vector3": "/UnrealEngine.com/Temporary/SpatialMath",
    "vector2": "/UnrealEngine.com/Temporary/SpatialMath",
    "rotation": "/UnrealEngine.com/Temporary/SpatialMath"
  }
}
```

### Experimental Features

**Digest-Based Suggestions** (opt-in): Enhanced suggestions based on official Verse API documentation

```json
{
  "verseAutoImports.useDigestFiles": true,
  "verseAutoImports.unknownIdentifierResolution": "digest_and_inference"
}
```

_Note: These features are experimental and may not always provide accurate suggestions._

## Requirements

- **VS Code:** 1.85.0 or newer
- **Environment:** Working with .verse files in a UEFN project
- **Language Server:** Verse language support enabled

## Troubleshooting

**Extension not working?**

1. Ensure you're working with `.verse` files
2. Check that Verse language support is enabled
3. Look at Output panel: `View` → `Output` → `Verse Auto Imports`

**Wrong imports being suggested?**

1. Configure `ambiguousImports` for your preferred modules
2. Adjust `multiOptionStrategy` to get more control
3. Use manual mode with `autoImport: false`

## Contributing

Found a bug or want to contribute? We welcome issues and pull requests!

- **GitHub Repository:** [verse-auto-imports](https://github.com/VukeFN/verse-auto-imports)
- **Issues:** Report bugs and request features
- **Discussions:** Share ideas and get help

## Release Notes

### 0.5.1 (LATEST)

**Bug Fixes:**

- Added support for new "Did you forget to specify one of" error pattern format

### 0.5.0

**Major New Features:**

- **Multi-Option Quick Fixes**: When VS Code shows "Did you mean any of", you now get separate import options for each possibility
- **Enhanced Error Recognition**: Improved pattern matching for various Verse compiler error formats
- **Advanced Configuration**: New settings for fine-tuning extension behavior
- **Better Import Organization**: Proper spacing and consolidation when moving imports to top
- **Experimental Digest Integration**: Optional API-based suggestions (disabled by default)

**Improvements:**

- Fixed multi-option parsing to extract correct namespaces
- Disabled experimental features by default for better stability
- Enhanced quick fix menu with confidence indicators and descriptions
- Better handling of edge cases in import organization

### 0.4.4

**Fixes and improvements:**

- Fixed detection of custom namespace patterns
- Disabled module visibility management features
- Improved error handling and diagnostics

### 0.4.3

**Bug fixes:**

- Fixed outdated error message pattern detection

### 0.4.2

**Improvements:**

- Fixed code deletion between scattered import statements
- Added `preserveImportLocations` setting
- Improved import block handling

### 0.4.1

**New features:**

- Configurable import syntax (`using { }` vs `using.`)
- Diagnostic processing delay for better performance
- Quick fix support for manual import management
- Ambiguous import handling
- Improved logging and error handling

### Earlier Versions

See [GitHub Releases](https://github.com/VukeFN/verse-auto-imports/releases) for complete changelog.

## License & Terms of Use
Copyright © 2025 VukeFN. All rights reserved.

This software and associated code files (the "Software") are
copyrighted by VukeFN and are protected by copyright law and international
treaties. VukeFN, also known as Vuke or the owner of VukeFN, holds the copyright for
this Software.

You are granted a non-exclusive, non-transferable license to use
and modify the Software for your personal, internal business, or commercial
purposes. Redistribution, resale, or sharing of the Software or any
modified versions of it is strictly prohibited without prior written
permission from VukeFN.

The Software is provided "as is", without warranty of any kind, express or
implied, including but not limited to the warranties of merchantability,
fitness for a particular purpose, or non-infringement. In no event shall
VukeFN be liable for any claim, damages, or other liability, whether in an
action of contract, tort, or otherwise, arising from, out of, or in
connection with the Software or the use or other dealings in the Software.

Unauthorized use, reproduction, redistribution, resale, or sharing of this
Software, or any derivative works, is prohibited and may result in legal
action. In the event of infringement, VukeFN may seek to recover actual
damages, any profits obtained by the infringer, and/or statutory damages
as permitted by applicable copyright law. For permissions or inquiries,
please contact VukeFN at vukefnbusiness@gmail.com or through a private
message on [X at @vukefn](https://x.com/vukefn).
