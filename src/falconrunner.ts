import { exec, spawn, ChildProcess } from 'child_process';

export class TaskFalconRunner {
    private cancelled: boolean = false;
    private process?: ChildProcess;
    private cmd: string[];
    private static extensionPath: string;

    constructor(cmd: string[]) {
        this.cmd = cmd;
    }

    public isRunning() {
        return this.process && !this.cancelled;
    }

    public kill() {
        if (this.cancelled) {
            return;
        }
        this.cancelled = true;
        this.process!.kill("SIGKILL");
    }

    public async run(): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            this.process = exec(TaskFalconRunner.getFalconBinary() + ' ' + this.cmd.join(' '), (err, stdout, stderr) => {
                if (err || this.cancelled) {
                    if (!stdout) {
                        stdout = err?.message!;
                    }
                    reject(stdout);
                } else {
                    resolve(stdout);
                }
            });
        });
    }

    public static getFalconBinary(): string {
        let binaries: {[key: string]: string} = {
            win32: 'falcon.exe',
            darwin: 'falcon',
            linux: 'falcon',
        };
        let platform = process.platform.toString();
        let binary: string = binaries[platform];
        let binPath = `${TaskFalconRunner.extensionPath}/bin/${platform}/${binary}`;
        return binPath;
    }

    public static setExtensionPath(path: string) {
        TaskFalconRunner.extensionPath = path;
    }
};