import { spawn, ChildProcess } from 'child_process';
import { Readable } from 'stream';

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

    private streamToString(stream: Readable): Promise<string> {
        const chunks:Buffer[] = [];
        return new Promise((resolve, reject) => {
          stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          stream.on('error', (err) => reject(err));
          stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
    }

    public async run(): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            this.process = spawn(TaskFalconRunner.getFalconBinary(), this.cmd);
            let stdout = this.streamToString(this.process!.stdout!);
            this.process.on('close', async (code) => {
                let result = await stdout;
                if (code !== 0 || this.cancelled) {
                    reject(result);
                } else {
                    resolve(result);
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