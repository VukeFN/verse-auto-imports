# Verse Auto Imports

Automatically adds missing imports in Verse files for Verse code. When the compiler indicates a missing import error, this extension will automatically add the required `using` statement to your file.

## Features

- **Automatic Import Detection**: Detects missing import errors in real-time
- **Zero Configuration**: Works out of the box with default settings
- **Dynamic Updates**: Supports any new Verse modules without requiring extension updates
- **Non-Intrusive**: Only adds imports that are actually needed by your code

![Demo of auto-importing](https://i.postimg.cc/wjgcS0cF/demo.gif)

## How It Works

When you write code that requires an import, such as:

```verse
# This will show an error without the proper import
if(MyCharacter := Player.GetFortCharacter[]){}
```

The compiler will show an error like:

```
Unknown member 'GetFortCharacter' in 'player'. Did you forget to specify using { /Fortnite.com/Characters }?
```

The extension automatically detects this error and adds the required import at the top of your file:

```verse
using { /Fortnite.com/Characters }

# Now this works!
if(MyCharacter := Player.GetFortCharacter[]){}
```

## Settings

This extension contributes the following settings:

- `verseAutoImports.autoImport`: Enable/disable automatic importing (default: `true`)

## Requirements

- Visual Studio Code 1.85.0 or newer
- Working with .verse files in a UEFN project

## Extension Settings

You can configure the extension through VS Code's settings:

1. Open Command Palette (Ctrl+Shift+P)
2. Type "Settings"
3. Choose "Preferences: Open Settings (UI)"
4. Search for "Verse Auto Imports"

## Known Issues

None currently reported. Please submit issues on our GitHub repository.

## Release Notes

### 0.1.0

Initial release:

- Automatic import detection and addition
- Support for all Verse modules
- Configurable auto-import setting

### 0.2.1

Accepting contributions:

- Now open source.
- Feel free to contribute to this extension.

## Contributing

Feel free to submit issues and pull requests on our GitHub repository.

## License

This extension is licensed under the MIT License. See the LICENSE file for details.
