# Verse Auto Imports

Automatically adds missing imports and handles module visibility in Verse files. This extension helps manage both import statements and module access issues automatically.

## Features

-   **Automatic Import Detection**: Detects missing import errors in real-time
-   **Module Visibility Management**: Automatically adds `<public>` attribute to internal modules when needed
-   **Zero Configuration**: Works out of the box with default settings
-   **Dynamic Updates**: Supports any new Verse modules without requiring extension updates
-   **Non-Intrusive**: Only adds imports and module attributes that are actually needed
-   **Import Optimization**: Automatically sorts and organizes import statements
-   **Command Support**: Includes commands for manual import optimization
-   **Import Syntax Preferences**: Choose between `using { /Path }` and `using. /Path` syntax styles
-   **Performance Optimized**: Includes configurable delay to prevent excessive processing
-   **Ambiguous Import Handling**: Smart resolution of class names that exist in multiple modules
-   **Quick Fix Support**: Adds "Add import" option to the quick fix menu for manual importing

![Demo of auto-importing](https://i.postimg.cc/wjgcS0cF/demo.gif)

## How It Works

### Import Management

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

### Quick Fix Support

If you prefer to add imports manually, you can hover over any import-related error, click the light bulb icon, and select "Add import" from the quick fix menu. This gives you control over which imports to add and when.

### Module Visibility

When you try to access an internal module, for example:

```verse
# This will show an error if SubModule is internal
MyGame.SubModule.DoSomething()
```

The compiler will show an error like:

```
Invalid access of internal module `(/Game/MyGame)SubModule`
```

The extension will automatically:

1. Locate the module definition file
2. Add the `<public>` attribute to the module
3. Make the module accessible

From:

```verse
MyGame := module:
    SubModule := module:
        # Module content
```

To:

```verse
MyGame := module:
    SubModule<public> := module:
        # Module content
```

### Handling Ambiguous Imports

Some classes like `vector3` appear in multiple modules (e.g., `/UnrealEngine.com/Temporary/SpatialMath` and `/Verse.org/SpatialMath`).
The extension provides a configuration to specify which module you prefer for these ambiguous class names:

```json
"verseAutoImports.ambiguousImports": {
  "vector3": "/UnrealEngine.com/Temporary/SpatialMath",
  "vector2": "/UnrealEngine.com/Temporary/SpatialMath"
}
```

You can add your own mappings for any other ambiguous classes you encounter.

## Commands

The extension provides the following commands:

-   **Verse: Optimize Imports**: Sorts all import statements in the current file alphabetically
    -   Can be triggered from the command palette (Ctrl+Shift+P or Cmd+Shift+P)
    -   Only works with .verse files
    -   Maintains existing import format while ensuring alphabetical order
-   **Verse: Add Import**: Adds a specific import to the current file (used by the quick fix feature)

## Settings

This extension contributes the following settings:

-   `verseAutoImports.autoImport`: Enable/disable automatic importing and module visibility management (default: `true`)
-   `verseAutoImports.diagnosticDelay`: Delay in milliseconds before processing diagnostics (default: `1000`)
-   `verseAutoImports.importSyntax`: Choose preferred import syntax format:
    -   `curly`: Use `using { /Path }` syntax (default)
    -   `dot`: Use `using. /Path` syntax
-   `verseAutoImports.ambiguousImports`: Mappings for class names that appear in multiple modules (default includes common vector types)

## Requirements

-   Visual Studio Code 1.85.0 or newer
-   Working with .verse files in a UEFN project

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

-   Automatic import detection and addition
-   Support for all Verse modules
-   Configurable auto-import setting

### 0.2.1

Accepting contributions:

-   Now open source
-   Feel free to contribute to this extension

### 0.3.0

New features:

-   Added "Optimize Imports" command for manual import organization
-   Imports are now automatically sorted alphabetically
-   Improved logging and error handling
-   Better code organization and maintainability
-   Added automatic `<public>` attribute handling for internal modules

### 0.3.1

New features:

-   Support custom missing usings (namespaces)

### 0.4.1

New features and fixes:

-   Added configurable import syntax preference (`using { }` or `using.`)
-   Added diagnostic processing delay to improve performance
-   Added quick fix support for manual import management
-   Added handling for ambiguous imports (classes that exist in multiple modules)
-   Optimized how imports are added to avoid switching active editors
-   Fixed issue with `vector3` importing from the wrong module
-   Fixed whitespace handling in import statements
-   Improved import statement format detection and conversion
-   Added support for namespaced imports (e.g. `OuterModule.Components`)
-   Improved diagnostic logging with simpler file references
-   Fixed issue with imports not converting to preferred syntax format

## Contributing

Feel free to submit issues and pull requests on our GitHub repository.

## License

This extension is licensed under the MIT License. See the LICENSE file for details.
