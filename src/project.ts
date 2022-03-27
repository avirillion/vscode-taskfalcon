import * as fs from 'fs';
import * as handlebars from 'handlebars';
import { promisify } from 'util';
import * as vscode from 'vscode';
import * as yaml from 'yaml';
import { TaskFalconRunner } from './falconrunner';
import { FilePos, findResource, findTask, parseReferences } from './referenceparser';

type PreviewConfig = {
    showIDs: boolean;
    showClosedTasks: boolean;
    hideTasks: boolean;
    showEnds: boolean;
    showEfforts: boolean;
    showEffortsSpent: boolean;
    showEffortsLeft: boolean;
    showDone: boolean;
    chart: 'gantt' | 'gantt-with-resources' | 'resources' | 'resources-with-tasks';
    prefix: string;
    today: string;
    noUpdates: boolean;
    allUpdates: boolean;
    scale: '' | 'day' | 'week' | 'month' | 'year';
    start: string;
    end: string;
    tags: string;
    freeParams: string;
};

const defaultConfig: PreviewConfig = {
    showIDs: false,
    showClosedTasks: false,
    hideTasks: false,
    showEfforts: false,
    showEffortsSpent: false,
    showEffortsLeft: false,
    showEnds: false,
    showDone: false,
    chart: 'gantt',
    prefix: '',
    today: '',
    scale: '',
    start: '',
    end: '',
    noUpdates: false,
    allUpdates: false,
    tags: '',
    freeParams: '',
};

enum ClickItemType {
    RESOURCE,
    TASK
}
interface ClickItem {
    type: ClickItemType,
    value: string,
}

export class TaskFalconProject implements vscode.WebviewViewProvider {
    public static readonly id = 'falcon-project';

    private view?: vscode.WebviewView;
    private ctx: vscode.ExtensionContext;
    private document?: vscode.TextDocument;
    private preview?: vscode.WebviewPanel;
    private previewConfig: PreviewConfig;
    private falconRunner?: TaskFalconRunner;
    private yamlExtension?: vscode.Extension<any>;
    private pages: {[key: string]: HandlebarsTemplateDelegate} = {};
    private taskFalconOutput?: vscode.OutputChannel;
    private clickMapFile?: string;
    private clickMapObject?: any;
    private clickMapReferences?: any;
    private lastClickItem?: string;
    private lastClickResults?: FilePos[];
    private lastClickTime: number = 0;
    private lastClickIteration: number = 0;

    constructor(context: vscode.ExtensionContext) {
        this.ctx = context;
        this.previewConfig = { ... defaultConfig };

        TaskFalconRunner.setExtensionPath(context.extensionPath);
        this.yamlExtension = vscode.extensions.getExtension("redhat.vscode-yaml");

        if (!this.yamlExtension) {
            vscode.window.showErrorMessage("Can not load extension 'redhat.vscode-yaml', which is required for TaskFalcon");
            return;
        }
        this.registerVsCodeIntegrations();
    }

    private registerVsCodeIntegrations() {
        this.taskFalconOutput = vscode.window.createOutputChannel("TaskFalcon");

        this.ctx.subscriptions.push(
            vscode.window.registerWebviewViewProvider(TaskFalconProject.id, this));

        // FIXME Commands are causing problems currently
        // this.registerCommands();

        // Register save listener when yaml files are being changed
        this.ctx.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document: vscode.TextDocument) => {
            if (document.languageId === "yaml" && document.uri.scheme === "file") {
                this.runFalcon();
            }
        }));

        this.registerYamlSchema();
    }

    private registerCommands() {
        /* From package.json:
            "commands": [
                {
                    "command": "taskfalcon.createProject",
                    "title": "Create new TaskFalcon project"
                },
                {
                    "command": "taskfalcon.setActiveProject",
                    "title": "Open active file as TaskFalcon project"
                }
            ],
            ...
            "activationEvents": [
                "onCommand:taskfalcon.createProject",
                "onCommand:taskfalcon.setActiveProject",
                "onView:falcon-project"
            ],
        */

        this.ctx.subscriptions.push(vscode.commands.registerCommand('taskfalcon.createProject', () => {
            this.createNewProjectFile();
        }));

        this.ctx.subscriptions.push(vscode.commands.registerCommand('taskfalcon.setActiveProject', () => {
            this.setActiveProject();
        }));
    }

    /**
     * Integrates custom yaml schema parsing. Since TaskFalcon files can be named freely, this can not be done via glob
     * or otherwise all yaml files would be treated as TaskFalcon files.
     */
    private async registerYamlSchema() {
        // load schema file
        let schemaContent = fs.readFileSync(`${this.ctx.extensionPath}/schema/taskfalcon-schema.json`).toString();

        // Function for determining schema for given document
        function requestSchema(resource: string) {
            for (let document of vscode.workspace.textDocuments) {
                if (document.uri.toString() === resource && TaskFalconProject.isTaskFalconFile(document)) {
                    return "taskfalcon:v1";
                }
            }
            return null;
        }

        // Function for loading schema
        function requestSchemaContent(uri: string) {
            if (uri === 'taskfalcon:v1') {
                return schemaContent;
            }
            return null;
        }

        // Load extension, if required
        if (!this.yamlExtension!.isActive) {
            await this.yamlExtension!.activate();
        }

        this.yamlExtension!.exports.registerContributor("taskfalcon", requestSchema, requestSchemaContent);
    }

    /**
     * Checks if a TextDocument is a TaskFalcon file
     * @param document 
     */
    public static isTaskFalconFile(document: vscode.TextDocument): boolean {
        let lcFile = document.fileName.toLowerCase();

        if (!lcFile.endsWith(".yaml") && !lcFile.endsWith(".yml") && !lcFile.endsWith(".tf")) {
            return false;
        }

        let yamlDoc = yaml.parse(document.getText());
        let project = yamlDoc['project'];
        return !!project?.['start'];
    }

    /**
     * Returns the vscode-conform URIs for the standard css and js files used in the webviews
     */
    private getHtmlResources() {
        let resources = {
            resetCss: this.view!.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'resources', 'reset.css')),
            vsCodeCss: this.view!.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'resources', 'vscode.css')),
            mainCss: this.view!.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'resources', 'main.css')),
            mainJs: this.view!.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'resources', 'main.js')),
        };
        return resources;
    }

    /**
     * Initialise webview for vscode
     */
    public async resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext<unknown>, token: vscode.CancellationToken) {
        this.view = webviewView;

        webviewView.webview.options = {
            // Allow scripts in the webview
            enableScripts: true,
            localResourceRoots: [
                this.ctx.extensionUri,
                vscode.Uri.joinPath(this.ctx.extensionUri, 'resource'),
            ]
        };

        let resources = this.getHtmlResources();
        webviewView.webview.html = await this.renderTemplate('noproject.html', resources);
        webviewView.webview.onDidReceiveMessage(data => this.webViewNotificationHandler(data.command, data.data, resources).catch(console.error));
    }

    /**
     * Handles requests from the webview
     */
    private async webViewNotificationHandler(command: string, data: any, resources: any) {
        let webview = this.view!;
        switch (command) {
            case 'setActiveProject':
                if (!this.checkValidWorkspaceFolder()) {
                    return;
                }
                if (this.setActiveProject()) {
                    webview.webview.html = await this.renderTemplate('project_settings.html', resources);
                } else {
                    vscode.window.showErrorMessage('Active file is no TaskFalcon project');
                }
                break;

            case 'closeProject':
                webview.webview.html = await this.renderTemplate('noproject.html', resources);
                this.closeProject();
                break;

            case 'openTaskFalconWebsite':
                vscode.env.openExternal(vscode.Uri.parse('https://taskfalcon.org'));
                break;

            case 'openTaskDocumentation':
                vscode.env.openExternal(vscode.Uri.parse('https://taskfalcon.org/doc/config_tasks/index.html'));
                break;

            case 'openCommandLineDocumentation':
                vscode.env.openExternal(vscode.Uri.parse('https://taskfalcon.org/doc/command_line/index.html'));
                break;

            case 'showProjectFile':
                this.showProjectFile();
                break;

            case 'newProject':
                if (!this.checkValidWorkspaceFolder()) {
                    return;
                }
                this.createNewProjectFile();
                break;

            case 'sync':
                this.syncConfig(data);
                this.runFalcon();
                break;
        }
    }

    /**
     * Synchronises the webview state with the internal chart config
     * @param data config from the webview
     */
    private syncConfig(data: any) {
        this.previewConfig = { ...defaultConfig, ...data };
    }

    /**
     * (Re-)Opens the main project file
     */
    private async showProjectFile() {
        if (!this.document?.isClosed ?? false) {
            vscode.window.showTextDocument(this.document!, vscode.ViewColumn.One);
            return;
        } 

        try {
            this.document = await vscode.workspace.openTextDocument(this.document.fileName);
        } catch (e) {
            vscode.window.showErrorMessage(e as any);
        }
    }

    /**
     * Creates a new project file with a basic project setup
     */
    private async createNewProjectFile() {
        let date = new Date().toISOString().substring(0, 10);
        let template = await this.renderTemplate('project-template.txt', { date });
        let save = await vscode.window.showSaveDialog({  
            defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'project.yaml'),
            filters: { 'TaskFalcon Project': ['yaml', 'yml'] }
        });
        if (save) {
            this.view!.webview.html = await this.renderTemplate('project_settings.html', this.getHtmlResources());
            await promisify(fs.writeFile)(save.fsPath, template);
            this.document = await vscode.workspace.openTextDocument(save.fsPath);
            let editor = await vscode.window.showTextDocument(this.document);
            this.runFalcon();
        }
    }

    /**
     * Loads a template from disk and renders it as handlebars file
     * @param file Local filename
     * @param data Template variables
     */
    private async renderTemplate(file: string, data: any): Promise<string> {
        let templateData = { ...data,
            cspSource: this.view!.webview.cspSource,
        };
        if (this.pages[file]) {
            return this.pages[file](templateData);
        }

        let buffer = await promisify(fs.readFile)(vscode.Uri.joinPath(this.ctx.extensionUri, 'resources', file).fsPath);
        let template = handlebars.compile(buffer.toString());
        this.pages[file] = template;
        return template(templateData);
    }

    /**
     * Checks if there is a valid workspace folder open
     */
    private checkValidWorkspaceFolder(): boolean {
        if ((vscode.workspace.workspaceFolders?.length ?? 0) < 1) {
            vscode.window.showErrorMessage("You need to open a workspace folder before you can open or create a project");
            return false; 
        }
        return true;
    }

    /**
     * Opens the currently active file as the main project file and opens a preview window
     */
    private setActiveProject(): boolean {
        let doc = vscode.window.activeTextEditor;
        if (!doc) { 
            return false;
        }

        try {
            let yamlDoc = yaml.parse(doc.document.getText());
            let project = yamlDoc['project'];
            this.document = doc.document;
            this.showPreview(undefined, "Processing TaskFalcon file...");
            return !!project;
        } catch (e) {
            return false;
        }
    }

    /**
     * Is the current project document still active
     */
    private isActive(): boolean {
        return !!this.document;
    }

    private clearClickMap() {
        this.clickMapObject = null;
        this.clickMapReferences = null;
        this.lastClickItem = "";
        this.lastClickResults = [];
        this.lastClickTime = 0;
        this.lastClickIteration = 0;
    }

    /**
     * Returns the clicked row in the image
     * @param x Image coords
     * @param y Image coords
     */
    private getRowByImageCoords(x: number, y: number): number {
        const offset = 50;
        const rowHeight = 20;
        const row = Math.floor((y - offset) / rowHeight);
        return row;
    }

    /**
     * Returns the element for the given row in the current image
     */
    private async getClickItemByImageRow(row: number): Promise<ClickItem | undefined> {
        if (!this.clickMapFile) {
            return;
        }

        if (!this.clickMapObject) {
            try {
                this.clickMapObject = await this.parseClickMap(this.clickMapFile);
            } catch (err) {
                console.log(err);
                return;
            }
        }

        const task = this.clickMapObject.tasks[row];
        if (task) {
            return { type: ClickItemType.TASK, value: task };
        }
        const resource = this.clickMapObject.resources[row];
        if (resource) {
            return { type: ClickItemType.RESOURCE, value: resource };
        }
    }

    /**
     * Gets called by preview window when the mouse hovers over a task
     * This function retrieves the task id for the given coordinates
     */
    private async hoverImage(x: number, y: number) {
        const row = this.getRowByImageCoords(x, y);
        let clickItem = await this.getClickItemByImageRow(row);
        if (!clickItem) {
            return;
        }

        this.preview?.webview.postMessage( {action: 'showId', x, y, id: clickItem.value} );
    }

    /**
     * Gets called when the user clicks on the preview image.
     * The function determines the task and navigates to the task in the source code files
     */
    private async clickImage(x: number, y: number) {
        const row = this.getRowByImageCoords(x, y);
        let clickItem = await this.getClickItemByImageRow(row);
        if (!clickItem) {
            return;
        }
        this.lastClickItem = clickItem.value;

        if (!this.clickMapReferences) {
            try {
                this.clickMapReferences = await parseReferences(this.document!.uri);
            } catch (err) {
                console.log(err);
                return;
            }
        }

        // Get list of matches in YAML files
        switch (clickItem.type) {
            case ClickItemType.RESOURCE:
                this.lastClickResults = findResource(this.clickMapReferences, clickItem.value);
                break;
            case ClickItemType.TASK:
                this.lastClickResults = findTask(this.clickMapReferences, clickItem.value);
                break;

        }

        // Check if we want to jump to the first entry or cycling through all entries
        const restartTimeout = 2000;
        if (new Date().getTime() < (this.lastClickTime + restartTimeout)) {
            this.lastClickIteration++;
        } else {
            this.lastClickIteration = 0;
        }
        this.lastClickTime = new Date().getTime();

        const filePos = this.lastClickResults![this.lastClickIteration % this.lastClickResults!.length];
        if (!filePos?.path) {
            return;
        }

        // Show selection
        const document = await vscode.workspace.openTextDocument(filePos.path);
        const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
        const selection = new vscode.Selection(filePos.line, 0, filePos.line, 0);
        editor.revealRange(selection);
        editor.selection = selection;
    }

    /**
     * Shows a HTML page with the rendered TaskFalcon image
     */
    private showPreview(imageUri?: vscode.Uri, error?: string) {
        const previewWindowId = 'TaskFalconPreview';
        const previewWindowTitle = 'TaskFalcon Preview';

        if (this.preview) {
            if (!this.preview.visible) {
                this.preview.reveal(vscode.ViewColumn.Beside);
            }
            this.preview!.title = previewWindowTitle;
        } else {
            const project = this;
            const options: vscode.WebviewOptions = {
                enableScripts: true
            };
            this.preview = vscode.window.createWebviewPanel(
                previewWindowId, previewWindowTitle,
                vscode.ViewColumn.Beside, options);
            this.preview.webview.onDidReceiveMessage(
                (data) => {
                    switch (data.action) {
                        case 'click':
                            project.clickImage(data.x, data.y);
                            break;
                        case 'hover':
                            project.hoverImage(data.x, data.y);
                            break;
                    }
                });
            this.preview.onDidDispose(() => {
                this.preview = undefined;
            });
        }

        let image = undefined;
        if (imageUri) {
            image = this.preview!.webview.asWebviewUri(imageUri) + `?${new Date().getTime()}`;
        }

        let resources = { image, error };
        this.preview!.webview.html = "";
        this.renderTemplate('preview.html', resources)
                .then(data => this.preview!.webview.html = data.toString())
                .catch(console.error);
    }

    /**
     * Closes the project
     */
    private closeProject() {
        this.document = undefined;
        this.closePreview();
    }

    /**
     * Closes the preview window
     */
    private closePreview() {
        if (this.preview) {
            this.preview.dispose();
            this.preview = undefined;
        }
    }

    /**
     * Runs taskfalcon to render the file.
     * Kills still running instances, if any.
     */
    private async runFalcon() {
        if (!this.isActive()) {
            return;
        }

        let parameters: string[] = [];
        if (this.previewConfig.showIDs) { parameters.push("-show-ids"); }
        if (this.previewConfig.hideTasks) { parameters.push("-no-tasks"); }
        if (this.previewConfig.showEnds) { parameters.push("-show-ends"); }
        if (this.previewConfig.showEfforts) { parameters.push("-show-efforts"); }
        if (this.previewConfig.showEffortsSpent) { parameters.push("-show-effortsspent"); }
        if (this.previewConfig.showEffortsLeft) { parameters.push("-show-effortsleft"); }
        if (this.previewConfig.showDone) { parameters.push("-show-done"); }
        if (this.previewConfig.showClosedTasks) { parameters.push("-show-closed-tasks"); }
        if (this.previewConfig.noUpdates) { parameters.push("-no-updates"); }
        if (this.previewConfig.allUpdates) { parameters.push("-all-updates"); }

        if (this.previewConfig.today.trim() !== '') { 
            parameters.push("-today"); 
            parameters.push(this.previewConfig.today.trim()); 
        }

        if (this.previewConfig.start.trim() !== '') { 
            parameters.push("-start"); 
            parameters.push(this.previewConfig.start.trim()); 
        }

        if (this.previewConfig.end.trim() !== '') { 
            parameters.push("-end"); 
            parameters.push(this.previewConfig.end.trim()); 
        }

        if (this.previewConfig.prefix.trim() !== '') { 
            parameters.push("-prefix"); 
            parameters.push(this.previewConfig.prefix.trim()); 
        }

        if (this.previewConfig.scale.trim() !== '') { 
            parameters.push("-scale"); 
            parameters.push(this.previewConfig.scale.trim()); 
        }

        if (this.previewConfig.tags.trim() !== '') {
            parameters.push("-tags"); 
            parameters.push(this.previewConfig.tags.trim()); 
        }

        if (this.previewConfig.freeParams.trim() !== '') {
            let freeParams = this.previewConfig.freeParams.split(' ');
            parameters = parameters.concat(freeParams);
        }

        parameters.push("-export-charts");
        parameters.push(this.previewConfig.chart);

        parameters.push("-export-click-map");

        parameters.push(this.document!.fileName);
        if (this.falconRunner) {
            this.falconRunner.kill();
            this.falconRunner = undefined;
        }

        if (this.preview) {
            this.preview!.title = "Running...";
        }
        this.falconRunner = new TaskFalconRunner(parameters);
        this.taskFalconOutput!.clear();
        this.taskFalconOutput!.show(true);
        this.taskFalconOutput!.appendLine("> falcon " + parameters.join(" ") + "\n");

        let output: string = "";
        try {
            output = await this.falconRunner.run();

            if (output.indexOf("CRITICAL") > 0) {
                throw(output);
            }
            
            let imageName = this.getPreviewImageName();
            let imageUri = vscode.Uri.file(imageName);
            this.clickMapFile = imageName + ".json";
            this.clearClickMap();
            this.showPreview(imageUri, undefined);
        } catch (e) {
            output = e as any;
            this.showPreview(undefined, output);
        }

        // Show output in console
        this.taskFalconOutput!.append(output);
        this.falconRunner = undefined;
    }

    private getPreviewImageName(): string {
        let filename = this.document!.fileName;
        let basename = filename;

        if (filename.toLowerCase().endsWith('.yaml')) {
            basename = filename.slice(0, filename.length-5);
        } else if (basename.toLowerCase().endsWith('.yml')) {
            basename = filename.slice(0, filename.length-4);
        }

        return `${basename}.${this.previewConfig.chart}.png`;
    }

    private async parseClickMap(filename: string): Promise<any> {
        const readFile = promisify(fs.readFile)
        let clickMap = await readFile(filename);
        return JSON.parse(clickMap.toString());
    }
}
