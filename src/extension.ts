'use strict';
import * as vscode from 'vscode';
import { TaskFalconProject } from './project';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    console.log("Activated TaskFalcon");
    new TaskFalconProject(context);
}

// this method is called when your extension is deactivated
export function deactivate() {}
