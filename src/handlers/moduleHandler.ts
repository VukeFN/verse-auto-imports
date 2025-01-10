import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ModuleInfo } from '../types/moduleInfo';
import { log } from '../utils/logging';

export class ModuleHandler {
    constructor(private outputChannel: vscode.OutputChannel) {}
    
    async handleModuleError(diagnostic: vscode.Diagnostic, document: vscode.TextDocument) {
        const moduleInfo = this.extractModuleInfo(diagnostic.message);
        if (!moduleInfo) return;

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (!workspaceRoot) return;

        const moduleFile = await this.findModuleInFiles(workspaceRoot, moduleInfo);
        if (moduleFile) {
            const moduleDocument = await vscode.workspace.openTextDocument(moduleFile);
            await this.addPublicAttribute(moduleDocument, moduleInfo);
        }
    }

    extractModuleInfo(errorMessage: string): ModuleInfo | null {
        log(this.outputChannel, `Attempting to extract module info from error: ${errorMessage}`);
    
        const match = errorMessage.match(/Invalid access of internal module `\(([^)]+)\)([^`]+)`/);
        if (!match) {
            log(this.outputChannel, 'No match found for module info pattern');
            return null;
        }

        const fullPath = match[1].replace(/:$/, '');
        const internalModule = match[2];
        
        const pathParts = fullPath.split('/').filter(Boolean);
        const projectName = pathParts[1];
        const outerModule = pathParts[pathParts.length - 1];
        const intermediatePath = pathParts.slice(2, -1).join('/');
        
        log(this.outputChannel, `Extracted module info:
        Project Name: ${projectName}
        Intermediate Path: ${intermediatePath}
        Outer Module: ${outerModule}
        Internal Module: ${internalModule}`);
        
        return {
            projectName,
            intermediatePath,
            outerModule,
            internalModule
        };
    }

    async findModuleInFiles(workspaceRoot: string, moduleInfo: ModuleInfo): Promise<string | null> {
        const searchPath = path.join(
            workspaceRoot,
            moduleInfo.intermediatePath
        );
        
        log(this.outputChannel, `Searching in directory: ${searchPath}`);
        
        try {
            const files = await fs.promises.readdir(searchPath);
            const verseFiles = files.filter(f => f.endsWith('.verse'));
            log(this.outputChannel, `Found verse files: ${verseFiles.join(', ')}`);
            
            for (const file of verseFiles) {
                const filePath = path.join(searchPath, file);
                log(this.outputChannel, `Checking file: ${file}`);
                const content = await fs.promises.readFile(filePath, 'utf8');
                
                const modulePattern = new RegExp(
                    `${moduleInfo.outerModule}\\s*:=\\s*module[\\s\\S]*?${moduleInfo.internalModule}\\s*:=\\s*module`
                );
                
                if (modulePattern.test(content)) {
                    log(this.outputChannel, `Found matching module in file: ${filePath}`);
                    return filePath;
                }
            }
        } catch (error) {
            log(this.outputChannel, `Error searching for module:\n${error}`);
        }
        
        return null;
    }

    async addPublicAttribute(document: vscode.TextDocument, moduleInfo: ModuleInfo): Promise<boolean> {
        log(this.outputChannel, `Attempting to add public attribute to ${moduleInfo.internalModule} in ${document.uri.toString()}`);
        const text = document.getText();
        
        const outerModuleMatch = text.match(
            new RegExp(`${moduleInfo.outerModule}\\s*:=\\s*module`)
        );
        
        if (!outerModuleMatch) {
            log(this.outputChannel, `Outer module ${moduleInfo.outerModule} not found in document`);
            return false;
        }
        log(this.outputChannel, `Found outer module declaration: ${outerModuleMatch[0]}`);
        
        const afterOuterModule = text.slice(outerModuleMatch.index! + outerModuleMatch[0].length);
        log(this.outputChannel, `After outer module: ${afterOuterModule}`);
        log(this.outputChannel, `Found outer module declaration from ${outerModuleMatch.index}:${outerModuleMatch[0].length}`);
        
        const internalModuleMatch = afterOuterModule.match(
            new RegExp(`${moduleInfo.internalModule}\\s*:=\\s*module`)
        );
        
        if (!internalModuleMatch) {
            log(this.outputChannel, `Internal module ${moduleInfo.internalModule} not found within outer module`);
            return false;
        }
        log(this.outputChannel, `Found internal module declaration: ${internalModuleMatch[0]}`);
        
        const fullPosition = outerModuleMatch.index! + outerModuleMatch[0].length + internalModuleMatch.index!;
        const editor = await vscode.window.showTextDocument(document);
        const startPosition = document.positionAt(fullPosition);
        const endPosition = document.positionAt(fullPosition + internalModuleMatch[0].length);
        
        log(this.outputChannel, `Found internal module declaration from ${startPosition.line}:${startPosition.character} to ${endPosition.line}:${endPosition.character}`);
        
        await editor.edit(editBuilder => {
            const newDeclaration = `${moduleInfo.internalModule}<public> := module`;
            editBuilder.replace(
                new vscode.Range(startPosition, endPosition),
                newDeclaration
            );
        });
        
        log(this.outputChannel, 'Successfully added public attribute');
        return true;
    }
}