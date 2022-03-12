import * as fs from 'fs';
import * as vscode from 'vscode';
import { DocumentSymbol, Range, Uri } from 'vscode';
import { parse as parseYaml } from 'yaml';
import { Merge } from 'yaml/types';

type ResourceDef = {
    [key:string]: FilePos
};

type TaskDef = {
    [key:string]: FilePos
};

type GroupDef = {
    _self: FilePos,
    [key:string]: TaskDef | FilePos
};

type UpdateDef = {
    [key:string]: TaskFalconDef
};

type TaskFalconDef = {
    uri: Uri;
    tasks: TaskDef | GroupDef;
    resources: ResourceDef;
    updates: UpdateDef;
    imports: Uri[];
};

export type FilePos = {
    path: string;
    line: number;
};

export async function parseReferences(uri: Uri): Promise<TaskFalconDef> {
    let knownFiles = new Set([uri.path]);
    let parent = await parseFile(uri);

    return await parseRecursively(parent, knownFiles, '');
}

async function parseRecursively(parent: TaskFalconDef, knownFiles: Set<string>, prefix: string): Promise<TaskFalconDef> {
    for (let uri of parent.imports) {
        if (knownFiles.has(uri.path)) {
            continue;
        }
        let basename = uri.path.split(/\/|\\/).pop()!.split('.').shift()!;
        let currentPrefix = prefix;
        if (prefix) {
            currentPrefix = `${prefix}.${basename}`;
        } else {
            currentPrefix = basename;
        }

        let subProject = await parseFile(uri);
        knownFiles.add(uri.path);
        mergeSubProject(parent, subProject, currentPrefix);
        parseRecursively(subProject, knownFiles, currentPrefix);
    }
    return parent;
}

async function parseFile(uri: Uri): Promise<TaskFalconDef> {
    let breadCrumbs = await vscode.commands.executeCommand<DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider', uri);

    let resourceCrumbs = breadCrumbs?.filter(c => c.name === 'resources').pop();
    let taskCrumbs = breadCrumbs?.filter(c => c.name === 'tasks').pop();
    let importCrumbs = breadCrumbs?.filter(c => c.name === 'imports').pop();
    let updateCrumbs = breadCrumbs?.filter(c => c.name === 'updates').pop();

    let resources = parseResources(resourceCrumbs, uri);
    let tasks = parseTasks(taskCrumbs, uri);
    let updates = parseUpdates(updateCrumbs, uri);
    let imports = parseImports(importCrumbs, uri);

    return {
        uri, tasks, resources, updates, imports
    };
}

function parseResources(resourceCrumbs: DocumentSymbol | undefined, uri: Uri): ResourceDef {
    if (!resourceCrumbs) {
        return {};
    }

    return resourceCrumbs.children
        .map((c) => c.children[0])
        .filter((c) => c.name === 'resource')
        .reduce((o, c) => { (o as any)[c.detail] = toFilePos(uri, c.range); return o; }, {});
}

function parseTasks(taskCrumbs: DocumentSymbol | undefined, uri: Uri) {
    if (!taskCrumbs) {
        return {};
    }

    const validElementNames = ['task', 'group', 'milestone'];

    const elementReducer = (o: any, c: DocumentSymbol) => {
        let type = '';
        let name = '';
        let subTasks: DocumentSymbol[]|null = null;

        for (let props of c.children) {
            switch (props.name) {
                case 'group':
                case 'task':
                case 'milestone':
                    type = props.name;
                    name = props.detail;
                    break;

                case 'tasks':
                    subTasks = props.children;
                    break;
            }
        }
        if (!validElementNames.includes(type)) {
            return o;
        }

        if (type === 'task' || type === 'milestone' || (type === 'group' && !subTasks)) {
            o[name] = toFilePos(uri, c.range);
        }

        if (type === 'group' && subTasks) {
            let children = subTasks.reduce(elementReducer, {});
            children._self = toFilePos(uri, c.range);
            o[name] = children;
        }

        return o;
    };

    return taskCrumbs.children
        .reduce(elementReducer, {});
}

function parseImports(importCrumbs: DocumentSymbol | undefined, uri: Uri): Uri[] {
    if (!importCrumbs) {
        return [];
    }
    
    // for imports (string-list) we have to parse the whole file again, since
    // vscode DocumentSymbol does not capture items in primitive lists :-(
    const fileContent = fs.readFileSync(uri.fsPath, 'utf8');
    let imports = parseYaml(fileContent).imports;
    let path = uri.path.substring(0, uri.path.length - uri.path.split('/').pop()!.length);
    return imports.map((file: string) => Uri.parse(path + file));
}

function parseUpdates(updateCrumbs: DocumentSymbol | undefined, uri: Uri) {
    if (!updateCrumbs) {
        return {};
    }

    let result: any = {};
    for (let c of updateCrumbs.children) {
        let update = parseUpdate(c, uri);
        result[update.update] = update;
        delete update.update;
    }
    return result;
}

function parseUpdate(updateCrumbs: DocumentSymbol, uri: Uri) {
    let result: any = {};
    for (let c of updateCrumbs.children) {
        switch (c.name) {
            case 'tasks':
                result.tasks = parseTasks(c, uri);
                break;
            case 'resources':
                result.resources = parseResources(c, uri);
                break;
            case 'update':
                result.update = c.detail;
                break;
        }
    }
    return result;
}

function toFilePos(uri: Uri, range: Range): FilePos {
    return {
        path: uri.path,
        line: range.start.line
    };
}

function mergeSubProject(parent: TaskFalconDef, subProject: TaskFalconDef, prefix: string) {
    parent.resources = { ...parent.resources, ...subProject.resources };
    let prefixedTasks: TaskDef = {};
    let lastPrefixPart = prefix.split('.').pop()!;
    (parent.tasks as any)[lastPrefixPart] = subProject.tasks;
    //Object.keys(subProject.tasks).forEach((key) => (prefixedTasks as any)[prefix + key] = subProject.tasks[key]);
    parent.tasks = { ...parent.tasks, ...prefixedTasks };

    prefix += '.';
    for (let date in subProject.updates) {
        let subUpdate = subProject.updates[date];
        if (subUpdate.tasks) {
            let newUpdate: TaskFalconDef = { ...(parent.updates[date]), ...{ tasks: {} } };
            Object.keys(subUpdate.tasks).forEach((key) => newUpdate.tasks[prefix + key] = subUpdate.tasks[key]);
            parent.updates[date] = newUpdate;
        }
        if (parent.updates[date]) {
            if (subUpdate.resources) {
                parent.updates[date].resources = { ...parent.updates[date].resources, ...subUpdate.resources };
                parent.updates[date].tasks = { ...parent.updates[date].tasks, ...subUpdate.tasks };
            }
        } else {
            parent.updates[date] = subUpdate;
            // check task prefixes
        }

    }
}

export function findTask(taskFalconReferences: TaskFalconDef, taskId: string): FilePos[] {
    let idParts = taskId.split('.');

    let result: FilePos[] = [];

    // Find task directly
    let element: any = taskFalconReferences.tasks;
    for (let part of idParts) {
        element = element[part];
        if (!element) {
            continue;
        }
    }
    if (element) {
        if (element._self) {
            result.push(element._self);
        } else {
            result.push(element);
        }
    }

    // Find task in updates
    Object.keys(taskFalconReferences.updates).reduce((refs, update) => {
        Object.keys(taskFalconReferences.updates[update].tasks || {})
            .filter((name) => name === taskId)
            .forEach((name) => (refs as any).push(taskFalconReferences.updates[update].tasks[name]));
        return refs;
    }, result);

    return result;
}

export function findResource(taskFalconReferences: TaskFalconDef, resourceId: string): FilePos[] {
    let result: FilePos[] = [];

    // Find resource definition
    if (taskFalconReferences.resources?.[resourceId]) {
        result.push(taskFalconReferences.resources[resourceId]);
    }

    // Find resource updates
    Object.keys(taskFalconReferences.updates).forEach((update) => {
        if (taskFalconReferences.updates[update].resources?.[resourceId]) {
            result.push(taskFalconReferences.updates[update].resources[resourceId]);
        }
    });
    return result;
}